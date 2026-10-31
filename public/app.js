'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const TOKEN = document.querySelector('meta[name="token"]').content;
  const ROTULO = { pendente: 'Pendente', lancando: 'Lançando…', lancado: 'Preenchido', gravado: 'Gravado', erro: 'Erro' };
  const MAX_ARQ = 2 * 1024 * 1024;

  let E = { versao: -1, boletos: [], extracao: {}, via: {}, lancando: null, app: {}, config: {} };
  let filtro = 'todos';
  const abertos = new Set(); // linhas expandidas (por link)

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
    historico: ['Histórico', 'Acompanhe todos os boletos extraídos e lançados.'],
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
  }
  addEventListener('hashchange', rota);
  rota();

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
    if (!contarLinks($('links').value)) return toast('Adicione ao menos um link', 'erro');
    const r = await api('/api/extrair', { texto: $('links').value });
    if (r) toast(`Extração iniciada: ${plural(r.total, 'link', 'links')}`, 'ok');
  };
  $('bPausar').onclick = () => api('/api/extracao/pausar');
  $('bParar').onclick = async () => { if (confirm('Interromper a extração?')) { const r = await api('/api/extracao/parar'); if (r) toast('Extração interrompida'); } };
  $('bVia').onclick = async () => {
    $('bVia').disabled = true;
    try { await api('/api/via/abrir'); } finally { $('bVia').disabled = false; }
  };
  $('bProx').onclick = () => {
    const i = E.boletos.findIndex(b => b.status === 'pendente' && !temProblema(b));
    if (i < 0) return toast('Nenhum boleto pendente', 'erro');
    lancar(i);
  };
  $('bLimparLista').onclick = async () => {
    if (confirm('Apagar a lista de boletos? Esta ação não pode ser desfeita.')) { abertos.clear(); await api('/api/limpar'); }
  };
  $('filtros').onclick = e => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    filtro = b.dataset.f;
    $('filtros').querySelectorAll('button').forEach(x => x.classList.toggle('ativo', x === b));
    renderHistorico();
  };

  async function lancar(i) {
    const b = E.boletos[i];
    if (!b) return;
    if (!confirm(`Lançar ${b.codIdentificador} (${b.unidade || ''})?\nConfirme que a tela Manutenção encargo está na aba ativa.`)) return;
    const r = await api('/api/lancar', { indice: i });
    if (r) toast(`Boleto ${b.codIdentificador} preenchido. Confira e grave no Via Imob.`, 'ok');
  }

  // Delegação de eventos nas tabelas (sem handlers inline → compatível com CSP).
  const aoClicarTabela = e => {
    const btn = e.target.closest('button[data-acao]'); if (!btn) return;
    const i = Number(btn.dataset.i);
    const b = E.boletos[i]; if (!b) return;
    switch (btn.dataset.acao) {
      case 'lancar': return lancar(i);
      case 'gravado': return api('/api/status', { indice: i, status: 'gravado' });
      case 'pendente': return api('/api/status', { indice: i, status: 'pendente' });
      case 'det':
        abertos.has(b.link) ? abertos.delete(b.link) : abertos.add(b.link);
        return render();
    }
  };
  $('tb').addEventListener('click', aoClicarTabela);
  $('tbHist').addEventListener('click', aoClicarTabela);

  // ---------- Render ----------
  const podeLancar = () => E.lancando === null && E.via.aberto;
  function botoesAcao(b, i) {
    if (temProblema(b)) return '';
    const dis = podeLancar() ? '' : ' disabled';
    if (b.status === 'lancado') return `<button type="button" class="mini" data-acao="gravado" data-i="${i}">Marcar gravado</button><button type="button" class="mini" data-acao="lancar" data-i="${i}"${dis}>Refazer</button>`;
    if (b.status === 'gravado') return `<button type="button" class="mini" data-acao="pendente" data-i="${i}">Reabrir</button>`;
    if (b.status === 'pendente' || b.status === 'erro') return `<button type="button" class="mini" data-acao="lancar" data-i="${i}"${dis}>Lançar</button>`;
    return '';
  }
  const tagStatus = b => {
    const st = statusDe(b);
    return `<span class="tag ${esc(st)}">${esc(ROTULO[st] || st)}</span>` +
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
      `<li>Link: <span class="sub2">${esc(b.link)}</span></li>`
    ].filter(Boolean).join('');
    return `<tr class="det"><td colspan="${colunas}"><ul>${itens}</ul></td></tr>`;
  }

  const linhaVazia = (colunas, titulo, texto) =>
    `<tr class="vazio"><td colspan="${colunas}">${ico('i-empty')}<strong>${titulo}</strong>${texto}</td></tr>`;

  function renderDashboard() {
    const bs = E.boletos;
    $('tb').innerHTML = bs.map((b, i) => {
      const aberto = abertos.has(b.link);
      return `<tr class="linha">
        <td><button type="button" class="expandir" data-acao="det" data-i="${i}" aria-expanded="${aberto}" aria-label="Detalhes">${ico('i-chev')}</button>${esc(b.condominio || '—')}</td>
        <td>${esc(b.unidade || '—')}</td>
        <td class="num">${esc(b.codIdentificador || '—')}</td>
        <td class="num">${esc(b.vencimento || '—')}</td>
        <td class="num">${b.conferencia ? 'R$ ' + esc(b.conferencia.valorDocumento) : '—'}</td>
        <td>${tagStatus(b)}</td>
        <td class="acoes">${botoesAcao(b, i)}</td></tr>${aberto ? detalhe(b, 7) : ''}`;
    }).join('') || linhaVazia(7, 'Nenhum dado extraído ainda.', 'Adicione os links ou o arquivo e clique em "Iniciar Extração".');
  }

  function renderHistorico() {
    const ok = b => filtro === 'todos' ? true : filtro === 'problema' ? temProblema(b) : !temProblema(b) && b.status === filtro;
    const linhas = E.boletos.map((b, i) => [b, i]).filter(([b]) => ok(b));
    $('tbHist').innerHTML = linhas.map(([b, i]) => {
      const aberto = abertos.has(b.link);
      return `<tr class="linha">
        <td><button type="button" class="expandir" data-acao="det" data-i="${i}" aria-expanded="${aberto}" aria-label="Detalhes">${ico('i-chev')}</button>${i + 1}</td>
        <td class="num">${esc(b.codIdentificador || '—')}</td>
        <td>${esc(b.condominio || '—')}<div class="sub2">${esc(b.unidade || '')}</div></td>
        <td class="sub2">${ocorrenciasHtml(b)}${b.desconto ? '<br><b>Desconto:</b> ' + esc(b.desconto.join(' | ')) : ''}</td>
        <td class="num">${b.conferencia ? 'R$ ' + esc(b.conferencia.valorDocumento) : '—'}</td>
        <td>${tagStatus(b)}${temProblema(b) ? `<div class="prob">${b.problemas.map(esc).join('<br>')}</div>` : ''}</td>
        <td class="acoes">${botoesAcao(b, i)}</td></tr>${aberto ? detalhe(b, 7) : ''}`;
    }).join('') || linhaVazia(7, 'Nenhum boleto encontrado.', '');
  }

  function renderConfig() {
    const c = E.config || {};
    const mapa = (c.mapaOcorrencias || []).map(m => `<code>/${esc(m.regex)}/i</code> → ${m.nome ? esc(m.nome) : '<span class="mut">ignorar (sem mapeamento)</span>'}`).join('<br>');
    const pares = [
      ['Porta', c.porta], ['Chrome', c.chrome], ['URL Via Imob', c.urlViaImob],
      ['Janela Via Imob', c.viewportViaImob ? `${c.viewportViaImob.width} × ${c.viewportViaImob.height}` : 'automática'],
      ['Concorrência', c.concorrenciaExtracao], ['Espera por página', c.esperaMs != null ? c.esperaMs + ' ms' : '']
    ];
    $('cfg').innerHTML = pares.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v ?? '—')}</dd>`).join('') + `<dt>Ocorrências</dt><dd>${mapa || '—'}</dd>`;
  }

  function renderControles() {
    const x = E.extracao || {}, bs = E.boletos;
    const n = s => bs.filter(b => !temProblema(b) && b.status === s).length;
    const prob = bs.filter(temProblema).length, pend = n('pendente');

    $('bExtrair').disabled = !!x.rodando;
    $('bPausar').disabled = !x.rodando;
    $('bParar').disabled = !x.rodando;
    $('bPausar').classList.toggle('ativo', !!x.pausado);
    $('bPausar').querySelector('b').textContent = x.pausado ? 'Retomar' : 'Pausar';
    $('bPausar').querySelector('small').textContent = x.pausado ? 'Continue o processo' : 'Pause o processo atual';
    $('bPausar').querySelector('.bola').innerHTML = ico(x.pausado ? 'i-play' : 'i-pause');
    $('bProx').disabled = !podeLancar() || !pend;
    $('bLimparLista').disabled = !!x.rodando || E.lancando !== null || !bs.length;
    $('viaTxt').textContent = E.via.aberto ? 'Navegador aberto' : 'Acesse o site de origem';

    const pw = $('progWrap');
    pw.hidden = !x.rodando;
    pw.classList.toggle('pausa', !!x.pausado);
    $('progBar').style.width = x.total ? (100 * x.feitos / x.total).toFixed(1) + '%' : '0';

    let cls = 'ok', icone = 'i-check', txt = 'Pronto para iniciar';
    if (x.rodando && x.pausado) [cls, icone, txt] = ['wait', 'i-pause', `Pausado · ${x.feitos}/${x.total}`];
    else if (x.rodando) [cls, icone, txt] = ['run', 'i-play', `Extraindo · ${x.feitos}/${x.total}`];
    else if (E.lancando !== null) [cls, icone, txt] = ['run', 'i-barcode', 'Lançando boleto…'];
    else if (x.erro) [cls, icone, txt] = ['err', 'i-stop', 'Erro: ' + x.erro];
    else if (pend) txt = `${plural(pend, 'boleto pronto', 'boletos prontos')} para lançar`;
    $('badge').className = 'badge ' + cls;
    $('badge').innerHTML = ico(icone) + `<span>${esc(txt)}</span>`;

    $('resumo').innerHTML = bs.length ? [
      ['Total', bs.length], ['Pendentes', pend], ['Preenchidos', n('lancado')], ['Gravados', n('gravado')], ['Com problema', prob]
    ].map(([k, v]) => `<span class="chip">${k}: <b>${v}</b></span>`).join('') : '';

    $('ultima').textContent = dataHora(E.atualizadoEm);
    $('versao').textContent = E.app?.versao || '—';
  }

  function render() {
    renderControles();
    renderDashboard();
    renderHistorico();
    renderConfig();
  }

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
      if (r.status === 200) { E = await r.json(); render(); }
      else if (r.status !== 204) throw new Error(r.status);
      setOnline(true);
    } catch { setOnline(false); }
    const ativo = E.extracao?.rodando || E.lancando !== null;
    agendar(document.hidden ? 5000 : ativo ? 700 : 1500);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) agendar(0); });
  atualizarContador();
  tick();
})();
