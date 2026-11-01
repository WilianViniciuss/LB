// Banco de dados local (SQLite embutido no Node — sem instalação extra).
// Arquivo: dados/boletopro.db. Cópias de segurança diárias em dados/backup/ (últimas 7).
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync;
try {
  // Silencia o aviso "experimental" do node:sqlite (só esse aviso).
  const emitir = process.emitWarning;
  process.emitWarning = (w, ...r) => (String(w?.message ?? w).includes('SQLite') ? undefined : emitir.call(process, w, ...r));
  ({ DatabaseSync } = await import('node:sqlite'));
  process.emitWarning = emitir;
} catch {
  throw new Error('Este Node.js não tem SQLite embutido. Atualize para o Node.js 22.13 ou superior (https://nodejs.org).');
}

const agora = () => new Date().toISOString();
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const centavos = v => {
  const n = parseFloat(String(v ?? '').trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const dataBR = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const escLike = s => s.replace(/[\\%_]/g, c => '\\' + c);
// Linha digitável comparada só pelos dígitos (espaços/pontos diferentes não escapam da checagem de duplicidade).
const soDigitos = s => String(s ?? '').replace(/\D/g, '') || null;

// Campos que vivem em colunas próprias (não vão no JSON "dados").
const COLUNAS = ['id', 'status', 'extraidoEm', 'lancadoEm', 'gravadoEm', 'arquivado', 'condominioId', 'linkId', 'temCaptura'];

export function abrirBanco(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, 'boletopro.db');
  const db = new DatabaseSync(arquivo);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS condominios (
      id INTEGER PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
      criado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      condominio_id INTEGER REFERENCES condominios(id) ON DELETE SET NULL,
      unidade TEXT,
      criado_em TEXT NOT NULL,
      ultima_extracao TEXT,
      ultimo_erro TEXT
    );
    CREATE TABLE IF NOT EXISTS boletos (
      id INTEGER PRIMARY KEY,
      link_id INTEGER REFERENCES links(id) ON DELETE SET NULL,
      condominio_id INTEGER REFERENCES condominios(id) ON DELETE SET NULL,
      linha_digitavel TEXT,
      status TEXT NOT NULL,
      problema INTEGER NOT NULL DEFAULT 0,
      valor_centavos INTEGER,
      vencimento TEXT,
      extraido_em TEXT,
      lancado_em TEXT,
      gravado_em TEXT,
      arquivado INTEGER NOT NULL DEFAULT 0,
      tem_captura INTEGER NOT NULL DEFAULT 0,
      busca TEXT NOT NULL DEFAULT '',
      dados TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS duplicidades (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      boleto_id INTEGER REFERENCES boletos(id) ON DELETE SET NULL,
      motivo TEXT NOT NULL,
      detectado_em TEXT NOT NULL,
      busca TEXT NOT NULL DEFAULT '',
      dados TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_dup_data ON duplicidades(detectado_em);
    -- Fila de extração persistente: o link só sai daqui depois de processado.
    CREATE TABLE IF NOT EXISTS fila_extracao (url TEXT PRIMARY KEY, ordem INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS controle (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE INDEX IF NOT EXISTS ix_links_cond ON links(condominio_id);
    CREATE INDEX IF NOT EXISTS ix_bol_linha ON boletos(linha_digitavel);
    CREATE INDEX IF NOT EXISTS ix_bol_link ON boletos(link_id);
    CREATE INDEX IF NOT EXISTS ix_bol_cond ON boletos(condominio_id);
    DROP INDEX IF EXISTS ix_bol_arq;
    CREATE INDEX IF NOT EXISTS ix_bol_status ON boletos(status);
    CREATE INDEX IF NOT EXISTS ix_bol_lanc ON boletos(lancado_em);
  `);

  // Migrações de versões anteriores (idempotentes).
  const colunas = new Set(db.prepare('PRAGMA table_info(boletos)').all().map(c => c.name));
  if (!colunas.has('tem_captura')) db.exec('ALTER TABLE boletos ADD COLUMN tem_captura INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE boletos SET tem_captura = 1 WHERE tem_captura = 0 AND json_extract(dados, '$.temCaptura') = 1;
    UPDATE boletos SET linha_digitavel = replace(replace(linha_digitavel, ' ', ''), '.', '') WHERE linha_digitavel GLOB '*[ .]*';
  `);

  // Prepared statements reaproveitados (mais rápido e imune a SQL injection).
  const st = {
    condPorNome: db.prepare('SELECT id FROM condominios WHERE nome = ?'),
    condCriar: db.prepare('INSERT INTO condominios (nome, criado_em) VALUES (?, ?) RETURNING id'),
    condExiste: db.prepare('SELECT id FROM condominios WHERE id = ?'),
    linkUpsert: db.prepare(`
      INSERT INTO links (url, condominio_id, unidade, criado_em, ultima_extracao, ultimo_erro) VALUES ($url, $cond, $unid, $agora, $agora, $erro)
      ON CONFLICT(url) DO UPDATE SET condominio_id = COALESCE(excluded.condominio_id, condominio_id),
        unidade = COALESCE(excluded.unidade, unidade), ultima_extracao = excluded.ultima_extracao, ultimo_erro = excluded.ultimo_erro
      RETURNING id`),
    linkVincular: db.prepare(`
      INSERT INTO links (url, condominio_id, criado_em) VALUES (?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET condominio_id = excluded.condominio_id`),
    linkRemover: db.prepare('DELETE FROM links WHERE id = ?'),
    bolPorLinha: db.prepare('SELECT * FROM boletos WHERE linha_digitavel = ? ORDER BY id DESC LIMIT 1'),
    bolErroDoLink: db.prepare("SELECT * FROM boletos WHERE link_id = ? AND status <> 'lancado' AND linha_digitavel IS NULL ORDER BY id DESC LIMIT 1"),
    bolPorId: db.prepare('SELECT * FROM boletos WHERE id = ?'),
    bolInserir: db.prepare(`
      INSERT INTO boletos (link_id, condominio_id, linha_digitavel, status, problema, valor_centavos, vencimento, extraido_em, lancado_em, tem_captura, busca, dados)
      VALUES ($link, $cond, $linha, $status, $problema, $valor, $venc, $extraido, $lancado, $captura, $busca, $dados) RETURNING id`),
    bolAtualizar: db.prepare(`
      UPDATE boletos SET link_id = $link, condominio_id = $cond, linha_digitavel = $linha, status = $status, problema = $problema,
        valor_centavos = $valor, vencimento = $venc, extraido_em = $extraido, lancado_em = $lancado, tem_captura = $captura,
        busca = $busca, dados = $dados WHERE id = $id`),
    lote: db.prepare("SELECT * FROM boletos WHERE status <> 'lancado' ORDER BY id"),
    limparPendentes: db.prepare("DELETE FROM boletos WHERE status NOT IN ('lancado', 'lancando') RETURNING id"),
    excluir: db.prepare("DELETE FROM boletos WHERE id = ? AND status NOT IN ('lancado', 'lancando')"),
    limparHistorico: db.prepare("DELETE FROM boletos WHERE status = 'lancado' RETURNING id"),
    excluirLancado: db.prepare("DELETE FROM boletos WHERE id = ? AND status = 'lancado' RETURNING id"),
    jaLancado: db.prepare("SELECT id, lancado_em FROM boletos WHERE linha_digitavel = ? AND status = 'lancado' AND id <> ? LIMIT 1"),
    dupInserir: db.prepare('INSERT INTO duplicidades (url, boleto_id, motivo, detectado_em, busca, dados) VALUES (?, ?, ?, ?, ?, ?)'),
    dupContar: db.prepare('SELECT COUNT(*) n FROM duplicidades'),
    dupRemover: db.prepare('DELETE FROM duplicidades WHERE id = ?'),
    dupLimpar: db.prepare('DELETE FROM duplicidades'),
    filaAdd: db.prepare('INSERT OR IGNORE INTO fila_extracao (url, ordem) VALUES (?, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM fila_extracao))'),
    filaProx: db.prepare('SELECT url FROM fila_extracao ORDER BY ordem LIMIT ?'),
    filaDel: db.prepare('DELETE FROM fila_extracao WHERE url = ?'),
    filaCount: db.prepare('SELECT COUNT(*) n FROM fila_extracao'),
    filaClear: db.prepare('DELETE FROM fila_extracao'),
    kvGet: db.prepare('SELECT valor FROM controle WHERE chave = ?'),
    kvSet: db.prepare('INSERT INTO controle (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
    kvDel: db.prepare('DELETE FROM controle WHERE chave = ?'),
    contar: db.prepare('SELECT COUNT(*) n FROM boletos')
  };

  const transacao = fn => (...a) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const linhaParaObj = r => r && ({
    ...JSON.parse(r.dados), id: r.id, status: r.status, extraidoEm: r.extraido_em, lancadoEm: r.lancado_em,
    condominioId: r.condominio_id, linkId: r.link_id, temCaptura: !!r.tem_captura
  });

  const parametros = b => {
    const dados = {};
    for (const [k, v] of Object.entries(b)) if (!COLUNAS.includes(k) && v !== undefined) dados[k] = v;
    return {
      $link: b.linkId ?? null, $cond: b.condominioId ?? null, $linha: soDigitos(b.linhaDigitavel),
      $status: b.status || 'pendente', $problema: b.problemas?.length ? 1 : 0,
      $valor: centavos(b.conferencia?.valorDocumento ?? b.valorTotal), $venc: dataBR(b.vencimento),
      $extraido: b.extraidoEm || null, $lancado: b.lancadoEm || null, $captura: b.temCaptura ? 1 : 0, $dados: JSON.stringify(dados),
      $busca: norm([b.condominio, b.unidade, b.codIdentificador, b.linhaDigitavel, b.vencimento,
        b.conferencia?.valorDocumento, b.link, ...(b.ocorrencias || []).flatMap(o => [o.nome, o.itemOriginal, o.historico])].filter(Boolean).join(' '))
    };
  };

  const idCondominio = nome => {
    nome = String(nome || '').trim();
    if (!nome) return null;
    return st.condPorNome.get(nome)?.id ?? st.condCriar.get(nome, agora()).id;
  };

  const inserir = b => { const id = st.bolInserir.get(parametros(b)).id; return { ...b, id }; };
  const atualizar = b => { st.bolAtualizar.run({ ...parametros(b), $id: b.id }); return b; };

  const dataCurta = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR'); };

  /** Registra um boleto extraído. Se o mesmo boleto (mesma linha digitável) já existe — lançado ou
   *  ainda pendente — o novo é ignorado e vai para a lista de duplicidades. */
  const registrarExtracao = transacao(b => {
    const condominioId = idCondominio(b.condominio);
    const linkId = st.linkUpsert.get({ $url: b.link, $cond: condominioId, $unid: b.unidade || null, $agora: agora(),
      $erro: b.erroExtracao || null }).id;
    const novo = { ...b, condominioId, linkId };
    const linha = soDigitos(b.linhaDigitavel);
    if (linha) {
      const ex = linhaParaObj(st.bolPorLinha.get(linha));
      // Ainda não lançado e com problema (ex.: mapeamento corrigido no config): atualiza com os dados novos.
      if (ex && ex.status !== 'lancado' && ex.status !== 'lancando' && ex.problemas?.length)
        return { boleto: atualizar({ ...novo, id: ex.id, temCaptura: ex.temCaptura }), duplicado: null };
      if (ex) {
        const motivo = ex.status === 'lancado'
          ? `Boleto já lançado${ex.lancadoEm ? ' em ' + dataCurta(ex.lancadoEm) : ''} (registro #${ex.id})`
          : `Boleto já está na lista para lançar (registro #${ex.id})`;
        const p = parametros(novo);
        st.dupInserir.run(b.link, ex.id, motivo, agora(), p.$busca, p.$dados);
        return { boleto: null, duplicado: { motivo, boletoId: ex.id } };
      }
      return { boleto: inserir(novo), duplicado: null };
    }
    // Falha de extração / sem linha digitável: substitui o erro anterior do mesmo link (não acumula).
    const ex = linhaParaObj(st.bolErroDoLink.get(linkId));
    if (ex && ex.status !== 'lancado') return { boleto: atualizar({ ...novo, id: ex.id, status: novo.status }), duplicado: null };
    return { boleto: inserir(novo), duplicado: null };
  });

  // ---------- Duplicidades ----------
  function duplicidades(f = {}) {
    const onde = [], p = [];
    for (const t of norm(f.busca).split(/\s+/).filter(Boolean).slice(0, 10)) { onde.push("d.busca LIKE ? ESCAPE '\\'"); p.push(`%${escLike(t)}%`); }
    const where = onde.length ? 'WHERE ' + onde.join(' AND ') : '';
    const limite = Math.min(Math.max(Number(f.limite) || 500, 1), 100000);
    const total = db.prepare(`SELECT COUNT(*) n FROM duplicidades d ${where}`).get(...p).n;
    const itens = db.prepare(`SELECT d.*, b.status orig_status, b.lancado_em orig_lancado FROM duplicidades d
      LEFT JOIN boletos b ON b.id = d.boleto_id ${where} ORDER BY d.id DESC LIMIT ?`).all(...p, limite)
      .map(r => ({ ...JSON.parse(r.dados), id: r.id, link: r.url, boletoId: r.boleto_id, motivo: r.motivo, detectadoEm: r.detectado_em,
        original: r.boleto_id ? { status: r.orig_status, lancadoEm: r.orig_lancado } : null }));
    return { total, itens };
  }

  // ---------- Histórico com filtros (SQL) ----------
  const ORDENS = {
    idx: 'b.id', cod: "json_extract(b.dados, '$.codIdentificador')", cond: "c.nome COLLATE NOCASE, json_extract(b.dados, '$.unidade')",
    unid: "json_extract(b.dados, '$.unidade')", venc: 'b.vencimento', valor: 'b.valor_centavos', lanc: 'b.lancado_em', status: 'b.status'
  };
  const DATAS = { lancadoEm: "date(b.lancado_em, 'localtime')",
    extraidoEm: "date(b.extraido_em, 'localtime')", vencimento: 'b.vencimento' };

  function historico(f = {}) {
    const onde = [], p = [];
    for (const t of norm(f.busca).split(/\s+/).filter(Boolean).slice(0, 10)) { onde.push("b.busca LIKE ? ESCAPE '\\'"); p.push(`%${escLike(t)}%`); }
    if (f.cond === 'sem') onde.push('b.condominio_id IS NULL');
    else if (/^\d+$/.test(f.cond || '')) { onde.push('b.condominio_id = ?'); p.push(Number(f.cond)); }
    onde.push("b.status = 'lancado'"); // Histórico = somente boletos lançados no Via Imob
    const col = DATAS[f.dataTipo] || DATAS.lancadoEm;
    if (DIA.test(f.de || '')) { onde.push(`${col} >= ?`); p.push(f.de); }
    if (DIA.test(f.ate || '')) { onde.push(`${col} <= ?`); p.push(f.ate); }
    const min = centavos(f.min), max = centavos(f.max);
    if (min !== null) { onde.push('b.valor_centavos >= ?'); p.push(min); }
    if (max !== null) { onde.push('b.valor_centavos <= ?'); p.push(max); }
    const where = onde.length ? 'WHERE ' + onde.join(' AND ') : '';
    const ordem = ORDENS[f.ordem] || ORDENS.idx;
    const dir = Number(f.dir) > 0 ? 'ASC' : 'DESC';
    const limite = Math.min(Math.max(Number(f.limite) || 200, 1), 100000);
    const desloc = Math.max(Number(f.desloc) || 0, 0);
    const base = `FROM boletos b LEFT JOIN condominios c ON c.id = b.condominio_id ${where}`;
    const tot = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(b.valor_centavos), 0) soma ${base}`).get(...p);
    const itens = db.prepare(`SELECT b.* ${base} ORDER BY ${ordem.split(',').map(x => `${x} ${dir}`).join(', ')}, b.id ${dir} LIMIT ? OFFSET ?`)
      .all(...p, limite, desloc).map(linhaParaObj);
    return { total: tot.n, somaCentavos: tot.soma, itens };
  }

  // ---------- Condomínios e links ----------
  const condominios = () => {
    const lista = db.prepare(`
      SELECT c.id, c.nome,
        (SELECT COUNT(*) FROM links l WHERE l.condominio_id = c.id) links,
        (SELECT COUNT(*) FROM boletos b WHERE b.condominio_id = c.id) boletos,
        (SELECT COUNT(*) FROM boletos b WHERE b.condominio_id = c.id AND b.status = 'lancado') lancados,
        (SELECT MAX(lancado_em) FROM boletos b WHERE b.condominio_id = c.id) ultimoLancamento,
        (SELECT MAX(ultima_extracao) FROM links l WHERE l.condominio_id = c.id) ultimaExtracao
      FROM condominios c ORDER BY c.nome COLLATE NOCASE`).all().map(r => ({ ...r }));
    const semCond = db.prepare('SELECT COUNT(*) n FROM links WHERE condominio_id IS NULL').get().n;
    return { condominios: lista, linksSemCondominio: semCond };
  };
  const linksDe = condId => db.prepare(`
    SELECT id, url, unidade, ultima_extracao ultimaExtracao, ultimo_erro ultimoErro FROM links
    WHERE ${condId === 'sem' ? 'condominio_id IS NULL' : 'condominio_id = ?'} ORDER BY unidade COLLATE NOCASE, url`)
    .all(...(condId === 'sem' ? [] : [Number(condId)])).map(r => ({ ...r }));
  const criarCondominio = nome => { if (!String(nome || '').trim()) throw new Error('Informe o nome'); return idCondominio(nome); };
  const vincularLinks = transacao((condId, urls) => {
    const id = condId === 'sem' ? null : Number(condId);
    if (id !== null && !st.condExiste.get(id)) throw new Error('Condomínio não encontrado');
    for (const u of urls) st.linkVincular.run(u, id, agora());
    return urls.length;
  });
  const removerLink = id => st.linkRemover.run(Number(id)).changes;

  // ---------- Migração do antigo plano_lote.json ----------
  const importarJson = transacao(boletos => {
    let n = 0;
    for (const b of boletos) {
      if (!b || !b.link) continue;
      const condominioId = idCondominio(b.condominio);
      const linkId = st.linkUpsert.get({ $url: b.link, $cond: condominioId, $unid: b.unidade || null, $agora: b.extraidoEm || agora(), $erro: b.erroExtracao || null }).id;
      inserir({ ...b, condominioId, linkId, status: b.status === 'lancando' ? 'pendente' : (b.status || 'pendente') });
      n++;
    }
    return n;
  });

  // ---------- Backup diário ----------
  function backupDiario() {
    try {
      const dirB = path.join(dir, 'backup');
      fs.mkdirSync(dirB, { recursive: true });
      const hoje = new Date().toISOString().slice(0, 10);
      const alvo = path.join(dirB, `boletopro-${hoje}.db`);
      if (!fs.existsSync(alvo) && st.contar.get().n > 0) db.prepare('VACUUM INTO ?').run(alvo);
      fs.readdirSync(dirB).filter(f => /^boletopro-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7)
        .forEach(f => fs.rmSync(path.join(dirB, f), { force: true }));
    } catch (e) { console.error('Backup falhou:', e.message); }
  }

  // Lançamentos interrompidos (app fechado no meio) voltam para pendente.
  db.exec("UPDATE boletos SET status = 'pendente' WHERE status = 'lancando'");
  // Versões anteriores tinham a etapa manual "gravado": passa a ser simplesmente "lançado".
  db.exec("UPDATE boletos SET status = 'lancado', lancado_em = COALESCE(lancado_em, gravado_em) WHERE status = 'gravado'");

  return {
    arquivo,
    loteAtual: () => st.lote.all().map(linhaParaObj),
    porId: id => linhaParaObj(st.bolPorId.get(Number(id))),
    registrarExtracao, atualizar, historico,
    limparPendentes: () => st.limparPendentes.all().map(r => r.id),
    // Histórico: apaga boletos lançados (todos ou os escolhidos). Devolve os ids apagados.
    limparHistorico: () => st.limparHistorico.all().map(r => r.id),
    excluirLancados: transacao(ids => ids.flatMap(id => st.excluirLancado.all(Number(id)).map(r => r.id))),
    excluir: id => st.excluir.run(Number(id)).changes,
    jaLancado: (linha, id) => (soDigitos(linha) ? st.jaLancado.get(soDigitos(linha), Number(id) || 0) : null),
    // Pré-checagem barata (antes da foto): já existe boleto com essa linha que não seria atualizado?
    seriaDuplicado: linha => {
      const ex = soDigitos(linha) && linhaParaObj(st.bolPorLinha.get(soDigitos(linha)));
      return !!ex && !(ex.status !== 'lancado' && ex.status !== 'lancando' && ex.problemas?.length);
    },
    duplicidades, contarDuplicidades: () => st.dupContar.get().n,
    removerDuplicidade: id => st.dupRemover.run(Number(id)).changes,
    limparDuplicidades: () => st.dupLimpar.run().changes,
    // Fila de extração
    filaAdicionar: transacao(urls => urls.reduce((n, u) => n + Number(st.filaAdd.run(u).changes), 0)),
    filaProxima: ignorar => st.filaProx.all(ignorar.size + 1).map(r => r.url).find(u => !ignorar.has(u)) ?? null,
    filaRemover: url => st.filaDel.run(url).changes,
    filaContar: () => st.filaCount.get().n,
    filaLimpar: () => st.filaClear.run().changes,
    // Controle (chave → JSON)
    kvLer: k => { const r = st.kvGet.get(k); try { return r ? JSON.parse(r.valor) : null; } catch { return null; } },
    kvGravar: (k, v) => (v == null ? st.kvDel.run(k) : st.kvSet.run(k, JSON.stringify(v))),
    condominios, linksDe, criarCondominio, vincularLinks, removerLink,
    importarJson, backupDiario, vazio: () => st.contar.get().n === 0,
    fechar: () => { try { db.close(); } catch {} }
  };
}
