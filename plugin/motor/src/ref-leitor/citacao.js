// Leitor de citações: leva qualquer jeito de escrever uma citação à chave canônica do apelido e
// ao caminho do dispositivo. Módulo puro, sem modelo, sem rede. É o mesmo código no servidor
// (`/v1/ref/conferir`) e na montagem do índice, para as duas pontas concordarem.
//
//   "art. 157, § 2º, II, do CP"            -> { chaves: ['cp'], caminho: 'art-157/par-2/inc-2' }
//   "Lei nº 13.105, de 16 de março de 2015" -> { chaves: ['lei 13105/2015'] }
//   "Súmula 7/STJ"                          -> { chaves: ['sumula stj 7'] }
//   "Tema 1016"                             -> { chaves: ['tema 1016'] }  (ambíguo: STF e STJ)
import { anoCompleto, normalizarBusca, numeroSemPonto, romanoParaNumero } from './normalizar.js';
import {
  APELIDOS_CONSAGRADOS,
  CODIGOS_DA_ESPECIE,
  ESPECIES_REGULADOR,
  GENTILICOS_UF,
  ORGAOS_CITAVEIS,
  UFS,
  chaveEstadual,
  chaveMunicipal,
  chaveRegimento,
  chaveRegulador,
  slugificar,
  chaveAcordaoTcu,
  chaveControle,
  chaveNorma,
  chaveOj,
  chaveProcessoStf,
  chaveSumula,
  chaveSv,
  chaveTema,
  colegiadoTcu,
  orgaoOj,
} from './ids.js';

