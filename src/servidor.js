// Interface local (http://localhost:<porta>). Extração em segundo plano + navegador próprio do Via Imob para lançamento.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extrair, separarLinks, gerarScript, MANUAL_PADRAO } from './extrator.js';
import { abrirBanco } from './banco.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(process.env.LB_CONFIG || path.join(raiz, 'config.json'), 'utf8'));
const { version: versaoApp } = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));

const porta = Number(cfg.porta);
if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) throw new Error('config.json: "porta" inválida');

process.on('unhandledRejection', e => console.error('Erro não tratado:', e));
process.on('uncaughtException', e => console.error('Exceção não tratada:', e));

// App já aberto? Só abre a janela dele e sai — antes de tocar no banco (não interfere no que está rodando).
let servidorPrincipal = false;
const portaEmUso = () => new Promise(ok => {
  const s = net.connect({ port: porta, host: '127.0.0.1' });
  s.setTimeout(800, () => { s.destroy(); ok(false); });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('error', () => ok(false));
});
if (await portaEmUso()) {
  console.log('App já está aberto; abrindo janela.');
  abrirJanela();
  await new Promise(r => setTimeout(r, 3000));
  process.exit(0);
}

// ---------- Estado ----------
const estado = {
  versao: 0,
  app: { versao: versaoApp },
  config: { chrome: cfg.chrome, porta, urlViaImob: cfg.urlViaImob, viewportViaImob: cfg.viewportViaImob,
    concorrenciaExtracao: cfg.concorrenciaExtracao, esperaMs: cfg.esperaMs, mapaOcorrencias: cfg.mapaOcorrencias,
    lancamento: cfg.lancamento, diasCapturas: cfg.diasCapturas || 90, lancamentoManual: cfg.lancamentoManual ?? MANUAL_PADRAO },
  atualizadoEm: new Date().toISOString(),
  extracao: { rodando: false, pausado: false, total: 0, feitos: 0, duplicados: 0, fila: 0, erro: null },
  boletos: [],
  via: { aberto: false },
  lancando: null, // id do boleto em lançamento
  passoLancamento: null,
  aguardandoGravar: null, // id do boleto preenchido esperando a confirmação para clicar em Gravar
  duplicidades: 0,
  // Revisões: a interface só recarrega Histórico/Condomínios/Duplicidades quando a respectiva muda.
  rev: { hist: 0, cond: 0, dup: 0 }
};
// ---------- Banco local ----------
const dirDados = process.env.LB_DADOS || path.join(raiz, 'dados');
const banco = abrirBanco(dirDados);
// Fotos da tela de erro do Via Imob (dados/capturas/<id>-erro.jpg), apagadas após N dias.
const dirCapturas = path.join(dirDados, 'capturas');
fs.mkdirSync(dirCapturas, { recursive: true });
const arqCaptura = id => path.join(dirCapturas, `${Number(id)}-erro.jpg`);
const apagarCapturas = ids => { for (const id of ids) fs.rmSync(arqCaptura(id), { force: true }); };
function limparCapturasAntigas() {
  const limite = Date.now() - (Number(cfg.diasCapturas) || 90) * 86400000;
  try {
    for (const f of fs.readdirSync(dirCapturas)) {
      const arq = path.join(dirCapturas, f);
      // Fotos de boleto de versões anteriores (<id>.jpg) não são mais usadas: removidas.
      if (/^\d+\.jpg$/.test(f) || (/^\d+-erro\.jpg$/.test(f) && fs.statSync(arq).mtimeMs < limite)) fs.rmSync(arq, { force: true });
    }
  } catch {}
}
limparCapturasAntigas();
setInterval(limparCapturasAntigas, 24 * 3600 * 1000).unref();
// Migração única do antigo plano_lote.json para o banco.
const arqPlano = path.join(raiz, 'plano_lote.json');
if (fs.existsSync(arqPlano)) {
  try {
    if (banco.vazio()) {
      const n = banco.importarJson(JSON.parse(fs.readFileSync(arqPlano, 'utf8')).boletos || []);
      console.log(`${n} boletos importados de plano_lote.json`);
    }
    fs.renameSync(arqPlano, arqPlano.replace(/\.json$/, '.importado.json'));
  } catch (e) { console.error('Falha ao importar plano_lote.json:', e.message); }
}
banco.backupDiario();
setInterval(() => banco.backupDiario(), 6 * 3600 * 1000).unref();
estado.boletos = banco.loteAtual();
estado.duplicidades = banco.contarDuplicidades();
estado.config.banco = banco.arquivo;

