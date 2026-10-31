// Executado DENTRO da página do boleto (page.evaluate). Retorna o objeto extraído.
(() => {
  const num = v => parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0;
  const brl = n => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const c = n => Math.round(n * 100);
  const limpa = s => s.replace(/\(\d+\)/g, ' ').replace(/\s+/g, ' ').trim();
  const txt = document.body.innerText;

  const td = [...document.querySelectorAll('td.nowrap')]
    .find(t => t.querySelector('b') && t.innerText.split('\n').filter(Boolean).length >= 3);
  const linhas = td ? td.innerText.split('\n').map(s => s.trim()).filter(Boolean) : [];
  const codIdentificador = (txt.match(/C[óo]d\.?\s*Identificador:?\s*([\w\-\/.]+)/i) || [])[1] || null;

  const itens = [...document.querySelectorAll('td.coluna-item-boleto')].map(t => ({
    item: t.querySelector('.descricao-item-boleto')?.innerText.trim(),
    valor: t.querySelector('.valor-item-boleto')?.innerText.trim()
  })).filter(i => i.item);

  const somaGrupo = lista => {
    const m = {};
    lista.forEach(i => { const k = limpa(i.item); m[k] = (m[k] || 0) + num(i.valor); });
    return Object.entries(m).map(([item, v]) => ({ item, valor: brl(v), n: v }));
  };
  const somaN = l => l.reduce((s, i) => s + i.n, 0);

  const isCham  = i => /^cham/i.test(i.item);
  const isFundo = i => /^fundo/i.test(i.item);
  const isMulta = i => /multa/i.test(i.item);
  const isMud   = i => /mudan/i.test(i.item);

  const chamadas = itens.filter(isCham);
  let chamadaExtra = null;
  if (chamadas.length) {
    const partes = [...new Set(chamadas.map(i => {
      let t = limpa(i.item).replace(/^chamada\s*(extra)?\s*/i, '').trim();
      const p = t.match(/(\d+\s*\/\s*\d+)\s*$/);
      if (p) t = t.slice(0, p.index).trim() + ' P. ' + p[1].replace(/\s/g, '');
      return t;
    }))];
    const v = chamadas.reduce((s, i) => s + num(i.valor), 0);
    chamadaExtra = { historico: 'Cham ' + partes.join(' e '), valor: brl(v), n: v };
  }

  const fundos  = somaGrupo(itens.filter(isFundo));
  const multa   = somaGrupo(itens.filter(isMulta));
  const mudanca = somaGrupo(itens.filter(isMud));
  const outros  = somaGrupo(itens.filter(i => !isCham(i) && !isFundo(i) && !isMulta(i) && !isMud(i)));

  const a = txt.indexOf('Instruções'), b = txt.indexOf('Pagador:', a);
  const instr = a < 0 ? [] : txt.slice(a + 10, b)
    .replace(/\(-\)\s*Desconto|\(-\)\s*Outras Deduções\/Abatimento|\(\+\)\s*Mora\/Multa\/Juros|\(\+\)\s*Outros Acréscimos|\(=\)\s*Valor Cobrado/gi, '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  const desconto = instr.filter(l => /desconto|abatimento/i.test(l));

  // Vencimento — heurístico; null se não encontrado.
  const vencimento = (txt.match(/Vencimento[\s\S]{0,60}?(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;

  const ldM = document.documentElement.innerHTML
    .match(/\d{5}\.?\d{5}\s*\d{5}\.?\d{6}\s*\d{5}\.?\d{6}\s*\d\s*\d{14}/);
  const linhaDigitavel = ldM ? ldM[0].replace(/\s+/g, ' ') : null;

  const somaCalc = (chamadaExtra ? chamadaExtra.n : 0) + somaN(fundos) + somaN(multa) + somaN(mudanca) + somaN(outros);
  const somaItens      = itens.reduce((s, i) => s + num(i.valor), 0);
  const totalRecibo    = num((txt.match(/Total:\s*([\d.,]+)/) || [])[1]);
  const valorDocumento = num((txt.match(/Valor do Documento[\s\S]{0,80}?R\$\s*([\d.,]+)/) || [])[1]);
  const valorLinha     = linhaDigitavel ? parseInt(linhaDigitavel.split(' ').pop().slice(4), 10) / 100 : 0;
  const ok = [somaItens, totalRecibo, valorDocumento, valorLinha].every(v => c(v) === c(somaCalc));

  return { condominio: linhas[0], unidade: linhas.at(-1), vencimento, codIdentificador, chamadaExtra, fundos, multa, mudanca, outros,
           desconto: desconto.length ? desconto : null, linhaDigitavel,
           conferencia: { somaCalc: brl(somaCalc), totalRecibo: brl(totalRecibo), valorDocumento: brl(valorDocumento), valorLinha: brl(valorLinha), ok } };
})()
