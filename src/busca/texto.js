// Texto da busca: normalização, tokens, radical leve do português e stopwords.
//
// Sem dependência nativa. O tokenizador do índice é o `unicode61 remove_diacritics 2` do FTS5, que
// minúscula e tira o acento; aqui a consulta passa pela mesma normalização, e cada palavra vira um
// RADICAL usado como prefixo (`negativ*` acha negativação, negativar, negativado). O radical é
// propositalmente curto e conservador: o ranking BM25 e a cobertura de termos desfazem o ruído.

const SEM_ACENTO = /[̀-ͯ]/g;

/** Minúscula, sem acento, espaços colapsados. Igual à normalização do tokenizador do índice. */
export function normalizar(texto) {
  return String(texto ?? '').normalize('NFD').replace(SEM_ACENTO, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Palavras gramaticais que não distinguem um documento de outro numa consulta de advogado. */
export const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'pelo', 'pela',
  'pelos', 'pelas', 'para', 'pra', 'com', 'sem', 'sob', 'sobre', 'ao', 'aos', 'a', 'e', 'ou', 'que', 'se', 'ser', 'ter', 'foi', 'sao', 'eh',
  'qual', 'quais', 'como', 'quando', 'onde', 'ate', 'entre', 'mais', 'menos', 'muito', 'pode', 'podem', 'deve', 'devem', 'cabe', 'cabem',
  'ha', 'tem', 'tambem', 'ja', 'nao', 'sim', 'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'esse', 'essa', 'isso', 'isto', 'aquele',
  'quanto', 'quantos', 'quanta', 'sobre', 'durante', 'apos', 'ante', 'contra', 'desde', 'perante', 'segundo', 'conforme', 'qualquer',
]);

/** Palavras que são ruído de consulta quando sozinhas (o advogado digita "lei", "artigo", "tema"). */
const RUIDO_DE_CONSULTA = new Set(['artigo', 'art', 'arts', 'artigos', 'inciso', 'paragrafo', 'caput', 'dispositivo', 'norma', 'normas', 'regra', 'regras']);

/** Palavras em [a-z0-9] da consulta já normalizada; números ficam (artigo, tema, súmula). */
export function palavras(texto) {
  return normalizar(texto).match(/[a-z0-9]+/g) || [];
}

const EXCECOES = new Map([
  ['lei', 'lei'], ['leis', 'lei'], ['mes', 'mes'], ['meses', 'mes'], ['pais', 'pais'], ['gas', 'gas'], ['juros', 'juros'], ['onus', 'onus'],
  ['bens', 'bem'], ['bem', 'bem'], ['mal', 'mal'], ['males', 'mal'], ['cidadaos', 'cidadao'], ['cidadao', 'cidadao'],
  ['capital', 'capital'], ['capitais', 'capital'], ['animal', 'animal'], ['animais', 'animal'], ['civil', 'civil'], ['civis', 'civil'],
  ['hospital', 'hospital'], ['hospitais', 'hospital'], ['sal', 'sal'], ['reu', 'reu'], ['reus', 'reu'], ['re', 're'],
  ['pena', 'pena'], ['penas', 'pena'], ['tres', 'tres'], ['uso', 'uso'], ['usos', 'uso'],
]);

// Terminações derivacionais, da mais longa para a mais curta. Só se o que sobra tiver >= 4 letras.
const SUFIXOS = ['amentos', 'imentos', 'amento', 'imento', 'adoras', 'adores', 'adora', 'acoes', 'icoes', 'idades', 'idade', 'mente', 'acao', 'icao', 'cao', 'coes', 'sao', 'soes', 'ismo', 'ista', 'istas', 'ando', 'endo', 'indo', 'ados', 'adas', 'idos', 'idas', 'ado', 'ada', 'ido', 'ida', 'oso', 'osa', 'osos', 'osas'];

/** Plural → singular, em texto já normalizado e sem acento. */
function singular(p) {
  if (p.length <= 3) return p;
  if (p.endsWith('oes') || p.endsWith('aes')) return `${p.slice(0, -3)}ao`;
  if (p.endsWith('ais') && p.length > 4) return `${p.slice(0, -3)}al`;
  if (p.endsWith('eis') && p.length > 5) return `${p.slice(0, -3)}el`;
  if (p.endsWith('ois') && p.length > 5) return `${p.slice(0, -3)}ol`;
  if (p.endsWith('res') || p.endsWith('zes')) return p.slice(0, -2);
  if (p.endsWith('ns')) return `${p.slice(0, -2)}m`;
  if (p.endsWith('s') && !p.endsWith('ss') && !p.endsWith('us') && !p.endsWith('is')) return p.slice(0, -1);
  return p;
}

/**
 * O radical de uma palavra, para busca por prefixo. Números e palavras curtas (<= 3 letras) passam
 * como estão. `danos`, `dano` → `dan`; `morais` → `moral`; `negativação` → `negativ`;
 * `sensíveis` → `sensiv`; `consumidores` → `consumidor`.
 */
export function radical(palavra) {
  const p = normalizar(palavra);
  if (!p || /\d/.test(p) || p.length <= 3) return p;
  if (EXCECOES.has(p)) return EXCECOES.get(p);
  let r = singular(p);
  if (EXCECOES.has(r)) return EXCECOES.get(r);
  for (const suf of SUFIXOS) {
    if (r.endsWith(suf) && r.length - suf.length >= 4) { r = r.slice(0, -suf.length); break; }
  }
  // -vel/-veis (sensível, sensíveis, passível): o radical é o que vem antes do "el".
  if (r.length >= 6 && r.endsWith('vel')) return r.slice(0, -2);
  // Vogal final (dano/dana/danos, comercio/comercial não se tocam, mas medico/medica/medicos sim).
  if (r.length >= 5 && /[aeo]$/.test(r)) r = r.slice(0, -1);
  // "ividade/ivo/iva": ativ → ativ fica; "ivel" já saiu pelos sufixos.
  return r;
}

/** Tokens úteis da consulta, na ordem, com o radical de cada um e se é número. */
export function tokensDaConsulta(texto) {
  const saida = [];
  for (const palavra of palavras(texto)) {
    if (STOPWORDS.has(palavra) && !/\d/.test(palavra)) continue;
    saida.push({ palavra, radical: radical(palavra), numero: /^\d+$/.test(palavra), ruido: RUIDO_DE_CONSULTA.has(palavra) });
  }
  return saida;
}

/** Escapa para FTS5: o termo sempre entre aspas duplas, sem aspas internas. */
export function termoFts(termo, { prefixo = false } = {}) {
  const limpo = normalizar(termo).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return `"${limpo}"${prefixo ? '*' : ''}`;
}