const mudou = (persistir = true) => {
  estado.versao++;
  if (persistir) estado.atualizadoEm = new Date().toISOString();
};
const salvarBoleto = b => { banco.atualizar(b); mudou(); };
const tocar = (...areas) => { for (const a of areas) estado.rev[a]++; };
const boletoDoLote = id => estado.boletos.find(b => b.id === id);
const erro = (msg, code) => Object.assign(new Error(msg), { code });

// Encerramento limpo: grava a lista, salva o login do Via Imob e fecha o navegador.
let encerrando = false;
async function encerrar() {
  if (encerrando) return; encerrando = true;
  setTimeout(() => process.exit(0), 5000).unref(); // nunca fica preso ao fechar
  try { await salvarSessao(); await viaCtx?.close().catch(() => {}); banco.fechar(); } finally { process.exit(0); }
}
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, encerrar);

// ---------- Via Imob ----------
// O perfil persistente (perfil-via/) guarda cookies duráveis e localStorage. Cookies de sessão e
// sessionStorage o Chrome descarta ao fechar; por isso são salvos à parte em perfil-via/sessao.json
// (arquivo local, permissão 600, ignorado pelo git) e restaurados ao abrir — o login continua valendo.
const dirPerfil = path.join(raiz, 'perfil-via');
const arqSessao = path.join(dirPerfil, 'sessao.json');
let viaCtx = null, timerSessao = null;

async function salvarSessao(ctx = viaCtx) {
  if (!ctx) return;
  try {
    const cookies = await ctx.cookies();
    // Mantém o sessionStorage salvo antes (no fechamento as páginas já não respondem).
    let storage = {};
    try { storage = JSON.parse(fs.readFileSync(arqSessao, 'utf8')).storage || {}; } catch {}
    for (const p of ctx.pages()) {
      try {
        const r = await p.evaluate(() => ({ o: location.origin, d: JSON.stringify(Object.entries(sessionStorage)) }));
        if (/^https?:/.test(r.o) && r.d !== '[]') storage[r.o] = r.d;
      } catch {}
    }
    if (!cookies.length && !Object.keys(storage).length) return;
    const tmp = arqSessao + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ salvoEm: new Date().toISOString(), cookies, storage }), { mode: 0o600 });
    fs.renameSync(tmp, arqSessao);
  } catch {}
}

async function restaurarSessao(ctx) {
  let s;
  try { s = JSON.parse(fs.readFileSync(arqSessao, 'utf8')); } catch { return; }
  const agora = Date.now() / 1000;
  const cookies = (s.cookies || []).filter(c => c.expires === -1 || c.expires > agora);
  // Só adiciona cookies que o perfil ainda não tem (não sobrescreve um login mais novo).
  const atuais = new Set((await ctx.cookies()).map(c => `${c.name}|${c.domain}|${c.path}`));
  const faltando = cookies.filter(c => !atuais.has(`${c.name}|${c.domain}|${c.path}`));
  if (faltando.length) await ctx.addCookies(faltando).catch(() => {});
  // sessionStorage: restaurado só no primeiro minuto após abrir (evita reviver sessão após logout).
  if (s.storage && Object.keys(s.storage).length) {
    await ctx.addInitScript(({ storage, ate }) => {
      try {
        const d = storage[location.origin];
        if (d && Date.now() < ate && sessionStorage.length === 0) for (const [k, v] of JSON.parse(d)) sessionStorage.setItem(k, v);
      } catch {}
    }, { storage: s.storage, ate: Date.now() + 60000 });
  }
}

