// Ids canônicos e apelidos (formas de citar). Módulo puro.
//
// Um id canônico é estável e legível: `fed:lei:13105:2015`, `fed:dl:2848:1940`, `fed:cf:1988`,
// `stj:sumula:7`, `stf:sv:11`, `stf:rg:1016`, `stj:rep:1000`, `stf:adi:6298`, `tst:oj-sdi1:191`,
// `tcu:sumula:1`, `tcu:js:70640`. O dispositivo pendura no documento depois de `#`:
// `fed:dl:2848:1940#art-157/par-2/inc-2`.
//
// O apelido é guardado numa forma CANÔNICA (`lei 13105/2015`, `cpc`, `sumula stj 7`), e o mesmo
// módulo de citação (`citacao.js`) leva qualquer jeito de escrever a essa forma. Assim a tabela
// `apelido` não precisa listar cada grafia possível: ela lista as chaves, e o leitor de citação
// faz o resto, sem modelo.
import { numeroSemPonto } from './normalizar.js';

/** Tipo do frontmatter da Legis -> código curto do id. */
export const CODIGO_DO_TIPO = Object.freeze({
  'Lei Ordinária': 'lei',
  'Lei Complementar': 'lc',
  'Decreto-Lei': 'dl',
  Decreto: 'dec',
  'Decreto Legislativo': 'dlg',
  'Decreto do Poder Legislativo': 'dpl',
  'Medida Provisória': 'mp',
  'Emenda Constitucional': 'ec',
  'Resolução do Senado Federal': 'rsf',
  'Resolução da Câmara dos Deputados': 'rcd',
  'Resolução do Congresso Nacional': 'rcn',
  'Lei Delegada': 'ld',
  'Lei Constitucional': 'lcons',
  'Decreto (não numerado)': 'dnn',
});

/** Como cada código aparece para o leitor (na `exibicao` do apelido). */
export const NOME_DO_CODIGO = Object.freeze({
  lei: 'Lei',
  lc: 'Lei Complementar',
  dl: 'Decreto-Lei',
  dec: 'Decreto',
  dlg: 'Decreto Legislativo',
  dpl: 'Decreto do Poder Legislativo',
  mp: 'Medida Provisória',
  ec: 'Emenda Constitucional',
  rsf: 'Resolução do Senado Federal',
  rcd: 'Resolução da Câmara dos Deputados',
  rcn: 'Resolução do Congresso Nacional',
  ld: 'Lei Delegada',
  lcons: 'Lei Constitucional',
  dnn: 'Decreto',
});

export function idNormaFederal(codigo, numero, ano) {
  return `fed:${codigo}:${numeroSemPonto(numero)}:${ano}`;
}

export function chaveNorma(codigo, numero, ano) {
  const n = numeroSemPonto(numero);
  return ano ? `${codigo} ${n}/${ano}` : `${codigo} ${n}`;
}

export const ID_CF = 'fed:cf:1988';

/**
 * Apelidos consagrados. Só entram no índice se o documento-alvo estiver na carga: apelido que
 * aponta para documento ausente seria uma citação "resolvida" para o nada.
 * Formas já normalizadas (sem acento, minúsculas).
 */
