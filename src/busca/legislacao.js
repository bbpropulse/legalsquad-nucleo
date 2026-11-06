// Busca no índice local ENXUTO, uma só para legislação e jurisprudência (ambas são documentos do mesmo
// índice, distintas pelo `tipo`). Em camadas:
//
//   1. diploma citado: sigla ou nome na consulta ("LGPD", "marco civil da internet") vira o documento
//      pela tabela `apelido` do índice assinado (a mesma que o `ref resolver` usa);
//   2. FTS do documento (título, ementa, apelidos) com radical em prefixo: AND dos termos e, se não
//      bastar, OR; as duas listas se unem;
//   3. FTS do SUMÁRIO do diploma (`busca_assunto`: títulos de livro, título e capítulo): acha o diploma
//      pelo tema quando o índice não tem texto de artigo (regra 1 do plano da Legis). O artigo certo
//      vem depois, do servidor (`refinarComServidor`, src/busca/enxuto.js);
//   4. reordenação em JS por COBERTURA PONDERADA (cada termo pesa pelo idf do índice), mais bônus por
//      selo conferido, vigência, tipo de norma e centralidade (quantos vínculos chegam nele), e
//      penalidade para revogado e vetado.
//
// Tudo aqui é leitura do índice. Sem rede, sem modelo.
import { normalizar, palavras, radical, STOPWORDS, termoFts } from './texto.js';
import { entradasQueCasam } from './dicionario.js';

const RUIDO = new Set(['artigo', 'art', 'arts', 'artigos', 'inciso', 'paragrafo', 'caput', 'dispositivo']);

/** Tokens da consulta com o radical, sem stopword nem ruído. */
export function termosDaConsulta(q) {
  const vistos = new Set();
  const termos = [];
  for (const p of palavras(q)) {
    if ((STOPWORDS.has(p) && !/\d/.test(p)) || RUIDO.has(p)) continue;
    const r = radical(p);
    if (!r || r.length < 2 || vistos.has(r)) continue;
    vistos.add(r);
    termos.push({ palavra: p, radical: r, numero: /^\d+$/.test(p) });
  }
  return termos;
}

const consultaFts = (termos, op) => termos.map((t) => termoFts(t.radical, { prefixo: !t.numero && t.radical.length >= 3 })).filter(Boolean).join(` ${op} `);

/** Palavras do texto (normalizado) em um Set, mais a lista para testar prefixo. */
function palavrasDe(texto) {
  const lista = normalizar(texto).match(/[a-z0-9]+/g) || [];
  return { set: new Set(lista), lista };
}

function casa(termo, w) {
  if (termo.numero || termo.radical.length < 3) return w.set.has(termo.radical);
  if (w.set.has(termo.radical)) return true;
  for (const x of w.lista) if (x.startsWith(termo.radical)) return true;
  return false;
}

/** Fração do peso da consulta presente no texto. */
export function cobertura(termos, pesos, texto) {
  if (!termos.length) return 0;
  const w = palavrasDe(texto);
  let achou = 0;
  let total = 0;
  for (const t of termos) {
    const p = pesos.get(t.radical) ?? 1;
    total += p;
    if (casa(t, w)) achou += p;
  }
  return total ? achou / total : 0;
}

/** Prepara os pesos (idf) pelo vocabulário do FTS do documento de cada banco. */
function pesosDosTermos(banco, termos) {
  if (banco.pesos) return banco.pesos;
  const pesos = new Map();
  try {
    if (!banco.vocab) {
      banco.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.busca_vocab USING fts5vocab(main, busca, 'row')");
      banco.vocab = true;
      banco.nDocs = banco.db.prepare('SELECT count(*) AS c FROM doc').get().c || 1;
    }
    const st = banco.db.prepare('SELECT coalesce(sum(doc), 0) AS df FROM temp.busca_vocab WHERE term >= ? AND term < ?');
    for (const t of termos) {
      const df = t.numero || t.radical.length < 3 ? Number(banco.db.prepare('SELECT coalesce(sum(doc), 0) AS df FROM temp.busca_vocab WHERE term = ?').get(t.radical).df) : Number(st.get(t.radical, `${t.radical}￿`).df);
      pesos.set(t.radical, Math.log(1 + banco.nDocs / (1 + df)));
    }
  } catch {
    for (const t of termos) pesos.set(t.radical, 1);
  }
  return pesos;
}