let abrindoVia = null; // evita abrir o mesmo perfil duas vezes (clique duplo)
const abrirVia = () => (abrindoVia ??= abrirViaAgora().finally(() => { abrindoVia = null; }));
async function abrirViaAgora() {
  if (viaCtx) {
    try { await viaCtx.pages()[0]?.bringToFront(); estado.via.aberto = true; mudou(false); return; } catch { viaCtx = null; }
  }
  const ctx = await chromium.launchPersistentContext(dirPerfil, {
    executablePath: cfg.chrome, headless: false, ignoreHTTPSErrors: true, viewport: cfg.viewportViaImob || null
  });
  viaCtx = ctx;
  await restaurarSessao(ctx);
  // Salva a sessão a cada carregamento de página e periodicamente (cobre o fechamento da janela).
  let tSalvar = null;
  const agendarSalvar = () => { clearTimeout(tSalvar); tSalvar = setTimeout(() => salvarSessao(ctx), 1500); };
  const observar = p => { p.on('load', agendarSalvar); p.on('close', () => salvarSessao(ctx)); };
  ctx.pages().forEach(observar);
  ctx.on('page', observar);
  clearInterval(timerSessao);
  timerSessao = setInterval(() => salvarSessao(ctx), 10000);
  ctx.on('close', () => {
    clearInterval(timerSessao); clearTimeout(tSalvar);
    if (viaCtx === ctx) { viaCtx = null; estado.via.aberto = false; mudou(false); }
  });
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto(cfg.urlViaImob).catch(() => {});
  estado.via.aberto = true; mudou(false);
}

// A aba "certa" é a que o usuário deixou visível/em foco no navegador do Via Imob.
async function abaAtiva() {
  if (!viaCtx) throw new Error('Navegador do Via Imob não está aberto');
  const pages = viaCtx.pages();
  for (const p of pages) {
    try { if (await p.evaluate(() => document.visibilityState === 'visible' && document.hasFocus())) return p; } catch {}
  }
  for (const p of pages) {
    try { if (await p.evaluate(() => document.visibilityState === 'visible')) return p; } catch {}
  }
  return pages[pages.length - 1];
}

const marcarLancado = (b, extra = {}) => {
  Object.assign(b, { status: 'lancado', lancadoEm: new Date().toISOString() }, extra);
  estado.boletos = estado.boletos.filter(x => x.id !== b.id); // sai da lista → Histórico
  tocar('hist', 'cond');
};

// Clica em Gravar (canto inferior direito da tela do Via Imob) e observa por 3 s se abriu a janela "Erro".
const SCRIPT_GRAVAR = async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const titulo = w => (w.querySelector('.title')?.textContent || '').replace(/\s+/g, ' ').trim();
  const ERRO = /^(erro|aviso|aten[cç][aã]o)\b/i;
  const antes = new Set(document.querySelectorAll('.dwmwindow'));
  const x = innerWidth - 237, y = innerHeight - 18, el = document.elementFromPoint(x, y);
  if (!el) return { erro: 'não achei o botão Gravar na posição esperada (a janela do Via Imob está maximizada?)' };
  const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
  o.buttons = 0;
  el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o));
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    await sleep(150);
    const erro = [...document.querySelectorAll('.dwmwindow')].find(w => ERRO.test(titulo(w)));
    if (erro) return { erro: `o Via Imob mostrou a janela "${titulo(erro)}" ao gravar` };
  }
  const novas = [...document.querySelectorAll('.dwmwindow')].filter(w => !antes.has(w)).map(titulo).filter(Boolean);
  return { janelas: novas };
};