export const APELIDOS_CONSAGRADOS = Object.freeze({
  'fed:lei:13105:2015': ['cpc', 'ncpc', 'cpc/2015', 'cpc/15', 'codigo de processo civil', 'novo codigo de processo civil'],
  'fed:lei:5869:1973': ['cpc/1973', 'cpc/73', 'codigo de processo civil de 1973'],
  'fed:dl:2848:1940': ['cp', 'codigo penal', 'cpb'],
  'fed:dl:3689:1941': ['cpp', 'codigo de processo penal'],
  'fed:lei:10406:2002': ['cc', 'cc/2002', 'cc/02', 'codigo civil', 'novo codigo civil'],
  'fed:lei:3071:1916': ['cc/1916', 'cc/16', 'codigo civil de 1916'],
  'fed:dl:5452:1943': ['clt', 'consolidacao das leis do trabalho'],
  'fed:lei:8078:1990': ['cdc', 'codigo de defesa do consumidor'],
  'fed:lei:5172:1966': ['ctn', 'codigo tributario nacional'],
  'fed:lei:9503:1997': ['ctb', 'codigo de transito brasileiro', 'codigo de transito'],
  'fed:lei:4737:1965': ['codigo eleitoral'],
  'fed:lei:8069:1990': ['eca', 'estatuto da crianca e do adolescente'],
  'fed:lei:7210:1984': ['lep', `lei de execucao${' '}penal`, 'lei de execucoes penais'],
  'fed:dl:4657:1942': ['lindb', 'lei de introducao as normas do direito brasileiro', 'licc'],
  'fed:dl:1001:1969': ['cpm', 'codigo penal militar'],
  'fed:dl:1002:1969': ['cppm', 'codigo de processo penal militar'],
  'fed:dl:3688:1941': ['lcp', 'lei das contravencoes penais'],
  'fed:lei:11340:2006': ['lei maria da penha'],
  'fed:lei:11343:2006': ['lei de drogas', 'lei antidrogas'],
  'fed:lei:8429:1992': ['lia', 'lei de improbidade administrativa', 'lei de improbidade'],
  'fed:lei:13709:2018': ['lgpd', 'lei geral de protecao de dados'],
  'fed:lei:12965:2014': ['marco civil da internet'],
  'fed:lei:10741:2003': ['estatuto do idoso', 'estatuto da pessoa idosa'],
  'fed:lei:10826:2003': ['estatuto do desarmamento'],
  'fed:lei:8072:1990': ['lei dos crimes hediondos', 'lei de crimes hediondos'],
  'fed:lei:12850:2013': ['lei de organizacoes criminosas', 'lei das organizacoes criminosas'],
  'fed:lei:9613:1998': ['lei de lavagem de dinheiro', 'lei de lavagem'],
  'fed:lei:13869:2019': ['lei de abuso de autoridade'],
  'fed:lei:8906:1994': ['eoab', 'estatuto da advocacia', 'estatuto da oab'],
  'fed:lei:6830:1980': ['lef', 'lei de execucao fiscal', 'lei de execucoes fiscais'],
  'fed:lei:12016:2009': ['lei do mandado de seguranca'],
  'fed:lei:7347:1985': ['lacp', 'lei da acao civil publica'],
  'fed:lei:11101:2005': ['lei de falencias', 'lei de recuperacao judicial e falencias'],
  'fed:lc:101:2000': ['lrf', 'lei de responsabilidade fiscal'],
  'fed:lei:8245:1991': ['lei do inquilinato'],
  'fed:lei:9099:1995': ['lei dos juizados especiais'],
  'fed:lei:10259:2001': ['lei dos juizados especiais federais'],
  'fed:lei:14133:2021': ['lei de licitacoes', 'nova lei de licitacoes'],
  'fed:lei:13964:2019': ['pacote anticrime'],
  'fed:lei:8112:1990': ['estatuto dos servidores publicos federais', 'rju'],
  'fed:lei:8213:1991': ['lei de beneficios da previdencia social', 'lei de beneficios'],
  'fed:lei:8212:1991': ['lei de custeio da seguridade social', 'lei de custeio'],
  'fed:lc:135:2010': ['lei da ficha limpa'],
  'fed:lc:64:1990': ['lei de inelegibilidades', 'lei das inelegibilidades'],
  'fed:lei:12846:2013': ['lei anticorrupcao'],
  'fed:lei:12527:2011': ['lai', 'lei de acesso a informacao'],
  'fed:lei:10257:2001': ['estatuto da cidade'],
  'fed:lei:12651:2012': ['codigo florestal'],
  'fed:lei:9605:1998': ['lei de crimes ambientais', 'lei dos crimes ambientais'],
  'fed:lei:9455:1997': ['lei de tortura'],
  'fed:lei:9296:1996': ['lei de interceptacao telefonica', 'lei das interceptacoes'],
  'fed:lei:9807:1999': ['lei de protecao a testemunhas'],
  'fed:lei:6015:1973': ['lei de registros publicos', 'lrp'],
  'fed:lei:6404:1976': ['lei das sociedades anonimas', 'lei das s.a.', 'lsa'],
  'fed:lei:9307:1996': ['lei de arbitragem'],
  'fed:lei:9784:1999': ['lei do processo administrativo federal'],
  'fed:lei:8080:1990': ['lei organica da saude'],
  'fed:lei:9394:1996': ['ldb', 'lei de diretrizes e bases da educacao'],
  'fed:lei:13146:2015': ['estatuto da pessoa com deficiencia', 'lei brasileira de inclusao'],
  'fed:lei:9279:1996': ['lei de propriedade industrial', 'lpi'],
  'fed:lei:9610:1998': ['lei de direitos autorais', 'lda'],
  'fed:lei:8137:1990': ['lei dos crimes contra a ordem tributaria'],
  'fed:lei:7492:1986': ['lei dos crimes contra o sistema financeiro', 'lei do colarinho branco'],
  'fed:lei:12037:2009': ['lei de identificacao criminal'],
  'fed:lei:7716:1989': ['lei do racismo', 'lei de racismo'],
  'fed:lei:9434:1997': ['lei de transplantes'],
  'reg:anvisa:port:344:1998': ['portaria 344/1998', 'portaria 344/98', 'portaria 344'],
  'trat:direitos-humanos:sanjose': ['pacto de san jose da costa rica', 'convencao americana sobre direitos humanos', 'cadh'],
  'trat:direitos-humanos:pacto': ['pacto internacional sobre direitos civis e politicos', 'pidcp'],
  'trat:direitos-humanos:belem': ['convencao de belem do para'],
  'trat:direitos-humanos:regras-de-mandela-presos-onu': ['regras de mandela'],
  'trat:direitos-humanos:regras-de-bangkok-mulheres-presas-onu': ['regras de bangkok'],
  'trat:direitos-humanos:regras-de-toquio-medidas-nao-privativas-onu': ['regras de toquio'],
  'trat:direitos-humanos:regras-de-pequim-justica-juvenil-onu': ['regras de pequim'],
  'trat:direitos-humanos:crianca': ['convencao sobre os direitos da crianca'],
  [ID_CF]: ['cf', 'cf/88', 'cf/1988', 'crfb', 'crfb/88', 'crfb/1988', 'constituicao federal', 'constituicao da republica', 'constituicao'],
});

