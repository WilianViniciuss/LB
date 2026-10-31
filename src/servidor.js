// Interface local (http://localhost:3737). Extração em segundo plano + navegador próprio do Via Imob para lançamento.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extrair, separarLinks, gerarScript } from './extrator.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(raiz, 'config.json'), 'utf8'));
const arqPlano = path.join(raiz, 'plano_lote.json');

const estado = {
  extracao: { rodando: false, total: 0, feitos: 0 },
  boletos: [],
  via: { aberto: false },
  lancando: null // índice em andamento
};
try { estado.boletos = JSON.parse(fs.readFileSync(arqPlano, 'utf8')).boletos || []; } catch {}
const salvar = () => fs.writeFileSync(arqPlano, JSON.stringify({ atualizadoEm: new Date().toISOString(), boletos: estado.boletos }, null, 2));

let viaCtx = null;

async function abrirVia() {
  if (viaCtx) { try { await viaCtx.pages()[0]?.bringToFront(); estado.via.aberto = true; return; } catch { viaCtx = null; } }
  viaCtx = await chromium.launchPersistentContext(path.join(raiz, 'perfil-via'), {
    executablePath: cfg.chrome, headless: false, ignoreHTTPSErrors: true, viewport: cfg.viewportViaImob || null
  });
  viaCtx.on('close', () => { viaCtx = null; estado.via.aberto = false; });
  const p = viaCtx.pages()[0] || await viaCtx.newPage();
  await p.goto(cfg.urlViaImob).catch(() => {});
  estado.via.aberto = true;
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
  const page = await abaAtiva();
  estado.lancando = i; b.status = 'lancando'; delete b.erroLancamento;
  try {
    await page.evaluate(gerarScript(b));
    b.status = 'lancado'; // preenchido; a gravação continua manual no Via Imob
  } catch (e) {
    b.status = 'erro'; b.erroLancamento = e.message.split('\n')[0];
  } finally { estado.lancando = null; salvar(); }
}

const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const corpo = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(raiz, 'public', 'index.html')));
    }
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url === '/api/estado') return json(res, estado);

    if (req.method === 'POST' && req.url === '/api/extrair') {
      if (estado.extracao.rodando) return json(res, { erro: 'Extração já em andamento' }, 409);
      const { texto } = await corpo(req);
      const links = separarLinks(texto || '');
      if (!links.length) return json(res, { erro: 'Nenhum link encontrado' }, 400);
      const base = estado.boletos.length;
      estado.extracao = { rodando: true, total: links.length, feitos: 0 };
      extrair(links, cfg, (i, b) => { estado.boletos.push(b); estado.extracao.feitos++; salvar(); })
        .catch(e => estado.extracao.erro = e.message)
        .finally(() => { estado.extracao.rodando = false; });
      return json(res, { ok: true, total: links.length, base });
    }
    if (req.method === 'POST' && req.url === '/api/limpar') {
      if (estado.extracao.rodando) return json(res, { erro: 'Extração em andamento' }, 409);
      estado.boletos = []; salvar(); return json(res, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/via/abrir') { await abrirVia(); return json(res, { ok: true }); }
    if (req.method === 'POST' && req.url === '/api/lancar') {
      const { indice } = await corpo(req);
      try { await lancar(indice); return json(res, { ok: true }); }
      catch (e) { return json(res, { erro: e.message }, 400); }
    }
    if (req.method === 'POST' && req.url === '/api/status') {
      const { indice, status } = await corpo(req);
      if (estado.boletos[indice]) { estado.boletos[indice].status = status; salvar(); }
      return json(res, { ok: true });
    }
    json(res, { erro: 'não encontrado' }, 404);
  } catch (e) { json(res, { erro: e.message }, 500); }
}).listen(cfg.porta, '127.0.0.1', () => {
  const url = `http://localhost:${cfg.porta}`;
  console.log('Interface em ' + url);
  exec(`start "" "${url}"`);
});