// Lança um boleto da lista. Sucesso → marcado como lançado e movido para o Histórico.
async function lancar(id) {
  if (estado.lancando !== null) throw erro('Já existe um lançamento em andamento', 409);
  const b = boletoDoLote(id);
  if (!b) throw erro('Boleto não está na lista para lançar (já lançado ou excluído)', 409);
  if (b.status === 'manual') throw erro('Este boleto é de lançamento manual (tem multa, mudança, caixa d\'água ou extintor)', 409);
  if (b.problemas?.length) throw erro('Boleto com problemas: ' + b.problemas.join('; '), 400);
  // Trava contra lançamento duplo: mesma linha digitável já lançada antes.
  const dup = banco.jaLancado(b.linhaDigitavel, b.id);
  if (dup) throw erro(`Este boleto já foi lançado (registro #${dup.id}). Lançamento bloqueado.`, 409);
  if (!viaCtx) throw erro('Abra o navegador do Via Imob antes de lançar', 409);
  estado.lancando = id;
  estado.passoLancamento = 'Preparando…';
  let page = null;
  // O script de lançamento informa cada etapa via console ("[LB] ...") → painel de conferência.
  let fotoErro = null, pular = false;
  const aoLog = msg => {
    const t = msg.text();
    if (t.startsWith('[LB] ')) { estado.passoLancamento = t.slice(5); mudou(false); }
    // Script pediu a foto da tela com o aviso aberto (antes de fechá-lo).
    else if (t === '[LB-FOTO]' && page) fotoErro = page.screenshot({ type: 'jpeg', quality: 75, timeout: 5000 }).catch(() => null);
  };
  // Caixa de mensagem do navegador (alert/confirm) durante o lançamento = aviso do Via Imob: fecha e avisa o script.
  const aoDialogo = async d => {
    const msg = d.message() || 'Caixa de mensagem do Via Imob';
    await d.dismiss().catch(() => {});
    page?.evaluate(m => { window.__lbAviso = m; }, msg).catch(() => {});
  };
  try {
    page = await abaAtiva();
    page.on('console', aoLog);
    page.on('dialog', aoDialogo);
    b.status = 'lancando'; delete b.erroLancamento; delete b.capturaErro; fs.rmSync(arqCaptura(b.id), { force: true });
    salvarBoleto(b);
    const opc = cfg.lancamento || {};
    await page.evaluate(gerarScript(b, { rapido: opc.rapido !== false, verificar: opc.verificarAvisos !== false }));
    if (opc.gravar !== false) {
      // Preenchido: espera a confirmação no app para clicar em Gravar (o lançamento continua "em andamento").
      estado.aguardandoGravar = b.id;
      estado.passoLancamento = 'Preenchido. Confira o Total no Via Imob e confirme a gravação abaixo.';
    } else marcarLancado(b);
  } catch (e) {
    b.status = 'erro';
    // Formato do script: AVISO|etapa|mensagem|fechou(0/1)|pode pular(0/1)
    const aviso = /AVISO\|([^|]*)\|([^|\n]*)(?:\|([01])\|([01]))?/.exec(String(e.message));
    if (aviso) {
      pular = aviso[4] === '1';
      b.erroLancamento = `Via Imob mostrou um aviso após ${aviso[1]}: ${aviso[2]}` +
        (aviso[3] === '0' ? ' (a caixa de aviso não fechou sozinha — feche no Via Imob)'
          : !pular ? ' (aviso fechado; confira e limpe os itens já adicionados na tela)' : '');
    } else b.erroLancamento = String(e.message).replace(/^page\.evaluate:\s*(Error:\s*)?/, '').split('\n')[0];
    // Foto da tela no momento do erro (a tirada com o aviso aberto, se houver).
    if (page) {
      try {
        const img = (await fotoErro) || await page.screenshot({ type: 'jpeg', quality: 75, timeout: 5000 });
        fs.writeFileSync(arqCaptura(b.id), img); b.capturaErro = true;
      } catch {}
    }
  } finally {
    page?.off('console', aoLog);
    page?.off('dialog', aoDialogo);
    if (estado.aguardandoGravar !== b.id) { estado.lancando = null; estado.passoLancamento = null; }
    salvarBoleto(b);
  }
  return { b, pular };
}

// ---------- Extração ----------
// A fila fica no banco: fechar o app no meio não perde nada. Ao abrir de novo, a extração
// continua sozinha (ou fica pausada, se foi pausada). "Parar" descarta a fila.
let ctrl = null;
const emAndamento = new Set();
const ex = () => estado.extracao;
const persistirExtracao = () => {
  ex().fila = banco.filaContar();
  banco.kvGravar('extracao', ex().fila ? { pausado: ex().pausado, total: ex().total, feitos: ex().feitos, duplicados: ex().duplicados } : null);
};

function processarFila() {
  if (ctrl) return;
  const c = ctrl = { pausado: false, parado: false, temMais: () => banco.filaContar() > emAndamento.size };
  Object.assign(ex(), { rodando: true, pausado: false, erro: null });
  persistirExtracao(); mudou(false);
  const proximo = () => {
    const url = c.parado ? null : banco.filaProxima(emAndamento);
    if (url) emAndamento.add(url);
    return url;
  };
  extrair(proximo, cfg, (url, novo) => {
    novo.extraidoEm = new Date().toISOString();
    try {
      const { boleto, duplicado } = banco.registrarExtracao(novo);
      if (duplicado) { ex().duplicados++; estado.duplicidades = banco.contarDuplicidades(); tocar('dup'); }
      else {
        const i = estado.boletos.findIndex(x => x.id === boleto.id);
        if (i >= 0) estado.boletos[i] = boleto; else estado.boletos.push(boleto);
      }
      tocar('cond');
    } catch (e) { console.error('Falha ao gravar boleto:', e.message); }
    // Sai da fila mesmo se a gravação falhar (evita repetir o mesmo link para sempre).
    banco.filaRemover(url);
    emAndamento.delete(url);
    ex().feitos++; persistirExtracao(); mudou();
  }, c)
    .catch(e => { if (!c.parado) ex().erro = String(e.message).split('\n')[0]; })
    .finally(() => {
      emAndamento.clear();
      if (ctrl === c) ctrl = null;
      ex().rodando = false;
      const resta = banco.filaContar();
      // Links que entraram na fila no finalzinho (ou depois do Parar): continua com eles.
      if (resta && !ex().erro && (c.parado || !c.pausado)) { ex().pausado = false; mudou(false); processarFila(); return; }
      // Sobrou fila por falha (ex.: Chrome não abriu): fica pausada para retomar.
      ex().pausado = resta > 0;
      persistirExtracao(); mudou(false);
    });
}

