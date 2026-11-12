// O julgado, a súmula e o tema citados pelo número na consulta da busca, e a preferência pela justiça da
// área. Medido em 11/11/2026 (gabarito de 30 consultas dos runs reais, dados/busca/gabarito-jurisprudencia.json):
// "REsp 1.978.268" devolvia a Súmula 268 do STJ, "EAREsp 676.608" julgados de TJ sem relação, "Súmula 437
// do TST" súmulas de TRT, "Tema 1.076 do STJ" informativos; e, num caso de consumo, "direito de
// arrependimento curso online" punha no topo um julgado de teletrabalho do TRT18. Base: 17 de 30.
import { normalizar, palavras, radical, STOPWORDS } from './texto.js';

// As classes de julgado que a peça cita pelo número. A ordem importa: a mais longa antes (EAREsp antes de AREsp).
const CLASSES = ['EAREsp', 'AREsp', 'EREsp', 'REsp', 'RHC', 'HC', 'RMS', 'MS', 'Rcl', 'ADPF', 'ADI', 'ADC', 'ARE', 'RE', 'CC', 'IRDR', 'PUIL', 'RR', 'AIRR'];
const CLASSES_DO_STF = new Set(['RE', 'ARE', 'ADI', 'ADC', 'ADPF', 'Rcl']);
const RE_JULGADO = new RegExp(`(?<![\\p{L}])(${CLASSES.join('|')})\\s*(?:n[º°o.]\\s*)?(\\d{1,3}(?:\\.\\d{3})+|\\d{3,})(?:\\s*[-/]\\s*([A-Z]{2})(?![\\p{L}]))?`, 'gu');

/** Os julgados citados pelo número: `{ classe, numero (só dígitos), uf, bruto }`. */
export function julgadosNaConsulta(q) {
  const out = [];
  for (const m of String(q || '').matchAll(RE_JULGADO)) out.push({ classe: m[1], numero: m[2].replace(/\./g, ''), uf: m[3] || null, bruto: m[0].trim() });
  return out;
}

/** A forma com que o número aparece no título do índice ("2.114.283") e a sem ponto ("2114283"). */
function formasDoNumero(n) {
  const comPonto = n.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return [...new Set([comPonto, n])];
}

/** Os documentos de jurisprudência cujo TÍTULO é o julgado (a classe e o número, com ou sem ponto). */
export function documentosDoJulgado(bancos, j, { lerDoc, docCols }) {
  // Sem consulta de frase: a camada gravada com `detail` menor que full não a aceita. A classe e cada
  // grupo do número no título, juntos; o regex confere a ordem.
  const frases = formasDoNumero(j.numero).map((f) => `(${[j.classe.toLowerCase(), ...f.split('.')].map((t) => `"${t}"`).join(' AND ')})`);
  const confere = new RegExp(`(?<![\\p{L}])${j.classe}\\s*(?:n[º°o.]\\s*)?${j.numero.split('').join('\\.?')}(?!\\d)`, 'u');
  const achados = new Map();
  for (const banco of bancos) {
    let linhas = [];
    try {
      linhas = banco.db.prepare(`SELECT ${docCols()} FROM (SELECT rowid AS rid FROM busca WHERE busca MATCH ? LIMIT 400) f JOIN doc d ON d.rid = f.rid WHERE d.tipo = 'jurisprudencia'`).all(`titulo : (${frases.join(' OR ')})`);
    } catch { linhas = []; }
    for (const d of linhas) if (confere.test(String(d.titulo || '')) && !achados.has(d.id)) achados.set(d.id, { ...d, camada: banco.camada, foco: 'citado', nota: 10 });
  }
  void lerDoc;
  return [...achados.values()];
}

/** O que sobra da consulta sem as citações: com nada ou quase nada, a consulta é só o número. */
export function soCitacao(q, citacoes) {
  let resto = String(q || '');
  for (const c of citacoes) resto = resto.replace(c, ' ');
  const sobra = palavras(resto.replace(/\b(?:do|da|de|no|na|STJ|STF|TST|TSE|STM|TNU|TRF\d?|TRT\d{0,2}|TJ[A-Z]{2}|Rel\.?|Min\.?|Terceira|Quarta|Turma|Corte|Especial|Seção|Primeira|Segunda|Quinta|Sexta)\b/gi, ' '))
    .filter((w) => !STOPWORDS.has(w) && !/^\d+$/.test(w) && w.length > 2);
  return sobra.length === 0;
}

/** O aviso do julgado que não está no índice: onde ele vem pela fonte oficial. */
export function avisoDeJulgadoAusente(j) {
  const nome = `${j.classe} ${formasDoNumero(j.numero)[0]}${j.uf ? `/${j.uf}` : ''}`;
  const onde = CLASSES_DO_STF.has(j.classe)
    ? 'pela fonte oficial do STF (portal.stf.jus.br, a pesquisa de jurisprudência)'
    : ['RR', 'AIRR'].includes(j.classe)
      ? 'pela fonte oficial do TST (jurisprudencia.tst.jus.br)'
      : `pela fonte oficial do STJ: node scripts/fonte-oficial.mjs --stj "${nome}" --out <pasta do run>/fontes`;
  return `${nome} não está no índice desta máquina (o índice tem os julgados dos informativos, das teses e dos temas, não todo acórdão); o inteiro teor vem ${onde}`;
}

