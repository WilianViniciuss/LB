'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const TOKEN = document.querySelector('meta[name="token"]').content;
  const ROTULO = { pendente: 'Pronto', lancando: 'Lançando…', lancado: 'Lançado', erro: 'Erro', manual: 'Manual' };
  const automaticos = () => E.boletos.filter(b => b.status !== 'manual');
  const manuais = () => E.boletos.filter(b => b.status === 'manual');
  const MAX_ARQ = 2 * 1024 * 1024;

  let E = { versao: -1, boletos: [], extracao: {}, via: {}, lancando: null, app: {}, config: {}, rev: {} };
  // Filtros: Dashboard (local) e Histórico (consultado no banco; lembrado entre aberturas).
  const HIST_PADRAO = { busca: '', cond: '', dataTipo: 'lancadoEm', de: '', ate: '', min: '', max: '', ordem: 'idx', dir: -1 };
  const F = { dash: { busca: '', status: 'todos', ordem: null, dir: 1 }, hist: { ...HIST_PADRAO } };
  try { Object.assign(F.hist, JSON.parse(localStorage.getItem('filtroHist') || '{}'), { busca: '' }); } catch {}
  if (!/^(\d+|sem)?$/.test(F.hist.cond || '')) F.hist.cond = '';
  const lembrar = () => { try { const { busca, ...resto } = F.hist; localStorage.setItem('filtroHist', JSON.stringify(resto)); } catch {} };
  const abertos = new Set(); // linhas expandidas (por id do boleto)
  let H = { total: 0, somaCentavos: 0, itens: [] }, limiteHist = 200, histRev = -1; // histórico (vem do banco)
  const selHist = new Set(); // ids selecionados no Histórico
  let CD = { condominios: [], linksSemCondominio: 0 }; // condomínios (vem do banco)
  const condAbertos = new Map(); // condomínio expandido → links
  let buscaCond = '';

  // ---------- Utilidades ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = id => `<svg><use href="#${id}"/></svg>`;
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  const temProblema = b => !!b.problemas?.length;
  const statusDe = b => temProblema(b) ? 'erro' : b.status;
  const dataHora = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  };
  const contarLinks = t => new Set((t.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').match(/https?:\/\/[^\s"'<>]+/g) || [])).size;

  function toast(msg, tipo = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + tipo;
    el.textContent = msg;
    $('toasts').append(el);
    setTimeout(() => el.remove(), tipo === 'erro' ? 7000 : 4000);
  }

  async function api(url, corpo) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify(corpo || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.erro || `Erro ${r.status}`, 'erro'); return null; }
      agendar(0);
      return j;
    } catch { toast('Sem conexão com o servidor', 'erro'); return null; }
  }

  // ---------- Tema ----------
  const raizHtml = document.documentElement;
  const aplicarTema = t => {
    raizHtml.dataset.theme = t;
    $('bTema').innerHTML = ico(t === 'dark' ? 'i-moon' : 'i-sun');
  };
  let temaSalvo = null;
  try { temaSalvo = localStorage.getItem('tema'); } catch {}
  aplicarTema(temaSalvo || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('bTema').onclick = () => {
    const t = raizHtml.dataset.theme === 'dark' ? 'light' : 'dark';
    aplicarTema(t);
    try { localStorage.setItem('tema', t); } catch {}
  };

  // ---------- Navegação ----------
  const TITULOS = {
    dashboard: ['Dashboard', 'Gerencie a extração de dados e o lançamento dos boletos de forma simples e eficiente.'],
    historico: ['Histórico', 'Boletos já lançados no Via Imob.'],
    condominios: ['Condomínios', 'Links vinculados a cada condomínio, prontos para reutilizar.'],
    manual: ['Lançamento manual', 'Boletos com multa ou taxa de mudança, para lançar à mão.'],
    duplicidades: ['Duplicidades', 'Boletos ignorados na extração por já existirem no banco.'],
    configuracoes: ['Configurações', 'Parâmetros atuais do sistema.'],
    ajuda: ['Ajuda', 'Passo a passo para usar o sistema.']
  };
  function rota() {
    const v = TITULOS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
    document.querySelectorAll('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
    document.querySelectorAll('nav a').forEach(a => {
      a.classList.toggle('ativo', a.dataset.view === v);
      a.toggleAttribute('aria-current', a.dataset.view === v);
    });
    $('titulo').textContent = TITULOS[v][0];
    $('subtitulo').textContent = TITULOS[v][1];
    if (v === 'historico') { sincronizarCampos(); recarregarHist(); }
    if (v === 'condominios') carregarCondominios();
    if (v === 'duplicidades') carregarDup();
  }
  addEventListener('hashchange', rota);

  // ---------- Links / arquivo ----------
  let tLinks;
  const atualizarContador = () => {
    const n = contarLinks($('links').value);
    $('nLinks').textContent = n === 1 ? '1 link adicionado' : `${n} links adicionados`;
  };
  $('links').addEventListener('input', () => { clearTimeout(tLinks); tLinks = setTimeout(atualizarContador, 150); });
  $('bLimparLinks').onclick = () => {
    $('links').value = ''; $('arq').value = ''; $('arqNome').textContent = 'Arquivos .txt suportados';
    atualizarContador();
  };

  async function carregarArquivo(f) {
    if (!f) return;
    if (!/\.txt$/i.test(f.name) && f.type !== 'text/plain') return toast('Envie um arquivo .txt', 'erro');
    if (f.size > MAX_ARQ) return toast('Arquivo muito grande (máx. 2 MB)', 'erro');
    const texto = await f.text();
    const atual = $('links').value.trim();
    $('links').value = atual ? atual + '\n' + texto : texto;
    $('arqNome').textContent = f.name;
    atualizarContador();
    toast(`${plural(contarLinks(texto), 'link carregado', 'links carregados')} de ${f.name}`, 'ok');
  }
  const drop = $('drop');
  $('arq').onchange = e => carregarArquivo(e.target.files[0]);
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('arq').click(); } });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('sobre'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('sobre'); }));
  drop.addEventListener('drop', e => carregarArquivo(e.dataTransfer.files[0]));

  // ---------- Ações ----------
  $('bExtrair').onclick = async () => {
    const temFila = (E.extracao?.fila || 0) > 0;
    if (!contarLinks($('links').value) && !temFila) return toast('Adicione ao menos um link', 'erro');
    const r = await api('/api/extrair', { texto: $('links').value });
    if (!r) return;
    if (r.retomado) toast(`Continuando de onde parou: ${plural(r.fila, 'link restante', 'links restantes')}`, 'ok');
    else toast(`${plural(r.novos, 'link adicionado', 'links adicionados')} à fila${temFila ? ' (continuando a extração anterior)' : ''}`, 'ok');
  };
  $('bPausar').onclick = () => api('/api/extracao/pausar');
  $('bParar').onclick = async () => {
    if (!confirm(`Parar de vez a extração?\nOs ${plural(E.extracao?.fila || 0, 'link restante será descartado', 'links restantes serão descartados')}. Para continuar depois, use Pausar.`)) return;
    if (await api('/api/extracao/parar')) toast('Extração parada');
  };
  $('bVia').onclick = async () => {
    $('bVia').disabled = true;
    try { await api('/api/via/abrir'); } finally { $('bVia').disabled = false; }
  };
  $('bProx').onclick = () => {
    const b = E.boletos.find(b => b.status === 'pendente' && !temProblema(b));
    if (!b) return toast('Nenhum boleto pendente', 'erro');
    lancar(b.id);
  };
  $('bLimparLista').onclick = async () => {
    if (!confirm('Remover da lista os boletos ainda NÃO lançados?\nOs já lançados continuam no Histórico. Os links continuam salvos em Condomínios.')) return;
    const r = await api('/api/limpar');
    if (r) toast(`${plural(r.removidos, 'boleto removido', 'boletos removidos')} da lista`, 'ok');
  };
  // ---------- Busca / filtros ----------
  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const dashAdiado = debounce(renderDashboard);
  // O valor é gravado no ato do evento; só a renderização/consulta é adiada (evita perder a escolha).
  const ligar = (id, tabela, chave, ev = 'input') => $(id).addEventListener(ev, e => {
    F[tabela][chave] = e.target.value;
    if (tabela === 'hist') { lembrar(); limiteHist = 200; histAdiado(); } else dashAdiado();
  });
  ligar('dBusca', 'dash', 'busca'); ligar('dStatus', 'dash', 'status', 'change');
  ligar('hBusca', 'hist', 'busca'); ligar('hCond', 'hist', 'cond', 'change'); ligar('hDataTipo', 'hist', 'dataTipo', 'change');
  ligar('hDe', 'hist', 'de', 'change'); ligar('hAte', 'hist', 'ate', 'change'); ligar('hMin', 'hist', 'min'); ligar('hMax', 'hist', 'max');
  const sincronizarCampos = () => {
    const h = F.hist;
    $('hBusca').value = h.busca; $('hDataTipo').value = h.dataTipo; $('hDe').value = h.de; $('hAte').value = h.ate;
    $('hMin').value = h.min; $('hMax').value = h.max;
  };
  $('hLimpar').onclick = () => { Object.assign(F.hist, HIST_PADRAO); $('hCond').value = ''; lembrar(); sincronizarCampos(); recarregarHist(); };
  $('hMais').onclick = () => { limiteHist += 200; recarregarHist(); };
  const ordenarPor = (tabela, thead) => $(thead).addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]'); if (!th) return;
    const f = F[tabela];
    if (f.ordem === th.dataset.sort) f.dir = -f.dir; else { f.ordem = th.dataset.sort; f.dir = 1; }
    if (tabela === 'hist') { lembrar(); recarregarHist(); } else renderDashboard();
  });
  ordenarPor('dash', 'thDash'); ordenarPor('hist', 'thHist');

  $('bCsv').onclick = async () => {
    const r = await consultar('/api/historico', { ...F.hist, limite: 100000 });
    if (!r) return;
    if (!r.itens.length) return toast('Nada para exportar', 'erro');
    const cel = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const cab = ['Registro', 'Código', 'Condomínio', 'Unidade', 'Vencimento', 'Valor', 'Extraído em', 'Lançado em', 'Ocorrências lançadas', 'Linha digitável', 'Link'];
    const corpo = r.itens.map(b => [b.id, b.codIdentificador, b.condominio, b.unidade, b.vencimento, b.conferencia?.valorDocumento,
      dataHora(b.extraidoEm), dataHora(b.lancadoEm),
      (b.ocorrencias || []).map(o => `${o.nome || o.itemOriginal}: ${o.valor}${o.historico ? ' (' + o.historico + ')' : ''}`).join(' | '),
      b.linhaDigitavel, b.link].map(cel).join(';'));
    const blob = new Blob(['\ufeff' + [cab.map(cel).join(';'), ...corpo].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `boletos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const acharBoleto = id => E.boletos.find(b => b.id === id) || H.itens.find(b => b.id === id);
  async function lancar(id, semConfirmar = false) {
    const b = acharBoleto(id);
    if (!b) return;
    if (!semConfirmar && !confirm(`Lançar ${b.codIdentificador} (${b.unidade || ''})?\nConfirme que a tela Manutenção encargo está na aba ativa.`)) return;
    const r = await api('/api/lancar', { id });
    if (!r) return;
    if (r.aguardando) {
      for (const p of r.pulados || []) toast(`Boleto ${p.cod}: ${p.erro}`, 'erro');
      toast(`Boleto ${r.aguardando.cod} preenchido. Confira o Total e clique em Gravar no painel.`, 'ok');
      $('conf').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    for (const p of r.pulados || []) toast(`Boleto ${p.cod}: ${p.erro}`, 'erro');
    if (r.lancado) toast(`Boleto ${r.lancado.cod} lançado e movido para o Histórico.${r.pulados?.length ? ` (${plural(r.pulados.length, 'boleto pulado', 'boletos pulados')} por aviso do Via Imob)` : ''} Confira e grave no Via Imob.`, 'ok');
    else if (r.parou) toast('Lançamento parado: confira a tela do Via Imob antes de continuar.', 'erro');
    else if (r.pulados?.length) toast('Nenhum outro boleto pronto para lançar.', 'erro');
  }

  // Delegação de eventos nas tabelas (sem handlers inline → compatível com CSP).
  const aoClicarTabela = async e => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) { // clique na linha (Dashboard): seleciona para conferência
      const tr = e.target.closest('tr.linha[data-id]');
      if (tr && e.currentTarget === $('tb')) { selecionado = Number(tr.dataset.id); renderDashboard(); renderConferencia(); $('conf').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      return;
    }
    const id = Number(btn.dataset.id);
    if (!acharBoleto(id)) return;
    switch (btn.dataset.acao) {
      case 'lancar': return lancar(id);
      case 'excluir':
        if (confirm('Excluir este boleto da lista? (ainda não foi lançado)')) api('/api/boletos/excluir', { id });
        return;
      case 'desfazer':
        if (confirm('Desfazer o lançamento?\nUse só se o boleto NÃO foi gravado no Via Imob. Ele volta para a lista de lançamento.')) {
          const r = await api('/api/desfazer', { id });
          if (r) { toast('Lançamento desfeito: boleto voltou para a lista', 'ok'); recarregarHist(); }
        }
        return;
      case 'dados': return abrirDados(acharBoleto(id));
      case 'fotoErro': return abrirFotoErro(acharBoleto(id));
      case 'det':
        abertos.has(id) ? abertos.delete(id) : abertos.add(id);
        renderDashboard(); return renderHistorico();
    }
  };
  $('tb').addEventListener('click', aoClicarTabela);
  $('tbHist').addEventListener('click', aoClicarTabela);

  // ---------- Render ----------
  const podeLancar = () => E.lancando === null && E.via.aberto;
  function botoesAcao(b) {
    const i = b.id;
    if (b.status === 'lancado') return `<button type="button" class="mini" data-acao="desfazer" data-id="${i}">Desfazer</button>`;
    if (b.status === 'lancando') return '';
    const excluir = `<button type="button" class="mini" data-acao="excluir" data-id="${i}" title="Excluir da lista">Excluir</button>`;
    if (temProblema(b)) return excluir;
    const dis = podeLancar() ? '' : ' disabled';
    return `<button type="button" class="mini" data-acao="lancar" data-id="${i}"${dis}>Lançar</button>${excluir}`;
  }
  const tagStatus = b => {
    const st = statusDe(b);
    const rot = st === 'lancado' && b.lancadoManual ? 'Lançado (manual)' : ROTULO[st] || st;
    return `<span class="tag ${esc(st)}">${esc(rot)}</span>` +
      (b.erroLancamento ? `<div class="prob">${esc(b.erroLancamento)}</div>` : '');
  };
  const ocorrenciasHtml = b => (b.ocorrencias || [])
    .map(o => `${esc(o.nome || o.itemOriginal)}: <span class="num">R$ ${esc(o.valor)}</span>${o.historico ? ' — ' + esc(o.historico) : ''}`).join('<br>');
  function detalhe(b, colunas) {
    const itens = [
      b.codIdentificador && `<li>Cód. identificador: <b>${esc(b.codIdentificador)}</b></li>`,
      b.linhaDigitavel && `<li>Linha digitável: <code>${esc(b.linhaDigitavel)}</code></li>`,
      b.ocorrencias?.length && `<li>Ocorrências:<br>${ocorrenciasHtml(b)}</li>`,
      b.desconto && `<li>Desconto: ${esc(b.desconto.join(' | '))}</li>`,
      b.conferencia && `<li>Conferência: soma ${esc(b.conferencia.somaCalc)} · recibo ${esc(b.conferencia.totalRecibo)} · documento ${esc(b.conferencia.valorDocumento)} · linha ${esc(b.conferencia.valorLinha)}</li>`,
      ...(b.problemas || []).map(p => `<li class="prob">${esc(p)}</li>`),
      `<li>Extraído: ${esc(dataHora(b.extraidoEm))} · Lançado: ${esc(dataHora(b.lancadoEm))}</li>`,
      `<li>Link: <span class="sub2">${esc(b.link)}</span> <button type="button" class="mini" data-acao="dados" data-id="${b.id}">Ver dados extraídos</button>${b.capturaErro ? ` <button type="button" class="mini" data-acao="fotoErro" data-id="${b.id}">Ver tela do erro</button>` : ''}</li>`
    ].filter(Boolean).join('');
    return `<tr class="det"><td colspan="${colunas}"><ul>${itens}</ul></td></tr>`;
  }

  const linhaVazia = (colunas, titulo, texto) =>
    `<tr class="vazio"><td colspan="${colunas}">${ico('i-empty')}<strong>${titulo}</strong>${texto}</td></tr>`;

  // ---------- Filtragem (Dashboard) ----------
  const numBR = v => { const n = parseFloat(String(v ?? '').trim().replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : n; };
  const valorDe = b => numBR(b.conferencia?.valorDocumento ?? b.valorTotal);
  const diaBR = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const norm = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const textoBusca = b => norm([b.condominio, b.unidade, b.codIdentificador, b.linhaDigitavel, b.vencimento, b.conferencia?.valorDocumento, b.link,
    ...(b.ocorrencias || []).flatMap(o => [o.nome, o.itemOriginal, o.historico])].join(' '));
  const ORDEM = {
    cod: b => norm(b.codIdentificador), cond: b => norm(b.condominio) + ' ' + norm(b.unidade), unid: b => norm(b.unidade),
    venc: b => diaBR(b.vencimento), valor: b => valorDe(b) ?? -1, status: b => statusDe(b)
  };
  function filtrar(lista, f) {
    const termos = norm(f.busca).split(/\s+/).filter(Boolean);
    const linhas = lista.filter(b => {
      if (f.status === 'problema' ? !temProblema(b) : f.status !== 'todos' && (temProblema(b) || b.status !== f.status)) return false;
      return !termos.length || termos.every(x => textoBusca(b).includes(x));
    });
    const k = ORDEM[f.ordem];
    if (k) linhas.sort((a, b) => { const x = k(a), y = k(b); return (x < y ? -1 : x > y ? 1 : a.id - b.id) * f.dir; });
    return linhas;
  }
  const marcarOrdem = (thead, f) => $(thead).querySelectorAll('th[data-sort]').forEach(th =>
    th.setAttribute('aria-sort', th.dataset.sort === f.ordem ? (f.dir > 0 ? 'ascending' : 'descending') : 'none'));
  const filtroAtivo = f => f.busca || (f.status && f.status !== 'todos') || f.cond || f.de || f.ate || f.min || f.max;
  // Só troca o HTML quando muda (evita redesenhar a tabela a cada consulta e perder o hover).
  const definirHTML = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };

  function renderDashboard() {
    const conferido = boletoConferencia()?.b;
    const lista = automaticos();
    const linhas = filtrar(lista, F.dash);
    marcarOrdem('thDash', F.dash);
    $('dResultado').innerHTML = filtroAtivo(F.dash) ? `<b>${linhas.length}</b> de ${lista.length}` : '';
    definirHTML($('tb'), linhas.map(b => {
      const aberto = abertos.has(b.id);
      return `<tr class="linha${conferido?.id === b.id ? ' sel' : ''}" data-id="${b.id}">
        <td><button type="button" class="expandir" data-acao="det" data-id="${b.id}" aria-expanded="${aberto}" aria-label="Detalhes">${ico('i-chev')}</button>${esc(b.condominio || '—')}</td>
        <td>${esc(b.unidade || '—')}</td>
        <td class="num">${esc(b.codIdentificador || '—')}</td>
        <td class="num">${esc(b.vencimento || '—')}</td>
        <td class="num">${b.conferencia ? 'R$ ' + esc(b.conferencia.valorDocumento) : '—'}</td>
        <td>${tagStatus(b)}</td>
        <td class="acoes">${botoesAcao(b)}</td></tr>${aberto ? detalhe(b, 7) : ''}`;
    }).join('') || (lista.length ? linhaVazia(7, 'Nenhum boleto corresponde à busca.', '')
      : linhaVazia(7, 'Nenhum dado extraído ainda.', 'Adicione os links ou o arquivo e clique em "Iniciar Extração".')));
  }

  // ---------- Histórico (consulta ao banco) ----------
  async function consultar(url, params) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]));
    try {
      const r = await fetch(url + '?' + q, { headers: { 'X-Token': TOKEN }, cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) { toast(j.erro || `Erro ${r.status}`, 'erro'); return null; }
      return j;
    } catch { return null; }
  }
  const visivel = v => !document.querySelector(`.view[data-view="${v}"]`).hidden;
  let seqHist = 0;
  async function recarregarHist() {
    const meu = ++seqHist;
    const r = await consultar('/api/historico', { ...F.hist, limite: limiteHist });
    if (!r || meu !== seqHist) return; // descarta respostas antigas
    H = r; histRev = E.rev.hist; renderHistorico();
  }
  const histAdiado = debounce(recarregarHist, 200);

  function opcoesCondominio() {
    const sel = $('hCond');
    const chave = CD.condominios.map(c => c.id + c.nome).join('|') + CD.linksSemCondominio;
    if (sel.dataset.k !== chave) {
      sel.dataset.k = chave;
      sel.innerHTML = '<option value="">Todos</option>' + CD.condominios.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('') +
        '<option value="sem">Sem condomínio</option>';
    }
    sel.value = F.hist.cond || '';
    if (sel.value !== (F.hist.cond || '')) sel.value = '';
  }

  function renderHistorico() {
    opcoesCondominio();
    marcarOrdem('thHist', F.hist);
    const soma = (H.somaCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    $('hResultado').innerHTML = `<b>${H.total}</b> ${H.total === 1 ? 'boleto' : 'boletos'} · soma <b>${soma}</b>` +
      (H.itens.length < H.total ? ` · mostrando ${H.itens.length}` : '');
    $('hMais').hidden = H.itens.length >= H.total;
    definirHTML($('tbHist'), H.itens.map(b => {
      const aberto = abertos.has(b.id);
      return `<tr class="linha${selHist.has(b.id) ? ' sel' : ''}">
        <td class="sel-col"><input type="checkbox" data-sel="${b.id}"${selHist.has(b.id) ? ' checked' : ''} aria-label="Selecionar boleto ${b.id}"></td>
        <td><button type="button" class="expandir" data-acao="det" data-id="${b.id}" aria-expanded="${aberto}" aria-label="Detalhes">${ico('i-chev')}</button>${b.id}</td>
        <td class="num">${esc(b.codIdentificador || '—')}</td>
        <td>${esc(b.condominio || '—')}<div class="sub2">${esc(b.unidade || '')}</div></td>
        <td class="sub2">${ocorrenciasHtml(b)}${b.desconto ? '<br><b>Desconto:</b> ' + esc(b.desconto.join(' | ')) : ''}</td>
        <td class="num">${esc(b.vencimento || '—')}</td>
        <td class="num">${b.conferencia ? 'R$ ' + esc(b.conferencia.valorDocumento) : '—'}</td>
        <td class="num sub2">${b.lancadoEm ? esc(dataHora(b.lancadoEm)) : '—'}</td>
        <td>${tagStatus(b)}${temProblema(b) ? `<div class="prob">${b.problemas.map(esc).join('<br>')}</div>` : ''}</td>
        <td class="acoes">${botoesAcao(b)}</td></tr>${aberto ? detalhe(b, 10) : ''}`;
    }).join('') || linhaVazia(10, 'Nenhum boleto encontrado.', filtroAtivo(F.hist) ? 'Ajuste ou limpe os filtros.' : ''));
    atualizarSelecao();
  }

  // Seleção no Histórico (só ids que ainda aparecem na lista).
  function atualizarSelecao() {
    const visiveis = new Set(H.itens.map(b => b.id));
    for (const id of selHist) if (!visiveis.has(id)) selHist.delete(id);
    const n = selHist.size;
    $('bExcluirSel').disabled = !n;
    $('bExcluirSel').querySelector('span').textContent = n ? `Excluir selecionados (${n})` : 'Excluir selecionados';
    $('bLimparHist').disabled = !H.total && !filtroAtivo(F.hist);
    const todos = $('selTodos');
    todos.checked = n > 0 && n === H.itens.length;
    todos.indeterminate = n > 0 && n < H.itens.length;
  }
  $('tbHist').addEventListener('change', e => {
    const cb = e.target.closest('input[data-sel]'); if (!cb) return;
    const id = Number(cb.dataset.sel);
    cb.checked ? selHist.add(id) : selHist.delete(id);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    $('tbHist')._html = null; // força redesenho correto na próxima atualização
    atualizarSelecao();
  });
  $('selTodos').addEventListener('change', e => {
    selHist.clear();
    if (e.target.checked) H.itens.forEach(b => selHist.add(b.id));
    $('tbHist')._html = null; renderHistorico();
  });
  const AVISO_TRAVA = 'Sem o registro, a proteção contra lançamento duplo deixa de valer para esses boletos.';
  $('bExcluirSel').onclick = async () => {
    const ids = [...selHist];
    if (!ids.length || !confirm(`Excluir ${plural(ids.length, 'boleto selecionado', 'boletos selecionados')} do histórico?\n${AVISO_TRAVA}`)) return;
    const r = await api('/api/historico/excluir', { ids });
    if (r) { selHist.clear(); toast(`${plural(r.removidos, 'boleto excluído', 'boletos excluídos')} do histórico`, 'ok'); recarregarHist(); }
  };
  $('bLimparHist').onclick = async () => {
    if (!confirm(`Apagar TODO o histórico (${plural(H.total, 'boleto lançado', 'boletos lançados')})?\n${AVISO_TRAVA}\nEsta ação não pode ser desfeita.`)) return;
    if (!confirm('Tem certeza? Todo o histórico será apagado.')) return;
    const r = await api('/api/historico/limpar');
    if (r) { selHist.clear(); toast(`Histórico limpo: ${plural(r.removidos, 'boleto removido', 'boletos removidos')}`, 'ok'); recarregarHist(); }
  };

  // ---------- Condomínios ----------
  let condRev = -1;
  async function carregarCondominios() {
    const rev = E.rev.cond;
    const r = await consultar('/api/condominios', {});
    if (!r) return;
    CD = r; condRev = rev;
    for (const id of condAbertos.keys()) await carregarLinks(id, false);
    opcoesCondominio(); renderCondominios();
  }
  async function carregarLinks(id, render = true) {
    const r = await consultar('/api/condominios/links', { id });
    if (r) condAbertos.set(id, r.links);
    if (render) renderCondominios();
  }
  function renderCondominios() {
    const termos = norm(buscaCond).split(/\s+/).filter(Boolean);
    const lista = [...CD.condominios, ...(CD.linksSemCondominio ? [{ id: 'sem', nome: 'Sem condomínio', links: CD.linksSemCondominio, boletos: 0, lancados: 0 }] : [])]
      .filter(c => termos.every(t => norm(c.nome).includes(t)));
    $('cResultado').innerHTML = `<b>${CD.condominios.length}</b> ${CD.condominios.length === 1 ? 'condomínio' : 'condomínios'} · <b>${CD.condominios.reduce((s, c) => s + c.links, 0) + CD.linksSemCondominio}</b> links`;
    const ocupado = !!E.extracao?.rodando;
    definirHTML($('tbCond'), lista.map(c => {
      const id = String(c.id), links = condAbertos.get(id);
      const linha = `<tr class="linha">
        <td><button type="button" class="expandir" data-c="abrir" data-cid="${id}" aria-expanded="${!!links}" aria-label="Ver links">${ico('i-chev')}</button><b>${esc(c.nome)}</b></td>
        <td class="num">${c.links}</td><td class="num">${c.boletos}</td><td class="num">${c.lancados}</td>
        <td class="num sub2">${c.ultimaExtracao ? esc(dataHora(c.ultimaExtracao)) : '—'}</td>
        <td class="num sub2">${c.ultimoLancamento ? esc(dataHora(c.ultimoLancamento)) : '—'}</td>
        <td class="acoes">
          <button type="button" class="mini" data-c="extrair" data-cid="${id}"${!c.links || ocupado ? ' disabled' : ''}>Extrair</button>
          <button type="button" class="mini" data-c="usar" data-cid="${id}"${c.links ? '' : ' disabled'}>Usar links</button>
          ${id !== 'sem' ? `<button type="button" class="mini" data-c="hist" data-cid="${id}">Histórico</button>` : ''}
        </td></tr>`;
      if (!links) return linha;
      const itens = links.map(l => `<li><span class="url">${esc(l.url)}</span>
          <span class="sub2">${esc(l.unidade || '')}${l.ultimaExtracao ? ' · extraído ' + esc(dataHora(l.ultimaExtracao)) : ''}</span>
          ${l.ultimoErro ? `<span class="prob">${esc(l.ultimoErro)}</span>` : ''}
          <button type="button" class="mini" data-c="remover" data-lid="${l.id}" data-cid="${id}" aria-label="Remover link">Remover</button></li>`).join('');
      return linha + `<tr class="det"><td colspan="7">
        <ul class="links-lista">${itens || '<li class="mut">Nenhum link.</li>'}</ul>
        <div class="vincular"><textarea data-vinc="${id}" rows="2" placeholder="Cole links para vincular a ${esc(c.nome)} (um por linha)"></textarea>
        <button type="button" class="btn-light" data-c="vincular" data-cid="${id}">Vincular links</button></div></td></tr>`;
    }).join('') || linhaVazia(7, 'Nenhum condomínio ainda.', 'Os condomínios aparecem aqui automaticamente após a primeira extração.'));
  }
  $('cBusca').addEventListener('input', debounce(e => { buscaCond = e.target.value; renderCondominios(); }));
  $('bNovoCond').onclick = async () => {
    const nome = $('novoCond').value.trim();
    if (!nome) return toast('Informe o nome do condomínio', 'erro');
    if (await api('/api/condominios/criar', { nome })) { $('novoCond').value = ''; toast('Condomínio adicionado', 'ok'); carregarCondominios(); }
  };
  $('tbCond').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-c]'); if (!btn) return;
    const id = btn.dataset.cid, cid = id === 'sem' ? 'sem' : Number(id);
    const c = CD.condominios.find(x => String(x.id) === id) || { nome: 'Sem condomínio' };
    switch (btn.dataset.c) {
      case 'abrir':
        if (condAbertos.has(id)) { condAbertos.delete(id); renderCondominios(); } else carregarLinks(id);
        return;
      case 'extrair': {
        if (!confirm(`Extrair todos os links de ${c.nome}?`)) return;
        const r = await api('/api/condominios/extrair', { condominioId: cid });
        if (r) { toast(`Extração iniciada: ${plural(r.total, 'link', 'links')}`, 'ok'); location.hash = '#dashboard'; }
        return;
      }
      case 'usar': {
        const r = await consultar('/api/condominios/links', { id });
        if (!r?.links.length) return;
        const atual = $('links').value.trim();
        $('links').value = (atual ? atual + '\n' : '') + `# ${c.nome}\n` + r.links.map(l => l.url).join('\n');
        atualizarContador(); location.hash = '#dashboard';
        toast(`${plural(r.links.length, 'link adicionado', 'links adicionados')} à caixa de extração`, 'ok');
        return;
      }
      case 'hist':
        F.hist.cond = id; lembrar(); location.hash = '#historico'; return;
      case 'remover':
        if (!confirm('Remover este link do condomínio? Os boletos já extraídos continuam no Histórico.')) return;
        if (await api('/api/links/remover', { id: Number(btn.dataset.lid) })) carregarCondominios();
        return;
      case 'vincular': {
        const ta = $('tbCond').querySelector(`textarea[data-vinc="${id}"]`);
        const r = await api('/api/condominios/vincular', { condominioId: cid, texto: ta.value });
        if (r) { toast(`${plural(r.total, 'link vinculado', 'links vinculados')} a ${c.nome}`, 'ok'); carregarCondominios(); }
      }
    }
  });

  // ---------- Lançamento manual (multa / taxa de mudança) ----------
  let buscaManual = '';
  const itensManuaisTxt = b => (b.itensManuais || []).map(i => `${i.item}: R$ ${i.valor}`).join(' | ');
  const listaManual = () => {
    const termos = norm(buscaManual).split(/\s+/).filter(Boolean);
    return manuais().filter(b => !termos.length || termos.every(t => textoBusca(b).includes(t)));
  };
  function renderManual() {
    const lista = listaManual(), total = manuais().length;
    $('mResultado').innerHTML = `<b>${lista.length}</b>${lista.length !== total ? ` de ${total}` : ''} ${total === 1 ? 'boleto' : 'boletos'}`;
    for (const id of ['bCopiarManual', 'bCsvManual', 'bLimparManual']) $(id).disabled = !total;
    definirHTML($('tbManual'), lista.map(b => {
      const link = /^https?:\/\//i.test(b.link || '') ? b.link : null;
      return `<tr class="linha">
        <td><b>${esc(b.condominio || '—')}</b><div class="sub2">${esc(b.unidade || '')}</div></td>
        <td class="num">${esc(b.codIdentificador || '—')}</td>
        <td class="num">${esc(b.vencimento || '—')}</td>
        <td class="num">${b.conferencia ? 'R$ ' + esc(b.conferencia.valorDocumento) : '—'}</td>
        <td>${(b.itensManuais || []).map(i => `<span class="tag manual">${esc(i.item)}: R$ ${esc(i.valor)}</span>`).join(' ')}
          ${temProblema(b) ? `<div class="prob">${b.problemas.map(esc).join('<br>')}</div>` : ''}</td>
        <td>${link ? `<a class="mini" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Abrir</a> <button type="button" class="mini" data-m="copiar" data-id="${b.id}">Copiar</button>` : '—'}
          <div class="sub2 url">${esc(b.link || '')}</div></td>
        <td class="acoes"><button type="button" class="mini" data-m="dados" data-id="${b.id}">Ver dados</button>
          <button type="button" class="mini" data-m="lancado" data-id="${b.id}">Marcar como lançado</button>
          <button type="button" class="mini" data-m="excluir" data-id="${b.id}">Excluir</button></td></tr>`;
    }).join('') || linhaVazia(7, total ? 'Nenhum boleto corresponde à busca.' : 'Nenhum boleto para lançamento manual.', total ? '' : 'Boletos com multa ou taxa de mudança aparecem aqui após a extração.'));
  }
  async function copiar(texto, msg) {
    try { await navigator.clipboard.writeText(texto); toast(msg, 'ok'); }
    catch { toast('Não foi possível copiar', 'erro'); }
  }
  $('mBusca').addEventListener('input', debounce(e => { buscaManual = e.target.value; renderManual(); }));
  $('tbManual').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-m]'); if (!btn) return;
    const id = Number(btn.dataset.id), b = E.boletos.find(x => x.id === id); if (!b) return;
    switch (btn.dataset.m) {
      case 'copiar': return copiar(b.link, 'Link copiado');
      case 'dados': return abrirDados(b);
      case 'lancado':
        if (confirm(`Confirma que o boleto ${b.codIdentificador} (${b.condominio} · ${b.unidade}) já foi lançado no Via Imob?`)
          && await api('/api/manual/lancado', { id })) toast('Marcado como lançado e movido para o Histórico', 'ok');
        return;
      case 'excluir':
        if (confirm('Excluir este boleto da lista de lançamento manual?')) api('/api/boletos/excluir', { id });
    }
  });
  $('bCopiarManual').onclick = () => {
    const lista = listaManual();
    copiar(lista.map(b => [b.condominio, b.unidade, b.codIdentificador, b.vencimento, b.conferencia && 'R$ ' + b.conferencia.valorDocumento,
      itensManuaisTxt(b), b.link].filter(Boolean).join(' — ')).join('\n'), `${plural(lista.length, 'boleto copiado', 'boletos copiados')}`);
  };
  $('bCsvManual').onclick = () => {
    const cel = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const linhas = [['Condomínio', 'Unidade', 'Código', 'Vencimento', 'Valor', 'Itens manuais', 'Link'],
      ...listaManual().map(b => [b.condominio, b.unidade, b.codIdentificador, b.vencimento, b.conferencia?.valorDocumento, itensManuaisTxt(b), b.link])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + linhas.map(l => l.map(cel).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `lancamento-manual-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('bLimparManual').onclick = async () => {
    if (!confirm('Remover todos os boletos da lista de lançamento manual?\n(Os já marcados como lançados continuam no Histórico.)')) return;
    const r = await api('/api/manual/limpar');
    if (r) toast(`${plural(r.removidos, 'boleto removido', 'boletos removidos')}`, 'ok');
  };

  // ---------- Duplicidades ----------
  let DUP = { total: 0, itens: [] }, buscaDup = '', dupRev = -1;
  async function carregarDup() {
    const rev = E.rev.dup;
    const r = await consultar('/api/duplicidades', { busca: buscaDup });
    if (!r) return;
    DUP = r; dupRev = rev; renderDup();
  }
  const dupAdiado = debounce(carregarDup, 250);
  function renderDup() {
    $('dupResultado').innerHTML = `<b>${DUP.total}</b> ${DUP.total === 1 ? 'registro' : 'registros'}`;
    $('bLimparDup').disabled = !DUP.total;
    $('tbDup').innerHTML = DUP.itens.map(d => `<tr class="linha">
        <td class="num sub2">${esc(dataHora(d.detectadoEm))}</td>
        <td>${esc(d.condominio || '—')}<div class="sub2">${esc(d.unidade || '')}</div></td>
        <td class="num">${esc(d.codIdentificador || '—')}</td>
        <td class="num">${esc(d.vencimento || '—')}</td>
        <td class="num">${d.conferencia ? 'R$ ' + esc(d.conferencia.valorDocumento) : '—'}</td>
        <td><span class="tag ${d.original?.status === 'lancado' ? 'lancado' : 'pendente'}">${esc(d.motivo)}</span>
          <div class="sub2 url">${esc(d.link)}</div></td>
        <td class="acoes">${d.codIdentificador ? `<button type="button" class="mini" data-d="ver" data-cod="${esc(d.codIdentificador)}" data-st="${esc(d.original?.status || '')}">Ver original</button>` : ''}
          <button type="button" class="mini" data-d="remover" data-did="${d.id}">Remover</button></td></tr>`).join('')
      || linhaVazia(7, 'Nenhuma duplicidade registrada.', 'Boletos repetidos encontrados na extração aparecem aqui.');
  }
  $('dupBusca').addEventListener('input', e => { buscaDup = e.target.value; dupAdiado(); });
  $('bLimparDup').onclick = async () => { if (confirm('Limpar a lista de duplicidades?')) { if (await api('/api/duplicidades/limpar')) carregarDup(); } };
  $('tbDup').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-d]'); if (!btn) return;
    if (btn.dataset.d === 'remover') { if (await api('/api/duplicidades/remover', { id: Number(btn.dataset.did) })) carregarDup(); return; }
    // Ver original: lançado → Histórico; pendente → Dashboard (busca pelo código).
    if (btn.dataset.st === 'lancado') {
      Object.assign(F.hist, HIST_PADRAO, { busca: btn.dataset.cod }); lembrar(); location.hash = '#historico';
    } else { F.dash.busca = btn.dataset.cod; $('dBusca').value = btn.dataset.cod; location.hash = '#dashboard'; renderDashboard(); }
  });

  function renderConfig() {
    const c = E.config || {};
    const mapa = (c.mapaOcorrencias || []).map(m => `<code>/${esc(m.regex)}/i</code> → ${m.nome ? esc(m.nome) : '<span class="mut">ignorar (sem mapeamento)</span>'}`).join('<br>');
    const pares = [
      ['Porta', c.porta], ['Chrome', c.chrome], ['URL Via Imob', c.urlViaImob],
      ['Janela Via Imob', c.viewportViaImob ? `${c.viewportViaImob.width} × ${c.viewportViaImob.height}` : 'automática'],
      ['Concorrência', c.concorrenciaExtracao], ['Espera por página', c.esperaMs != null ? c.esperaMs + ' ms' : ''],
      ['Lançamento', [(c.lancamento?.gravar !== false ? 'clica em Gravar após sua confirmação' : 'só preenche (grava à mão)'),
        (c.lancamento?.rapido !== false ? 'rápido (espera a resposta do Via Imob)' : 'tempos fixos'),
        (c.lancamento?.verificarAvisos !== false ? 'verifica avisos' : 'sem verificação de avisos'),
        (c.lancamento?.pularComErro !== false ? 'com aviso: fecha e vai para o próximo' : 'com aviso: para')].join(' · ')],
      ['Lançamento manual (termos)', (c.lancamentoManual || []).join(', ') || '—'],
      ['Foto da tela de erro', `guardada por ${c.diasCapturas} dias`],
      ['Banco de dados', c.banco]
    ];
    $('cfg').innerHTML = pares.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v ?? '—')}</dd>`).join('') + `<dt>Ocorrências</dt><dd>${mapa || '—'}</dd>`;
  }

  function renderControles() {
    const x = E.extracao || {}, bs = automaticos(), nMan = manuais().length;
    const n = s => bs.filter(b => !temProblema(b) && b.status === s).length;
    const prob = bs.filter(temProblema).length, pend = n('pendente');

    const temFila = (x.fila || 0) > 0;
    const pausado = !!x.pausado; // pausado em execução ou fila salva aguardando
    $('bExtrair').disabled = !!x.rodando && !pausado;
    $('bExtrair').querySelector('b').textContent = temFila && !x.rodando ? 'Continuar Extração' : 'Iniciar Extração';
    $('bExtrair').querySelector('small').textContent = temFila && !x.rodando ? `${plural(x.fila, 'link restante', 'links restantes')}` : 'Comece a processar os dados';
    $('bPausar').disabled = !x.rodando && !temFila;
    $('bParar').disabled = !x.rodando && !temFila;
    $('bPausar').classList.toggle('ativo', !!x.pausado);
    $('bPausar').querySelector('b').textContent = x.pausado ? 'Retomar' : 'Pausar';
    $('bPausar').querySelector('small').textContent = x.pausado ? 'Continue o processo' : 'Pause o processo atual';
    $('bPausar').querySelector('.bola').innerHTML = ico(x.pausado ? 'i-play' : 'i-pause');
    $('bProx').disabled = !podeLancar() || !pend;
    $('bLimparLista').disabled = !!x.rodando || E.lancando !== null || !bs.length;
    $('nManual').textContent = nMan || ''; $('nManual').hidden = !nMan;
    $('nDup').textContent = E.duplicidades || '';
    $('nDup').hidden = !E.duplicidades;
    $('viaTxt').textContent = E.via.aberto ? 'Navegador aberto' : 'Acesse o site de origem';

    const pw = $('progWrap');
    pw.hidden = !x.rodando && !temFila;
    pw.classList.toggle('pausa', !!x.pausado);
    $('progBar').style.width = x.total ? (100 * x.feitos / x.total).toFixed(1) + '%' : '0';

    let cls = 'ok', icone = 'i-check', txt = 'Pronto para iniciar';
    if (pausado && temFila) [cls, icone, txt] = ['wait', 'i-pause', `Pausado · ${x.feitos}/${x.total} — clique em Retomar`];
    else if (x.rodando) [cls, icone, txt] = ['run', 'i-play', `Extraindo · ${x.feitos}/${x.total}`];
    else if (E.lancando !== null) [cls, icone, txt] = ['run', 'i-barcode', 'Lançando boleto…'];
    else if (x.erro) [cls, icone, txt] = ['err', 'i-stop', 'Erro: ' + x.erro];
    else if (x.duplicados && !pend) [cls, icone, txt] = ['wait', 'i-check', `${plural(x.duplicados, 'duplicado ignorado', 'duplicados ignorados')}`];
    else if (pend) txt = `${plural(pend, 'boleto pronto', 'boletos prontos')} para lançar`;
    $('badge').className = 'badge ' + cls;
    $('badge').innerHTML = ico(icone) + `<span>${esc(txt)}</span>`;

    $('resumo').innerHTML = (bs.length ? [
      ['Na lista', bs.length], ['Prontos', pend], ['Com problema', prob], ['Erro no lançamento', n('erro')]
    ].map(([k, v]) => `<span class="chip">${k}: <b>${v}</b></span>`).join('') : '') +
      (nMan ? `<a class="chip chip-manual" href="#manual">Lançamento manual: <b>${nMan}</b> →</a>` : '');

    $('ultima').textContent = dataHora(E.atualizadoEm);
    $('versao').textContent = E.app?.versao || '—';
  }

  // ---------- Conferência do lançamento ----------
  let selecionado = null;
  // Qual boleto mostrar: o que está sendo lançado > o clicado > o próximo pronto.
  function boletoConferencia() {
    const bs = automaticos();
    if (E.lancando !== null) { const b = bs.find(x => x.id === E.lancando); if (b) return { b, modo: 'Lançando agora', cls: 'run' }; }
    const sel = bs.find(x => x.id === selecionado);
    if (sel) return { b: sel, modo: 'Selecionado', cls: 'wait' };
    const prox = bs.find(x => x.status === 'pendente' && !temProblema(x));
    if (prox) return { b: prox, modo: 'Próximo a lançar', cls: 'ok' };
    return bs[0] ? { b: bs[0], modo: 'Com problema', cls: 'err' } : null;
  }
  const centavos = v => Math.round((numBR(v) || 0) * 100);
  const brl = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const linhaParaBarras = l => {
    const d = String(l || '').replace(/\D/g, '');
    if (d.length === 44) return d;
    if (d.length !== 47) return null;
    return d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  };
  let chaveConf = '';
  function renderConferencia() {
    const c = boletoConferencia();
    $('conf').hidden = !c;
    if (!c) return;
    const { b } = c;
    const passo = E.lancando === b.id ? (E.passoLancamento || 'Preparando…') : '';
    $('confPasso').hidden = !passo;
    $('confPasso').lastElementChild.textContent = passo;
    // Etapa atual destacada na lista "Será lançado".
    const ocs = b.ocorrencias || [];
    let etapa = -1;
    if (passo) {
      if (/identificador/i.test(passo)) etapa = 0; else if (/barras/i.test(passo)) etapa = 1;
      else { const m = /Ocorrência (\d+) de/.exec(passo); if (m) etapa = 1 + Number(m[1]); else if (/Conclu/i.test(passo)) etapa = 99; }
    }
    const aguardando = E.aguardandoGravar === b.id;
    $('confGravar').hidden = !aguardando;
    $('confPasso').querySelector('.spin').hidden = aguardando;
    const chave = JSON.stringify([b.id, b.status, passo, c.modo, b.capturaErro, b.erroLancamento, aguardando]);
    if (chave === chaveConf) return; // nada mudou: não redesenha
    chaveConf = chave;

    $('confModo').className = 'badge ' + c.cls; $('confModo').textContent = c.modo;
    $('confSub').textContent = c.modo === 'Selecionado' ? 'Boleto escolhido na lista. Clique em outro para trocar.'
      : 'Confira os itens do recibo e o que será digitado no Via Imob.';

    const dados = [['Condomínio', b.condominio], ['Unidade', b.unidade], ['Cód. identificador', b.codIdentificador],
      ['Vencimento', b.vencimento], ['Valor do documento', b.conferencia ? 'R$ ' + b.conferencia.valorDocumento : null],
      ['Linha digitável', b.linhaDigitavel], ['Extraído em', dataHora(b.extraidoEm)]];
    $('confDados').innerHTML = dados.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || '—')}</dd>`).join('') +
      (b.desconto ? `<dt>Desconto</dt><dd>${esc(b.desconto.join(' | '))}</dd>` : '');

    const itens = b.itensRecibo;
    $('confItens').innerHTML = itens?.length
      ? `<table class="rec"><tbody>${itens.map(i => `<tr><td>${esc(i.item)}</td><td>R$ ${esc(i.valor)}</td></tr>`).join('')}</tbody>
         <tfoot><tr><td>Total dos itens</td><td>R$ ${brl(itens.reduce((s, i) => s + centavos(i.valor), 0))}</td></tr></tfoot></table>`
      : '<p class="mut">Itens não disponíveis (boleto extraído antes desta versão). Use "Ver boleto original" ou extraia de novo.</p>';

    const cls = i => etapa === 99 || i < etapa ? ' class="feito"' : i === etapa ? ' class="atual"' : '';
    const barras = linhaParaBarras(b.linhaDigitavel);
    const somaLanc = ocs.reduce((s, o) => s + centavos(o.valor), 0);
    $('confLanc').innerHTML = [
      `<li${cls(0)}>Código identificador: <b>${esc(b.codIdentificador || '—')}</b></li>`,
      `<li${cls(1)}>Código de barras: <code>${esc(barras || 'linha digitável inválida')}</code></li>`,
      ...ocs.map((o, i) => `<li${cls(2 + i)}>${o.nome ? `<b>${esc(o.nome)}</b>` : `<span class="erro-map">SEM MAPEAMENTO</span>`}
        <span class="val">R$ ${esc(o.valor)}</span>
        <span class="hist">${o.nome ? '' : 'Item do recibo: '}${esc(o.itemOriginal)}${o.historico ? ' · histórico: ' + esc(o.historico) : ''}</span></li>`)
    ].join('') + `<li class="total"><b>Total a lançar: R$ ${brl(somaLanc)}</b></li>`;

    const doc = b.conferencia ? centavos(b.conferencia.valorDocumento) : null;
    const ok = v => doc !== null && centavos(v) === doc;
    const checks = b.conferencia ? [
      ['Itens do recibo', b.itensRecibo ? brl(b.itensRecibo.reduce((s, i) => s + centavos(i.valor), 0)) : null],
      ['Total do recibo', b.conferencia.totalRecibo], ['Valor da linha digitável', b.conferencia.valorLinha], ['Total a lançar', brl(somaLanc)]
    ].filter(([, v]) => v != null) : [];
    $('confCheck').innerHTML = checks.map(([k, v]) => `<span class="check${ok(v) ? '' : ' nao'}">${ok(v) ? '✓' : '✗'} ${k}: R$ ${esc(v)}</span>`).join('') +
      (doc !== null ? `<span class="check${checks.every(([, v]) => ok(v)) ? '' : ' nao'}">Valor do documento: R$ ${esc(b.conferencia.valorDocumento)}</span>` : '') +
      (b.problemas || []).map(p => `<span class="check nao">⚠ ${esc(p)}</span>`).join('') +
      (b.erroLancamento ? `<span class="check nao">⚠ Último lançamento: ${esc(b.erroLancamento)}</span>` : '');
    $('bVerBoleto').onclick = () => abrirDados(b);
    $('bVerErro').hidden = !b.capturaErro;
    $('bVerErro').onclick = () => abrirFotoErro(b);
  }

  // ---------- Gravar no Via Imob (após conferir) ----------
  async function confirmarGravacao(gravar) {
    const id = E.aguardandoGravar; if (id == null) return;
    $('bGravar').disabled = $('bManualGravar').disabled = true;
    try {
      const r = await api('/api/gravar', { id, gravar });
      if (!r) return;
      if (!r.ok) return toast(r.erro, 'erro');
      if (!gravar) return toast('Marcado como lançado. Grave no Via Imob.', 'ok');
      toast('Gravado no Via Imob e movido para o Histórico.' + (r.janelas?.length ? ` Abriu: ${r.janelas.join(', ')} — confira.` : ''), r.janelas?.length ? 'erro' : 'ok');
      // Segue para o próximo boleto pronto.
      await tick();
      const prox = automaticos().find(x => x.status === 'pendente' && !temProblema(x));
      if (prox && podeLancar()) lancar(prox.id, true);
    } finally { $('bGravar').disabled = $('bManualGravar').disabled = false; }
  }
  $('bGravar').onclick = () => confirmarGravacao(true);
  $('bManualGravar').onclick = () => confirmarGravacao(false);

  // ---------- Janela: todos os dados extraídos / foto da tela de erro ----------
  let urlFoto = null;
  function abrirJanela(b, titulo) {
    $('dlgTitulo').textContent = titulo + ' · ' + ([b.condominio, b.unidade, b.codIdentificador].filter(Boolean).join(' · ') || `registro #${b.id}`);
    const link = /^https?:\/\//i.test(b.link || '') ? b.link : null;
    $('dlgLink').hidden = !link; if (link) $('dlgLink').href = link;
    $('dlgImg').hidden = true; $('dlgVazio').hidden = true; $('dlgDados').hidden = true;
    $('dlgBoleto').showModal();
  }
  const tabela = (cab, linhas, rodape) => `<table class="rec"><thead><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map(l => `<tr>${l.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>${rodape ? `<tfoot><tr>${rodape.map(c => `<td>${c}</td>`).join('')}</tr></tfoot>` : ''}</table>`;
  function abrirDados(b) {
    if (!b) return;
    abrirJanela(b, 'Dados extraídos');
    const cf = b.conferencia, ocs = b.ocorrencias || [], itens = b.itensRecibo || [];
    const doc = cf ? centavos(cf.valorDocumento) : null;
    const marca = v => doc === null ? '' : centavos(v) === doc ? ' <span class="ok-txt">✓</span>' : ' <span class="nao-txt">✗</span>';
    const ident = [['Condomínio', b.condominio], ['Unidade', b.unidade], ['Cód. identificador', b.codIdentificador],
      ['Vencimento', b.vencimento], ['Valor do documento', cf && 'R$ ' + cf.valorDocumento], ['Linha digitável', b.linhaDigitavel],
      ['Código de barras', linhaParaBarras(b.linhaDigitavel)], ['Link', b.link], ['Status', ROTULO[statusDe(b)] || b.status],
      ['Extraído em', b.extraidoEm && dataHora(b.extraidoEm)], ['Lançado em', b.lancadoEm && dataHora(b.lancadoEm)]];
    $('dlgDados').innerHTML = `
      <section><h3>Identificação</h3><dl class="cfg mini-dl">${ident.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || '—')}</dd>`).join('')}</dl></section>
      <section><h3>Itens do recibo <small>como estão no link</small></h3>${itens.length
        ? tabela(['Item', 'Valor'], itens.map(i => [esc(i.item), 'R$ ' + esc(i.valor)]), ['Total dos itens', 'R$ ' + brl(itens.reduce((s, i) => s + centavos(i.valor), 0))])
        : '<p class="mut">Itens não disponíveis (boleto extraído numa versão anterior — extraia de novo para ver).</p>'}</section>
      <section><h3>Será lançado no Via Imob</h3>${ocs.length
        ? tabela(['Ocorrência no Via Imob', 'Item do recibo', 'Valor', 'Histórico'],
          ocs.map(o => [o.nome ? esc(o.nome) : '<span class="erro-map">SEM MAPEAMENTO</span>', esc(o.itemOriginal), 'R$ ' + esc(o.valor), esc(o.historico || '—')]),
          ['Total a lançar', '', 'R$ ' + brl(ocs.reduce((s, o) => s + centavos(o.valor), 0)), ''])
        : '<p class="mut">Nenhuma ocorrência.</p>'}</section>
      ${cf ? `<section><h3>Conferência dos totais</h3><dl class="cfg mini-dl">
        <dt>Soma calculada</dt><dd>R$ ${esc(cf.somaCalc)}${marca(cf.somaCalc)}</dd>
        <dt>Total do recibo</dt><dd>R$ ${esc(cf.totalRecibo)}${marca(cf.totalRecibo)}</dd>
        <dt>Valor da linha digitável</dt><dd>R$ ${esc(cf.valorLinha)}${marca(cf.valorLinha)}</dd>
        <dt>Valor do documento</dt><dd>R$ ${esc(cf.valorDocumento)}</dd></dl></section>` : ''}
      ${b.desconto ? `<section><h3>Desconto / instruções</h3><ul>${b.desconto.map(d => `<li>${esc(d)}</li>`).join('')}</ul></section>` : ''}
      ${b.problemas?.length || b.erroLancamento ? `<section><h3>Problemas</h3><ul>${[...(b.problemas || []), ...(b.erroLancamento ? ['Lançamento: ' + b.erroLancamento] : [])]
        .map(p => `<li class="prob">${esc(p)}</li>`).join('')}</ul></section>` : ''}`;
    $('dlgDados').hidden = false;
  }
  async function abrirFotoErro(b) {
    if (!b) return;
    abrirJanela(b, 'Tela do erro');
    try {
      const r = await fetch('/api/captura?id=' + b.id, { headers: { 'X-Token': TOKEN }, cache: 'no-store' });
      if (!r.ok) throw 0;
      if (urlFoto) URL.revokeObjectURL(urlFoto);
      urlFoto = URL.createObjectURL(await r.blob());
      $('dlgImg').src = urlFoto; $('dlgImg').hidden = false;
    } catch { $('dlgVazio').hidden = false; }
  }
  $('dlgFechar').onclick = () => $('dlgBoleto').close();
  $('dlgBoleto').addEventListener('click', e => { if (e.target === $('dlgBoleto')) $('dlgBoleto').close(); });
  $('dlgBoleto').addEventListener('close', () => { if (urlFoto) { URL.revokeObjectURL(urlFoto); urlFoto = null; } $('dlgImg').removeAttribute('src'); });

  let configMostrada = false;
  function render() {
    renderControles();
    renderDashboard();
    renderConferencia();
    renderManual();
    if (!configMostrada) { renderConfig(); configMostrada = true; }
    // Dados do banco: recarrega só a tela visível e só quando aquela área mudou.
    if (visivel('historico') && histRev !== E.rev.hist) histAdiado();
    // Condomínios também alimentam o filtro do Histórico.
    if ((visivel('condominios') || visivel('historico')) && condRev !== E.rev.cond) condAdiado();
    if (visivel('duplicidades') && dupRev !== E.rev.dup) dupAdiado();
  }
  const condAdiado = debounce(carregarCondominios, 300);

  // ---------- Polling (204 quando nada mudou) ----------
  let timer = null, online = null;
  const setOnline = on => {
    if (on === online) return;
    online = on;
    $('online').className = 'online ' + (on ? 'on' : 'off');
    $('online').querySelector('span').textContent = on ? 'Sistema online' : 'Sistema offline';
    $('dotRodape').className = 'dot ' + (on ? 'on' : 'off');
  };
  function agendar(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  async function tick() {
    try {
      const r = await fetch('/api/estado?v=' + E.versao, { headers: { 'X-Token': TOKEN }, cache: 'no-store' });
      if (r.status === 200) {
        const primeira = E.versao === -1;
        E = await r.json(); render();
        if (primeira && E.extracao?.retomada && E.extracao.fila)
          toast(E.extracao.pausado ? `Extração pausada: ${plural(E.extracao.fila, 'link restante', 'links restantes')}. Clique em Retomar.`
            : `Continuando a extração de onde parou (${plural(E.extracao.fila, 'link restante', 'links restantes')})`, 'ok');
      }
      else if (r.status !== 204) throw new Error(r.status);
      setOnline(true);
    } catch { setOnline(false); }
    const ativo = E.extracao?.rodando || E.lancando !== null;
    agendar(document.hidden ? 5000 : ativo ? 700 : 1500);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) agendar(0); });
  sincronizarCampos();
  atualizarContador();
  carregarCondominios();
  rota();
  tick();
})();
