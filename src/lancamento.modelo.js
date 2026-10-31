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

  const activeCanvas = () => document.querySelector('.dwmwindow.active canvas');
  const waitNewWindow = async prev => {
    const t = Date.now();
    while (Date.now() - t < 8000) { const c = activeCanvas(); if (c && c !== prev) { await sleep(400); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; } await sleep(150); }
    throw new Error('Janela "Edição item encargo" não abriu');
  };

  const linhaParaBarras = l => {
    const d = l.replace(/\D/g, '');
    if (d.length === 44) return d;
    if (d.length !== 47) throw new Error('Linha digitável inválida');
    return d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  };

  const addOcorrencia = async ({ nome, valor, historico }) => {
    const prev = activeCanvas();
    click(23, 293);
    const w = await waitNewWindow(prev);
    click(w.x + 418, w.y + 67); await sleep(900);
    await type(nome); await sleep(500);
    key('Enter'); await sleep(700);
    click(w.x + 484, w.y + 67); await sleep(400);
    await type(valor); key('Tab'); await sleep(600);
    if (historico) {
      click(w.x + 266, w.y + 107); await sleep(700);
      key('Home'); await sleep(200);
      await type(historico); await sleep(400);
    }
    click(w.x + 405, w.y + 150); await sleep(1800);
  };

  // ===== DADOS DO BOLETO =====
  const data = /*__DADOS__*/;
  // ===========================

  click(100, 112); await sleep(500);
  await type(data.codIdentificador); key('Tab'); await sleep(2800);
  click(330, 154); await sleep(500);
  await type(linhaParaBarras(data.linhaDigitavel), 15); key('Tab'); await sleep(2800);
  for (const o of data.ocorrencias) await addOcorrencia(o);
  console.log('Lançamento concluído. Confira o Total e clique em Gravar.');
})();