const NUM = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)`;

const PALAVRA_DO_CODIGO = [
  ['lei complementar', 'lc'],
  ['lei delegada', 'ld'],
  ['decreto-lei', 'dl'],
  ['decreto lei', 'dl'],
  ['decreto legislativo', 'dlg'],
  ['medida provisoria', 'mp'],
  ['emenda constitucional', 'ec'],
  ['emenda constitucional de revisao', 'ecr'],
  ['decreto', 'dec'],
  ['lei', 'lei'],
  ['lc', 'lc'],
  ['dl', 'dl'],
  ['del', 'dl'],
  ['dlg', 'dlg'],
  ['mpv', 'mp'],
  ['mp', 'mp'],
  ['ec', 'ec'],
  ['emc', 'ec'],
  ['dec', 'dec'],
];
const ALTERNATIVA_CODIGO = PALAVRA_DO_CODIGO.map(([p]) => p.replace(/[-\s]/g, '[-\\s]')).join('|');
const QUALIFICADORES = ['federal', 'estadual', 'municipal', 'distrital', ...Object.keys(GENTILICOS_UF)].join('|');
const RE_NORMA = new RegExp(
  String.raw`(?<![a-z0-9])(${ALTERNATIVA_CODIGO})\s*(?:(?:${QUALIFICADORES})\s+){0,2}(?:n\.?\s*)?${NUM}(-\d+)?` +
    String.raw`(?:\s*\/\s*(\d{4}|\d{2})(?!\d)|\s*,?\s*de\s+(?:\d{1,2}\s+(?:de\s+)?[a-z]+\s+de\s+|\d{1,2}\s*[/.]\s*\d{1,2}\s*[/.]\s*)?(\d{4}))?`,
);

const TRIBUNAIS = [
  ['supremo tribunal federal', 'stf'],
  ['superior tribunal de justica', 'stj'],
  ['tribunal superior do trabalho', 'tst'],
  ['tribunal de contas da uniao', 'tcu'],
  ['tribunal superior eleitoral', 'tse'],
  ['superior tribunal militar', 'stm'],
  ['stf', 'stf'],
  ['stj', 'stj'],
  ['tst', 'tst'],
  ['tcu', 'tcu'],
  ['tse', 'tse'],
  ['stm', 'stm'],
];

// Tribunais e órgãos com súmula própria além dos superiores: TJs, TRFs, TRTs, TNU, tribunais de
// contas e órgãos administrativos de julgamento. "TRF-4", "TCE/SP" e "TCESP" viram "trf4" e "tce-sp".
const RE_TRIB_EXTRA = /(?<![a-z])(tjdft|tj[a-z]{2}|trf\s*-?\s*\d|trt\s*-?\s*\d{1,2}|tnu|carf|cade|crps|tcdf|tc[em]\s*[-/]?\s*[a-z]{2})(?![a-z])/;

export function siglaTribunal(bruta) {
  const t = String(bruta || '').toLowerCase().replace(/\s+/g, '');
  const m = /^(tc[em])[-/]?([a-z]{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  return t.replace(/-/g, '');
}

function tribunalNoTexto(n) {
  let melhor = null;
  for (const [nome, sigla] of TRIBUNAIS) {
    const m = new RegExp(String.raw`(?<![a-z])${nome}(?![a-z])`).exec(n);
    if (m && (!melhor || m.index < melhor.index)) melhor = { index: m.index, sigla };
  }
  const extra = RE_TRIB_EXTRA.exec(n);
  if (extra && (!melhor || extra.index < melhor.index)) melhor = { index: extra.index, sigla: siglaTribunal(extra[1]) };
  // "TRT da 15ª Região", "Tribunal Regional do Trabalho da 15ª Região", "TRF da 4ª Região" (a ordinal já saiu na normalização).
  const regiao = /(?<![a-z])(trt|trf|tribunal regional do trabalho|tribunal regional federal)\s*(?:d[aoe]s?\s+)?(\d{1,2})\s*(?:a\s+)?regiao/.exec(n);
  if (regiao && (!melhor || regiao.index < melhor.index)) melhor = { index: regiao.index, sigla: `${/trabalho|^trt/.test(regiao[1]) ? 'trt' : 'trf'}${Number(regiao[2])}` };
  return melhor?.sigla || null;
}

// ── UF e município de uma norma ────────────────────────────────────────────

const SIGLAS_UF = Object.keys(UFS).join('|');
const NOMES_UF = Object.entries(UFS).sort((a, b) => b[1].length - a[1].length);

/**
 * UF citada junto da norma: "do Estado de São Paulo", "estadual (SP)", "lei paulista", "-SP" ou
 * "(SP)" logo depois do número. Sigla solta no meio da frase não conta ("se" e "es" são palavras).
 */
export function ufNoTexto(n, cauda = '') {
  for (const [sigla, nome] of NOMES_UF) {
    if (new RegExp(String.raw`(?<![a-z])(?:estado|estadual)\s+d[eoa]s?\s+${nome}(?![a-z])`).test(n)) return sigla;
  }
  for (const [g, sigla] of Object.entries(GENTILICOS_UF)) if (new RegExp(String.raw`(?<![a-z-])${g}(?![a-z-])`).test(n)) return sigla;
  let m;
  if ((m = new RegExp(String.raw`(?<![a-z])estadual\s*(?:\(|-|\/|d[eoa]s?\s+)?\s*(${SIGLAS_UF})(?![a-z])`).exec(n))) return m[1];
  if ((m = new RegExp(String.raw`^\s*,?\s*(?:-|\(|\/)\s*(${SIGLAS_UF})(?![a-z])`).exec(cauda))) return m[1];
  return null;
}

const FIM_DE_NOME = String.raw`(?=\s*(?:[,;()]|\/\s*[a-z]{2}(?![a-z])|\s-\s|-[a-z]{2}(?![a-z])|$|\s+(?:d[oa]s?\s+estado|art|arts|lei|decreto|n\s*\d)\b))`;

/** Município citado: "do Município de São Paulo/SP", "Lei Municipal 16.050/2014 de Recife (PE)". */
export function municipioNoTexto(n, cauda = '') {
  if (!/(?<![a-z])(?:municipal|municipio|prefeitura)(?![a-z])/.test(n)) return null;
  let m = new RegExp(String.raw`(?:municipio|prefeitura)\s+(?:municipal\s+)?d[eoa]s?\s+([a-z][a-z' -]*?)${FIM_DE_NOME}`).exec(n);
  let resto;
  if (m) resto = n.slice(m.index + m[0].length);
  else if ((m = new RegExp(String.raw`^\s*,?\s*(?:d[eoa]s?\s+|\(\s*)([a-z][a-z' -]*?)${FIM_DE_NOME}`).exec(cauda))) resto = cauda.slice(m[0].length);
  if (!m) return { slug: null, uf: null };
  const nome = m[1].trim();
  let uf = new RegExp(String.raw`^\s*(?:\/|-|\()\s*(${SIGLAS_UF})(?![a-z])`).exec(resto)?.[1] || null;
  if (!uf) for (const [sigla, nomeUf] of NOMES_UF) if (new RegExp(String.raw`(?<![a-z])estado\s+d[eoa]s?\s+${nomeUf}(?![a-z])`).test(n)) { uf = sigla; break; }
  return { slug: slugificar(nome), uf };
}

// ── Regimentos, constituições estaduais, leis orgânicas e atos de regulador ─

const SIGLAS_REGIMENTO = String.raw`stf|stj|tst|tse|stm|tcu|tnu|tjdft|tj[a-z]{2}|trf\d|trt\d{1,2}`;
const RE_REGIMENTO_SIGLA = new RegExp(String.raw`(?<![a-z])ri(${SIGLAS_REGIMENTO})(?![a-z])`);
const RE_REGIMENTO_NOME = /regimento interno d[oa]\s+(?:colendo\s+|egregio\s+)?(?:(stf|stj|tst|tse|stm|tcu|tnu|tjdft|tj[a-z]{2}|trf\s*-?\s*\d|trt\s*-?\s*\d{1,2})(?![a-z])|(supremo tribunal federal|superior tribunal de justica|tribunal superior do trabalho|tribunal de contas da uniao)|tribunal de justica d[eoa]s?\s+(?:estado\s+d[eoa]s?\s+)?([a-z ]+?)(?=\s*(?:[,;()]|$|\s+art)))/;
const NOME_TRIBUNAL_SUPERIOR = { 'supremo tribunal federal': 'stf', 'superior tribunal de justica': 'stj', 'tribunal superior do trabalho': 'tst', 'tribunal de contas da uniao': 'tcu' };

function regimentoNoTexto(n) {
  let m = RE_REGIMENTO_SIGLA.exec(n);
  if (m) return m[1];
  if ((m = RE_REGIMENTO_NOME.exec(n))) {
    if (m[1]) return siglaTribunal(m[1]);
    if (m[2]) return NOME_TRIBUNAL_SUPERIOR[m[2]];
    const nome = m[3].trim();
    if (nome === 'distrito federal e territorios' || nome === 'distrito federal') return 'tjdft';
    const uf = NOMES_UF.find(([, nm]) => nm === nome)?.[0];
    if (uf) return `tj${uf}`;
  }
  return null;
}

const ALT_ESPECIE_REG = ESPECIES_REGULADOR.map(([p]) => p.replace(/\s+/g, '\\s+')).join('|');
// Depois da espécie vem um espaço, um ponto ou uma barra ("Ofício-Circular/CVM/SNC 01/26"); a sigla do
// órgão pode vir colada ("IN DREI 81/2020") ou depois ("RN 465/2021 da ANS", achada em `orgaosDoAto`).
const RE_ATO_REGULADOR = new RegExp(
  String.raw`(?<![a-z])(${ALT_ESPECIE_REG})\.?(?:\s+|\s*\/\s*)(?:([a-z][a-z/]{1,15}(?:\s*\/\s*[a-z]{2,10})*)\s+)?(?:n\.?\s*)?${NUM}` +
    String.raw`(?:\s*\/\s*(\d{4}|\d{2})(?!\d)|\s*,?\s*de\s+(?:\d{1,2}\s+(?:de\s+)?[a-z]+\s+de\s+|\d{1,2}\s*[/.]\s*\d{1,2}\s*[/.]\s*)?(\d{4}))?`,
);
const ORGAOS_ORDENADOS = Object.entries(ORGAOS_CITAVEIS).sort((a, b) => b[0].length - a[0].length).map(([forma, orgao]) => ({
  orgao,
  re: new RegExp(String.raw`(?<![a-z])${forma.replace(/[/]/g, '\\s*\\/\\s*')}(?![a-z])`),
}));

function codigoDaEspecie(palavra) {
  const p = palavra.replace(/\s+/g, ' ');
  return ESPECIES_REGULADOR.find(([nome]) => nome === p)?.[1] || null;
}

const PALAVRAS_QUE_NAO_SAO_ORGAO = new Set(['de', 'do', 'da', 'dos', 'das', 'no', 'na', 'em', 'ao', 'n', 'nr', 'num', 'numero', 'art', 'lei', 'sob', 'cf']);

/**
 * Órgão(s) do ato, em ordem de preferência, para montar a chave `<espécie> <órgão> <número>/<ano>`:
 * - a sigla colada à espécie, se o leitor a conhece ("IN RFB 1432/2013");
 * - uma sigla colada que ele NÃO conhece, mas que está em maiúsculas na citação ("Resolução CCFGTS 1.144",
 *   "IN SIT/MTE 2/2024"): vale ela inteira e, se composta, cada parte ("sit/mte", "mte", "sit"). Em minúsculas
 *   não vale, porque "resolução de 5 de maio" não é ato de órgão nenhum;
 * - um órgão conhecido em qualquer ponto da frase ("RN 465/2021 da ANS", "Portaria 344/98 da SVS/MS").
 */
function orgaosDoAto(siglaColada, n, texto = '') {
  if (siglaColada) {
    const s = siglaColada.replace(/\s+/g, '');
    if (ORGAOS_CITAVEIS[s]) return [ORGAOS_CITAVEIS[s]];
    const partes = s.split('/').filter((p) => p.length >= 2 && !PALAVRAS_QUE_NAO_SAO_ORGAO.has(p));
    const emMaiuscula = partes.length && partes.length === s.split('/').length && new RegExp(String.raw`(?<![A-Za-zÀ-ÿ])${s.split('/').map((p) => p.toUpperCase()).join(String.raw`\s*/\s*`)}(?![A-Za-zÀ-ÿ])`).test(String(texto).normalize('NFD').replace(/\p{M}/gu, ''));
    if (emMaiuscula) return [...new Set([s, ...partes.map((p) => ORGAOS_CITAVEIS[p] || p)])];
  }
  for (const { orgao, re } of ORGAOS_ORDENADOS) if (re.test(n)) return [orgao];
  return [];
}

const RE_PEDE_ORIGINAL = /(?<![a-z])(?:redacao|texto|versao|publicacao|forma)\s+original(?![a-z])/;

/** Normalização própria da citação: tira "nº", ordinais e aspas, mantém "§". */
export function normalizarCitacao(texto) {
  return normalizarBusca(texto)
    .replace(/[“”"'‘’«»]/g, ' ')
    .replace(/\bn\s*[.ºo°]{1,2}\s*(?=\d)/g, ' ')
    .replace(/\bnumero\s*(?=\d)/g, ' ')
    .replace(/(\d)\s*[ºo°ª](?![a-z])/g, '$1')
    .replace(/\s*[–—]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Dispositivo ────────────────────────────────────────────────────────────

const RE_ART = /(?<![a-z])(?:artigos?|arts?)\s*\.?\s*(\d{1,2}(?:\.\d{3})+|\d+)(?:\s*-\s*([a-z]{1,2})(?![a-z]))?/;
const RE_PAR_UNICO = /(?:§\s*unico|paragrafo\s+unico|par\.\s*unico|p\.\s*u\.|§\s*u\b)/;
const RE_PAR = /(?:§\s*|paragrafo\s+)(\d+)(?:\s*-\s*([a-z])(?![a-z]))?/;
const RE_INC = /(?<![a-z])inc(?:iso)?s?\.?\s*([ivxlcdm]+)(?:\s*-\s*([a-z])(?![a-z]))?(?![a-z])/;
const RE_ALI = /(?<![a-z])al(?:inea)?s?\.?\s*([a-z])(?![a-z])/;

/**
 * Lê os componentes que vêm depois do artigo, na ordem: ", § 2º, II, b" ou ", inciso II, alínea b".
 * Para no primeiro trecho que não é componente (", do CP"), e não confunde "a" de alínea com o
 * artigo da frase: letra solta só vale depois de um inciso e antes de vírgula, parêntese, fim ou
 * "do/da/de".
 */
function componentesDepoisDoArtigo(cauda) {
  const out = {};
  let resto = cauda;
  for (let guarda = 0; guarda < 6; guarda++) {
    resto = resto.replace(/^\s*(?:,|\be\b|\bc\/c\b)?\s*/, '');
    let m;
    if ((m = /^caput(?![a-z])/.exec(resto))) {
      out.caput = true;
    } else if (!out.par && (m = new RegExp('^' + RE_PAR_UNICO.source).exec(resto))) {
      out.par = 'u';
    } else if (!out.par && (m = new RegExp('^' + RE_PAR.source).exec(resto))) {
      out.par = m[1] + (m[2] ? `-${m[2]}` : '');
    } else if (!out.inc && (m = new RegExp('^' + RE_INC.source).exec(resto))) {
      out.inc = incisoCanonico(m[1], m[2]);
    } else if (!out.inc && (m = /^([ivxlcdm]+)(?:\s*-\s*([a-z])(?![a-z]))?(?=\s*(?:,|$|\)|\s+d[oae]s?\b|\s+e\b))/.exec(resto)) && romanoParaNumero(m[1])) {
      out.inc = incisoCanonico(m[1], m[2]);
    } else if (!out.ali && (m = new RegExp('^' + RE_ALI.source).exec(resto))) {
      out.ali = m[1];
    } else if (!out.ali && out.inc && (m = /^([a-z])(?=\s*(?:,|$|\)|\s+d[oae]s?\b))/.exec(resto))) {
      out.ali = m[1];
    } else {
      break;
    }
    resto = resto.slice(m[0].length);
  }
  return out;
}

function incisoCanonico(romano, sufixo) {
  const n = romanoParaNumero(romano);
  return n ? `${n}${sufixo ? `-${sufixo}` : ''}` : null;
}

export function caminhoDeComponentes({ prefixo = '', art, par, inc, ali }) {
  if (!art) return null;
  let c = `${prefixo}art-${art}`;
  if (par) c += `/par-${par}`;
  if (inc) c += `/inc-${inc}`;
  if (ali) c += `/ali-${ali}`;
  return c;
}

const ROMANOS = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];
function paraRomano(n) {
  let r = '';
  for (const [v, s] of ROMANOS) while (n >= v) { r += s; n -= v; }
  return r;
}

/** "adct/art-10/par-1/inc-2/ali-a" -> "ADCT, art. 10, § 1º, II, a". */
export function rotuloDeCaminho(caminho) {
  if (!caminho) return '';
  const partes = [];
  for (const seg of caminho.split('/')) {
    const [tipo, ...resto] = seg.split('-');
    const valor = resto.join('-');
    if (tipo === 'adct') partes.push('ADCT');
    else if (tipo === 'anexo') partes.push(`Anexo ${valor}`);
    else if (tipo === 'art') partes.push(`art. ${rotuloNumero(valor)}`);
    else if (tipo === 'par') partes.push(valor === 'u' ? 'parágrafo único' : `§ ${rotuloNumero(valor)}`);
    else if (tipo === 'inc') {
      const [n, suf] = valor.split('-');
      partes.push(paraRomano(Number(n)) + (suf ? `-${suf.toUpperCase()}` : ''));
    } else if (tipo === 'ali') partes.push(valor);
  }
  return partes.join(', ');
}

function rotuloNumero(valor) {
  const [n, suf] = String(valor).split('-');
  const num = Number(n);
  const base = num < 10 ? `${num}º` : String(num).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return base + (suf ? `-${suf.toUpperCase()}` : '');
}

/** Extrai o dispositivo (artigo, parágrafo, inciso, alínea) de uma citação já normalizada. */
export function lerDispositivo(n) {
  const art = RE_ART.exec(n);
  if (!art) return null;
  const comp = { art: numeroSemPonto(art[1]) + (art[2] ? `-${art[2]}` : '') };
  // Componentes antes do artigo: "§ 1º do art. 312", "inciso II do art. 5º".
  const antes = n.slice(0, art.index);
  let m;
  if ((m = RE_PAR_UNICO.exec(antes))) comp.par = 'u';
  else if ((m = RE_PAR.exec(antes))) comp.par = m[1] + (m[2] ? `-${m[2]}` : '');
  if ((m = RE_INC.exec(antes))) comp.inc = incisoCanonico(m[1], m[2]);
  if ((m = RE_ALI.exec(antes))) comp.ali = m[1];
  const depois = componentesDepoisDoArtigo(n.slice(art.index + art[0].length));
  for (const k of ['par', 'inc', 'ali']) if (!comp[k] && depois[k]) comp[k] = depois[k];
  return comp;
}

// ── Documento ──────────────────────────────────────────────────────────────

/** Apelidos consagrados ordenados do mais longo para o mais curto ("cpc/73" antes de "cpc"). */
const APELIDOS_ORDENADOS = Object.values(APELIDOS_CONSAGRADOS)
  .flat()
  .concat(['adct'])
  .sort((a, b) => b.length - a.length)
  .map((forma) => ({
    forma,
    re: new RegExp(String.raw`(?<![a-z0-9])${forma.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![a-z0-9]|\/\d)`),
  }));

function codigoDaPalavra(palavra) {
  const p = palavra.replace(/\s+/g, ' ').replace('decreto lei', 'decreto-lei');
  for (const [nome, codigo] of PALAVRA_DO_CODIGO) if (nome === p) return codigo;
  return null;
}

// Marca de outra esfera na citação de norma: "Lei Estadual", "Lei Complementar Estadual",
// "Decreto Estadual", "Lei nº 10.261/1968 do Estado". Com ela, a citação nunca resolve para a lei
// federal de mesmo número (02/11/2026): sem UF identificável, é ambígua entre as UFs. A marca vale
// entre a espécie e o número ou logo depois dele; "estadual" solto mais adiante na frase ("Lei
// 8.072/90, aplicada pela justiça estadual") não muda a esfera da lei.
const RE_MARCA_ESTADUAL = /(?<![a-z])estadua(?:l|is)(?![a-z])/;
const RE_LOGO_DEPOIS = /^\s*,?\s*(?:(?:\(|-)\s*)?(?:estadua(?:l|is)(?![a-z])|d[oa]\s+estado(?!\s+d[eoa]s?\s+[a-z]))/;

/**
 * Citação local sem UF: `chaves` fica vazia (quem só olha a primeira chave não acha nada, e nunca
 * a lei federal) e `chaves_candidatas` traz a chave da mesma norma em cada UF, para o `conferir`
 * listar as que a base tem e responder `ambigua`.
 */
function semUf(resultado, candidatas, motivo) {
  return { ...resultado, chaves: [], chaves_candidatas: candidatas, exige_uf: true, motivo };
}

/**
 * Lê a citação inteira. Devolve `{ reconhecida, tipo, chaves, caminho, rotulo }`:
 * - `chaves`: chaves canônicas a procurar na tabela `apelido`, em ordem de preferência;
 * - `caminho`: caminho do dispositivo dentro do documento (ou null para o documento inteiro);
 * - `exige_uf` e `chaves_candidatas`: norma estadual (ou constituição estadual) citada sem a UF.
 */
export function lerCitacao(texto, agora = new Date()) {
  const n = normalizarCitacao(texto);
  const vazio = { reconhecida: false, tipo: null, chaves: [], caminho: null, rotulo: null, normalizada: n };
  if (!n) return vazio;

  const disp = lerDispositivo(n);
  // "redação original", "texto original": pede a versão original do ato (a carga guarda o original de um
  // ato consolidado com a chave "<chave> original"); sem ela, cai na chave comum, que é a do vigente.
  const pedeOriginal = RE_PEDE_ORIGINAL.test(n);
  const pronto = (tipo, chaves, prefixo = '') => {
    const caminho = disp ? caminhoDeComponentes({ prefixo, ...disp }) : null;
    const todas = pedeOriginal && chaves.length ? [...chaves.map((k) => `${k} original`), ...chaves] : chaves;
    return { reconhecida: true, tipo, chaves: todas, caminho, rotulo: caminho ? rotuloDeCaminho(caminho) : null, normalizada: n };
  };

  let m;
  // Súmula vinculante antes da súmula comum: "súmula vinculante 11" não é a súmula 11 do STF.
  if ((m = new RegExp(String.raw`(?<![a-z])(?:sumula vinculante|sv)\s*(?:n\.?\s*)?(\d+)`).exec(n))) {
    return pronto('sumula_vinculante', [chaveSv(m[1])]);
  }
  if ((m = new RegExp(String.raw`(?<![a-z])(?:oj|orientacao jurisprudencial)\s*(?:-\s*)?(?:(s?b?di\s*-?\s*[12](?:\s*-?\s*t(?:ransitoria)?)?|sdc)\s*-?\s*)?(?:n\.?\s*)?(\d+)`).exec(n))) {
    const orgaoAntes = m[1] ? orgaoOj(m[1]) : null;
    const orgaoDepois = /(s?b?di\s*-?\s*[12](?:\s*-?\s*t(?:ransitoria)?)?|sdc)/.exec(n.slice(m.index + m[0].length));
    const orgao = orgaoAntes || (orgaoDepois ? orgaoOj(orgaoDepois[1]) : null);
    return pronto('oj', [chaveOj(orgao, m[2])]);
  }
  if ((m = new RegExp(String.raw`(?<![a-z])(?:sumula|enunciado)\s*(?:n\.?\s*)?(\d+)`).exec(n)) ||
      (m = new RegExp(String.raw`(?<![a-z])sumula\s+(?:do|da)\s+(?:[a-z ]+?\s)?(?:n\.?\s*)?(\d+)`).exec(n))) {
    const trib = tribunalNoTexto(n);
    return pronto('sumula', [trib ? chaveSumula(trib, m[1]) : `sumula ${numeroSemPonto(m[1])}`]);
  }
  if ((m = new RegExp(String.raw`(?<![a-z])tema\s*(?:repetitivo\s*)?(?:n\.?\s*)?${NUM}`).exec(n))) {
    let trib = null;
    if (/repercussao geral|(?<![a-z])rg(?![a-z])|(?<![a-z])stf(?![a-z])|supremo/.test(n)) trib = 'stf';
    else if (/repetitiv|(?<![a-z])stj(?![a-z])|superior tribunal de justica/.test(n)) trib = 'stj';
    else if (/(?<![a-z])tst(?![a-z])/.test(n)) trib = 'tst';
    return pronto('tema', [chaveTema(trib, m[1])]);
  }
  if ((m = new RegExp(String.raw`(?<![a-z])(adi|adin|adc|adpf|ado)\s*(?:n\.?\s*)?${NUM}`).exec(n))) {
    return pronto('controle', [chaveControle(m[1] === 'adin' ? 'adi' : m[1], m[2])]);
  }
  if (/(?<![a-z])tcu(?![a-z])|tribunal de contas da uniao/.test(n) &&
      (m = new RegExp(String.raw`(?<![a-z])acordao\s*(?:n\.?\s*)?${NUM}\s*\/\s*(\d{4})`).exec(n))) {
    const col = colegiadoTcu(n.slice(m.index + m[0].length));
    const chaves = col ? [chaveAcordaoTcu(m[1], m[2], col), chaveAcordaoTcu(m[1], m[2])] : [chaveAcordaoTcu(m[1], m[2])];
    return pronto('acordao_tcu', chaves);
  }
  if ((m = new RegExp(String.raw`(?<![a-z])(?:res(?:olucao)?|prov(?:imento)?|rec(?:omendacao)?)\.?\s*(?:conjunta\s*)?(?:n\.?\s*)?(?:(cnj|cnmp)\s*(?:n\.?\s*)?)?(\d+)(?:\s*\/\s*(\d{4}|\d{2})(?!\d)|\s*,?\s*de\s+(?:\d{1,2}\s+(?:de\s+)?[a-z]+\s+de\s+|\d{1,2}\s*[/.]\s*\d{1,2}\s*[/.]\s*)?(\d{4}))?`).exec(n)) &&
      /(?<![a-z])(cnj|cnmp)(?![a-z])|conselho nacional/.test(n) && !/conjunta/.test(m[0])) {
    const orgao = m[1] || (/(?<![a-z])cnmp(?![a-z])|ministerio publico/.test(n) ? 'cnmp' : 'cnj');
    const especie = /^prov/.test(m[0]) ? 'prov' : /^rec/.test(m[0]) ? 'rec' : 'res';
    const ano = anoCompleto(m[3] || m[4], agora);
    const base = `${especie} ${orgao} ${numeroSemPonto(m[2])}`;
    return pronto('ato_conselho', ano ? [`${base}/${ano}`, base] : [base]);
  }
  const trib = regimentoNoTexto(n);
  if (trib) return pronto('regimento', [chaveRegimento(trib)]);
  if (/(?<![a-z])constituicao\s+(?:do\s+estado|estadual)|(?<![a-z])constituicao\s+(?:paulista|mineira|fluminense|gaucha|catarinense|paranaense|baiana|pernambucana|cearense|goiana|capixaba)/.test(n)) {
    const uf = ufNoTexto(n);
    if (uf) return pronto('constituicao_estadual', [`${uf} ce`], '');
    return semUf(pronto('constituicao_estadual', []), Object.keys(UFS).map((u) => `${u} ce`), 'constituição estadual sem o estado');
  }
  if ((m = /(?<![a-z])lei\s+organica\s+(?:do\s+municipio\s+d[eoa]s?|municipal\s+d[eoa]s?|d[eoa]s?)\s+([a-z][a-z' -]*?)(?=\s*(?:[,;()]|\/\s*[a-z]{2}(?![a-z])|-[a-z]{2}(?![a-z])|$|\s+art))/.exec(n)) && !/distrito federal/.test(m[1])) {
    const resto = n.slice(m.index + m[0].length);
    const uf = new RegExp(String.raw`^\s*(?:\/|-|\()\s*(${SIGLAS_UF})(?![a-z])`).exec(resto)?.[1] || null;
    const slug = slugificar(m[1].trim());
    return pronto('lei_organica', uf ? [chaveMunicipal(slug, uf, 'lom', null), chaveMunicipal(slug, null, 'lom', null)] : [chaveMunicipal(slug, null, 'lom', null)]);
  }
  // Norma Regulamentadora do MTE: "NR-35", "NR 35", "Norma Regulamentadora nº 35". Não tem órgão nem ano na
  // citação. "NR" só vale em maiúsculas e com número de 1 a 40, porque "nr." também abrevia "número".
  if ((m = /(?<![A-Za-zÀ-ÿ])NR\s*-?\s*(?:n[.ºo°]*\s*)?(\d{1,2})(?![\d])/.exec(String(texto))) || (m = /(?<![a-z])norma regulamentadora\s*(?:n\.?\s*)?(\d{1,2})(?![\d])/.exec(n))) {
    const nr = Number(m[1]);
    if (nr >= 1 && nr <= 40) return { ...pronto('norma_regulamentadora', [`nr ${nr}`]), caminho: null, rotulo: null };
  }
  if ((m = RE_ATO_REGULADOR.exec(n))) {
    const especie = m[1].replace(/\s+/g, ' ');
    const codigo = codigoDaEspecie(m[1]);
    // "ICVM 617": a sigla da espécie já diz o órgão.
    const orgaos = codigo ? (especie === 'icvm' ? ['cvm'] : orgaosDoAto(m[2], n, texto)) : [];
    if (orgaos.length) {
      const numero = numeroSemPonto(m[3]).replace(/^0+(?=\d)/, '');
      const ano = anoCompleto(m[4] || m[5], agora);
      const codigos = CODIGOS_DA_ESPECIE[especie] || [codigo];
      const chaves = [];
      for (const orgao of orgaos) for (const c of codigos) chaves.push(chaveRegulador(c, orgao, numero, ano));
      return pronto('ato_regulador', [...new Set(chaves)]);
    }
  }
  if ((m = RE_NORMA.exec(n))) {
    const codigo = codigoDaPalavra(m[1]);
    if (codigo) {
      const numero = numeroSemPonto(m[2]) + (m[3] || '');
      const ano = anoCompleto(m[4] || m[5], agora);
      const cauda = n.slice(m.index + m[0].length);
      const mun = municipioNoTexto(n, cauda);
      if (mun) {
        if (!mun.slug) return { ...pronto('norma_municipal', []), motivo: 'norma municipal sem o nome do município' };
        const chaves = [chaveMunicipal(mun.slug, null, codigo, numero, ano)];
        if (mun.uf) chaves.unshift(chaveMunicipal(mun.slug, mun.uf, codigo, numero, ano));
        return pronto('norma_municipal', chaves);
      }
      const uf = ufNoTexto(n, cauda);
      if (uf) return pronto('norma_estadual', [chaveEstadual(uf, codigo, numero, ano)]);
      if (RE_MARCA_ESTADUAL.test(m[0]) || RE_LOGO_DEPOIS.test(cauda)) {
        return semUf(pronto('norma_estadual', []), Object.keys(UFS).map((u) => chaveEstadual(u, codigo, numero, ano)), 'norma estadual sem a UF: a citação não diz o estado');
      }
      return pronto('norma', ano ? [chaveNorma(codigo, numero, ano)] : [chaveNorma(codigo, numero, null)]);
    }
  }
  for (const { forma, re } of APELIDOS_ORDENADOS) {
    if (re.test(n)) {
      if (forma === 'adct') return pronto('norma', ['cf'], 'adct/');
      return pronto('norma', [forma]);
    }
  }
  if ((m = new RegExp(String.raw`(?<![a-z])(re|are|ai)\s*(?:n\.?\s*)?${NUM}`).exec(n))) {
    return pronto('processo_stf', [chaveProcessoStf(m[1], m[2])]);
  }
  return vazio;
}
