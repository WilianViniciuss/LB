// Interface local (http://localhost:<porta>). Extração em segundo plano + navegador próprio do Via Imob para lançamento.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extrair, separarLinks, gerarScript } from './extrator.js';
import { abrirBanco } from './banco.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(process.env.LB_CONFIG || path.join(raiz, 'config.json'), 'utf8'));
const { version: versaoApp } = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));

const porta = Number(cfg.porta);
if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) throw new Error('config.json: "porta" inválida');

// ---------- Estado ----------
const estado = {
  versao: 0,
  app: { versao: versaoApp },
  config: { chrome: cfg.chrome, porta, urlViaImob: cfg.urlViaImob, viewportViaImob: cfg.viewportViaImob,
    concorrenciaExtracao: cfg.concorrenciaExtracao, esperaMs: cfg.esperaMs, mapaOcorrencias: cfg.mapaOcorrencias },
  atualizadoEm: new Date().toISOString(),
  extracao: { rodando: false, pausado: false, total: 0, feitos: 0, duplicados: 0, fila: 0, erro: null },
  boletos: [],
  via: { aberto: false },
  lancando: null // id do boleto em lançamento
};
// ---------- Banco local ----------
const dirDados = process.env.LB_DADOS || path.join(raiz, 'dados');
const banco = abrirBanco(dirDados);
// Capturas (foto da página do boleto): dados/capturas/<id>.jpg, apagadas após N dias.
const dirCapturas = path.join(dirDados, 'capturas');
fs.mkdirSync(dirCapturas, { recursive: true });
const arqCaptura = id => path.join(dirCapturas, `${Number(id)}.jpg`);
function limparCapturasAntigas() {
  const limite = Date.now() - (Number(cfg.diasCapturas) || 90) * 86400000;
  try {
    for (const f of fs.readdirSync(dirCapturas)) {
      const arq = path.join(dirCapturas, f);
      if (/^\d+\.jpg$/.test(f) && fs.statSync(arq).mtimeMs < limite) fs.rmSync(arq, { force: true });
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
const boletoDoLote = id => estado.boletos.find(b => b.id === id);
const erro = (msg, code) => Object.assign(new Error(msg), { code });

// Encerramento limpo: grava a lista, salva o login do Via Imob e fecha o navegador.
let encerrando = false;
async function encerrar() {
  if (encerrando) return; encerrando = true;
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

async function abrirVia() {
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

// Lança um boleto da lista. Sucesso → marcado como lançado e movido para o Histórico.
async function lancar(id) {
  if (estado.lancando !== null) throw erro('Já existe um lançamento em andamento', 409);
  const b = boletoDoLote(id);
  if (!b) throw erro('Boleto não está na lista para lançar (já lançado ou excluído)', 409);
  if (b.problemas?.length) throw erro('Boleto com problemas: ' + b.problemas.join('; '), 400);
  // Trava contra lançamento duplo: mesma linha digitável já lançada antes.
  const dup = banco.jaLancado(b.linhaDigitavel, b.id);
  if (dup) throw erro(`Este boleto já foi lançado (registro #${dup.id}). Lançamento bloqueado.`, 409);
  estado.lancando = id;
  estado.passoLancamento = 'Preparando…';
  let page = null;
  // O script de lançamento informa cada etapa via console ("[LB] ...") → painel de conferência.
  const aoLog = msg => { const t = msg.text(); if (t.startsWith('[LB] ')) { estado.passoLancamento = t.slice(5); mudou(false); } };
  try {
    page = await abaAtiva();
    page.on('console', aoLog);
    b.status = 'lancando'; delete b.erroLancamento; salvarBoleto(b);
    await page.evaluate(gerarScript(b));
    b.status = 'lancado';
    b.lancadoEm = new Date().toISOString();
    estado.boletos = estado.boletos.filter(x => x.id !== b.id); // sai da lista → Histórico
  } catch (e) {
    b.status = 'erro'; b.erroLancamento = String(e.message).split('\n')[0];
  } finally {
    page?.off('console', aoLog);
    estado.lancando = null; estado.passoLancamento = null; salvarBoleto(b);
  }
  return b;
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
  extrair(proximo, cfg, (url, novo, captura) => {
    novo.extraidoEm = new Date().toISOString();
    try {
      const { boleto, duplicado } = banco.registrarExtracao(novo);
      if (duplicado) { ex().duplicados++; estado.duplicidades = banco.contarDuplicidades(); }
      else {
        if (captura) { try { fs.writeFileSync(arqCaptura(boleto.id), captura); boleto.temCaptura = true; banco.atualizar(boleto); } catch {} }
        const i = estado.boletos.findIndex(x => x.id === boleto.id);
        if (i >= 0) estado.boletos[i] = boleto; else estado.boletos.push(boleto);
      }
      banco.filaRemover(url); // só sai da fila depois de gravado
    } catch (e) { console.error('Falha ao gravar boleto:', e.message); }
    emAndamento.delete(url);
    ex().feitos++; persistirExtracao(); mudou();
  }, c, ex().fila)
    .catch(e => { if (!c.parado) ex().erro = String(e.message).split('\n')[0]; })
    .finally(() => {
      emAndamento.clear();
      if (ctrl === c) ctrl = null;
      if (c.parado) banco.filaLimpar();
      ex().rodando = false;
      // Sobrou fila sem ter sido parado (ex.: falha do Chrome): fica pausada para retomar.
      ex().pausado = !c.parado && banco.filaContar() > 0;
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
const LIMITE_LINKS_CORPO = 1000;
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
    Object.assign(ex(), { pausado: false, fila: 0, retomada: false });
    banco.kvGravar('extracao', null); mudou(false);
    return { ok: true };
  },
  // Remove da lista os boletos ainda não lançados (os lançados continuam no Histórico).
  'POST /api/limpar': async () => {
    if (estado.extracao.rodando) throw erro('Extração em andamento', 409);
    if (estado.lancando !== null) throw erro('Lançamento em andamento', 409);
    const n = banco.limparPendentes(); estado.boletos = banco.loteAtual(); mudou(); return { ok: true, removidos: n };
  },
  'POST /api/via/abrir': async () => { await abrirVia(); return { ok: true }; },
  'POST /api/lancar': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    const b = await lancar(id);
    if (b.status === 'erro') throw erro(b.erroLancamento || 'Falha no lançamento', 400);
    return { ok: true };
  },
  'POST /api/boletos/excluir': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    if (estado.lancando === id) throw erro('Boleto em lançamento', 409);
    if (!banco.excluir(id)) throw erro('Só é possível excluir boletos ainda não lançados', 409);
    fs.rmSync(arqCaptura(id), { force: true });
    estado.boletos = estado.boletos.filter(x => x.id !== id); mudou(); return { ok: true };
  },
  // Desfaz um lançamento (ex.: não foi gravado no Via Imob): volta para a lista.
  'POST /api/desfazer': async ({ id }) => {
    if (!idValido(id)) throw erro('Boleto inválido', 400);
    const b = banco.porId(id);
    if (!b || b.status !== 'lancado') throw erro('Boleto não está lançado', 409);
    b.status = 'pendente'; delete b.lancadoEm; delete b.gravadoEm;
    estado.boletos.push(b); salvarBoleto(b); return { ok: true };
  },
  'POST /api/duplicidades/remover': async ({ id }) => {
    if (!idValido(id)) throw erro('Registro inválido', 400);
    banco.removerDuplicidade(id); estado.duplicidades = banco.contarDuplicidades(); mudou(false); return { ok: true };
  },
  'POST /api/duplicidades/limpar': async () => {
    banco.limparDuplicidades(); estado.duplicidades = 0; mudou(false); return { ok: true };
  },
  // ---- Condomínios / links ----
  'POST /api/condominios/criar': async ({ nome }) => {
    const id = banco.criarCondominio(String(nome ?? '').slice(0, 200)); mudou(false); return { ok: true, id };
  },
  'POST /api/condominios/vincular': async ({ condominioId, texto }) => {
    const urls = separarLinks(String(texto ?? '')).slice(0, LIMITE_LINKS_CORPO);
    if (!urls.length) throw erro('Nenhum link encontrado', 400);
    if (condominioId !== 'sem' && !idValido(condominioId)) throw erro('Condomínio inválido', 400);
    const n = banco.vincularLinks(condominioId, urls); mudou(false); return { ok: true, total: n };
  },
  'POST /api/links/remover': async ({ id }) => {
    if (!idValido(id)) throw erro('Link inválido', 400);
    banco.removerLink(id); mudou(false); return { ok: true };
  },
  'POST /api/condominios/extrair': async ({ condominioId }) => {
    if (condominioId !== 'sem' && !idValido(condominioId)) throw erro('Condomínio inválido', 400);
    const urls = banco.linksDe(condominioId).map(l => l.url);
    if (!urls.length) throw erro('Este condomínio não tem links', 400);
    const r = iniciarExtracao(urls);
    return { ok: true, total: r.novos, ...r };
  }
};

const consultas = {
  '/api/historico': q => {
    const r = banco.historico(Object.fromEntries(q));
    return { ...r, versao: estado.versao };
  },
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

let servidorPrincipal = false;
servidor.on('error', e => {
  // Já há um servidor rodando nesta porta: só abre a janela dele e sai.
  if (e.code === 'EADDRINUSE') { console.log('App já está aberto; abrindo janela.'); abrirJanela(); setTimeout(() => process.exit(0), 3000); }
  else { console.error(e); process.exit(1); }
});
servidor.listen(porta, '127.0.0.1', () => {
  servidorPrincipal = true;
  if (retomarAoIniciar) setTimeout(processarFila, 1500);
  console.log(`Interface em http://localhost:${porta}`);
  abrirJanela();
});
