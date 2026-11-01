(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
    o.buttons = 0;
    el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o));
  };
  const SPECIAL = { Tab: 9, Enter: 13, Backspace: 8, Delete: 46, Home: 36, End: 35 };
  const PUNCT = { '-': [189, 'Minus'], ',': [188, 'Comma'], '.': [190, 'Period'], '/': [191, 'Slash'], ' ': [32, 'Space'] };
  const key = k => {
    let kc, code, ch = null;
    if (SPECIAL[k]) { kc = SPECIAL[k]; code = k; }
    else { ch = k;
      if (/[0-9]/.test(k)) { kc = k.charCodeAt(0); code = 'Digit' + k; }
      else if (/[a-z]/i.test(k)) { kc = k.toUpperCase().charCodeAt(0); code = 'Key' + k.toUpperCase(); }
      else [kc, code] = PUNCT[k] || [0, '']; }
    const t = document.activeElement || document.body;
    const base = { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, shiftKey: !!ch && ch !== ch.toLowerCase() };
    t.dispatchEvent(new KeyboardEvent('keydown', base));
    if (ch) { const c = ch.charCodeAt(0); t.dispatchEvent(new KeyboardEvent('keypress', { ...base, keyCode: c, which: c, charCode: c })); }
    t.dispatchEvent(new KeyboardEvent('keyup', base));
  };
  const type = async (s, d = 25) => { for (const c of s) { key(c); await sleep(d); } };

  // ===== DADOS DO BOLETO =====
  const data = /*__DADOS__*/;
  // ===========================

  const activeCanvas = () => document.querySelector('.dwmwindow.active canvas');
  const textoJanela = c => {
    const w = c?.closest('.dwmwindow');
    const t = (w?.getAttribute('title') || w?.querySelector('[class*="title" i],[class*="caption" i]')?.textContent || w?.innerText || '').trim();
    return t.replace(/\s+/g, ' ').slice(0, 200);
  };
  const PARECE_AVISO = /aviso|erro|aten[cç][aã]o|n[aã]o\s+(encontrad|localizad|existe|permitid)|inv[aá]lid|j[aá]\s+(lan[cç]ad|cadastrad|existe|baixad)|duplicad/i;

  // ---- Monitor de rede: espera só até o Via Imob responder (XHR, fetch e WebSocket) ----
  const R = window.__lbRede ||= (() => {
    const r = { pend: 0, n: 0, t: 0 };
    const ativ = () => { r.n++; r.t = Date.now(); };
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
      r.pend++; ativ();
      this.addEventListener('loadend', () => { r.pend--; ativ(); }, { once: true });
      return XS.apply(this, a);
    };
    const F = window.fetch;
    window.fetch = function (...a) { r.pend++; ativ(); return F.apply(this, a).finally(() => { r.pend--; ativ(); }); };
    const WS = WebSocket.prototype.send;
    WebSocket.prototype.send = function (...a) {
      ativ();
      if (!this.__lb) { this.__lb = 1; this.addEventListener('message', ativ); }
      return WS.apply(this, a);
    };
    return r;
  })();

  // Lança erro se o Via Imob mostrou um aviso: caixa de diálogo do navegador ou janela nova sobre a esperada.
  const checar = (esperada, etapa) => {
    const limpo = t => String(t).replace(/[|\n]+/g, ' / ');
    if (window.__lbAviso) { const m = window.__lbAviso; window.__lbAviso = null; throw new Error(`AVISO|${etapa}|${limpo(m)}`); }
    if (!data.verificar) return;
    const c = activeCanvas();
    if (c && c !== esperada) throw new Error(`AVISO|${etapa}|${limpo(textoJanela(c) || 'O Via Imob abriu uma janela de aviso')}`);
  };
  /** Espera a resposta do Via Imob: segue assim que houve comunicação e a rede ficou quieta;
   *  no máximo `max` ms (o tempo fixo antigo). Checa avisos durante toda a espera. */
  const esperar = async (esperada, etapa, min, max) => {
    const t0 = Date.now(), n0 = R.n;
    while (Date.now() - t0 < max) {
      await sleep(80);
      checar(esperada, etapa);
      if (data.rapido && Date.now() - t0 >= min && R.n > n0 && R.pend === 0 && Date.now() - R.t > 350) break;
    }
    await sleep(120); // margem para a tela desenhar um eventual aviso
    checar(esperada, etapa);
  };
  const waitNewWindow = async prev => {
    const t = Date.now();
    while (Date.now() - t < 8000) {
      if (window.__lbAviso) checar(prev, 'abrir a ocorrência');
      const c = activeCanvas();
      if (c && c !== prev) {
        await sleep(400);
        const titulo = textoJanela(c);
        if (data.verificar && titulo && PARECE_AVISO.test(titulo)) throw new Error(`AVISO|abrir a ocorrência|${titulo.replace(/\|/g, '/')}`);
        const r = c.getBoundingClientRect(); return { c, x: r.x, y: r.y };
      }
      await sleep(100);
    }
    throw new Error('Janela "Edição item encargo" não abriu');
  };

  const linhaParaBarras = l => {
    const d = l.replace(/\D/g, '');
    if (d.length === 44) return d;
    if (d.length !== 47) throw new Error('Linha digitável inválida');
    return d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  };

  // Etapas informadas ao app (aparecem ao vivo no painel de conferência).
  const passo = t => console.log('[LB] ' + t);

  const addOcorrencia = async ({ nome, valor, historico }, i, total, principal) => {
    const etapa = `a ocorrência ${i + 1} (${nome})`;
    passo(`Ocorrência ${i + 1} de ${total}: ${nome} — R$ ${valor}${historico ? ' — ' + historico : ''}`);
    click(23, 293);
    const w = await waitNewWindow(principal);
    click(w.x + 418, w.y + 67); await sleep(900);
    await type(nome); await sleep(500);
    key('Enter'); await esperar(w.c, etapa, 200, 700);
    click(w.x + 484, w.y + 67); await sleep(400);
    await type(valor); key('Tab'); await sleep(600);
    checar(w.c, etapa);
    if (historico) {
      click(w.x + 266, w.y + 107); await sleep(700);
      key('Home'); await sleep(200);
      await type(historico); await sleep(400);
    }
    click(w.x + 405, w.y + 150);
    // Confirmada = janela da ocorrência fechou e a tela principal voltou a ficar ativa.
    const t0 = Date.now();
    while (Date.now() - t0 < 1800) {
      await sleep(80);
      if (window.__lbAviso) checar(principal, etapa);
      const c = activeCanvas();
      if (c === principal && (!data.rapido || (R.pend === 0 && Date.now() - R.t > 300))) break;
      if (c && c !== principal && c !== w.c) checar(principal, etapa); // abriu outra janela: aviso
    }
    await sleep(120);
    if (data.verificar && activeCanvas() === w.c) throw new Error(`AVISO|${etapa}|A janela da ocorrência não fechou — o Via Imob pode ter recusado o item`);
    checar(principal, etapa);
  };

  // Limpa o campo antes de digitar (pode ter sobrado texto de um boleto anterior que deu erro).
  const limparCampo = async (x, y) => {
    click(x, y); await sleep(250);
    key('End'); for (let i = 0; i < 60; i++) key('Backspace');
    await sleep(150);
  };
  // Fecha a caixa de aviso do Via Imob (Enter, depois Esc). true = a tela principal voltou.
  const fecharAviso = async principal => {
    for (const k of ['Enter', 'Escape', 'Enter']) {
      if (activeCanvas() === principal) return true;
      key(k); await sleep(450);
    }
    return activeCanvas() === principal;
  };

  window.__lbAviso = null;
  const principal = activeCanvas(); // tela "Manutenção encargo"
  let fase = 'codigo';
  try {
    passo('Digitando código identificador: ' + data.codIdentificador);
    await limparCampo(100, 112);
    await type(data.codIdentificador); key('Tab');
    passo('Verificando código identificador no Via Imob…');
    await esperar(principal, 'o código identificador', 300, 2800);
    const barras = linhaParaBarras(data.linhaDigitavel);
    passo('Digitando código de barras: ' + barras);
    fase = 'barras';
    await limparCampo(330, 154);
    await type(barras, 15); key('Tab');
    passo('Verificando código de barras no Via Imob…');
    await esperar(principal, 'o código de barras', 300, 2800);
    fase = 'ocorrencias';
    for (let i = 0; i < data.ocorrencias.length; i++) await addOcorrencia(data.ocorrencias[i], i, data.ocorrencias.length, principal);
    passo('Concluído. Confira o Total e clique em Gravar.');
  } catch (e) {
    if (!String(e.message).startsWith('AVISO|')) throw e;
    // Foto da tela COM o aviso (o app captura ao receber este sinal), depois fecha a caixa.
    console.log('[LB-FOTO]'); await sleep(700);
    passo('Fechando a caixa de aviso do Via Imob…');
    const fechou = await fecharAviso(principal);
    // Pode pular para o próximo boleto só se nada foi adicionado à tela ainda (erro no código ou nas barras).
    const pular = fechou && fase !== 'ocorrencias';
    throw new Error(`${e.message}|${fechou ? 1 : 0}|${pular ? 1 : 0}`);
  }
})();