const TIPO_PRIOR = { 'Constituição': 0.12, 'Emenda Constitucional': 0.1, 'Lei Complementar': 0.1, 'Lei Ordinária': 0.09, 'Decreto-Lei': 0.09, 'Medida Provisória': 0.05, 'Súmula': 0.08, 'Súmula vinculante': 0.1, 'Decreto': 0.02, 'Portaria': 0.01 };

const SUBTIPOS_DE_RUIDO = /informativo|ata e certid|boletim|termo de coopera|portarias da (?:secretaria|presid|corregedoria)|resolução da câmara|decreto do poder legislativo|resolução do senado/i;
function bonusDoDoc(d) {
  let b = 0;
  if (String(d.id).startsWith('arq:')) b -= 0.2;
  if (d.tipo === 'norma' && SUBTIPOS_DE_RUIDO.test(String(d.subtipo || ''))) b -= 0.12;
  if (d.selo === 'conferido') b += 0.06;
  else if (d.selo === 'divergente') b += 0.02;
  if (d.vigencia === 'vigente') b += 0.05;
  else if (d.vigencia === 'revogado' || /cancelad|revogad/i.test(d.vigencia || '')) b -= 0.25;
  else if (d.vigencia === 'desconhecida') b -= 0.02;
  b += TIPO_PRIOR[d.subtipo] ?? 0;
  return b;
}

const DOC_COLS = 'd.id, d.tipo, d.subtipo, d.uf, d.orgao, d.numero, d.data, d.titulo, d.ementa, d.vigencia, d.selo, d.conferido_em, d.url_oficial, d.area, d.sha256_texto, d.rotulos_artigos, d.assunto';
/** Colunas do documento no índice enxuto: sem `trecho` (o enunciado da súmula e da tese está na `ementa`). */
const docCols = () => DOC_COLS;

function filtroSql(f, params) {
  const w = [];
  if (f.tipo) { w.push('(lower(d.tipo) = lower(?) OR lower(d.subtipo) = lower(?))'); params.push(f.tipo, f.tipo); }
  if (f.tribunal) { w.push('lower(d.orgao) = lower(?)'); params.push(f.tribunal); }
  if (f.uf) { w.push('upper(d.uf) = upper(?)'); params.push(f.uf); }
  if (f.vigente) { w.push("(d.vigencia = 'vigente')"); }
  if (f.desde) { w.push('d.data >= ?'); params.push(f.desde); }
  return w.length ? ` AND ${w.join(' AND ')}` : '';
}

function podarDoc(banco, termos) {
  if (termos.length <= 2 || !banco.vocab) return termos;  // sem vocabulário do documento: não poda
  try {
    const dfs = termos.map((t) => ({ t, df: Number(t.numero || t.radical.length < 3 ? banco.db.prepare('SELECT coalesce(sum(doc), 0) AS df FROM temp.busca_vocab WHERE term = ?').get(t.radical).df : banco.db.prepare('SELECT coalesce(sum(doc), 0) AS df FROM temp.busca_vocab WHERE term >= ? AND term < ?').get(t.radical, `${t.radical}￿`).df) }));
    const raros = dfs.filter((x) => x.df <= banco.nDocs * 0.04).map((x) => x.t);
    return raros.length >= 2 ? raros : dfs.sort((a, b) => a.df - b.df).slice(0, 2).map((x) => x.t);
  } catch { return termos; }
}

