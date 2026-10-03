// Situação do verbete no acervo: a súmula existe, mas está vigente?
//
// Medido em 29/09/2026: o Citation Gate confirmava que a súmula existia no acervo, não que estava
// vigente, e a Súmula 228 do TST, cancelada, saía VERIFICADA. O acervo de súmulas da curadoria já
// declara a situação no corpo do arquivo; faltava ler. A ordem de leitura:
//
// 1. o campo `situacao` do frontmatter (vigente | cancelada | superada | revogada |
//    parcialmente_cancelada | alterada), quando o curador o grava: é a declaração explícita e vence
//    o corpo, inclusive quando diz `vigente`;
// 2. a primeira linha da seção `## Situação`, que abre com a marca em CAIXA ALTA: "CANCELADA A
//    Segunda Seção, na sessão de ..." (STJ), "CANCELADA O livro oficial de súmulas do TST ..."
//    (TST), "SUPERADA Na página oficial da súmula ..." e "REVOGADA ..." (STF), "PARCIALMENTE
//    CANCELADA ..." (TST), "ALTERADA", "REVISADA" e "MODIFICADA" (redação nova, que o próprio
//    arquivo diz ser a vigente). Só a caixa alta conta: a seção antiga do TST guardava o histórico em
//    minúsculas ("cancelada a parte final da antiga redação e inseridos os itens II e III"), e a
//    súmula dela é vigente;
// 3. a nota do livro do TST na primeira linha de `## Fonte de publicação`, o parêntese antes de
//    "Res.": "(cancelada) - Res. 121/2003", "(cancelamento mantido) - Res. ...", "(cancelada por
//    perda de eficácia ...) – Res. 225/2025" e "(item I cancelado ...) – Res. ..." (parcial).
//
// Sem nenhum desses sinais, nada é declarado e o verbete é tratado como vigente, como antes.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o
// indexador (`scripts/indexar-acervo.js` e o template), para o `scripts/squad-state.mjs` (o cartório
// não aceita como verificada a cópia do acervo que declara a súmula cancelada), para o
// `scripts/fonte-oficial.mjs` (a reabertura no acervo) e para o hook `verifica-citacoes.mjs`.

// >>> situacao-acervo:begin
/** Os valores que o campo `situacao` aceita (frontmatter do acervo e entrada do índice). */
const SITUACOES_DO_ACERVO = new Set(['vigente', 'cancelada', 'superada', 'revogada', 'parcialmente_cancelada', 'alterada']);
/** Situação que tira o verbete do fundamento: a citação não se verifica por ele. */
const SITUACOES_QUE_IMPEDEM = new Set(['cancelada', 'superada', 'revogada']);
/** Situação que deixa o verbete de pé, com a ressalva de conferir o trecho ou a redação citada. */
const SITUACOES_COM_AVISO = new Set(['parcialmente_cancelada', 'alterada']);

const MARCAS_DA_SITUACAO = [
  [/^PARCIALMENTE\s+CANCELAD[AO]S?\b/u, 'parcialmente_cancelada'],
  [/^CANCELAD[AO]S?\b/u, 'cancelada'],
  [/^SUPERAD[AO]S?\b/u, 'superada'],
  [/^REVOGAD[AO]S?\b/u, 'revogada'],
  [/^(?:ALTERAD|REVISAD|MODIFICAD)[AO]S?\b/u, 'alterada'],
];

