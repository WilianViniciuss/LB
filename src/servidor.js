// Interface local (http://localhost:<porta>). Extração em segundo plano + navegador próprio do Via Imob para lançamento.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extrair, separarLinks, gerarScript } from './extrator.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(process.env.LB_CONFIG || path.join(raiz, 'config.json'), 'utf8'));
const { version: versaoApp } = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
const arqPlano = path.join(raiz, 'plano_lote.json');

const porta = Number(cfg.porta);
if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) throw new Error('config.json: "porta" inválida');

// ---------- Estado ----------
const estado = {
  versao: 0,
  app: { versao: versaoApp },
  config: { chrome: cfg.chrome, porta, urlViaImob: cfg.urlViaImob, viewportViaImob: cfg.viewportViaImob,
    concorrenciaExtracao: cfg.concorrenciaExtracao, esperaMs: cfg.esperaMs, mapaOcorrencias: cfg.mapaOcorrencias },
  atualizadoEm: null,
  extracao: { rodando: false, pausado: false, total: 0, feitos: 0, erro: null },
  boletos: [],
  via: { aberto: false },
  lancando: null // índice em andamento
};
try {
  const salvo = JSON.parse(fs.readFileSync(arqPlano, 'utf8'));
  estado.boletos = Array.isArray(salvo.boletos) ? salvo.boletos : [];
  estado.atualizadoEm = salvo.atualizadoEm || null;
} catch {}

// Gravação com debounce e escrita atômica (tmp + rename): não corrompe o arquivo se o processo cair.
let timerSalvar = null;
const salvarAgora = () => {
  clearTimeout(timerSalvar); timerSalvar = null;
  const tmp = arqPlano + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ atualizadoEm: estado.atualizadoEm, boletos: estado.boletos }, null, 2));
  fs.renameSync(tmp, arqPlano);
};
const mudou = (persistir = true) => {
  estado.versao++;
  if (!persistir) return;
  estado.atualizadoEm = new Date().toISOString();
  if (!timerSalvar) timerSalvar = setTimeout(() => { try { salvarAgora(); } catch (e) { console.error('Falha ao salvar:', e.message); } }, 400);
};
// Encerramento limpo: grava a lista, salva o login do Via Imob e fecha o navegador.
let encerrando = false;
async function encerrar() {
  if (encerrando) return; encerrando = true;
  try { if (timerSalvar) salvarAgora(); await salvarSessao(); await viaCtx?.close().catch(() => {}); } finally { process.exit(0); }
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

async function lancar(i) {
  const b = estado.boletos[i];
  if (!b) throw new Error('Boleto inexistente');
  if (b.problemas?.length) throw new Error('Boleto com problemas: ' + b.problemas.join('; '));
  if (estado.lancando !== null) throw new Error('Já existe um lançamento em andamento');
  estado.lancando = i;
  try {
    const page = await abaAtiva();
    b.status = 'lancando'; delete b.erroLancamento; mudou();
    await page.evaluate(gerarScript(b));
    b.status = 'lancado'; // preenchido; a gravação continua manual no Via Imob
  } catch (e) {
    b.status = 'erro'; b.erroLancamento = String(e.message).split('\n')[0];
  } finally { estado.lancando = null; mudou(); }
}

// ---------- Extração ----------
let ctrl = null;
function iniciarExtracao(texto) {
  if (estado.extracao.rodando) throw Object.assign(new Error('Extração já em andamento'), { code: 409 });
  const links = separarLinks(texto);
  if (!links.length) throw Object.assign(new Error('Nenhum link encontrado'), { code: 400 });
  ctrl = { pausado: false, parado: false };
  const c = ctrl;
  estado.extracao = { rodando: true, pausado: false, total: links.length, feitos: 0, erro: null };
  mudou(false);
  extrair(links, cfg, (_, b) => { b.extraidoEm = new Date().toISOString(); estado.boletos.push(b); estado.extracao.feitos++; mudou(); }, c)
    .catch(e => { if (!c.parado) estado.extracao.erro = String(e.message).split('\n')[0]; })
    .finally(() => { estado.extracao.rodando = false; estado.extracao.pausado = false; if (ctrl === c) ctrl = null; mudou(false); });
  return links.length;
}

// ---------- HTTP ----------
const TOKEN = crypto.randomBytes(24).toString('hex');
const hostsOk = new Set([`localhost:${porta}`, `127.0.0.1:${porta}`]);
const origensOk = new Set([...hostsOk].map(h => 'http://' + h));
const STATUS_MANUAIS = new Set(['pendente', 'lancado', 'gravado']);
const LIMITE_CORPO = 2 * 1024 * 1024;

const SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
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
const indiceValido = i => Number.isInteger(i) && i >= 0 && i < estado.boletos.length;
const tokenOk = req => {
  const t = String(req.headers['x-token'] || '');
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
};

const rotas = {
  'POST /api/extrair': async b => ({ ok: true, total: iniciarExtracao(String(b.texto ?? '')) }),
  'POST /api/extracao/pausar': async () => {
    if (!ctrl) throw Object.assign(new Error('Nenhuma extração em andamento'), { code: 409 });
    ctrl.pausado = !ctrl.pausado; estado.extracao.pausado = ctrl.pausado; mudou(false);
    return { ok: true, pausado: ctrl.pausado };
  },
  'POST /api/extracao/parar': async () => {
    if (!ctrl) throw Object.assign(new Error('Nenhuma extração em andamento'), { code: 409 });
    ctrl.parado = true; ctrl.pausado = false;
    await ctrl.browser?.close().catch(() => {});
    return { ok: true };
  },
  'POST /api/limpar': async () => {
    if (estado.extracao.rodando) throw Object.assign(new Error('Extração em andamento'), { code: 409 });
    if (estado.lancando !== null) throw Object.assign(new Error('Lançamento em andamento'), { code: 409 });
    estado.boletos = []; mudou(); return { ok: true };
  },
  'POST /api/via/abrir': async () => { await abrirVia(); return { ok: true }; },
  'POST /api/lancar': async ({ indice }) => {
    if (!indiceValido(indice)) throw Object.assign(new Error('Índice inválido'), { code: 400 });
    await lancar(indice);
    const b = estado.boletos[indice];
    if (b.status === 'erro') throw Object.assign(new Error(b.erroLancamento || 'Falha no lançamento'), { code: 400 });
    return { ok: true };
  },
  'POST /api/status': async ({ indice, status }) => {
    if (!indiceValido(indice) || !STATUS_MANUAIS.has(status)) throw Object.assign(new Error('Parâmetros inválidos'), { code: 400 });
    if (estado.lancando === indice) throw Object.assign(new Error('Boleto em lançamento'), { code: 409 });
    estado.boletos[indice].status = status; mudou(); return { ok: true };
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
      if (url.pathname === '/api/estado') {
        if (!tokenOk(req)) return json(res, { erro: 'Não autorizado' }, 403);
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
  console.log(`Interface em http://localhost:${porta}`);
  abrirJanela();
});