function consultar(banco, termos, f, { de = 'norma', limite = 200, raros: rarosDados = null } = {}) {
  // `de`: 'norma' ou 'juris' (restringe o tipo do documento)
  const saida = new Map();
  const bm = 'bm25(busca, 4, 2, 6)'; // título, ementa, apelidos (a FTS do /3 não guarda `doc_id`: o `rowid` é o `rid` do documento)
  const rodar = (m, lim, tabela = 'busca') => {
    if (!m) return;
    // FTS primeiro (subconsulta) e só depois o join com `doc` pelo `rid`: o planejador, se deixado só, varre `doc`.
    const params = [m, lim * 6];
    let tipoSql = '';
    if (de === 'norma') tipoSql = " AND d.tipo = 'norma'";
    else if (de === 'juris') tipoSql = " AND d.tipo = 'jurisprudencia'";
    const sql = `SELECT ${docCols()}, f.r AS r FROM (SELECT rowid AS rid, ${tabela === 'busca' ? bm : `bm25(${tabela})`} AS r FROM ${tabela} WHERE ${tabela} MATCH ? ORDER BY r LIMIT ?) f JOIN doc d ON d.rid = f.rid WHERE 1 = 1${tipoSql}${filtroSql(f, params)} ORDER BY f.r LIMIT ?`;
    params.push(lim);
    try { for (const l of banco.db.prepare(sql).all(...params)) if (!saida.has(l.id)) saida.set(l.id, { ...l, camada: banco.camada }); } catch { /* consulta FTS inválida: ignora */ }
  };
  if (termos.length) {
    rodar(consultaFts(termos, 'AND'), limite);
    // Termos raros: pela base de referência (a nacional, que já tem o vocabulário), uma vez por busca. Cada camada
    // calculando a própria raridade não funcionava: só a nacional tinha `vocab`, então nas outras 153 a poda não
    // rodava e o OR ia com todos os termos ("execu"* OR "fiscal"*), casando quase todo documento (04/11/2026:
    // 1.232 consultas e cerca de 2,4 s por busca com o índice completo).
    const raros = rarosDados || podarDoc(banco, termos);
    rodar(consultaFts(raros, 'OR'), limite);
    // Sumário do diploma (títulos de livro, título e capítulo), quando o índice enxuto o tem: o tema da consulta
    // aparece no nome do capítulo mais vezes do que na ementa. Só acha o DIPLOMA; o artigo vem do texto.
    rodar(consultaFts(termos, 'AND'), 60, 'busca_assunto');
    rodar(consultaFts(raros, 'OR'), 60, 'busca_assunto');
  }
  return saida;
}

/** Documentos citados por sigla ou nome na consulta (apelido exato, em n-gramas de 1 a 6 palavras). */
function diplomasCitados(banco, q) {
  const w = palavras(q);
  const formas = new Set();
  for (let n = 1; n <= Math.min(6, w.length); n += 1) for (let i = 0; i + n <= w.length; i += 1) formas.add(w.slice(i, i + n).join(' '));
  const out = new Map();
  const st = banco.db.prepare('SELECT doc_id FROM apelido WHERE forma = ?');
  for (const f of formas) {
    if (f.length < 2 || STOPWORDS.has(f)) continue;
    for (const r of st.all(f)) if (!out.has(r.doc_id)) out.set(r.doc_id, f);
  }
  return out;
}

function docPorApelido(banco, forma) {
  const r = banco.db.prepare('SELECT doc_id FROM apelido WHERE forma = ? LIMIT 3').all(forma);
  return r.map((x) => x.doc_id);
}

function lerDoc(banco, id) {
  const d = st(banco, 'doc', `SELECT ${docCols()} FROM doc d WHERE d.id = ?`).get(id);
  return d ? { ...d, camada: banco.camada } : null;
}

function st(banco, chave, sql) {
  banco.stmts ??= new Map();
  let s = banco.stmts.get(chave);
  if (!s) { s = banco.db.prepare(sql); banco.stmts.set(chave, s); }
  return s;
}

/** Apelidos (até 40 por documento, ordem da forma) de uma lista de ids, numa consulta: Map id -> texto. */
function apelidosEmLote(banco, ids) {
  const lista = [...ids];
  const saida = new Map();
  if (!lista.length) return saida;
  const linhas = st(banco, 'apel-lote', 'SELECT doc_id AS id, coalesce(exibicao, forma) AS a FROM apelido WHERE doc_id IN (SELECT value FROM json_each(?)) ORDER BY doc_id, forma').all(JSON.stringify(lista));
  const conta = new Map();
  for (const { id, a } of linhas) {
    const n = conta.get(id) || 0;
    if (n >= 40) continue;
    conta.set(id, n + 1);
    saida.set(id, n ? `${saida.get(id)} ${a}` : a);
  }
  return saida;
}