/** `"Parcialmente cancelada"`, `parcialmente-cancelada` → `parcialmente_cancelada`. */
function normalizarSituacao(valor) {
  return String(valor ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

/**
 * O primeiro parágrafo depois do título `## <nome>` (linhas juntas por espaço, até a linha em branco
 * ou o próximo título), ou ''. Parágrafo, não linha: o livro antigo do TST quebra a nota da fonte no
 * meio ("(cancelada por perda de eficácia a partir de 11.11.2017, pela Lei" / "13.467/2017) – Res.").
 */
function primeiroParagrafoDaSecao(linhas, nome) {
  const i = linhas.findIndex((l) => nome.test(l));
  if (i < 0) return '';
  const partes = [];
  for (const linha of linhas.slice(i + 1)) {
    if (/^#{1,6}\s/.test(linha)) break;
    const limpa = linha.replace(/^[\s>*_]+/, '').trim();
    if (!limpa) {
      if (partes.length) break;
      continue;
    }
    partes.push(limpa);
  }
  return partes.join(' ');
}

// A nota do livro do TST abre o parêntese com a palavra da situação ("(mantida)", "(nova redação)",
// "(cancelada)", "(item I cancelado ...)"); parêntese de título ("(REFLEXOS)") não é nota. Vale a
// ÚLTIMA nota do parágrafo: "(nova redação) - Res. 121/2003 ... (cancelada em decorrência ...) -
// Res. 129/2005" é a súmula que ganhou redação nova e depois foi cancelada. A nota que o livro
// antigo deixou sem fechar no fim do parágrafo ("(cancelada por perda de eficácia ..., pela Lei") vale.
const NOTA_DO_LIVRO = /\(((?:mantida|cancelad[ao]|cancelamento|nova\s+reda[çc][ãa]o|reda[çc][ãa]o|alterad[ao]|atualizad[ao]|incorporad[ao]s?|convers[ãa]o|ite(?:m|ns)|republicad[ao]|aglutinad[ao])\b[^()]*)(?:\)|$)/giu;

/**
 * A situação que o arquivo declara. Devolve `{ situacao, origem, invalida }`: `situacao` é um dos
 * `SITUACOES_DO_ACERVO` ou null (nada declarado: vigente por padrão); `origem` diz de onde veio
 * (`frontmatter`, `situacao`, `fonte`); `invalida` traz o valor do frontmatter que não é situação
 * conhecida (ignorado, e o corpo decide).
 */
function situacaoDoTexto(texto) {
  const raw = String(texto ?? '').replace(/^\uFEFF/, '');
  let invalida = null;
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw.slice(0, 8192));
  if (fm) {
    const linha = /^situacao:[ \t]*(.*?)[ \t]*$/m.exec(fm[1]);
    const valor = linha ? normalizarSituacao(linha[1]) : '';
    if (valor && SITUACOES_DO_ACERVO.has(valor)) return { situacao: valor, origem: 'frontmatter', invalida: null };
    if (valor && valor !== 'null' && valor !== '~') invalida = linha[1].trim();
  }
  const corpo = fm ? raw.slice(fm.index + fm[0].length) : raw;
  const linhas = corpo.split(/\r?\n/);
  const naSituacao = primeiroParagrafoDaSecao(linhas, /^#{2,6}\s+Situa[çc][ãa]o\s*$/iu);
  for (const [marca, situacao] of MARCAS_DA_SITUACAO) {
    if (marca.test(naSituacao)) return { situacao, origem: 'situacao', invalida };
  }
  const naFonte = primeiroParagrafoDaSecao(linhas, /^#{2,6}\s+Fonte\s+de\s+publica[çc][ãa]o\s*$/iu);
  const notas = [...naFonte.matchAll(NOTA_DO_LIVRO)];
  const nota = notas.length ? notas[notas.length - 1][1].trim() : '';
  // "cancelada" sozinha, ou seguida de "por"/"em" ("por perda de eficácia", "em decorrência da sua
  // incorporação"): "cancelada a parte final da antiga redação" é histórico de súmula vigente.
  if (/^(?:cancelad[ao]|cancelamento\s+mantido)(?=$|[\s,;]+(?:por|em|a\s+partir)\b)/iu.test(nota)) return { situacao: 'cancelada', origem: 'fonte', invalida };
  if (/^ite(?:m|ns)\b.*\bcancelad[oa]s?\b/iu.test(nota)) return { situacao: 'parcialmente_cancelada', origem: 'fonte', invalida };
  return { situacao: null, origem: null, invalida };
}

/**
 * A frase que acompanha a situação na saída de quem consome o índice: "súmula cancelada: não
 * fundamente nela" (o que impede) ou o aviso de conferir o trecho (o que só ressalva).
 */
function mensagemDaSituacao(situacao, { sumula = true } = {}) {
  const s = normalizarSituacao(situacao);
  if (SITUACOES_QUE_IMPEDEM.has(s)) {
    return sumula ? `súmula ${s}: não fundamente nela` : `precedente ${s.replace(/a$/, 'o')}: não fundamente nele`;
  }
  if (s === 'parcialmente_cancelada') return 'súmula parcialmente cancelada: confira no documento se o item citado continua vigente';
  if (s === 'alterada') return 'súmula com redação alterada: cite a redação vigente, a do documento';
  return '';
}
// <<< situacao-acervo:end

export { SITUACOES_DO_ACERVO, SITUACOES_QUE_IMPEDEM, SITUACOES_COM_AVISO, normalizarSituacao, situacaoDoTexto, mensagemDaSituacao };
