// De onde vem cada documento da pasta do caso: dos AUTOS (tem folha, porque foi
// juntado a um processo) ou do CLIENTE (procuração, declaração, comprovante,
// documento avulso que a peça vai juntar como Doc. N e que ainda não tem folha).
//
// Medido na medição dos moldes de 24/09/2026 (G17): o índice não fazia essa
// distinção, e o sinal `folhas` do Redação Gate cobrava folha de documento que
// nunca foi juntado. No HC da medição, a declaração da mãe e a do empregador
// (documentos do escritório, fora da numeração da origem) reprovaram a final em
// todas as versões; nas pastas pré-processuais (alimentos, negativação,
// reclamação), o redator passou a escrever "Doc. 02, fls. 1" para um documento
// que só tem página, texto artificial que o juiz lê.
//
// Módulo PURO (só texto e regex). O indexador grava `origem` no índice; o hook
// de redação usa o campo e, em índice antigo sem ele, deduz pelo texto do
// documento (sem ele, pela `primeira_pagina`), com a mesma função.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo
// `scripts/sync-blocos.mjs` para o indexador (raiz e templates) e para o hook de
// redação (raiz, .codex e templates). Nenhum import.

// >>> autos-origem:begin
/**
 * Âncora de folha que a pasta do caso dá ao documento: a que o conversor e as
 * cópias extraídas de processo trazem (`## fls. 12`, `<!-- fls. 3/40 -->`).
 * Folha citada em prosa ("a via juntada está às fls. 145") não conta: é o
 * documento falando de outro.
 */
const ORIGEM_ANCORA_FOLHA = /(?:^|\s)#{1,3}\s*(?:e-?)?fls?\.?\s*\d+|<!--\s*(?:e-?)?fls?\.\s*\d+/;
/** Âncora de página de documento sem folha (pasta pré-processual): `## p. 1`, `## pág. 2`. */
const ORIGEM_ANCORA_PAGINA = /(?:^|\s)#{1,3}\s*(?:p|pag|pagina)\.?\s*\d+/;
/**
 * Marca de sistema processual no texto de um PDF sem âncora: o rodapé do PJe
 * (`Num. 12345678 - Pág. 1`), o carimbo de folha do e-SAJ numa linha só
 * (`fls. 123`), o rodapé de conferência do e-SAJ e a marca de evento do eproc.
 * Vem DEPOIS da âncora: a cópia de uma sentença de outro processo, que o
 * cliente trouxe e a pasta pagina com `## p. N`, carrega o rodapé do tribunal
 * e continua sendo documento do cliente (medido no despejo de 24/09/2026).
 */
const ORIGEM_SISTEMA = [
  /\bnum\.\s*\d{5,}\s*-\s*pag\.\s*\d+/,
  /(?:^|\n)[ \t]*(?:e-?)?fls\.\s*\d+(?:\s*\/\s*\d+)?[ \t]*(?:\n|$)/,
  /\bevento\s+\d+\s*,\s*[a-z]+\d*\s*,\s*pagina\s+\d+/,
  /\bpara conferir o original,? acesse o site\b/,
];
/** O próprio documento diz, no cabeçalho, que está fora dos autos. */
const ORIGEM_FORA_DOS_AUTOS = /\bnao juntad[oa]s?\b|\bfora da numeracao\b|\bsem folha\b|\bdocumento (?:avulso|do escritorio|do cliente|interno)\b|\ba juntar\b|\bpasta (?:da empresa|do cliente)\b/;
const ORIGEM_CABECALHO = 400;

function semAcentoOrigem(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** `autos`, `cliente` ou `null` (não dá para dizer pelo texto). */
function origemDoTexto(texto) {
  const t = semAcentoOrigem(texto);
  if (!t.trim()) return null;
  if (ORIGEM_ANCORA_FOLHA.test(t)) return 'autos';
  if (ORIGEM_ANCORA_PAGINA.test(t)) return 'cliente';
  if (ORIGEM_FORA_DOS_AUTOS.test(t.slice(0, ORIGEM_CABECALHO))) return 'cliente';
  if (ORIGEM_SISTEMA.some((re) => re.test(t))) return 'autos';
  return null;
}

/**
 * Completa `origem` em cada documento do índice. `textoDe(doc)` devolve o texto
 * (ou `null` quando não há o que ler). A origem já gravada vale; a que falta sai
 * do texto; e, numa pasta em que algum documento tem folha, o documento com
 * texto e sem folha nenhuma está fora da numeração: é do cliente. Documento sem
 * texto (PDF digitalizado sem OCR) fica `null`, e quem lê trata como autos.
 */
function completarOrigens(docs, textoDe) {
  const lista = Array.isArray(docs) ? docs : [];
  const textos = lista.map((d) => { try { return textoDe(d); } catch { return null; } });
  const origens = lista.map((d, i) => (d && (d.origem === 'autos' || d.origem === 'cliente') ? d.origem : origemDoTexto(textos[i])));
  const haAutos = origens.includes('autos');
  return lista.map((d, i) => ({ ...d, origem: origens[i] ?? (haAutos && String(textos[i] || '').trim() ? 'cliente' : null) }));
}
// <<< autos-origem:end

export { origemDoTexto, completarOrigens };