/** Apelidos de uma norma federal a partir do código, número e ano. */
export function apelidosDeNorma(codigo, numero, ano) {
  const nome = NOME_DO_CODIGO[codigo] || codigo;
  const n = numeroSemPonto(numero);
  const exibicao = `${nome} ${formatarNumeroLegivel(numero)}/${ano}`;
  const lista = [{ forma: chaveNorma(codigo, n, ano), exibicao }];
  // Sem ano, a citação é ambígua sempre que o número se repete (decretos recomeçaram a numeração);
  // o apelido entra assim mesmo, e a resolução devolve `ambigua` com os candidatos.
  if (codigo !== 'dnn') lista.push({ forma: chaveNorma(codigo, n, null), exibicao: `${nome} ${formatarNumeroLegivel(numero)}` });
  return lista;
}

/** 13105 -> 13.105; 2200-2 fica como está. */
export function formatarNumeroLegivel(numero) {
  const s = numeroSemPonto(numero);
  const m = s.match(/^(\d+)(.*)$/);
  if (!m) return s;
  return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + m[2];
}

// ── Jurisprudência ─────────────────────────────────────────────────────────

export const chaveSumula = (tribunal, n) => `sumula ${tribunal} ${numeroSemPonto(n)}`;
export const chaveSv = (n) => `sv ${numeroSemPonto(n)}`;
export const chaveTema = (tribunal, n) => (tribunal ? `tema ${tribunal} ${numeroSemPonto(n)}` : `tema ${numeroSemPonto(n)}`);
export const chaveControle = (classe, n) => `${classe} ${numeroSemPonto(n)}`;
export const chaveOj = (orgao, n) => (orgao ? `oj ${orgao} ${numeroSemPonto(n)}` : `oj ${numeroSemPonto(n)}`);
export const chaveAcordaoTcu = (num, ano, colegiado) =>
  colegiado ? `acordao tcu ${numeroSemPonto(num)}/${ano} ${colegiado}` : `acordao tcu ${numeroSemPonto(num)}/${ano}`;