function centralidade(banco, id) {
  try {
    const r = st(banco, 'cent', 'SELECT count(*) AS c FROM vinculo WHERE destino >= ? AND destino < ?').get(id, `${id}#￿`);
    return Math.log1p(Number(r.c)) / Math.log(2000);
  } catch { return 0; }
}

/**
 * Busca de legislação em todos os bancos abertos. `contexto`: { bancos, dic, area }.
 * Devolve `{ resultados, expandida, relaxada, termos }` com até `limite` documentos, cada um com os
 * (os artigos, quando existem, vêm do refino com o texto do servidor).
 */
export function buscarLegislacao(contexto, q, filtros = {}) {
  const T0 = Date.now(); const marca = (n) => { if (process.env.BUSCA_PERFIL) console.error(`  [${Date.now() - T0}ms] ${n}`); };
  const limite = Math.min(50, Math.max(1, Number(filtros.limite) || 10));
  const termos = termosDaConsulta(q);
  const normalizada = normalizar(q);
  const dic = contexto.dic;
  const acrescimo = [];
  for (const e of entradasQueCasam(dic.equivalencias, normalizada)) for (const x of e.acrescentar) if (!termos.some((t) => t.radical === radical(x)) && !acrescimo.some((t) => t.radical === radical(x))) acrescimo.push({ palavra: x, radical: radical(x), numero: /^\d+$/.test(x) });
  const assuntos = new Set();
  for (const e of entradasQueCasam(dic.assuntos, normalizada)) for (const d of e.diplomas) assuntos.add(d);
  const area = contexto.areaInfo;
  if (area) for (const d of area.diplomas || []) assuntos.add(d);

  const todos = new Map();
  const docsFoco = new Map(); // doc_id -> 'citado' | 'assunto'
  let relaxada = false;

  // Pesos (idf) uma vez só, pelo vocabulário do FTS do documento do primeiro banco (a nacional).
  const todosTermos = [...termos, ...acrescimo];
  const base = contexto.bancos[0];
  const pesos = base ? pesosDosTermos(base, todosTermos) : new Map();
  const rarosCache = new Map(); // a lista muda por camada (o nome do diploma citado sai); cada lista distinta é podada uma vez
  const rarosDe = (lista) => {
    if (!base || !lista.length) return null;
    const chave = lista.map((t) => t.radical).join('|');
    if (!rarosCache.has(chave)) rarosCache.set(chave, podarDoc(base, lista));
    return rarosCache.get(chave);
  };
  for (const banco of contexto.bancos) {
    const cit = diplomasCitados(banco, q);
    if ((filtros.de || 'norma') === 'norma') for (const [id] of cit) docsFoco.set(id, 'citado');
    if ((filtros.de || 'norma') === 'norma') for (const s of assuntos) for (const id of docPorApelido(banco, s)) if (!docsFoco.has(id)) docsFoco.set(id, 'assunto');

    // Termos que NÃO são o nome do diploma citado: a busca de conteúdo procura o resto.
    const formasCitadas = new Set([...cit.values()].flatMap((f) => f.split(' ')));
    const termosTema = termos.filter((t) => !formasCitadas.has(t.palavra) || t.numero);
    const alvo = termosTema.length ? termosTema : termos;

    const principais = alvo.length ? alvo : termos;
    marca(`banco ${banco.camada}`);
    const c1 = consultar(banco, principais, filtros, { de: filtros.de || 'norma', raros: rarosDe(principais) });
    if (!c1.size && principais.length > 1) relaxada = true;
    const comAcrescimo = acrescimo.length ? [...principais, ...acrescimo] : principais;
    marca('c1');
    const c2 = acrescimo.length ? consultar(banco, comAcrescimo, filtros, { de: filtros.de || 'norma', limite: 120, raros: rarosDe(comAcrescimo) }) : new Map();
    const docsCand = new Map([...c1, ...c2]);

    marca('c1/c2');
    for (const [id] of docsFoco) if (!docsCand.has(id)) { const d = lerDoc(banco, id); if (d) docsCand.set(id, d); }

    // Apelidos de todos os candidatos da camada numa consulta só (antes: uma por candidato, cerca de 9 mil
    // por busca com o índice completo, 1,2 a 1,5 s). Mesmos 40 por documento, na ordem do índice (forma).
    const apelidosDe = apelidosEmLote(banco, docsCand.keys());
    for (const [id, d] of docsCand) {
      // Cada lista só tem o seu tipo: a de jurisprudência nunca recebe norma (diploma citado, conteúdo ou assunto) e vice-versa.
      if (d.tipo !== ((filtros.de || 'norma') === 'juris' ? 'jurisprudencia' : 'norma')) continue;
      if (filtros.vigente && d.vigencia !== 'vigente') continue;
      if (filtros.tipo && !(String(d.tipo).toLowerCase() === filtros.tipo.toLowerCase() || String(d.subtipo).toLowerCase() === filtros.tipo.toLowerCase())) continue;
      if (filtros.uf && String(d.uf || '').toUpperCase() !== String(filtros.uf).toUpperCase()) continue;
      if (filtros.tribunal && String(d.orgao || '').toLowerCase() !== String(filtros.tribunal).toLowerCase()) continue;
      if (filtros.desde && String(d.data || '') < filtros.desde) continue;
      const texto = `${d.titulo || ''} ${d.ementa || ''}${d.assunto ? ` ${d.assunto}` : ''}`;
      const apelidos = apelidosDe.get(id) || '';
      const covDoc = cobertura(alvo, pesos, `${texto} ${apelidos}`);
      const covX = acrescimo.length ? cobertura(acrescimo, pesos, `${texto} ${apelidos}`) : 0;
      const covDisp = 0;
      const foco = docsFoco.get(id);
      let nota = 1.0 * covDoc + 0.15 * covX;
      // Bônus de diploma: citado pelo nome vale muito; do assunto/área vale menos e só soma com conteúdo.
      if (foco === 'citado') nota += 0.6;
      else if (foco === 'assunto') nota += 0.1;
      // Documento só pelo diploma (sem nenhum termo): não sobe.
      // (O diploma do assunto fica quando a busca vai refinar com o texto do servidor: o artigo dele é que decide.)
      if (covDoc === 0 && foco !== 'citado' && !(filtros.manterFoco && foco === 'assunto')) continue;
      nota += bonusDoDoc(d) + 0.08 * centralidade(banco, id);
      const prev = todos.get(id);
      if (!prev || prev.nota < nota) todos.set(id, { ...d, nota: Number(nota.toFixed(4)), dispositivos: [], foco: foco || null, cobertura: Number(covDoc.toFixed(3)), cobertura_dispositivo: Number(covDisp.toFixed(3)), _banco: banco.camada });
    }
  }
  const ordenados = [...todos.values()].sort((a, b) => b.nota - a.nota);
  let resultados = ordenados.slice(0, limite);
  // Índice enxuto com servidor: os diplomas citados e os do assunto vão para o refinamento por artigo mesmo
  // com a nota do documento baixa (o artigo deles é que decide).
  if (filtros.manterFoco) resultados = [...resultados, ...ordenados.slice(limite).filter((d) => d.foco)];
  // `interno` serve ao refinamento por artigo com o texto do servidor (src/busca/enxuto.js): os termos, o
  // acréscimo do dicionário, os pesos e as formas do diploma citado, como a busca os usou.
  const formasCitadasTodas = new Set();
  for (const banco of contexto.bancos) for (const f of diplomasCitados(banco, q).values()) for (const w of f.split(' ')) formasCitadasTodas.add(w);
  return { resultados, relaxada, expandida: acrescimo.map((x) => x.palavra), termos: termos.map((t) => t.radical), diplomas: [...docsFoco.entries()].filter(([, v]) => v === 'citado').map(([k]) => k), interno: { termos, acrescimo, pesos, formasCitadas: formasCitadasTodas, limite } };
}

export { bonusDoDoc, centralidade, docCols, lerDoc };
