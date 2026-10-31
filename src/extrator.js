// Extração em segundo plano (Chrome headless). Executa src/pagina.js em cada link.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagina = fs.readFileSync(path.join(raiz, 'src', 'pagina.js'), 'utf8');

export const separarLinks = texto =>
  [...new Set(texto.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').match(/https?:\/\/[^\s"'<>]+/g) || [])];

export async function extrair(links, cfg, onItem) {
  const nomeDe = item => {
    for (const m of cfg.mapaOcorrencias) if (new RegExp(m.regex, 'i').test(item)) return m.nome;
    return null;
  };
  const browser = await chromium.launch({ executablePath: cfg.chrome, headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const fila = [...links.entries()];

  const trabalhador = async () => {
    while (fila.length) {
      const [i, url] = fila.shift();
      const page = await ctx.newPage();
      try {
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

        onItem(i, { link: url, condominio: d.condominio, unidade: d.unidade, codIdentificador: d.codIdentificador,
          linhaDigitavel: d.linhaDigitavel, desconto: d.desconto, valorTotal: d.conferencia.valorDocumento,
          ocorrencias, conferencia: d.conferencia, problemas, status: 'pendente' });
      } catch (e) {
        onItem(i, { link: url, erroExtracao: e.message.split('\n')[0], problemas: ['Falha na extração: ' + e.message.split('\n')[0]], ocorrencias: [], status: 'erro' });
      } finally { await page.close(); }
    }
  };
  try { await Promise.all(Array.from({ length: cfg.concorrenciaExtracao || 3 }, trabalhador)); }
  finally { await browser.close(); }
}

export const gerarScript = b => {
  const modelo = fs.readFileSync(path.join(raiz, 'src', 'lancamento.modelo.js'), 'utf8');
  const data = { codIdentificador: b.codIdentificador, linhaDigitavel: b.linhaDigitavel,
    ocorrencias: b.ocorrencias.map(({ nome, valor, historico }) => ({ nome, valor, historico })) };
  return modelo.replace('/*__DADOS__*/', () => JSON.stringify(data, null, 2));
};