export const chaveProcessoStf = (classe, n) => `${classe} ${numeroSemPonto(n)}`;

/** Colegiado do TCU numa forma curta e estável. */
export function colegiadoTcu(texto) {
  const t = String(texto || '').toLowerCase();
  if (/plen/.test(t)) return 'plenario';
  if (/primeira|1[ªa]?\s*c/.test(t)) return '1c';
  if (/segunda|2[ªa]?\s*c/.test(t)) return '2c';
  return null;
}

/** Órgão de OJ do TST a partir de "SDI-1", "SBDI-1", "SDI1T", "SDC"... */
export function orgaoOj(texto) {
  const t = String(texto || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^s?b?di1t|sdi1transit|sbdi1transit/.test(t)) return 'sdi1t';
  if (/^s?b?di1/.test(t) || t === 'sdi1' || t === 'sbdi1') return 'sdi1';
  if (/^s?b?di2/.test(t)) return 'sdi2';
  if (t === 'sdc') return 'sdc';
  if (/tpoe|tribunalpleno|orgaoespecial/.test(t)) return 'tp-oe';
  return null;
}

// ── Blocos além do federal: estaduais, municipais, reguladores, tratados ──

/** Siglas e nomes das UFs (forma sem acento, minúscula). */
export const UFS = Object.freeze({
  ac: 'acre', al: 'alagoas', ap: 'amapa', am: 'amazonas', ba: 'bahia', ce: 'ceara', df: 'distrito federal',
  es: 'espirito santo', go: 'goias', ma: 'maranhao', mt: 'mato grosso', ms: 'mato grosso do sul', mg: 'minas gerais',
  pa: 'para', pb: 'paraiba', pr: 'parana', pe: 'pernambuco', pi: 'piaui', rj: 'rio de janeiro', rn: 'rio grande do norte',
  rs: 'rio grande do sul', ro: 'rondonia', rr: 'roraima', sc: 'santa catarina', sp: 'sao paulo', se: 'sergipe', to: 'tocantins',
});

/** Gentílicos que, ao lado de "estadual" ou de "lei", indicam a UF ("lei paulista"). */
export const GENTILICOS_UF = Object.freeze({
  paulista: 'sp', fluminense: 'rj', mineira: 'mg', mineiro: 'mg', gaucha: 'rs', gaucho: 'rs', catarinense: 'sc',
  paranaense: 'pr', baiana: 'ba', baiano: 'ba', pernambucana: 'pe', pernambucano: 'pe', cearense: 'ce', goiana: 'go',
  goiano: 'go', capixaba: 'es', paraense: 'pa', amazonense: 'am', maranhense: 'ma', piauiense: 'pi', potiguar: 'rn',
  sergipana: 'se', sergipano: 'se', alagoana: 'al', alagoano: 'al', tocantinense: 'to', rondoniense: 'ro', roraimense: 'rr',
  acreana: 'ac', acreano: 'ac', amapaense: 'ap', distrital: 'df', paraibana: 'pb', paraibano: 'pb',
  'mato-grossense': 'mt', 'sul-mato-grossense': 'ms',
});