/** Adiciona links à fila e inicia (ou continua) a extração. Sem links novos, apenas retoma a fila. */
function iniciarExtracao(texto) {
  const links = Array.isArray(texto) ? texto : separarLinks(texto);
  const filaAntes = banco.filaContar();
  const novos = links.length ? banco.filaAdicionar(links) : 0;
  if (!novos && !filaAntes) throw erro(links.length ? 'Esses links já estão na fila' : 'Nenhum link encontrado', 400);
  if (!filaAntes && !ex().rodando) Object.assign(ex(), { total: novos, feitos: 0, duplicados: 0 });
  else ex().total += novos;
  persistirExtracao();
  if (ctrl) { if (ctrl.pausado) { ctrl.pausado = false; ex().pausado = false; persistirExtracao(); } mudou(false); }
  else processarFila();
  return { novos, fila: ex().fila, retomado: !novos };
}

// Retomada na inicialização (o processamento só começa depois que este processo assume a porta).
let retomarAoIniciar = false;
{
  const salvo = banco.kvLer('extracao'), nFila = banco.filaContar();
  if (nFila) {
    Object.assign(estado.extracao, { rodando: false, pausado: !!salvo?.pausado, total: salvo?.total ?? nFila,
      feitos: salvo?.feitos ?? 0, duplicados: salvo?.duplicados ?? 0, fila: nFila, retomada: true });
    if (!salvo?.pausado) { console.log(`Retomando extração: ${nFila} links restantes`); retomarAoIniciar = true; }
    else console.log(`Extração pausada: ${nFila} links restantes`);
  } else banco.kvGravar('extracao', null);
}

// ---------- HTTP ----------
const TOKEN = crypto.randomBytes(24).toString('hex');
const hostsOk = new Set([`localhost:${porta}`, `127.0.0.1:${porta}`]);
const origensOk = new Set([...hostsOk].map(h => 'http://' + h));
const LIMITE_CORPO = 2 * 1024 * 1024;

const SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

// Arquivos estáticos carregados em memória na inicialização (whitelist — sem path traversal).
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const estaticos = new Map();
for (const nome of ['index.html', 'app.css', 'app.js', 'logo.svg', 'icone.ico']) {
  let corpo = fs.readFileSync(path.join(raiz, 'public', nome));
  if (nome === 'index.html') corpo = Buffer.from(corpo.toString('utf8').replace('__TOKEN__', TOKEN));
  estaticos.set(nome === 'index.html' ? '/' : '/' + nome, { tipo: TIPOS[path.extname(nome)], corpo });
}
estaticos.set('/favicon.ico', estaticos.get('/icone.ico'));