// ── A justiça da área ────────────────────────────────────────────────────────────────────────────

/** A família do órgão julgador: stf, stj, tst, tse, stm, tcu, tnu, trt, trf, tre, tj, carf ou outro. */
export function familiaDoOrgao(orgao) {
  const o = String(orgao || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (['STF', 'STJ', 'TST', 'TSE', 'STM', 'TCU', 'TNU', 'CARF'].includes(o)) return o.toLowerCase();
  if (/^TRT/.test(o)) return 'trt';
  if (/^TRF/.test(o)) return 'trf';
  if (/^TRE/.test(o)) return 'tre';
  if (/^TJ/.test(o)) return 'tj';
  return 'outro';
}

// As justiças que julgam cada área (a chave é a do dicionário, `areas` de dados/busca/dicionario.json).
const JUSTICAS_DA_AREA = {
  trabalho: ['tst', 'trt', 'stf'],
  previdenciario: ['stj', 'stf', 'trf', 'tnu', 'tj'],
  eleitoral: ['tse', 'tre', 'stf'],
  penal: ['stj', 'stf', 'tj', 'trf', 'stm'],
  administrativo: ['stf', 'stj', 'tj', 'trf', 'tcu'],
  tributario: ['stj', 'stf', 'trf', 'tj', 'carf'],
};
const JUSTICAS_COMUNS = ['stj', 'stf', 'tj', 'trf', 'tnu'];
const SUPERIORES = new Set(['stf', 'stj', 'tst', 'tse']);

/**
 * O ajuste da nota do julgado pela área do caso: a justiça que não julga a área perde (o TRT num caso
 * de consumo, o TCU num de família); o superior da área ganha um pouco; a área declarada no documento,
 * quando bate, ganha. Não corta nada: a área do índice falta em parte dos julgados e erra em outros
 * (o REsp do art. 49 do CDC está como Direito Civil), então ela só soma.
 */
export function ajusteDaArea(d, areaInfo, termosDaArea = []) {
  if (!areaInfo || !areaInfo.chave) return 0;
  const justicas = JUSTICAS_DA_AREA[areaInfo.chave] || JUSTICAS_COMUNS;
  const fam = familiaDoOrgao(d.orgao);
  let b = 0;
  if (fam !== 'outro' && !justicas.includes(fam)) b -= 0.5;
  else if (SUPERIORES.has(fam) && justicas.includes(fam)) b += 0.08;
  const area = normalizar(String(d.area || ''));
  if (area && termosDaArea.some((t) => t && area.includes(t))) b += 0.12;
  return b;
}

/**
 * A expressão da consulta no texto: a fração dos pares de palavras seguidas da consulta (sem as
 * vazias, pelo radical) que aparecem seguidos no título e na ementa. "direito de arrependimento" junto
 * vale mais do que "direito" e "arrependimento" soltos (a adoção e o estelionato vinham antes do REsp
 * do art. 49 do CDC).
 */
export function fracaoDaExpressao(q, texto) {
  const rad = (s) => palavras(s).filter((w) => !STOPWORDS.has(w) && w.length > 1).map(radical);
  const qs = rad(q);
  if (qs.length < 2) return 0;
  const pares = new Set();
  for (let i = 0; i + 1 < qs.length; i += 1) pares.add(`${qs[i]} ${qs[i + 1]}`);
  const ts = rad(texto);
  const doTexto = new Set();
  for (let i = 0; i + 1 < ts.length; i += 1) doTexto.add(`${ts[i]} ${ts[i + 1]}`);
  let n = 0;
  for (const p of pares) if (doTexto.has(p)) n += 1;
  return n / pares.size;
}

/**
 * O peso do precedente pela hierarquia: o tema, a súmula e a orientação dos tribunais superiores (o que
 * vincula ou orienta) vêm antes; o resto do superior, depois; o acórdão de tribunal local, sem bônus.
 * No gabarito de 11/11/2026, o Tema 1.076 do STJ ficava em 17º para "honorários por equidade" e o Tema
 * 1.046 do STF em 16º para "norma coletiva que limita direito", atrás de acórdãos de TRT que o citam.
 */
export function pesoDaHierarquia(d) {
  const fam = familiaDoOrgao(d.orgao);
  const sub = normalizar(String(d.subtipo || ''));
  const vinculante = /^(?:tema|sumula|orientacao|oj|precedente normativo)/.test(sub);
  if (SUPERIORES.has(fam)) return vinculante ? 0.3 : /^(?:iac|irdr|sirdr|puil)/.test(sub) ? 0.2 : 0.12;
  if (/^(?:sumula|irdr|iac|tema)/.test(sub)) return 0.05;
  return 0;
}

/**
 * O mesmo julgado publicado duas vezes no índice (o informativo inteiro e o item dele, com o mesmo
 * título): fica o primeiro, que é o de nota maior. No gabarito, "reconhecimento fotográfico" trazia o
 * REsp 1.969.032, o HC 598.886 e o HC 712.781 duas vezes cada no top 10.
 */
export function semDuplicatas(lista) {
  const vistos = new Set();
  return lista.filter((d) => {
    if (d.tipo !== 'jurisprudencia' || !d.titulo) return true;
    const k = `${String(d.orgao || '').toUpperCase()}|${normalizar(d.titulo).replace(/[^a-z0-9]+/g, ' ').trim()}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}