/** Forma estável para id e apelido: sem acento, minúscula, só [a-z0-9-]. */
export function slugificar(texto, limite = 60) {
  return String(texto ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, limite).replace(/-+$/g, '');
}

/**
 * Tipo do frontmatter (estadual, municipal, regulador, conselho) -> código curto. Os tipos do CNMP
 * vêm no plural ("Resoluções", "Portarias da Presidência") e as portarias de cada órgão interno
 * têm numeração própria: o código separa cada série, para o número não colidir.
 */
const CODIGO_DO_TIPO_GERAL = Object.freeze({
  'lei ordinaria': 'lei', lei: 'lei', 'lei complementar': 'lc', 'decreto-lei': 'dl', 'decreto lei': 'dl', decreto: 'dec',
  'decreto legislativo': 'dlg', 'decreto (nao numerado)': 'dnn', 'lei delegada': 'ld', 'emenda constitucional': 'ec',
  'constituicao estadual': 'ce', 'lei promulgada': 'lp', 'decreto-lei complementar': 'dlc', resolucao: 'res', resolucoes: 'res',
  portaria: 'port', portarias: 'port', 'instrucao normativa': 'in', 'instrucoes normativas': 'in', deliberacao: 'delib',
  circular: 'circ', recomendacao: 'rec', recomendacoes: 'rec', provimento: 'prov', provimentos: 'prov', sumula: 'sumula',
  sumulas: 'sumula', 'ato normativo': 'an', 'atos normativos': 'an', 'parecer normativo': 'pn', 'solucao de consulta': 'sc',
  'ato declaratorio executivo': 'ade', 'ato declaratorio': 'ad', 'ato declaratorio normativo': 'adn',
  'ato declaratorio interpretativo': 'adint', 'convenio icms': 'convenio-icms', 'lei organica': 'lom',
  'emenda a lei organica': 'elom', 'regimento interno': 'regimento', 'regimento interno consolidado': 'regimento',
  'portaria conjunta': 'portc', 'portarias conjuntas': 'portc', 'resolucao conjunta': 'resc', 'resolucoes conjuntas': 'resc',
  'instrucao normativa conjunta': 'inc', enunciado: 'enunciado', enunciados: 'enunciado', 'codigo tributario': 'ctm',
  'codigo municipal': 'codigo', 'plano diretor': 'plano-diretor', 'portarias da presidencia': 'port-presidencia',
  'portarias da secretaria geral': 'port-sg', 'portarias da corregedoria': 'port-corregedoria',
  'emendas regimentais': 'emenda-regimental', 'emenda regimental': 'emenda-regimental',
  'resolucao normativa consolidada': 'rn-consolidada', 'instrucao normativa consolidada': 'in-consolidada',
  'portaria normativa': 'portn', 'portaria normativa conjunta': 'portnc',
});