const responder = (res, code, corpo, tipo, extra = {}) => {
  res.writeHead(code, { ...SEGURANCA, 'Cache-Control': 'no-store', ...(tipo && { 'Content-Type': tipo }), ...extra });
  res.end(corpo);
};
const json = (res, obj, code = 200) => responder(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

const lerCorpo = req => new Promise((ok, falha) => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return falha(Object.assign(new Error('Content-Type inválido'), { code: 415 }));
  let tam = 0; const partes = [];
  req.on('data', c => {
    tam += c.length;
    if (tam > LIMITE_CORPO) { falha(Object.assign(new Error('Corpo muito grande'), { code: 413 })); req.destroy(); return; }
    partes.push(c);
  });
  req.on('end', () => { try { const o = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'); ok(o && typeof o === 'object' ? o : {}); } catch { falha(Object.assign(new Error('JSON inválido'), { code: 400 })); } });
  req.on('error', falha);
});
const idValido = id => Number.isInteger(id) && id > 0;
const tokenOk = req => {
  const t = String(req.headers['x-token'] || '');
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
};

const rotas = {
  'POST /api/extrair': async b => ({ ok: true, ...iniciarExtracao(String(b.texto ?? '')) }),
  // Pausar / Retomar. A pausa fica salva: fechando e abrindo o app, continua pausada.
  'POST /api/extracao/pausar': async () => {
    if (ctrl) {
      ctrl.pausado = !ctrl.pausado; ex().pausado = ctrl.pausado;
      persistirExtracao(); mudou(false);
      return { ok: true, pausado: ctrl.pausado };
    }
    if (!banco.filaContar()) throw erro('Nenhuma extração em andamento', 409);
    processarFila(); // retoma a fila salva
    return { ok: true, pausado: false };
  },
  // Parar: interrompe de vez e descarta os links restantes.
  'POST /api/extracao/parar': async () => {
    if (!ctrl && !banco.filaContar()) throw erro('Nenhuma extração em andamento', 409);
    banco.filaLimpar();
    if (ctrl) { ctrl.parado = true; ctrl.pausado = false; await ctrl.browser?.close().catch(() => {}); }
    Object.assign(ex(), { pausado: false, fila: 0, retomada: false, total: 0, feitos: 0, duplicados: 0 });
    banco.kvGravar('extracao', null); mudou(false);
    return { ok: true };
  },
  // Remove da lista os boletos ainda não lançados (os lançados continuam no Histórico).
  'POST /api/limpar': async () => {
    if (estado.extracao.rodando) throw erro('Extração em andamento', 409);
    if (estado.lancando !== null) throw erro('Lançamento em andamento', 409);
    const ids = banco.limparPendentes();
    apagarCapturas(ids);
    estado.boletos = banco.loteAtual(); tocar('cond'); mudou(); return { ok: true, removidos: ids.length };
  },
  'POST /api/via/abrir': async () => { await abrirVia(); return { ok: true }; },
  // Lança o boleto. Se o Via Imob avisar erro no código/barras, a caixa é fechada e segue para o próximo pronto.
  'POST /api/lancar': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    const pulados = [];
    const pularLigado = cfg.lancamento?.pularComErro !== false;
    for (let atual = id; ;) {
      const { b, pular } = await lancar(atual);
      if (estado.aguardandoGravar === b.id) return { ok: true, aguardando: { id: b.id, cod: b.codIdentificador }, pulados };
      if (b.status === 'lancado') return { ok: true, lancado: { id: b.id, cod: b.codIdentificador }, pulados };
      pulados.push({ id: b.id, cod: b.codIdentificador, erro: b.erroLancamento });
      const prox = pular && pularLigado && estado.boletos.find(x => x.status === 'pendente' && !x.problemas?.length);
      if (!prox) return { ok: true, lancado: null, pulados, parou: !pular };
      estado.passoLancamento = `Aviso no boleto ${b.codIdentificador} — indo para o próximo…`; mudou(false);
      atual = prox.id;
    }
  },
  // Confirmação do Gravar: gravar=true clica em Gravar no Via Imob; false = "eu gravo manualmente".
  'POST /api/gravar': async ({ id, gravar }) => {
    if (!idValido(id) || estado.aguardandoGravar !== id) throw erro('Nenhum boleto aguardando gravação', 409);
    const b = boletoDoLote(id);
    const fim = () => { estado.aguardandoGravar = null; estado.lancando = null; estado.passoLancamento = null; };
    if (!gravar) { marcarLancado(b); fim(); salvarBoleto(b); return { ok: true, gravado: false }; }
    estado.passoLancamento = 'Clicando em Gravar no Via Imob…'; mudou(false);
    let page = null, r;
    const aoDialogo = async d => { r = { erro: `caixa de mensagem ao gravar: ${d.message()}` }; await d.dismiss().catch(() => {}); };
    try {
      page = await abaAtiva();
      page.on('dialog', aoDialogo);
      r = (await page.evaluate(SCRIPT_GRAVAR)) || r;
    } catch (e) { r = { erro: String(e.message).replace(/^page\.evaluate:\s*(Error:\s*)?/, '').split('\n')[0] }; }
    finally { page?.off('dialog', aoDialogo); }
    if (r?.erro) {
      b.status = 'erro'; b.erroLancamento = 'Ao gravar: ' + r.erro;
      try { fs.writeFileSync(arqCaptura(b.id), await page.screenshot({ type: 'jpeg', quality: 75, timeout: 5000 })); b.capturaErro = true; } catch {}
      fim(); salvarBoleto(b);
      return { ok: false, erro: b.erroLancamento };
    }
    marcarLancado(b, { gravadoPeloApp: true, ...(r?.janelas?.length && { avisoGravar: `Após gravar abriu: ${r.janelas.join(', ')}` }) });
    fim(); salvarBoleto(b);
    return { ok: true, gravado: true, janelas: r?.janelas || [] };
  },
  'POST /api/boletos/excluir': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    if (estado.lancando === id) throw erro('Boleto em lançamento', 409);
    if (!banco.excluir(id)) throw erro('Só é possível excluir boletos ainda não lançados', 409);
    apagarCapturas([id]);
    estado.boletos = estado.boletos.filter(x => x.id !== id); tocar('cond'); mudou(); return { ok: true };
  },
  // Desfaz um lançamento (ex.: não foi gravado no Via Imob): volta para a lista.
  'POST /api/desfazer': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    const b = banco.porId(id);
    if (!b || b.status !== 'lancado') throw erro('Boleto não está lançado', 409);
    b.status = b.manual ? 'manual' : 'pendente'; delete b.lancadoEm; delete b.lancadoManual;
    estado.boletos.push(b); tocar('hist', 'cond'); salvarBoleto(b); return { ok: true };
  },
  // Histórico: excluir selecionados / limpar tudo. Atenção: sem o registro, a trava de lançamento duplo deixa de valer para eles.
  'POST /api/historico/excluir': async ({ ids }) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100000 || !ids.every(idValido)) throw erro('Seleção inválida', 400);
    const apagados = banco.excluirLancados(ids);
    apagarCapturas(apagados); tocar('hist', 'cond'); mudou(false); return { ok: true, removidos: apagados.length };
  },
  'POST /api/historico/limpar': async () => {
    const apagados = banco.limparHistorico();
    apagarCapturas(apagados); tocar('hist', 'cond'); mudou(false); return { ok: true, removidos: apagados.length };
  },
  // Lançamento manual (multa / taxa de mudança): o usuário lança no Via Imob e marca aqui.
  'POST /api/manual/lancado': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    const b = boletoDoLote(id);
    if (!b || b.status !== 'manual') throw erro('Boleto não está na lista de lançamento manual', 409);
    const dup = banco.jaLancado(b.linhaDigitavel, b.id);
    if (dup) throw erro(`Este boleto já foi lançado (registro #${dup.id})`, 409);
    b.status = 'lancado'; b.lancadoEm = new Date().toISOString(); b.lancadoManual = true;
    estado.boletos = estado.boletos.filter(x => x.id !== id);
    tocar('hist', 'cond'); salvarBoleto(b); return { ok: true };
  },
  'POST /api/manual/limpar': async () => {
    const ids = banco.limparManuais(); apagarCapturas(ids);
    estado.boletos = estado.boletos.filter(x => x.status !== 'manual'); tocar('cond'); mudou(); return { ok: true, removidos: ids.length };
  },
  'POST /api/duplicidades/remover': async ({ id }) => {
    if (!idValido(id)) throw erro('Registro inválido', 400);
    banco.removerDuplicidade(id); estado.duplicidades = banco.contarDuplicidades(); tocar('dup'); mudou(false); return { ok: true };
  },
  'POST /api/duplicidades/limpar': async () => {
    banco.limparDuplicidades(); estado.duplicidades = 0; tocar('dup'); mudou(false); return { ok: true };
  },
  // ---- Condomínios / links ----
  'POST /api/condominios/criar': async ({ nome }) => {
    const id = banco.criarCondominio(String(nome ?? '').slice(0, 200)); tocar('cond'); mudou(false); return { ok: true, id };
  },
  'POST /api/condominios/vincular': async ({ condominioId, texto }) => {
    const urls = separarLinks(String(texto ?? ''));
    if (!urls.length) throw erro('Nenhum link encontrado', 400);
    if (condominioId !== 'sem' && !idValido(condominioId)) throw erro('Condomínio inválido', 400);
    const n = banco.vincularLinks(condominioId, urls); tocar('cond'); mudou(false); return { ok: true, total: n };
  },
  'POST /api/links/remover': async ({ id }) => {
    if (!idValido(id)) throw erro('Link inválido', 400);
    banco.removerLink(id); tocar('cond'); mudou(false); return { ok: true };
  },
  'POST /api/condominios/extrair': async ({ condominioId }) => {
    if (condominioId !== 'sem' && !idValido(condominioId)) throw erro('Condomínio inválido', 400);
    const urls = banco.linksDe(condominioId).map(l => l.url);
    if (!urls.length) throw erro('Este condomínio não tem links', 400);
    return { ok: true, ...iniciarExtracao(urls) };
  }
};

