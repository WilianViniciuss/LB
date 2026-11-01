// Extração em segundo plano (Chrome headless). Executa src/pagina.js em cada link.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Lidos uma única vez (evita I/O por boleto).
const pagina = fs.readFileSync(path.join(raiz, 'src', 'pagina.js'), 'utf8');
const modelo = fs.readFileSync(path.join(raiz, 'src', 'lancamento.modelo.js'), 'utf8');

const MAX_LINKS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const primeiraLinha = e => String(e?.message || e).split('\n')[0].slice(0, 300);

export const separarLinks = texto => {
  const semComentarios = String(texto).split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  const achados = semComentarios.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const validos = achados.filter(u => {
    try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
  });
  return [...new Set(validos)].slice(0, MAX_LINKS);
};

// Compila as regex do config uma vez só.
export const criarMapeador = mapa => {
  const regras = (mapa || []).map(m => ({ re: new RegExp(m.regex, 'i'), nome: m.nome }));
  return item => regras.find(r => r.re.test(item))?.nome ?? null;
};

/**
 * Processa links até a fila acabar.
 * @param {() => string|null} proximo  entrega o próximo link da fila (ou null quando acabou)
 * @param {object} cfg
 * @param {(url:string, boleto:object, captura:Buffer|null) => void} onItem
 * @param {{pausado:boolean, parado:boolean, browser?:any, temMais?:()=>boolean, seriaDuplicado?:(linha:string)=>boolean}} ctrl
 */
export async function extrair(proximo, cfg, onItem, ctrl) {
  const nomeDe = criarMapeador(cfg.mapaOcorrencias);
  const browser = await chromium.launch({ executablePath: cfg.chrome, headless: true });
  ctrl.browser = browser;
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: false, serviceWorkers: 'block' });
  // Sem captura, não baixa imagens/fontes (só o HTML importa). Com captura, carrega para a foto ficar fiel.
  const capturar = cfg.capturarBoleto !== false;
  const bloquear = capturar ? ['media'] : ['image', 'font', 'media'];
  await ctx.route('**/*', r => bloquear.includes(r.request().resourceType()) ? r.abort() : r.continue());
  const foto = async page => {
    if (!capturar || !page) return null;
    try { return await page.screenshot({ type: 'jpeg', quality: 72, fullPage: true, timeout: 10000 }); } catch { return null; }
  };
  const trabalhador = async () => {
    while (!ctrl.parado) {
      // Pausado: espera — a menos que não reste mais nada a fazer (aí encerra normalmente).
      while (ctrl.pausado && !ctrl.parado && (ctrl.temMais?.() ?? true)) await sleep(300);
      if (ctrl.parado) break;
      const url = proximo();
      if (!url) break;
      let page;
      try {
        page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'load', timeout: 45000 });
        await page.waitForSelector('td.coluna-item-boleto', { timeout: 15000 });
        await page.waitForTimeout(cfg.esperaMs);
        const d = await page.evaluate(pagina);

        const ocorrencias = [];
        const add = (item, valor, historico = '') => ocorrencias.push({ nome: nomeDe(item), itemOriginal: item, valor, historico });
        d.fundos.forEach(f => add(f.item, f.valor));
        if (d.chamadaExtra) add('Chamada Extra', d.chamadaExtra.valor, d.chamadaExtra.historico);
        d.multa.forEach(m => add(m.item, m.valor));
        d.mudanca.forEach(m => add(m.item, m.valor));
        d.outros.forEach(o => add(o.item, o.valor));

        const problemas = [];
        if (!d.conferencia.ok) problemas.push('Soma não fecha com recibo/documento/linha digitável');
        if (!d.codIdentificador) problemas.push('Código identificador não encontrado');
        if (!d.linhaDigitavel) problemas.push('Linha digitável não encontrada');
        ocorrencias.filter(o => !o.nome).forEach(o => problemas.push(`Sem mapeamento: "${o.itemOriginal}" (config.json)`));

        if (ctrl.parado) break;
        // Duplicado não precisa de foto (economiza a etapa mais lenta).
        const captura = ctrl.seriaDuplicado?.(d.linhaDigitavel) ? null : await foto(page);
        if (ctrl.parado) break;
        onItem(url, { link: url, itensRecibo: d.itensRecibo, condominio: d.condominio, unidade: d.unidade, vencimento: d.vencimento, codIdentificador: d.codIdentificador,
          linhaDigitavel: d.linhaDigitavel, desconto: d.desconto, valorTotal: d.conferencia.valorDocumento,
          ocorrencias, conferencia: d.conferencia, problemas, status: 'pendente' }, captura);
      } catch (e) {
        if (ctrl.parado) break;
        const msg = primeiraLinha(e);
        onItem(url, { link: url, erroExtracao: msg, problemas: ['Falha na extração: ' + msg], ocorrencias: [], status: 'erro' }, await foto(page));
      } finally { await page?.close().catch(() => {}); }
    }
  };
  try {
    // Trabalhadores sem link para pegar simplesmente terminam.
    const n = Math.min(Math.max(1, cfg.concorrenciaExtracao | 0 || 3), 8);
    await Promise.all(Array.from({ length: n }, trabalhador));
  } finally {
    ctrl.browser = null;
    await browser.close().catch(() => {});
  }
}

export const gerarScript = b => {
  const data = { codIdentificador: b.codIdentificador, linhaDigitavel: b.linhaDigitavel,
    ocorrencias: b.ocorrencias.map(({ nome, valor, historico }) => ({ nome, valor, historico })) };
  // JSON escapado: impede que "</script>" ou separadores de linha quebrem o script injetado.
  const literal = JSON.stringify(data, null, 2).replace(/[<\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return modelo.replace('/*__DADOS__*/', () => literal);
};