export function codigoDoTipoGeral(tipo) {
  const t = String(tipo ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return CODIGO_DO_TIPO_GERAL[t] || slugificar(t, 40) || null;
}

/** Como cada código aparece na exibição do apelido (o que não estiver aqui usa o tipo do frontmatter). */
export const NOME_DO_CODIGO_GERAL = Object.freeze({
  lei: 'Lei', lc: 'Lei Complementar', dl: 'Decreto-Lei', dec: 'Decreto', dlg: 'Decreto Legislativo', ld: 'Lei Delegada',
  ec: 'Emenda Constitucional', ce: 'Constituição Estadual', lp: 'Lei Promulgada', res: 'Resolução', port: 'Portaria',
  in: 'Instrução Normativa', delib: 'Deliberação', circ: 'Circular', rec: 'Recomendação', prov: 'Provimento',
  sumula: 'Súmula', rdc: 'RDC', lom: 'Lei Orgânica', elom: 'Emenda à Lei Orgânica', ade: 'Ato Declaratório Executivo',
  sc: 'Solução de Consulta', pn: 'Parecer Normativo',
});

/**
 * Órgãos reguladores que o leitor de citação reconhece por sigla ou nome. Só entram siglas que não
 * são palavra comum do português ("mapa", "cultura" e "defesa" são pastas da Legis, mas na frase
 * não dizem órgão nenhum; essas aparecem só no apelido do documento, com o nome da pasta).
 */
export const ORGAOS_CITAVEIS = Object.freeze({
  agu: 'agu', anac: 'anac', anatel: 'anatel', ancine: 'ancine', aneel: 'aneel', anm: 'anm', anp: 'anp', ans: 'ans',
  antaq: 'antaq', antt: 'antt', anvisa: 'anvisa', bcb: 'bcb', bacen: 'bcb', 'banco central': 'bcb', cmn: 'cmn',
  bndes: 'bndes', cade: 'cade', capes: 'capes', carf: 'carf', cfc: 'cfc', cgu: 'cgu', cne: 'cne', cns: 'cns', coaf: 'coaf',
  conama: 'conama', confaz: 'confaz', contran: 'contran', cvm: 'cvm', dpu: 'dpu', ibama: 'ibama', icmbio: 'icmbio',
  inep: 'inep', inmetro: 'inmetro', inss: 'inss', iphan: 'iphan', mcti: 'mcti', mdic: 'mdic', mds: 'mds', mec: 'mec',
  mma: 'mma', mme: 'mme', mte: 'mte', pgfn: 'pgfn', previc: 'previc', rfb: 'rfb', srf: 'srf', 'receita federal': 'rfb',
  senatran: 'senatran', denatran: 'denatran', susep: 'susep', stn: 'stn', 'svs/ms': 'svs/ms', 'ministerio da saude': 'ms',
  'ministerio da justica': 'mj', mjsp: 'mj', 'policia federal': 'pf', dpf: 'pf', prf: 'prf', depen: 'depen', cnpcp: 'cnpcp',
  senasp: 'senasp', cosit: 'cosit', anpd: 'anpd', cnj: 'cnj', cnmp: 'cnmp', 'conselho nacional de justica': 'cnj',
  'conselho nacional do ministerio publico': 'cnmp', 'corregedoria nacional de justica': 'cnj',
  // Órgãos e colegiados com ato próprio na Legis que a lista acima não tinha (a sigla de órgão
  // desconhecida em maiúsculas também vale, ver `orgaosDoAto` em citacao.js).
  drei: 'drei', dnrc: 'dnrc', cgsn: 'cgsn', cgsim: 'cgsim', ccfgts: 'ccfgts', codefat: 'codefat', fundacentro: 'fundacentro',
  memp: 'memp', mtp: 'mtp', jucesp: 'jucesp', jucerj: 'jucerj', jucepe: 'jucepe', jucemg: 'jucemg', fonaprec: 'fonaprec',
});

/** Espécies de ato de regulador, da forma mais longa à mais curta. */
export const ESPECIES_REGULADOR = Object.freeze([
  ['instrucao normativa conjunta', 'inc'], ['instrucao normativa', 'in'], ['portaria conjunta', 'portc'],
  ['portaria normativa', 'portn'], ['portaria', 'port'], ['resolucao da diretoria colegiada', 'rdc'],
  ['resolucao conjunta', 'resc'], ['resolucao normativa', 'res'], ['resolucao', 'res'], ['rdc', 'rdc'], ['circular', 'circ'],
  ['deliberacao', 'delib'], ['parecer normativo', 'pn'], ['solucao de consulta', 'sc'], ['ato declaratorio executivo', 'ade'],
  ['ato declaratorio interpretativo', 'adint'], ['ato declaratorio normativo', 'adn'], ['ato declaratorio', 'ad'],
  ['convenio icms', 'convenio-icms'], ['ato normativo', 'an'], ['ade', 'ade'], ['in', 'in'], ['port', 'port'], ['res', 'res'],
  // Acrescentadas em 04/11/2026 (RN da ANS, pareceres e ofícios-circulares da CVM e do DREI, instruções da CVM).
  ['parecer de orientacao', 'parecer-de-orientacao'], ['oficio circular', 'oficio-circular'], ['oficio-circular', 'oficio-circular'],
  ['instrucao cvm', 'instrucao-cvm'], ['icvm', 'instrucao-cvm'], ['rn', 'rn'], ['oc', 'oficio-circular'], ['po', 'parecer-de-orientacao'],
]);

/**
 * Os códigos de espécie que uma citação pode ter na tabela de apelidos, em ordem de preferência. A
 * carga grava o apelido de cada documento com o código do SEU tipo no frontmatter, que não é sempre o
 * mesmo que se escreve na citação (uma Resolução Normativa da ANS entra como `res` ou como
 * `resolucao-normativa`, conforme o tipo que a fonte deu). O leitor tenta cada um; a carga grava os
 * aliases do tipo do documento (`codigosDaEspecie`).
 */
export const CODIGOS_DA_ESPECIE = Object.freeze({
  'resolucao normativa': ['rn', 'res', 'resolucao-normativa'], rn: ['rn', 'res', 'resolucao-normativa'],
  rdc: ['rdc', 'res'], 'resolucao da diretoria colegiada': ['rdc', 'res'],
  'instrucao cvm': ['instrucao-cvm', 'icvm'], icvm: ['instrucao-cvm', 'icvm'],
  'parecer de orientacao': ['parecer-de-orientacao', 'po'], po: ['parecer-de-orientacao', 'po'],
  'oficio circular': ['oficio-circular', 'oc'], 'oficio-circular': ['oficio-circular', 'oc'], oc: ['oficio-circular', 'oc'],
});

/**
 * Os códigos de espécie com que um documento de regulador é achado: o do tipo (que também compõe o
 * id), o da espécie do começo do tipo ("Resolução CGSN" é `res`) e os aliases de `CODIGOS_DA_ESPECIE`.
 */
export function codigosDaEspecie(tipo, titulo = '') {
  const t = String(tipo ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const tt = String(titulo ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const out = [];
  const poe = (c) => { if (c && !out.includes(c)) out.push(c); };
  poe(codigoDoTipoGeral(tipo));
  for (const [nome, cod] of ESPECIES_REGULADOR) {
    if (nome.length > 3 && (t === nome || t.startsWith(`${nome} `))) { poe(cod); break; }
  }
  // Resolução Normativa que a fonte tipou só como "Resolução" (a maioria da ANS): o título diz.
  if (/^resolucao normativa\b|^rn\b/.test(t) || /^resolucao normativa\b|^resolucao normativa - rn\b/.test(tt)) for (const c of CODIGOS_DA_ESPECIE.rn) poe(c);
  if (t === 'norma regulamentadora') poe('nr');
  for (const c of CODIGOS_DA_ESPECIE[t] || []) poe(c);
  return out;
}

/** Chaves de apelido dos blocos novos (formas já normalizadas). */
export const chaveEstadual = (uf, codigo, n, ano) => (ano ? `${uf} ${codigo} ${numeroSemPonto(n)}/${ano}` : `${uf} ${codigo} ${numeroSemPonto(n)}`);
export const chaveMunicipal = (mun, uf, codigo, n, ano) => {
  const lugar = uf ? `${mun}/${uf}` : mun;
  if (n == null) return `${lugar} ${codigo}`;
  return ano ? `${lugar} ${codigo} ${numeroSemPonto(n)}/${ano}` : `${lugar} ${codigo} ${numeroSemPonto(n)}`;
};
export const chaveRegulador = (codigo, orgao, n, ano) => (ano ? `${codigo} ${orgao} ${numeroSemPonto(n)}/${ano}` : `${codigo} ${orgao} ${numeroSemPonto(n)}`);
export const chaveRegimento = (tribunal) => `ri${tribunal}`;