const consultas = {
  '/api/historico': q => banco.historico(Object.fromEntries(q)),
  '/api/condominios': () => banco.condominios(),
  '/api/duplicidades': q => banco.duplicidades(Object.fromEntries(q)),
  '/api/condominios/links': q => {
    const id = q.get('id');
    if (id !== 'sem' && !/^\d+$/.test(id || '')) throw erro('Condomínio inválido', 400);
    return { links: banco.linksDe(id) };
  }
};

const servidor = http.createServer(async (req, res) => {
  try {
    // Bloqueia DNS rebinding: só aceita Host local exato.
    if (!hostsOk.has(String(req.headers.host || '').toLowerCase())) return responder(res, 421, 'Host não permitido', 'text/plain; charset=utf-8');
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' || req.method === 'HEAD') {
      const arq = estaticos.get(url.pathname);
      if (arq) return responder(res, 200, req.method === 'HEAD' ? undefined : arq.corpo, arq.tipo);
      if (url.pathname.startsWith('/api/') && !tokenOk(req)) return json(res, { erro: 'Não autorizado' }, 403);
      if (consultas[url.pathname]) return json(res, consultas[url.pathname](url.searchParams));
      if (url.pathname === '/api/captura') {
        const id = url.searchParams.get('id');
        if (!/^\d+$/.test(id || '')) return json(res, { erro: 'id inválido' }, 400);
        let img; try { img = fs.readFileSync(arqCaptura(id)); } catch { return json(res, { erro: 'Captura não disponível' }, 404); }
        return responder(res, 200, img, 'image/jpeg');
      }
      if (url.pathname === '/api/estado') {
        // Polling barato: sem mudança desde a versão do cliente → 204 sem corpo.
        if (url.searchParams.get('v') === String(estado.versao)) return responder(res, 204);
        return json(res, estado);
      }
      return json(res, { erro: 'não encontrado' }, 404);
    }

    if (req.method === 'POST') {
      // CSRF: exige origem local + token de sessão.
      const origem = req.headers.origin;
      if ((origem && !origensOk.has(origem)) || !tokenOk(req)) return json(res, { erro: 'Não autorizado' }, 403);
      const rota = rotas['POST ' + url.pathname];
      if (!rota) return json(res, { erro: 'não encontrado' }, 404);
      const corpo = await lerCorpo(req);
      return json(res, await rota(corpo));
    }
    responder(res, 405, undefined, undefined, { Allow: 'GET, HEAD, POST' });
  } catch (e) {
    const code = Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, { erro: code === 500 ? 'Erro interno: ' + String(e.message).split('\n')[0] : e.message }, code);
  }
});
servidor.headersTimeout = 15000;
servidor.requestTimeout = 120000;
// ---------- Janela do app ----------
// Abre a interface numa janela própria do Chrome (modo app: sem abas nem barra de endereço),
// com perfil separado. Fechar a janela encerra o servidor.
function abrirJanela() {
  const url = `http://localhost:${porta}/`;
  if (process.env.LB_SEM_NAVEGADOR) return;
  if (cfg.abrirComoApp === false) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref(); } catch {}
    return;
  }
  const { width = 1440, height = 900 } = cfg.janelaApp || {};
  const inicio = Date.now();
  const filho = spawn(cfg.chrome, [
    `--app=${url}`, `--user-data-dir=${path.join(raiz, 'perfil-app')}`, `--window-size=${width | 0},${height | 0}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions'
  ], { stdio: 'ignore' });
  filho.on('error', e => console.error('Não foi possível abrir a janela do app:', e.message));
  // Se a janela já existia (outra instância), o processo sai na hora: não encerra o servidor.
  filho.on('exit', () => { if (Date.now() - inicio > 5000 && servidorPrincipal) encerrar(); });
}

servidor.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${porta} está ocupada por outro programa. Troque "porta" no config.json.` : e);
  process.exit(1);
});
servidor.listen(porta, '127.0.0.1', () => {
  servidorPrincipal = true;
  if (retomarAoIniciar) setTimeout(processarFila, 1500);
  console.log(`Interface em http://localhost:${porta}`);
  abrirJanela();
});
