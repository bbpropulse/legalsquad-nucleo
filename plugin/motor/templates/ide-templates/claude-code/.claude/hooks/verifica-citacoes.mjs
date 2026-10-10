#!/usr/bin/env node
/**
 * Citation Gate v3 — sentinela determinística para artefatos jurídicos finais.
 *
 * FAZ (fail-closed no escopo):
 * - identifica arquivos jurídicos finais em squads/<squad>/output/ pelo NOME (vocabulário de
 *   peças levantado das skills em produção) ou pela FORMA (fórmulas de peça, ato judicial,
 *   parecer, contrato, notificação — duas distintas no mesmo texto);
 * - bloqueia marcadores de pendência;
 * - exige um manifesto <artefato>.citation-gate.json aprovado;
 * - confere a estrutura do manifesto e seu vínculo SHA-256 com o arquivo exato;
 * - exige que CADA citação material do texto (lei + artigo, súmula, tema, acórdão) tenha entrada
 *   correspondente em citations[] — mesma classe, mesmo número.
 *
 * NÃO FAZ (verificação material):
 * - não acessa tribunais, diários ou bases oficiais;
 * - não confirma existência, vigência, teor, pertinência ou oficialidade da fonte;
 * - não substitui o verificador de citações nem a revisão humana.
 *
 * O manifesto é uma ATESTAÇÃO do trabalho material já realizado, não prova de que
 * a fonte existe. URL bem-formada e status "verificada" são apenas dados locais.
 * Entrada inesperada fora do escopo é ignorada; depois que um artefato final é
 * identificado, erro de leitura, manifesto ausente/inválido ou hash divergente
 * sempre bloqueia (exit 2).
 */
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';

// Onde estão os documentos do caso: cópia do bloco canônico de src/autos-path.js. A transcrição de
// documento do caso (K9) só sai da lista de citações quando o texto transcrito está nele.
// >>> autos-path:begin
/**
 * Pasta de autos de um squad: `squads/<nome>/autos/` (copiados para o squad) ou,
 * por referência, a pasta do caso que `squads/<nome>/caso.json` aponta
 * (`{"autos": "Processos/<caso>/autos"}` ou `{"pasta": "Processos/<caso>"}`,
 * relativo à raiz do projeto, a pasta acima de `squads/`). A cópia local com
 * `_index.yaml` vence a referência; sem `caso.json`, fica a do squad.
 */
function pastaDeAutos(squadDir) {
  const noSquad = join(squadDir, 'autos');
  if (existsSync(join(noSquad, '_index.yaml'))) return noSquad;
  try {
    const caso = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8'));
    const raiz = dirname(dirname(squadDir));
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (autos) return resolve(raiz, autos);
  } catch { /* sem caso.json, ou ilegível: fica o do squad */ }
  return noSquad;
}

/**
 * Aceita `squads/<nome>` (com `autos/` dentro ou `caso.json` apontando o caso), a
 * pasta do caso (com `autos/` dentro) ou o caminho direto de `autos/`.
 * Devolve `{ dir, erro }`; `dir` é absoluto.
 */
function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const dir = pastaDeAutos(abs);
  if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, erro: null };
  if (existsSync(join(abs, 'caso.json'))) return { dir: null, erro: `${entrada}/caso.json aponta ${dir}, que não existe: confira o caminho (relativo à raiz do projeto, a pasta acima de squads/)` };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/; crie ${entrada}/autos/ e coloque nela os PDFs e documentos do caso, ou grave ${entrada}/caso.json apontando a pasta do caso` };
}
// <<< autos-path:end

// Situação do verbete no acervo: cópia do bloco canônico de src/situacao-acervo.js. A citação
// conferida numa cópia do acervo que declara a súmula cancelada, revogada ou superada não vai à
// final (a Súmula 228 do TST, cancelada, passava como conferida em 29/09/2026).
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

/**
 * Cópia local de LEGISLAÇÃO (`acervo/legislacao/` do projeto ou `acervo/_packs/<pacote>/legislacao/`,
 * o pacote `acervo.legislacao`): o artigo como a curadoria o coletou no Planalto, com a data em
 * `coletado_ate`. Serve para achar o texto e a URL oficial (`fonte_url`), nunca para fechar a
 * citação: lei muda de redação, e a palavra final é a fonte oficial aberta no run (decisão do dono,
 * 06/10/2026). Súmula e julgado do acervo assinado seguem como antes.
 */
const RE_LEGISLACAO_LOCAL = /(^|[\\/])acervo[\\/](?:_packs[\\/][^\\/]+[\\/])?legislacao[\\/]/;
function ehLegislacaoLocal(caminho) {
  return typeof caminho === 'string' && RE_LEGISLACAO_LOCAL.test(caminho);
}

/** A data `coletado_ate` (AAAA-MM-DD) do frontmatter, ou null. */
function coletadoAteDoTexto(texto) {
  const fm = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(texto ?? '').slice(0, 8192));
  const linha = fm && /^coletado_ate:[ \t]*["']?(\d{4}-\d{2}-\d{2})["']?[ \t]*$/m.exec(fm[1]);
  return linha ? linha[1] : null;
}

/** O aviso da lei conferida só no texto local: de quando é o texto e o que fazer. */
function avisoDaLegislacaoLocal(coletadoAte) {
  return `o texto local da lei é a coleta da curadoria ${coletadoAte ? `de até ${coletadoAte}` : 'sem data de coleta'} e não fecha a citação: confira na fonte oficial (a fonte_url do artigo, por scripts/fonte-oficial.mjs); se ela não abrir, a citação fica pendente`;
}
// <<< situacao-acervo:end

const EXIT_BLOCKED = 2;
const MANIFEST_SUFFIX = '.citation-gate.json';
const FINAL_MARKER = /<!--\s*LEGALSQUAD:CITATION-GATE:FINAL\s*-->/i;
// Frontmatter é só o bloco `---` que ABRE o arquivo. Testar `^---` com flag m no arquivo inteiro
// era quadrático em peça cheia de réguas `---` (6 s em 3 MB); agora só o cabeçalho é lido.
function frontmatterDe(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || '').slice(0, 8192));
  return m ? m[1] : '';
}
const FINAL_FRONTMATTER = { test: (text) => /^citation_gate:\s*["']?final["']?\s*$/im.test(frontmatterDe(text)) };
const DRAFT_FRONTMATTER = { test: (text) => /^citation_gate:\s*["']?(?:draft|internal|rascunho)["']?\s*$/im.test(frontmatterDe(text)) };
// Gramática do marcador de pendência: cópia do bloco canônico de src/pendencia.js.
// >>> pendencia:begin
/**
 * Regras da gramática: a palavra-chave em CAIXA ALTA (é assim que o runner, as
 * skills e o ensaio a escrevem), com carga opcional depois de dois-pontos,
 * travessão, hífen, vírgula, ponto e vírgula ou espaço (`[CONFERIR: a vara]`, `[CONFIRMAR COM A AUTORA]`,
 * `[CONFIRMAR, decisão da cliente]`: com vírgula, escapava do manifesto, achado A8 do m4 de 01/10/2026).
 * Caixa alta é o que separa o marcador de um link Markdown (`[Conferir o
 * inteiro teor](url)`) e de um termo técnico entre colchetes (`[hipótese de
 * incidência]`): com a flag `i`, os dois bloqueavam a gravação da final.
 * Colchete seguido de `(` é link, nunca marcador.
 */
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O|PREENCHER|A[ _]PREENCHER|DILIG[ÊE]NCIA)(?:(?:\s+|\s*[:,;—–-])[^\]]*)?\](?!\()/g;
/**
 * Marcador de DADO (o fato que depende do profissional ou do cliente), separado do
 * de citação na medição dos moldes de 24/09/2026 (G11). O de citação trava a final
 * sempre; o de dado passa se o manifesto o lista em `pendencias_do_profissional[]`,
 * e a parada aprovação o mostra. Testado sobre um marcador já casado por PENDING_MARKER.
 */
const DATA_MARKER = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:,;—–-]|\])/;
/** Tema sem âncora apontado pelo verificador de persuasão: contado à parte (não trava hoje). */
const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
/** A linha que abre ou fecha a nota ao revisor (a mesma do bloco `nota-ao-revisor`). */
const LINHA_DA_NOTA_AO_REVISOR = /^[ \t]*<!--\s*nota-ao-revisor:(inicio|fim)\s*-->[ \t]*\r?$/;
/**
 * Cada marcador de pendência do texto, na ordem, com `indice` (posição no texto), `naNota` (está
 * dentro da nota ao revisor) e `repeteDaPeca` (na nota, o mesmo marcador que a peça já traz). A nota
 * que recapitula os campos da peça não é outra pendência: medido em 27/09/2026 (L15, locação, motor
 * 0.9.60), a tabela "Campos e diligências" da nota repetia os marcadores do corpo, e o manifesto saiu
 * com 39 entradas para 18 marcadores. O marcador que só a nota tem continua contando.
 */
function ocorrenciasDePendencia(texto) {
  const normal = (m) => String(m).normalize('NFC').replace(/\s+/g, ' ').trim();
  const out = [];
  let naNota = false;
  let pos = 0;
  for (const linha of String(texto ?? '').split('\n')) {
    const nota = linha.match(LINHA_DA_NOTA_AO_REVISOR);
    if (nota) naNota = nota[1] === 'inicio';
    else {
      for (const a of linha.matchAll(new RegExp(PENDING_MARKER.source, 'g'))) {
        out.push({ marcador: a[0], indice: pos + a.index, naNota, mencao: naNota && mencaoAoMarcador(linha, a.index, a[0]) });
      }
    }
    pos += linha.length + 1;
  }
  const naPeca = new Set(out.filter((o) => !o.naNota).map((o) => normal(o.marcador)));
  return out.map((o) => ({ ...o, repeteDaPeca: o.naNota && naPeca.has(normal(o.marcador)) }));
}
/**
 * Na nota ao revisor, o marcador NU (sem carga) que a frase nomeia como coisa é menção, não
 * pendência: "Nenhum item [NÃO VERIFICADO] da pesquisa foi usado", "(marcadores [CONFIRMAR] e
 * [DILIGÊNCIA])", "`[CONFERIR]`". Medido em 27/09/2026 (negativação, motor 0.9.61): a primeira
 * frase fez o manifesto-final recusar por `marcador-de-citacao` (L17) e a segunda virou duas
 * pendências no manifesto, 10 contra as 8 do empacotador (L18). O critério: marcador nu, entre
 * crases ou aspas, ou precedido (depois de outros marcadores nus e de "e", "ou", vírgula ou barra)
 * de palavra que o nomeia (marcador, item, nenhum, sem...). Continua contando o marcador com carga
 * (`[NÃO VERIFICADO: Súmula 999]`) e o nu colado ao que ele marca (`REsp 1.234/SP [NÃO
 * VERIFICADO]`, `Estado civil do fiador [CONFIRMAR]`). Fora da nota, marcador é sempre marcador.
 */
const PALAVRAS_DO_MARCADOR = PENDING_MARKER.source.slice(PENDING_MARKER.source.indexOf('(?:'), PENDING_MARKER.source.indexOf(')(?:(?:') + 1);
const MARCADOR_NU = new RegExp(`^\\[${PALAVRAS_DO_MARCADOR}\\]$`);
const MARCADOR_NU_NO_FIM = new RegExp(`\\[${PALAVRAS_DO_MARCADOR}\\]\\s*$`);
const PALAVRA_QUE_NOMEIA = /^(?:marcador(?:es)?|item|itens|rotulos?|etiquetas?|sinal|sinais|nenhum|nenhuma|sem|todos?|todas?|tipos?)$/;
function mencaoAoMarcador(linha, indice, marcador) {
  if (!MARCADOR_NU.test(marcador)) return false;
  const antes = linha.slice(0, indice);
  const depois = linha.slice(indice + marcador.length);
  if (/[`"'“‘]$/.test(antes) && /^[`"'”’]/.test(depois)) return true;
  let resto = antes;
  for (;;) {
    const sem = resto.replace(/\s+$/, '').replace(/(?:\s(?:e|ou)|[,/])$/, '').replace(MARCADOR_NU_NO_FIM, '');
    if (sem === resto) break;
    resto = sem;
  }
  const palavra = (resto.match(/([\p{L}]+)[\s(]*$/u) || [])[1] || '';
  return PALAVRA_QUE_NOMEIA.test(palavra.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
}
// <<< pendencia:end
void TEMA_MARKER;
const FINAL_NAME = /(?:^|[-_.])final(?:[-_.]|$)/i;
const SUPPORTED_EXT = /\.(?:md|markdown|txt|rtf|doc|docx|odt|pdf)$/i;

// ── Vocabulário e forma de peça ─────────────────────────────────────────────────────────────────
// Bloco IDÊNTICO em verifica-citacoes.mjs e verifica-redacao.mjs; tests/templates-paridade confere.
// Nomes de peça, ato e instrumento jurídico, como TOKENS canônicos de nome de arquivo (sem acento,
// sem preposição: `resposta-acusacao`, `agravo-instrumento`). Casam em QUALQUER posição do nome:
// `0001234-56.2024.8.26.0100-sentenca.md` e `cliente-x-contestacao.md` são peça. Levantados das 6.999
// skills em produção, família a família (cível, recursal, penal, trabalhista e previdenciária,
// tributária, administrativa, eleitoral, constitucional, extrajudicial, gabinete e MP) e verificados
// contra 600+ nomes de ataque. O que protege o artefato interno não é a posição do token, é o
// PREFIXO interno (`analise-da-contestacao`, `fichamento-do-hc`: ver PREFIXOS_INTERNOS). Palavras
// que sozinhas nomeiam tanto peça quanto coisa interna (`ata`, `termo`, `carta`, `memorando`,
// `informacoes`, `consulta`, `decisao`, `voto`) entram só compostas (`ata-assembleia`, `termo-acordo`,
// `informacoes-ms`, `decisao-interlocutoria`); o ato judicial solto (`decisao.md`) é pego pela FORMA.
const NOMES_DE_PECA = [
  'absolvicao-sumaria', 'acao', 'acao-civil-publica', 'acao-coletiva', 'acao-cumprimento',
  'acao-improbidade', 'acao-investigacao-judicial-eleitoral', 'acao-penal', 'acao-popular',
  'acao-previdenciaria', 'acao-rescisoria', 'acao-revisao', 'acordao', 'acordo', 'acordo-nao-persecucao',
  'acp', 'act', 'adc', 'adi', 'aditamento', 'aditamento-denuncia', 'aditivo', 'adjudicacao',
  'adjudicacao-compulsoria', 'ado', 'adocao', 'adpf', 'advertencia', 'afastamento-sigilo', 'agint',
  'agravo', 'agravo-execucao', 'agravo-instrumento', 'agravo-interno', 'agravo-peticao',
  'agravo-regimental', 'agrg', 'aije', 'aime', 'airc', 'airr', 'alegacoes', 'alegacoes-finais',
  'alienacao-parental', 'alimentos', 'alteracao-contratual', 'alvara', 'alvara-soltura', 'amicus',
  'amicus-curiae', 'anpc', 'anpp', 'antecipacao-garantia', 'antecipacao-tutela', 'anulacao', 'anulatoria',
  'apelacao', 'apelacao-criminal', 'aposentadoria', 'apuracao-haveres', 'arbitramento-honorarios', 'are',
  'aresp', 'arguicao', 'arguicao-inconstitucionalidade', 'arquivamento', 'arrazoado', 'arrematacao',
  'arresto', 'arrolamento', 'assistencia', 'assistente-acusacao', 'ata-age', 'ata-ago', 'ata-agoe',
  'ata-assembleia', 'ata-assembleia-geral', 'ata-audiencia', 'ata-notarial', 'ata-rca',
  'ata-reuniao-acionistas', 'ata-reuniao-condominio', 'ata-reuniao-conselho', 'ata-reuniao-diretoria',
  'ata-reuniao-quotistas', 'ata-reuniao-socios', 'ato-ordinatorio', 'audiencia-custodia',
  'auditoria-interna', 'auto-infracao', 'autofalencia', 'auxilio', 'averbacao', 'averbacao-tempo',
  'aviso-previo', 'beneficio', 'bpc', 'busca-apreensao', 'carta-anuencia', 'carta-cobranca',
  'carta-dispensa', 'carta-intencoes', 'carta-justa-causa', 'carta-ordem', 'carta-precatoria',
  'carta-preposicao', 'carta-preposto', 'carta-rogatoria', 'carta-testemunhavel', 'cautelar', 'cct',
  'certidao', 'cessao', 'chamamento-processo', 'cobranca', 'cobranca-extrajudicial', 'codicilo',
  'codigo-conduta', 'colaboracao-premiada', 'comodato', 'compensacao', 'composicao-civil', 'compra-venda',
  'compromisso', 'compromisso-ajustamento', 'comunicacao-dispensa', 'comunicado-fato-relevante',
  'comunicado-mercado', 'comutacao', 'concessao', 'confissao-divida', 'conflito-atribuicoes',
  'conflito-competencia', 'conflito-jurisdicao', 'consignacao', 'consignacao-pagamento', 'consignatoria',
  'constituicao-mora', 'consulta-fiscal', 'consulta-tributaria', 'contestacao', 'contestacao-fazenda',
  'contra-minuta', 'contradita', 'contramandado', 'contraminuta', 'contranotificacao', 'contraproposta',
  'contrarrazoes', 'contrarrazoes-recurso', 'contrato', 'contrato-honorarios', 'contrato-social',
  'contrato-trabalho', 'convencao', 'convencao-condominio', 'correicao-parcial', 'cota', 'cota-ministerial',
  'crps', 'cumprimento', 'cumprimento-exigencia', 'cumprimento-sentenca', 'curatela',
  'decisao-interlocutoria', 'decisao-liminar', 'decisao-monocratica', 'decisao-saneadora', 'declaracao',
  'declaracao-voto', 'declaratoria', 'decreto', 'defesa', 'defesa-escrita', 'defesa-preliminar',
  'defesa-previa', 'demarcacao', 'demolitoria', 'denuncia', 'denunciacao-lide', 'desaforamento',
  'desaposentacao', 'desapropriacao', 'desconsideracao', 'desentranhamento', 'desinternacao', 'desistencia',
  'despacho', 'despejo', 'destituicao-poder-familiar', 'detracao', 'direito-resposta',
  'dispensa-justa-causa', 'dissidio', 'dissolucao', 'dissolucao-uniao-estavel', 'distrato', 'divisao',
  'divorcio', 'dpa', 'due-diligence', 'duvida-registral', 'edcl', 'edital', 'edital-convocacao',
  'efeito-suspensivo', 'emancipacao', 'embargos', 'embargos-declaracao', 'embargos-declaratorios',
  'embargos-divergencia', 'embargos-execucao', 'embargos-execucao-fiscal', 'embargos-infringentes',
  'embargos-monitorios', 'embargos-sdi', 'embargos-terceiro', 'emenda', 'emenda-inicial', 'eresp',
  'esboco-partilha', 'esclarecimento', 'esclarecimentos', 'escritura', 'especificacao-condominio',
  'especificacao-provas', 'estatuto', 'estatuto-social', 'excecao', 'excecao-incompetencia',
  'excecao-pre-executividade', 'exclusao-socio', 'execucao', 'execucao-fiscal', 'execucao-penal',
  'exequatur', 'exibicao', 'exibicao-documentos', 'exigir-contas', 'exoneracao', 'exoneracao-alimentos',
  'exordial', 'exposicao-motivos', 'extincao', 'extincao-punibilidade', 'falencia', 'falta-grave',
  'fato-relevante', 'fianca', 'formal-partilha', 'gratuidade-justica', 'guarda', 'guia-execucao',
  'guia-recolhimento', 'habeas-corpus', 'habeas-data', 'habilitacao', 'hc', 'homologacao',
  'homologacao-acordo', 'iac', 'idpj', 'imissao-posse', 'impedimento', 'improbidade', 'impronuncia',
  'impugnacao', 'impugnacao-auto-infracao', 'impugnacao-cumprimento-sentenca', 'impugnacao-edital',
  'impugnacao-sentenca-liquidacao', 'incidente', 'incidente-assuncao-competencia',
  'incidente-desconsideracao', 'incidente-insanidade', 'incidente-resolucao-demandas-repetitivas',
  'incidente-uniformizacao', 'indebito', 'indenizacao', 'indenizatoria', 'indulto', 'inexistencia-debito',
  'informacoes-autoridade-coatora', 'informacoes-hc', 'informacoes-ms', 'informacoes-prestadas', 'inicial',
  'inquerito', 'inquerito-civil', 'inquerito-judicial', 'instituicao-condominio', 'instrucao-normativa',
  'instrumento-particular', 'interdicao', 'interdito', 'interdito-proibitorio', 'internacao-compulsoria',
  'interpelacao', 'intervencao-federal', 'inventario', 'investigacao-paternidade', 'irdr',
  'juizo-admissibilidade', 'juizo-retratacao', 'julgamento-antecipado', 'juntada', 'justica-gratuita',
  'justificacao', 'justificacao-administrativa', 'legal-opinion', 'libelo', 'liberdade-provisoria',
  'liminar', 'liquidacao', 'livramento', 'loas', 'locacao', 'loi', 'mandado', 'mandado-busca-apreensao',
  'mandado-citacao', 'mandado-injuncao', 'mandado-prisao', 'mandado-seguranca', 'manifestacao',
  'manifestacao-inconformidade', 'manifestacao-ministerial', 'manutencao-posse', 'mediacao',
  'medida-cautelar', 'medida-protetiva', 'medidas-cautelares', 'medidas-protetivas',
  'memorando-entendimento', 'memorando-entendimentos', 'memoriais', 'memorial', 'memorial-incorporacao',
  'mocao', 'monitoracao-eletronica', 'monitoria', 'mou', 'ms', 'nda', 'negatoria', 'nota-devolutiva',
  'nota-tecnica', 'noticia-crime', 'noticia-fato', 'noticia-inelegibilidade', 'notificacao',
  'notificacao-extrajudicial', 'notificacao-recomendatoria', 'notitia-criminis', 'nunciacao', 'objecao',
  'obrigacao-fazer', 'obrigacao-nao-fazer', 'oferecimento-garantia', 'oferta-alimentos', 'oficio',
  'oficio-requisitorio', 'opiniao-juridica', 'opiniao-legal', 'oposicao', 'pacto-antenupcial', 'pad',
  'parcelamento', 'parecer', 'parecer-ministerial', 'parecer-procuradoria', 'partilha', 'paternidade',
  'pauliana', 'peca', 'pedido', 'pedido-contraposto', 'pedido-efeito-suspensivo', 'pedido-informacoes',
  'pedido-providencias', 'pedido-reconsideracao', 'pedido-revisao', 'pedido-suspensao',
  'pedido-uniformizacao', 'penhora', 'pensao-morte', 'peticao', 'peticao-inicial', 'plano-partilha',
  'plano-recuperacao', 'plano-recuperacao-judicial', 'politica', 'politica-interna', 'politica-privacidade',
  'portaria', 'possessoria', 'pre-executividade', 'precatorio', 'preliminar-repercussao-geral',
  'prestacao-contas', 'prestacao-informacoes', 'primeiras-declaracoes', 'prisao-domiciliar',
  'prisao-preventiva', 'procedimento-controle-administrativo', 'procedimento-investigatorio-criminal',
  'procedimento-preparatorio', 'procuracao', 'producao-antecipada', 'progressao-regime', 'projeto-decreto',
  'projeto-emenda', 'projeto-lei', 'projeto-resolucao', 'projeto-sentenca', 'promessa-compra-venda',
  'promocao', 'promocao-arquivamento', 'promocao-ministerial', 'pronuncia', 'proposta-acordo', 'protesto',
  'protesto-interruptivo', 'puil', 'quanti-minoris', 'quebra-sigilo', 'queixa', 'queixa-crime', 'querela',
  'querela-nullitatis', 'quesitos', 'questao-ordem', 'quitacao', 'razoes', 'razoes-apelacao',
  'razoes-finais', 'rced', 'rcl', 'reabilitacao-criminal', 'reafirmacao-der', 'recibo', 'reclamacao',
  'reclamacao-constitucional', 'reclamacao-correicional', 'reclamacao-disciplinar',
  'reclamacao-previdenciaria', 'reclamacao-trabalhista', 'reclamatoria', 'recomendacao',
  'recomendacao-ministerial', 'reconhecimento-paternidade', 'reconhecimento-tempo-especial',
  'reconhecimento-uniao-estavel', 'reconhecimento-vinculo', 'reconsideracao', 'reconvencao',
  'recuperacao-judicial', 'recurso', 'recurso-adesivo', 'recurso-administrativo', 'recurso-especial',
  'recurso-extraordinario', 'recurso-hierarquico', 'recurso-inominado', 'recurso-interno',
  'recurso-ordinario', 'recurso-revisao', 'recurso-revista', 'recurso-sentido-estrito',
  'recurso-voluntario', 'redibitoria', 'reequilibrio', 'reexame', 'regimento', 'regimento-interno',
  'registro-candidatura', 'regressao-regime', 'regulamentacao-guarda', 'regulamentacao-visitas',
  'regulamento', 'regulamento-interno', 'reintegracao-posse', 'reivindicatoria', 'relatorio-auditoria',
  'relatorio-due-diligence', 'relatorio-voto', 'relaxamento', 'remicao', 'renovatoria', 'renuncia',
  'repercussao-geral', 'repeticao-indebito', 'replica', 'representacao', 'representacao-criminal',
  'representacao-interventiva', 'requerimento', 'requerimento-administrativo', 'requisicao', 'rescisao',
  'rescisoria', 'rese', 'resolucao', 'resp', 'respe', 'responsabilidade-civil', 'resposta',
  'resposta-acusacao', 'resposta-consulta', 'resposta-oficio', 'restabelecimento', 'restauracao-autos',
  'restituicao', 'restituicao-coisas', 'retificacao', 'revisao-alimentos', 'revisao-aposentadoria',
  'revisao-beneficio', 'revisao-contratual', 'revisao-criminal', 'revisao-vida-toda', 'revisional',
  'revocatoria', 'revogacao', 'rhc', 'ripd', 'rms', 'roc', 'rol-testemunhas', 'rrc', 'rse', 'rvcr',
  'saida-temporaria', 'salario-maternidade', 'salvo-conduto', 'saneamento', 'sentenca', 'sequestro',
  'sindicancia', 'sindicancia-interna', 'sobrepartilha', 'substabelecimento', 'substituicao-pena',
  'suprimento', 'sursis', 'suscitacao-duvida', 'suspeicao', 'suspensao', 'suspensao-condicional',
  'suspensao-liminar', 'suspensao-seguranca', 'suspensao-tutela', 'sustacao', 'sustentacao',
  'sustentacao-oral', 'tac', 'tce', 'tempo-especial', 'term-sheet', 'termo-acordo', 'termo-adesao',
  'termo-aditivo', 'termo-ajustamento', 'termo-ajustamento-conduta', 'termo-audiencia', 'termo-compromisso',
  'termo-conciliacao', 'termo-consentimento', 'termo-mediacao', 'termo-quitacao', 'termo-referencia',
  'termo-responsabilidade', 'termos-uso', 'testamento', 'testemunhavel', 'tomada-decisao-apoiada',
  'trabalho-externo', 'trancamento', 'transacao', 'transacao-extrajudicial', 'transacao-penal',
  'transferencia-preso', 'treplica', 'tutela', 'tutela-antecedente', 'tutela-antecipada', 'tutela-cautelar',
  'tutela-evidencia', 'tutela-provisoria', 'tutela-recursal', 'tutela-urgencia', 'ultimas-declaracoes',
  'uniao-estavel', 'unificacao-penas', 'uniformizacao', 'usucapiao', 'usucapiao-extrajudicial',
  'vinculo-empregaticio', 'voto', 'voto-divergente', 'voto-vista',
];

// Preposições que o nome do arquivo pode trazer ou omitir (`resposta-a-acusacao` ou
// `resposta-acusacao`, `agravo-de-instrumento` ou `agravo-instrumento`): saem dos dois lados.
const PREPOSICOES_NO_NOME = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'ao', 'aos', 'as', 'em', 'no', 'na', 'nos', 'nas', 'e', 'o', 'os',
  'um', 'uma', 'para', 'por', 'com',
]);

/** `Contestação_Cliente X.v2.md`, `PeticaoInicial.docx` → `contestacao-cliente-x-v2`, `peticao-inicial`:
 * sem extensão, sem acento, camelCase e letra↔dígito separados, sem preposição. */
function nomeCanonico(name, { separarCamelCase = true } = {}) {
  const semExtensao = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const separado = !separarCamelCase ? semExtensao : semExtensao
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .replace(/(\d)([A-Za-z])/g, '$1-$2');
  const ascii = separado.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return ascii.split(/[^a-z0-9]+/).filter((s) => s && !PREPOSICOES_NO_NOME.has(s)).join('-');
}
/** As duas leituras do nome: com camelCase separado (`PeticaoInicial` → `peticao-inicial`) e sem
 * (`RvCr`, `AgRg` são siglas, não camelCase). */
function leiturasDoNome(name) {
  const com = nomeCanonico(name);
  const sem = nomeCanonico(name, { separarCamelCase: false });
  return com === sem ? [com] : [com, sem];
}

// O que começa assim é trabalho SOBRE a peça, não a peça: análise, fichamento, mapa, plano, notas,
// resumo, pesquisa, revisão, relatório… Um prefixo interno vence o nome de peça que vier depois
// (`analise-da-contestacao`, `03-fichamento-do-acordao`, `resumo-da-sentenca`), com uma exceção: o
// nome que COMEÇA por um token composto do vocabulário é peça (`relatorio-e-voto`, `nota-tecnica`,
// `revisao-de-beneficio`, `plano-de-partilha`), porque o composto é mais específico que o prefixo.
// Palavra que também nomeia peça ou ato (`decisao`, `informacoes`, `consulta`, `ata`, `memorando`)
// NÃO está aqui: esses nomes ficam neutros e a forma decide.
const PREFIXOS_INTERNOS = [
  'revisao', 'aprovacao', 'checklist', 'relatorio', 'pesquisa', 'resumo', 'diagnostico', 'bloqueio',
  'precedentes', 'precedente', 'julgado', 'julgados', 'jurisprudencia', 'ementa', 'cabimento', 'fatos',
  'teses', 'tese', 'estrategia', 'calculo', 'intake', 'onboarding', 'triagem', 'publish-report', 'foco',
  'temas', 'contradicoes', 'pre-mortem', 'contraditor', 'prazos', 'prazo', 'carteira', 'comunicacao',
  'analise', 'analises', 'fichamento', 'mapa', 'mapas', 'esqueleto', 'estrutura', 'outline', 'notas', 'nota',
  'anotacoes', 'anotacao', 'plano', 'planejamento', 'roteiro', 'briefing', 'cronograma', 'cronologia',
  'agenda', 'tabela', 'lista', 'matriz', 'comparativo', 'comparacao', 'memoria', 'reuniao', 'email',
  'mail', 'mensagem', 'entrevista', 'perguntas', 'pendencias', 'pendencia', 'pontos', 'ponto', 'glossario',
  'dossie', 'sintese', 'sumario', 'transcricao', 'linha', 'viabilidade', 'requisitos', 'recomendacoes',
  'riscos', 'risco', 'duvidas', 'duvida', 'historico', 'cenarios', 'cenario', 'observacoes', 'observacao',
  'diff', 'comentarios', 'comentario', 'sugestoes', 'sugestao', 'apontamentos', 'criticas', 'critica',
  'avaliacao', 'andamento', 'anexos', 'bens', 'clausulas', 'conferencia', 'dispositivo', 'feedback',
  'fontes', 'indice', 'lacunas', 'leitura', 'licoes', 'metricas', 'pauta', 'planilha', 'preparacao',
  'provas', 'quadro', 'referencias', 'research', 'simulacao', 'sobrevivencia', 'status', 'tendencia',
  'trechos', 'validacao', 'verificacao', 'log', 'logs', 'review', 'gate', 'flags', 'tarefas', 'tarefa',
  'research-focus', 'summary', 'notes', 'analysis', 'timeline', 'todo', 'changelog', 'report', 'brief', 'memo',
  'itens', 'proxima', 'proximo', 'proximos', 'curso', 'auto-avaliacao', 'red-team',
];
// Último segmento que denuncia trabalho SOBRE a peça (`contrato-analise`, `hc-fichamento`,
// `contestacao-revisao-a`). O composto de peça sai antes (`pedido-revisao` é a peça).
const SUFIXOS_INTERNOS = [
  'notas', 'checklist', 'analise', 'fichamento', 'mapa', 'pesquisa', 'resumo', 'revisao', 'briefing', 'outline',
  'esqueleto', 'comparativo', 'cronograma', 'log', 'todo', 'notes', 'summary', 'analysis', 'review',
];
// Segmentos que, em QUALQUER posição, denunciam gestão do run ou comunicação interna.
// (`acervo`, `log` e `run` ficaram de fora: "partilha-do-acervo-hereditario" e a razão social
// "log-in-logistica" são peça.)
const SEGMENTOS_INTERNOS = [
  'tarefas', 'tarefa', 'pendencias', 'pendencia', 'reuniao', 'equipe', 'versoes', 'interno', 'interna',
  'estrategia', 'estrategica', 'estrategico', 'prazos', 'autos',
];
// Segmentos de ordem ou de versão que o agente põe na frente do nome (`03-`, `2026-09-11-`, `step-03-`,
// `v2-`, `nova-`, `ultima-`, `re-`, `pre-`): saem antes de olhar o prefixo.
const SEGMENTO_DE_ORDEM = /^(?:\d+|step|etapa|passo|v\d+|run|nov[oa]s?|ultim[oa]s?|primeir[oa]s?|segund[oa]s?|terceir[oa]s?|pre|re)(?:-|$)/;

const NOME_DE_PECA = new RegExp(`(?:^|-)(?:${NOMES_DE_PECA.join('|')})(?:-|$)`);
const COMPOSTOS_DE_PECA = NOMES_DE_PECA.filter((t) => t.includes('-'));
const NOME_DE_PECA_COMPOSTO_NO_INICIO = new RegExp(`^(?:${COMPOSTOS_DE_PECA.join('|')})(?:-|$)`);
const NOME_DE_PECA_COMPOSTO = new RegExp(`(?:^|-)(?:${COMPOSTOS_DE_PECA.join('|')})(?=-|$)`, 'g');
const PREFIXO_INTERNO = new RegExp(`^(?:${PREFIXOS_INTERNOS.join('|')})(?:-|$)`);
const SEGMENTO_INTERNO = new RegExp(`(?:^|-)(?:${SEGMENTOS_INTERNOS.join('|')})(?:-|$)`);
const SUFIXO_INTERNO = new RegExp(`(?:^|-)(?:${SUFIXOS_INTERNOS.join('|')})(?:-[a-z0-9]{1,2})?$`);
const SEGMENTO_DE_RASCUNHO = /(?:^|-)(?:minuta|rascunho|draft|intern[oa])(?:-|$)/;

function semSegmentosDeOrdem(canonico) {
  let nome = canonico;
  while (SEGMENTO_DE_ORDEM.test(nome)) nome = nome.replace(SEGMENTO_DE_ORDEM, '');
  return nome;
}

/** Rascunho pelo nome: `minuta`, `rascunho`, `draft`, `interno`. O composto de peça não conta:
 * `agravo-interno` é o recurso, não um rascunho. */
function nomeRascunho(name) {
  return leiturasDoNome(name).every((canonico) => SEGMENTO_DE_RASCUNHO.test(canonico.replace(NOME_DE_PECA_COMPOSTO, '')));
}

/** Nome de artefato interno: prefixo interno (salvo composto de peça no início) ou segmento interno. */
function nomeInterno(name) {
  return leiturasDoNome(name).every((leitura) => {
    const canonico = semSegmentosDeOrdem(leitura);
    const semCompostos = canonico.replace(NOME_DE_PECA_COMPOSTO, '');
    if (SEGMENTO_INTERNO.test(semCompostos) || SUFIXO_INTERNO.test(semCompostos)) return true;
    return PREFIXO_INTERNO.test(canonico) && !NOME_DE_PECA_COMPOSTO_NO_INICIO.test(canonico);
  });
}

function nomeDePeca(name) {
  return leiturasDoNome(name).some((canonico) => NOME_DE_PECA.test(canonico));
}

// Subpastas de output/ que guardam material de trabalho, não entrega. Só o trecho DEPOIS de
// `/output/` conta: uma pasta ancestral chamada `autos/` ou `Pesquisa/` não desliga o gate.
const SUBPASTA_INTERNA = /^(?:_[^/]*|drafts?|rascunhos?|internal|intern[oa]s?|revis(?:ao|ão)[^/]*|pesquisas?|precedentes|diagn[óo]stico|autos|fontes|refer[êe]ncias|anexos|notas|an[áa]lises?|fichamentos|resumos|c[áa]lculos|prazos|briefing|checklists|logs|e-?mails|mapas|mem[óo]ria|reuni[õo]es|trabalho|transcri[çc][õo]es|tmp|temp)$/i;
function emSubpastaInterna(filePath) {
  const caminho = String(filePath || '').replace(/\\/g, '/');
  const i = caminho.search(/\/output\//i);
  if (i < 0) return false;
  const dentro = caminho.slice(i + '/output/'.length).split('/');
  dentro.pop(); // o arquivo
  return dentro.some((pasta) => SUBPASTA_INTERNA.test(pasta));
}

// Relatório de gate nunca é peça, nem com "-final" no nome nem com o marcador de final: é o que o
// verificador, o avaliador ou o conferente disse SOBRE a peça, e costuma transcrever a síntese e o
// fecho dela. Só é peça final o que o nome de peça, a forma ou o manifesto reconhecem, fora destas
// pastas e destes nomes. Medido em 26/09/2026 (mandado de segurança, motor 0.9.54): o relatório
// `persuasao/verificador-persuasao-c3-final.md` foi tratado como peça final, o hook bloqueou por
// manifesto ausente e o chefe renomeou o arquivo para seguir.
const PASTA_DE_GATE = /^(?:persuas(?:ao|ão)|cita(?:coes|ções)|_meta|meta)$/i;
const NOME_DE_GATE = /^(?:verificador(?:es)?|verificacao|avaliacao|avaliacoes|avaliador(?:es)?|conferencia|conferente|persuasao|meta-consenso|reabertura|contraditor|red-team)(?:-|$)/;
function relatorioDeGate(filePath) {
  const caminho = String(filePath || '').replace(/\\/g, '/');
  const i = caminho.search(/\/output\//i);
  if (i < 0) return false;
  const dentro = caminho.slice(i + '/output/'.length).split('/');
  const nome = dentro.pop();
  if (dentro.some((pasta) => PASTA_DE_GATE.test(pasta))) return true;
  return leiturasDoNome(nome).some((leitura) => NOME_DE_GATE.test(semSegmentosDeOrdem(leitura)));
}

// Fórmulas que só existem em artefato FINAL: endereçamento e fecho de peça, dispositivo de ato
// judicial, fecho de parecer, abertura de contrato, notificação, procuração, ata. Uma transcrição
// traz uma; a peça traz várias. Por isso a forma só conta com DUAS fórmulas em trechos DISTINTOS do
// texto (duas regexes casando a mesma frase valem uma). Sem flag `m` com `\s` que atravesse linhas:
// isso é quadrático em arquivo cheio de linhas em branco.
const FORMAS_DE_PECA = [
  // endereçamento
  /(?:excelent[íi]ssim[oa]s?|exm[oa]s?|ilustr[íi]ssim[oa]s?|ilm[oa]s?|merit[íi]ssim[oa]s?|mm)\.?(?:\s*\([ao]s?\))?\s+(?:senhor(?:a|es|as)?|sr(?:a|s|as)?|ju[íi]z[oa]?|ju[íi]za|doutor|dr)\b/iu,
  /^[ \t#*_>]*(?:ao|à|a)\s+(?:(?:mm\.?|dd\.?|douto|egr[ée]gi[oa]|colend[oa]|excelent[íi]ssim[oa]|d\.|r\.)\s+)?(?:ju[íi]zo|tribunal|turma|c[âa]mara|se[çc][ãa]o|plen[áa]rio|vara|junta|conselho)\b/imu,
  /\b(?:egr[ée]gi[oa]|colend[oa])\s+(?:tribunal|turma|c[âa]mara|se[çc][ãa]o|plen[áa]rio|corte|conselho)\b/iu,
  // corpo e fecho de peça de parte
  /\bv[êe]m,?\s+(?:respeitosamente,?\s+)?(?:por\s+(?:seus?|suas?)\s+(?:advogad|procurador|patron|defensor)[^\n]{0,80}?,?\s+)?(?:[àa]\s+(?:honrosa\s+)?presen[çc]a\s+de\s+v(?:ossa|\.)\s*ex(?:cel[êe]ncia|a\.?)|perante\s+(?:este|esse|vossa|v\.)|propor|ajuizar|opor|oferecer|apresentar|interpor|requerer|impetrar|promover|expor|manifestar)\b/iu,
  /\b(?:propor|ajuizar|opor|oferecer|apresentar|interpor|impetrar|promover|manejar)\s+(?:a|o|os|as)\s+presentes?\s+/iu,
  /\bpor\s+(?:seus?|suas?)\s+(?:advogad[oa]s?|procurador(?:a|es|as)?|patron[oa]s?|defensor(?:a|es|as)?|promotor(?:a|es|as)?|membro)\b[^\n]{0,60}?\b(?:que\s+esta\s+subscreve|infra[- ]?assinad[oa]s?|abaixo[- ]?assinad[oa]s?|ao\s+final\s+assinad[oa]s?|que\s+ao\s+final\s+subscreve)/iu,
  /\bno\s+uso\s+de\s+suas\s+atribui[çc][õo]es\b|\bincurs[oa]s?\s+nas?\s+(?:penas|san[çc][õo]es)\s+do\s+art/iu,
  /^[ \t#*_>]*rol\s+de\s+testemunhas\b/imu,
  /\bj[áa]\s+(?:devidamente\s+)?qualificad[oa]s?(?:\s*\([ao]s?\))?\s+nos\s+autos\b/iu,
  /\b(?:d[áa]|atribui)(?:-se|o-se)?\s+[àa]\s+(?:presente\s+)?causa\s+o\s+valor\b|\bvalor\s+da\s+causa\s*:/iu,
  /\bprotesta(?:ndo|m|-se)?\b[^\n]{0,40}?\bprovar\s+o\s+alegado\b/iu,
  /^[ \t#*_>]*(?:nestes|nesses)\s+termos\b|\btermos\s+em\s+que\b/imu,
  /\bpede(?:m|-se)?\s+(?:e\s+espera(?:m)?\s+)?deferimento\b|\b[ée]\s+o\s+que\s+se\s+requer\b/iu,
  /\b(?:ante\s+o|diante\s+d[oe]|pelo|por\s+todo\s+o|em\s+face\s+d[oe]|isto\s+posto|isso\s+posto|posto\s+isso|posto\s+isto)\s*(?:exposto)?,?\s+(?:requer|requerem|requer-se|pede|pedem)\b/iu,
  // ato judicial
  /^[ \t#*_>]*vistos(?:[.,]|\s+etc|\s*,?\s+relatados\s+e\s+discutidos|\s+os\s+autos|\s+e\s+examinados)/imu,
  /(?<!\p{L})[é]\s+o\s+(?:breve\s+)?relat(?:[óo]rio|o)\b|(?<!\p{L})[é]\s+a\s+s[íi]ntese\s+do\s+necess[áa]rio\b/iu,
  /^[ \t#*_>]*(?:decido|passo\s+a\s+decidir|fundamento\s+e\s+decido)[.:]?\s*$|(?<!\p{L})[é]\s+(?:o\s+voto|como\s+voto)\b/imu,
  /\b(?:ante\s+o|diante\s+d[oe]|pelo|por\s+todo\s+o|em\s+face\s+d[oe]|isto\s+posto|isso\s+posto|posto\s+isso|posto\s+isto)\s*(?:exposto)?,?\s+(?:julgo|defiro|indefiro|concedo|denego|absolvo|condeno|pronuncio|impronuncio|nego|dou|conhe[çc]o|homologo|decreto|rejeito|recebo|acolho|extingo|declaro|determino|nega-se|d[áa]-se|conhece-se|acolhe-se|rejeita-se|defere-se|indefere-se|nego-lhe|dou-lhe)\b/iu,
  /\bjulgo\s+(?:parcialmente\s+)?(?:procedentes?|improcedentes?|extint[oa]s?|prejudicad[oa]s?)\b/iu,
  /\b(?:publique-se|registre-se|intime(?:m)?-se|cumpra-se|arquive(?:m)?-se|cite-se|citem-se)[.,;]?\s*(?:publique-se|registre-se|intime(?:m)?-se|cumpra-se|arquive(?:m)?-se|cite-se|citem-se)\b|\bp\.\s*r\.\s*i\./iu,
  /\bacordam,?\s+(?:os|as|em|na|no)\b|\bproferir\s+a\s+seguinte\s+decis[ãa]o\b|\bv\.\s*u\.|\bvota[çc][ãa]o\s+un[âa]nime\b|\b(?:por|[àa])\s+unanimidade\b|\brelat[óo]rio\s+se\s+adota\b/iu,
  // parecer e Ministério Público
  /(?<!\p{L})[é]\s+o\s+(?:nosso\s+)?parecer\b/iu,
  /\bs\.\s*m\.\s*j\.|\bsalvo\s+melhor\s+ju[íi]zo\b/iu,
  /\b(?:consulta-nos|consulente\s*:|formula\s+a\s+presente\s+consulta|trata-se\s+de\s+consulta)/iu,
  /\b(?:ante\s+o|diante\s+d[oe]|pelo)\s+exposto,?\s+(?:conclui-se|conclu[íi]mos|opina-se|opinamos|respond(?:e-se|emos))\b/iu,
  /\b(?:opina|manifesta-se|requer|promove)\s+o\s+(?:minist[ée]rio\s+p[úu]blico|parquet)\b|\bo\s+minist[ée]rio\s+p[úu]blico\b[^\n]{0,60}?\b(?:requer|promove|oferece|denuncia|manifesta-se|opina)\b/iu,
  /\bvem\s+oferecer\s+(?:den[úu]ncia|queixa-crime)\b|\b(?:promove|requer)\s+o\s+arquivamento\s+do\s+inqu[ée]rito\b/iu,
  // contrato e instrumento
  /\bcl[áa]usula\s+(?:primeira|1[ªa°º.]?)\b|^[ \t#*_>]*(?:1|primeira)\s*[.º°ªa-]?\s*(?:d[oa]\s+)?objeto\b/imu,
  /\bpelo\s+presente\s+instrumento\b/iu,
  /\bt[êe]m\s+entre\s+si\s+just[oa]s?\s+e\s+(?:contratad[oa]s?|acordad[oa]s?|aven[çc]ad[oa]s?)\b|\bpor\s+estarem\s+(?:assim\s+)?just[oa]s\s+e\s+(?:contratad[oa]s|acordad[oa]s)\b/iu,
  /\bresolvem,?\s+de\s+comum\s+acordo,?\s+(?:celebrar|rescindir|distratar|firmar)\b|\b(?:assinam|firmam)\s+o\s+presente\b/iu,
  /\bem\s+(?:duas|2|tr[êe]s|3)\s+vias\s+de\s+igual\s+teor\b|\b(?:elegem|elege-se|fica\s+eleito)\s+o\s+foro\b/iu,
  /\b(?:contratante|contratad[ao]|locador|locat[áa]ri[oa]|outorgante|outorgad[oa]|notificante|notificad[oa]|interpelante|interpelad[oa]|comprador|vendedor|cedente|cession[áa]ri[oa]|mutuante|mutu[áa]ri[oa]|comodante|comodat[áa]ri[oa]|empregador|empregad[oa])\s*(?:\([^)\n]{0,30}\))?\s*:/iu,
  // notificação, procuração, escritura, ata, declaração
  /\bfica\s+v\.?\s*s(?:a|\.)?\.?\s+notificad[oa]\b|\bserve\s+a\s+presente\s+para\s+(?:notificar|interpelar|constituir)\b|\bvem,?\s+pela\s+presente,?\s+(?:notificar|interpelar)\b|\bnotific(?:o|amos)\s+v(?:\.|ossa)\s*s(?:\.|enhoria)/iu,
  /\bmedidas\s+(?:judiciais|legais)\s+cab[íi]veis\b|\bsob\s+pena\s+de\s+(?:ado[çc][ãa]o|ajuizamento|protesto)\b/iu,
  /\bnomeia\s+e\s+constitui\s+(?:seu|sua|seus|suas)\s+bastante|\bconstitu(?:i|em)\b[^\n]{0,60}?\bprocurador(?:es|a|as)?\b|\bad\s+judicia\b/iu,
  /\bsaibam\s+quantos\s+este\s+p[úu]blico\s+instrumento\b|\bnada\s+mais\s+havendo\s+a\s+tratar\b/iu,
  /\bdeclaro,?\s+(?:para\s+os\s+devidos\s+fins|sob\s+as\s+penas\s+da\s+lei)\b/iu,
];

/** Forma de peça: duas fórmulas em trechos DISTINTOS. Uma frase transcrita, ainda que case duas
 * regexes ("Ante o exposto, JULGO PROCEDENTE"), vale uma. */
function formaDePeca(text) {
  if (!text) return false;
  const trechos = [];
  for (const formula of FORMAS_DE_PECA) {
    const m = formula.exec(text);
    if (!m) continue;
    const inicio = m.index;
    const fim = inicio + m[0].length;
    if (trechos.some(([a, b]) => inicio < b && fim > a)) continue;
    trechos.push([inicio, fim]);
    if (trechos.length >= 2) return true;
  }
  return false;
}
// ── fim do bloco compartilhado ─────────────────────────────────────────────────────────────────

// ── Citações materiais: extração com chave normalizada ─────────────────────────────────────────
// O manifesto tem de cobrir CADA citação do texto, não "ao menos uma". Cada citação sai com uma
// chave (classe + número, mais tribunal e diploma quando o texto os traz) que se compara ao `title`
// de cada entrada do manifesto. O texto é lido em NFC e desacentuado preservando posições, para as
// regexes serem ASCII e "Súmula", "Sumula" e "SÚMULA" caírem no mesmo padrão.
// Guardas herdadas do src/citacao-gate.js, nascidas de falso positivo medido: sigla de código exige
// fronteira à direita ("CE" não casa em "CESSAÇÃO"); "lei" só é diploma com número ("previsto em
// lei. Inteligência do art. 96" não é citação).

/** Sem acento, mesma quantidade de caracteres: `é`→`e`, `ç`→`c`. Índices continuam válidos. */
function desacentuarPreservandoPosicoes(text) {
  return text.replace(/[À-ɏ]/g, (c) => {
    const base = c.normalize('NFD')[0];
    return base && base.length === 1 ? base : c;
  });
}

// ADCT: o Ato das Disposições Constitucionais Transitórias é diploma próprio, com numeração própria
// (achado M3 1 a 4 da medição de 01/10/2026, motor 0.9.80): "ADCT, art. 126" saía sem diploma, "ADCT,
// arts. 125 a 129" herdava a LC 214/2025, "CF, ADCT, art. 129" virava o art. 129 da CF e "art. 129 do
// ADCT" nem era extraído; o laço de citação escalou com o texto da peça certo.
const SIGLA_DE_CODIGO = 'cf|crfb|cr\\/\\d{2,4}|ncpc|cpc|cpp|clt|cdc|ctn|ctb|cpb|cp|ccb|cc|ce|lep|eca|lindb|adct';
const ALIAS_DE_SIGLA = { crfb: 'cf', cr: 'cf', ncpc: 'cpc', cpb: 'cp', ccb: 'cc' };
// A Constituição do Estado é diploma próprio (L2, HC de 27/09/2026, motor 0.9.60): "Constituição do
// Estado de Minas Gerais, art. 106, I, d" saía como CF, art. 106 (que é o dos TRFs). Vem antes da
// CF na alternância, e a CF não aceita "Constituição" seguida de Estado, UF ou adjetivo pátrio.
const UF_POR_EXTENSO = 'acre|alagoas|amapa|amazonas|bahia|ceara|espirito\\s+santo|goias|maranhao|mato\\s+grosso(?:\\s+do\\s+sul)?|minas\\s+gerais|para|paraiba|parana|pernambuco|piaui|rio\\s+de\\s+janeiro|rio\\s+grande\\s+do\\s+(?:norte|sul)|rondonia|roraima|santa\\s+catarina|sao\\s+paulo|sergipe|tocantins';
const GENTILICO_DE_UF = 'acreana|alagoana|amapaense|amazonense|baiana|cearense|capixaba|goiana|maranhense|mato-grossense|sul-mato-grossense|mineira|paraense|paraibana|paranaense|pernambucana|piauiense|fluminense|potiguar|gaucha|rondoniense|roraimense|catarinense|paulista|sergipana|tocantinense';
const CONSTITUICAO_ESTADUAL = `constituicao\\s+(?:estadual|do\\s+estado(?:\\s+d[aeo]s?\\s+(?:${UF_POR_EXTENSO}))?|d[aeo]s?\\s+(?:${UF_POR_EXTENSO})|d[aeo]\\s+(?!br\\b)[a-z]{2}(?![a-z])|(?:${GENTILICO_DE_UF})(?![a-z-]))`;
const DIPLOMA_POR_EXTENSO = [
  ['adct', 'ato\\s+das\\s+disposicoes\\s+constitucionais\\s+transitorias'],
  ['constituicao-estadual', CONSTITUICAO_ESTADUAL],
  ['cf', `(?!${CONSTITUICAO_ESTADUAL})constituicao(?:\\s+(?:federal|da\\s+republica(?:\\s+federativa(?:\\s+do\\s+brasil)?)?))?(?:\\s+de\\s+1988)?|carta\\s+magna|lei\\s+maior`],
  ['cpc', 'codigo\\s+de\\s+processo\\s+civil'],
  ['cpp', 'codigo\\s+de\\s+processo\\s+penal'],
  ['cc', 'codigo\\s+civil'],
  ['cp', 'codigo\\s+penal'],
  ['cdc', 'codigo\\s+de\\s+defesa\\s+do\\s+consumidor'],
  ['clt', 'consolidacao\\s+das\\s+leis\\s+do\\s+trabalho'],
  ['ctn', 'codigo\\s+tributario\\s+nacional'],
  ['ctb', 'codigo\\s+de\\s+transito(?:\\s+brasileiro)?'],
  ['ce', 'codigo\\s+eleitoral'],
  ['lep', 'lei\\s+de\\s+execucao\\s+penal'],
  ['eca', 'estatuto\\s+da\\s+crianca(?:\\s+e\\s+do\\s+adolescente)?'],
  ['lindb', 'lei\\s+de\\s+introducao(?:\\s+as\\s+normas\\s+do\\s+direito\\s+brasileiro)?'],
];
const EXTENSO = DIPLOMA_POR_EXTENSO.map(([, rx]) => rx).join('|');
// Lei numerada ↔ sigla do código: "Lei 13.105/2015, art. 300" cobre "art. 300 do CPC" e vice-versa.
const LEI_DO_CODIGO = { 13105: 'cpc', 10406: 'cc', 5452: 'clt', 8078: 'cdc', 5172: 'ctn', 3689: 'cpp', 2848: 'cp', 7210: 'lep', 8069: 'eca', 4737: 'ce', 9503: 'ctb', 4657: 'lindb', 1988: 'cf' };
// Lei conhecida pelo apelido: "art. 33 da Lei de Drogas", "Lei Maria da Penha, art. 22".
const APELIDOS_DE_LEI = [
  ['11343', 'drogas|antidrogas'], ['11340', 'maria\\s+da\\s+penha'], ['8429', 'improbidade(?:\\s+administrativa)?'],
  ['12846', 'anticorrupcao'], ['8245', 'inquilinato|locacoes'], ['13709', 'lgpd|geral\\s+de\\s+protecao\\s+de\\s+dados'],
  ['6830', 'execuc(?:ao|oes)\\s+fisca(?:l|is)'], ['9099', 'juizados\\s+especiais'], ['12016', 'mandado\\s+de\\s+seguranca'],
  ['7347', 'acao\\s+civil\\s+publica'], ['9307', 'arbitragem'], ['11101', 'falencias?|recuperacao\\s+judicial'],
  ['9656', 'planos\\s+de\\s+saude'], ['8213', 'beneficios\\s+da\\s+previdencia(?:\\s+social)?|planos\\s+de\\s+beneficios'],
  ['8212', 'custeio(?:\\s+da\\s+seguridade)?'], ['10741', 'estatuto\\s+d[oa]\\s+(?:pessoa\\s+)?idos[oa]'],
  ['8906', 'estatuto\\s+da\\s+(?:oab|advocacia)'], ['8072', 'crimes\\s+hediondos'], ['13869', 'abuso\\s+de\\s+autoridade'],
  ['9613', 'lavagem(?:\\s+de\\s+dinheiro)?'], ['10826', 'estatuto\\s+do\\s+desarmamento'], ['13964', 'pacote\\s+anticrime'],
  ['13467', 'reforma\\s+trabalhista'], ['12965', 'marco\\s+civil(?:\\s+da\\s+internet)?'], ['12651', 'codigo\\s+florestal'],
  ['10257', 'estatuto\\s+da\\s+cidade'], ['14133', 'licitacoes(?:\\s+e\\s+contratos)?'],
];
const APELIDO = APELIDOS_DE_LEI.map(([, rx]) => rx).join('|');
function leiDoApelido(trecho) {
  const t = trecho.toLowerCase();
  for (const [numero, rx] of APELIDOS_DE_LEI) if (new RegExp(`(?:^|[^a-z])(?:${rx})(?![a-z])`).test(t)) return numero;
  return '';
}
const CODIGO_DA_LEI = Object.fromEntries(Object.entries(LEI_DO_CODIGO).map(([n, s]) => [s, n]));

// Diploma infralegal com número e ano é diploma como a lei (K16, inventário extrajudicial de
// 26/09/2026, motor 0.9.59): "Provimento Conjunto nº 93/2020, art. 220" saía `sem_diploma` e "art.
// 222 do Provimento Conjunto nº 93/2020" nem era extraído; os três artigos do provimento mineiro
// foram conferidos à parte, fora do manifesto. Provimento (e Provimento Conjunto) e Código de
// Normas entram ao lado de resolução, portaria, instrução normativa e decreto, que já estavam; o
// órgão entre o nome e o número ("CNJ", "Estadual", "CGJ") segue lido por ORGAO_DO_DIPLOMA. Sem
// número, nenhum deles é diploma ("o Código de Normas da Corregedoria" não identifica o ato).
const DIPLOMA_NUMERADO = '(?:lei\\s+complementar|lc|lei|decreto-lei|dl|decreto|dec\\.?|resolucao|res\\.?|portaria|port\\.?|instrucao\\s+normativa|in|provimento(?:\\s+conjunto)?|prov\\.?|codigo\\s+de\\s+normas|medida\\s+provisoria|mp|emenda\\s+constitucional|ec)';
const LEI_SEM_ARTIGO = '(?:lei\\s+complementar|lc|lei|decreto-lei|dl|medida\\s+provisoria|mp|emenda\\s+constitucional|ec)';
// Órgão entre o nome e o número ("IN RFB 2.110", "Portaria MTE 671", "Resolução CNJ 455"): até
// dois tokens curtos que não sejam preposição.
const ORGAO_DO_DIPLOMA = '(?:\\s+(?!d[eao]s?\\b|n[o°º.]*(?:\\s|$))[a-z]{2,12}\\.?){0,2}';
const NUMERO_DE_LEI = '(?:n[o°º.]*\\s*)?(\\d[\\d.]*(?:\\/\\d{2,4})?)';
// Outro diploma numerado adiante (sem grupo de captura): o limite do trecho entre diploma e artigo.
const OUTRO_DIPLOMA_NUMERADO = `\\b${DIPLOMA_NUMERADO}(?![a-z])${ORGAO_DO_DIPLOMA}\\s*(?:n[o°º.]*\\s*)?\\d`;
const ORGAO_JULGADOR = '(?:\\s*(?:do|da|de|\\/|-)\\s*(stf|stj|tst|tse|stm|tnu|carf|crps|tcu|trf\\d?|trt\\d{0,2}|tj[a-z]{2}))?';
// Enumeração de artigos: "arts. 5º e 6º", "arts. 186, 187 e 927", "art. 5º e art. 6º". Um número
// seguido de "ª", "parte", "inciso" ou "%" não é outro artigo.
//
// Cada artigo leva o seu dispositivo: inciso romano, parágrafo ("§ 1º", "§§ 2º e 3º", "parágrafo
// único"), "caput" e alínea. Medido na medição dos moldes de 24/09/2026 (G4, defeitos 3 e 21): sem
// isso, "CF, art. 5º, LVI" passava pelo título "CF, art. 5º, LXIII", "CLT, art. 59-B" pelo "CLT,
// art. 59", a enumeração parava em "parágrafo único" (o 147 de "arts. 146, parágrafo único, e 147"
// nem era extraído) e o título "CPC, arts. 373, II, e 429" só cobria o 373.
const NUMERO_DE_ARTIGO = '\\d+(?:\\.\\d{3})*(?:\\.?\\s*[o°º])?(?:-[a-z](?![a-z]))?';
// Romano válido (I a CCCXCIX): "civil", "cc" (Código Civil) e "lc" não são inciso; "c/c" também não.
const ROMANO = '(?=[ivxlc])(?!cc(?![a-z]))c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})(?![a-z0-9/])';
const INCISO = `(?:inc(?:isos?|s?\\.)\\s*)?${ROMANO}`;
const NUMERO_DE_PARAGRAFO = '\\d+(?:\\.?\\s*[o°º])?(?![\\d/])';
// "§§ 2º e 3º" fecha a lista no item depois do "e": em "arts. 33, §§ 2º e 3º, 44" o 44 é artigo.
const PARAGRAFO = `(?:§§|paragrafos)\\s*${NUMERO_DE_PARAGRAFO}(?:\\s*,\\s*${NUMERO_DE_PARAGRAFO})*\\s*,?\\s*(?:e|ou)\\s*(?:§\\s*)?${NUMERO_DE_PARAGRAFO}|(?:§|paragrafo)\\s*${NUMERO_DE_PARAGRAFO}`;
const PARAGRAFO_UNICO = '(?:paragrafo|par\\.?|p\\.)\\s*un(?:ico|\\.)';
// Alínea: marcada ("alínea a"), entre aspas ("a") ou letra solta depois de inciso ou parágrafo,
// seguida de pontuação, conjunção ou do diploma. "e" solto é conjunção; "a partir" não é alínea.
// A alínea entre aspas fecha também antes da barra de tabela (achado M2b 4 da medição de 01/10/2026:
// na célula "Lei 8.036, art. 23, § 2º, "b" |" o extrator lia o § 2º sem a alínea, e o cartório,
// com o título que trazia o "b", não cobria a citação).
const ALINEA = `(?:(?:alineas?|letras?)\\s*["'“”‘’]?[a-z]["'“”‘’]?|["'“”‘’][a-z]["'“”‘’]|(?!e(?![a-z]))[a-z])(?![a-z0-9])(?=\\s*(?:[,;.:)\\]|]|e\\s|ou\\s|d[oa]s?\\s|$))`;
// "I a III" é intervalo de incisos (arts. 396 e 397, I a III, do CPC: medido na negativação de
// 24/09/2026, só o inciso I era extraído). O "a" só separa quando vem outro romano depois.
const SEPARADOR_DE_DISPOSITIVO = `(?:\\s*,\\s*(?:(?:e|ou)\\s+)?|\\s+(?:e|ou)\\s+|\\s+a\\s+(?=${ROMANO}))`;
// Alínea marcada (entre aspas, ou com "alínea"/"letra") logo depois do número do artigo, sem inciso
// nem parágrafo: "Lei 8.036, art. 27, "e"" (as alíneas do caput). Sem a marca, a letra solta depois do
// artigo é ambígua com a conjunção e não entra.
const ALINEA_MARCADA = `(?:(?:alineas?|letras?)\\s*["'“”‘’]?[a-z]["'“”‘’]?|["'“”‘’][a-z]["'“”‘’])(?![a-z0-9])`;
const DISPOSITIVOS = `(?:${SEPARADOR_DE_DISPOSITIVO}(?:caput|${PARAGRAFO_UNICO}|${PARAGRAFO}|${INCISO})(?:${SEPARADOR_DE_DISPOSITIVO}${ALINEA})*|${SEPARADOR_DE_DISPOSITIVO}${ALINEA_MARCADA})*`;
const ENUMERACAO_DE_ARTIGOS = `${NUMERO_DE_ARTIGO}${DISPOSITIVOS}(?:\\s*(?:,\\s*(?:e|ou)?|e|ou|a(?=\\s*\\d))\\s*(?:[oa]s?\\s+)?(?:art(?:igo)?s?\\.?\\s*)?(?!\\d+\\s*(?:ª|a(?![a-z])(?!\\s*\\d)|parte|inciso|incisos|paragrafo|§|%))${NUMERO_DE_ARTIGO}${DISPOSITIVOS})*`;
const ARTIGO = `\\bart(?:igo)?s?\\.?\\s*(${ENUMERACAO_DE_ARTIGOS})`;
const ENUMERACAO_SIMPLES = '\\d+(?:\\s*(?:,|e|ou)\\s*(?:n[o°º.]*\\s*)?\\d+)*';
// Cada elemento admite o sufixo de letra do artigo ("396-A e 401"): sem ele a enumeração parava
// em "396" e o título "CPP, arts. 396-A e 401" não cobria o art. 401 (run de 16/09/2026).
const ENUMERACAO_COM_PONTO = '\\d[\\d.]*(?:-[a-z])?(?:\\s*(?:,|e|ou)\\s*(?:n[o°º.]*\\s*)?\\d[\\d.]*(?:-[a-z])?)*';

// Lê a enumeração já casada ("146, parágrafo único, e 147"; "386, II e VII, 392, II"; "33, §§ 2º e
// 3º, 44") e devolve um item por artigo e dispositivo: { artigo, sufixo, dispositivo }. O dispositivo
// é um caminho: "p:u" (parágrafo único), "p:3" (§ 3º), "caput", "i:lvi" (inciso), "a:d" (alínea),
// juntos por "/" ("p:3/i:ii"). Sem dispositivo, "". O texto e o título passam pelo mesmo leitor, em
// minúsculas: letra romana solta depois de um inciso é alínea (os dois lados leem igual). O "c" solto é
// sempre alínea: inciso C (cem) não há em lei nenhuma, e o corpus de referência (27/09/2026) mostrou
// "CP 33, § 2º, c" (a alínea c do regime aberto, nas duas apelações criminais) lido como inciso C.
const TOKEN_DE_ENUMERACAO = /(art(?:igo)?s?\.?)|(§§|§)|((?:paragrafo|par\.?|p\.)\s*un(?:ico|\.))|(paragrafos?)|(caput)|(inc(?:isos?|s?\.))|(alineas?|letras?)|(\d+(?:\.\d{3})*)(?:\.?\s*[o°º])?(?:-([a-z])(?![a-z]))?|["'“”‘’]([a-z])["'“”‘’]|([a-z]+)/g;
const ROMANO_INTEIRO = new RegExp(`^${ROMANO}$`);
const VALOR_ROMANO = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function romanoParaNumero(r) {
  let total = 0;
  for (let k = 0; k < r.length; k += 1) {
    const v = VALOR_ROMANO[r[k]] || 0;
    total += (VALOR_ROMANO[r[k + 1]] || 0) > v ? -v : v;
  }
  return total;
}
function numeroParaRomano(n) {
  let r = '';
  for (const [v, s] of [[100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (n >= v) { r += s; n -= v; }
  return r;
}
function artigosDe(enumeracao) {
  const texto = String(enumeracao || '').toLowerCase();
  const tokens = [];
  TOKEN_DE_ENUMERACAO.lastIndex = 0;
  let m;
  while ((m = TOKEN_DE_ENUMERACAO.exec(texto))) {
    if (m[1]) tokens.push({ t: 'art' });
    else if (m[2]) tokens.push({ t: 'par', plural: m[2] === '§§' });
    else if (m[3]) tokens.push({ t: 'pu' });
    else if (m[4]) tokens.push({ t: 'par', plural: m[4] === 'paragrafos' });
    else if (m[5]) tokens.push({ t: 'caput' });
    else if (m[6]) tokens.push({ t: 'inc' });
    else if (m[7]) tokens.push({ t: 'ali' });
    else if (m[8]) tokens.push({ t: 'num', v: m[8].replace(/\./g, '').replace(/^0+(?=\d)/, ''), sufixo: m[9] || '' });
    else if (m[10]) tokens.push({ t: 'letra', v: m[10] });
    // "alínea e": depois da palavra alínea, o "e" é a letra, não a conjunção (achado do m2 de
    // 01/10/2026: o título "art. 27, alínea e" do verificador não cobria o "art. 27, "e"" da peça).
    else if (m[11] === 'e' && tokens.length && tokens[tokens.length - 1].t === 'ali') tokens.push({ t: 'letra', v: 'e' });
    else if (m[11] === 'e' || m[11] === 'ou') tokens.push({ t: 'conj' });
    else if (m[11]) tokens.push({ t: 'palavra', v: m[11] });
  }
  const artigos = [];
  let atual = null;
  let paragrafo = '';
  let inciso = '';
  let faixa = false; // "a" entre dois números ou dois romanos: intervalo (até 30 itens)
  let esperaParagrafo = 0; // 1: "§ N" (um só); 2: "§§ N, N e N" (até o item depois do "e")
  let esperaAlinea = false;
  let conj = false;
  const juntar = (...partes) => partes.filter(Boolean).join('/');
  const marcar = (caminho) => { if (atual && caminho) atual.caminhos.push(caminho); };
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i];
    if (tk.t === 'conj') { conj = true; continue; }
    const seguinte = tokens[i + 1];
    if (tk.t === 'palavra' && tk.v === 'a' && seguinte && ((seguinte.t === 'num' && atual && !esperaParagrafo && !paragrafo && !inciso) || (seguinte.t === 'palavra' && inciso && ROMANO_INTEIRO.test(seguinte.v)))) { faixa = true; continue; }
    if (tk.t === 'art') esperaParagrafo = 0;
    else if (tk.t === 'par') esperaParagrafo = tk.plural ? 2 : 1;
    else if (tk.t === 'pu') { paragrafo = 'p:u'; inciso = ''; marcar(paragrafo); esperaParagrafo = 0; }
    else if (tk.t === 'caput') { paragrafo = ''; inciso = ''; marcar('caput'); esperaParagrafo = 0; }
    else if (tk.t === 'num' && esperaParagrafo) {
      paragrafo = `p:${tk.v}`;
      inciso = '';
      marcar(paragrafo);
      if (esperaParagrafo === 1 || conj) esperaParagrafo = 0;
    } else if (tk.t === 'num') {
      if (faixa && atual && !atual.sufixo && !tk.sufixo) {
        const de = Number(atual.artigo);
        const ate = Number(tk.v);
        if (ate > de + 1 && ate - de <= 30) for (let k = de + 1; k < ate; k += 1) artigos.push({ artigo: String(k), sufixo: '', caminhos: [] });
      }
      // "arts. 59 a 59-C" e "59-A a 59-C": as letras do mesmo artigo entre as duas pontas (achado da
      // medição de 01/10/2026, m2: o 59-A e o 59-B ficavam fora do gate).
      if (faixa && atual && tk.sufixo && atual.artigo === tk.v && (atual.sufixo || 'a') <= tk.sufixo) {
        const primeira = atual.sufixo ? atual.sufixo.charCodeAt(0) + 1 : 'a'.charCodeAt(0);
        for (let c = primeira; c < tk.sufixo.charCodeAt(0); c += 1) artigos.push({ artigo: atual.artigo, sufixo: String.fromCharCode(c), caminhos: [] });
      }
      atual = { artigo: tk.v, sufixo: tk.sufixo, caminhos: [] };
      artigos.push(atual);
      paragrafo = '';
      inciso = '';
    } else if (tk.t === 'letra' || (tk.t === 'palavra' && esperaAlinea && tk.v.length === 1)) {
      marcar(juntar(paragrafo, inciso, `a:${tk.v}`));
    } else if (tk.t === 'palavra') {
      const w = tk.v;
      const proximo = tokens[i + 1];
      // "V" ou "X" solto depois de inciso menor é o inciso seguinte da lista, não alínea: medido em
      // 25/09/2026 (HC, motor 0.9.50), "art. 319, I, II, IV e V, do CPP" lia o V como alínea do IV,
      // e o título do inciso IV cobria o V.
      const incisoSeguinte = w.length === 1 && inciso && /^[vx]$/.test(w) && romanoParaNumero(w) > romanoParaNumero(inciso.slice(2));
      if (ROMANO_INTEIRO.test(w) && w !== 'c' && (faixa || incisoSeguinte || !(w.length === 1 && inciso))) {
        if (faixa && inciso) {
          const de = romanoParaNumero(inciso.slice(2));
          const ate = romanoParaNumero(w);
          if (ate > de + 1 && ate - de <= 30) for (let k = de + 1; k < ate; k += 1) marcar(juntar(paragrafo, `i:${numeroParaRomano(k)}`));
        }
        inciso = `i:${w}`;
        marcar(juntar(paragrafo, inciso));
      } else if (w.length === 1 && w !== 'e' && !(/^[oa]$/.test(w) && proximo && (proximo.t === 'art' || proximo.t === 'num'))) {
        marcar(juntar(paragrafo, inciso, `a:${w}`));
      }
    }
    esperaAlinea = tk.t === 'ali';
    conj = false;
    faixa = false;
  }
  const saida = [];
  for (const a of artigos) {
    const unicos = [...new Set(a.caminhos)];
    // "§ 3º, II" é o inciso II do § 3º, não o § 3º inteiro: fica só a folha de cada caminho.
    const folhas = unicos.filter((c) => !unicos.some((outro) => outro.startsWith(`${c}/`)));
    for (const dispositivo of folhas.length ? folhas : ['']) saida.push({ artigo: a.artigo, sufixo: a.sufixo, dispositivo });
  }
  return saida;
}
/** O título cobre o dispositivo quando nomeia o mesmo ou um mais largo dentro do artigo (o § 3º
 * cobre o § 3º, II); a citação sem dispositivo é coberta por qualquer um do artigo. O artigo
 * inteiro, sem dispositivo, cobre só o artigo e o caput: medido na negativação de 24/09/2026
 * (motor 0.9.49), o título "art. 300 do CPC" cobria o § 1º, cujo texto a peça transcreve
 * ("conforme o caso"), e o § 3º, e o manifesto não provava a conferência dispositivo a dispositivo. */
function dispositivoCobre(doTitulo, daCitacao) {
  if (!daCitacao || doTitulo === daCitacao) return true;
  if (!doTitulo) return daCitacao === 'caput';
  return daCitacao.startsWith(`${doTitulo}/`);
}
const ARTIGO_NO_TITULO = new RegExp(`(?:^|[^a-z])art(?:igo)?s?\\.?\\s*(${ENUMERACAO_DE_ARTIGOS})`, 'g');
function artigosDoTitulo(texto) {
  const achados = [];
  ARTIGO_NO_TITULO.lastIndex = 0;
  let m;
  while ((m = ARTIGO_NO_TITULO.exec(texto))) achados.push(...artigosDe(m[1]));
  // O título na forma abreviada ("CPP 244", "CP 44, § 2º") vale como a citação abreviada vale.
  for (const a of texto.matchAll(new RegExp(ARTIGO_ABREVIADO, 'g'))) {
    if (artigoAbreviadoValido(a[1].toUpperCase(), a[2])) achados.push(...artigosDe(a[2]));
  }
  return achados;
}
/** "8.213/91" → "8213/91": a chave e a comparação não dependem do ponto do milhar. */
function numeroDeLei(bruto) {
  const [numero, ano] = String(bruto || '').split('/');
  const digitos = numero.replace(/\D/g, '');
  return ano ? `${digitos}/${ano.replace(/\D/g, '')}` : digitos;
}

function numerosDe(enumeracao) {
  return (enumeracao.match(/\d+(?:\.\d{3})*/g) || []).map((n) => n.replace(/\./g, ''));
}
function siglaCanonica(bruta) {
  const s = bruta.toLowerCase().replace(/\/\d+$/, '');
  return ALIAS_DE_SIGLA[s] || s;
}
function siglaDoExtenso(trecho) {
  const t = trecho.toLowerCase();
  for (const [sigla, rx] of DIPLOMA_POR_EXTENSO) if (new RegExp(`^(?:${rx})$`).test(t)) return sigla;
  return '';
}

// Classes de acórdão sem ambiguidade com abreviatura corrente ("AP 1201" é apartamento, "SL 1201"
// é sala, "RO" é UF). As constitucionais aceitam número curto ("ADPF 130", "ADC 16").
// APn é a ação penal originária no STJ ("APn 1.074/DF"): sem ela, o AP casava e o "n" colado o
// descartava, e a citação saía do gate sem aviso (run m9, 06/10/2026).
const CLASSE_CURTA = 'ADIn|ADI|ADC|ADPF|ADO|Rcl|STA|IRDR|IAC|Pet|Inq|SL|SS|APn|AP|MI';
// SL, SS, AP e MI também são sala, seção, apartamento e sigla corrente: só valem em caixa alta e
// com sinal de acórdão (tribunal logo antes, sufixo como MC-Ref, UF ou "nº"). Medido em 25/09/2026
// (HC, motor 0.9.50): "STF, SL 1395 MC-Ref/SP" ficou fora do gate e do manifesto, e o manifesto
// saiu aprovado sem ela.
const CLASSE_AMBIGUA = /^(?:SL|SS|AP|MI)$/;
// Incidente depois do número: "SL 1395 MC-Ref/SP", "HC 126.292 AgR", "ADI 6581 MC". É outro
// acórdão do mesmo processo e entra na chave como a cadeia de recursos antes da classe.
const SUFIXO_POS_NUMERO = '(?:\\s+((?:MC|AgRg|AgR|EDcl|ED|QO|TP|Ref)(?:-(?:MC|AgRg|AgR|EDcl|ED|QO|TP|Ref))*)(?![a-z]))?';
// RO (recurso ordinário) é também a UF de Rondônia: vale só na forma do TST, colado ao número único da
// Justiça do Trabalho ("RO-76-80.2013.5.06.0000", SBDI-2; contestação trabalhista do corpus de
// referência, 27/09/2026, que estava no manifesto e o extrator não via).
const CLASSE_LONGA = 'REsp|AREsp|EREsp|RHC|HC|RE|ARE|RMS|MS|RRAg|RR|AIRR|ARR|ROT|REspe|RvCr?|RO(?=-\\d+-\\d{2}\\.\\d{4}\\.5\\.)';
// O recurso interno antes da classe é outro acórdão do mesmo processo, e entra na chave: "EDcl no
// REsp 1.846.649/MA" (a redação da tese do Tema 1061) passava como coberto pelo título "REsp
// 1.846.649/MA" (negativação, 24/09/2026). Duas grafias: a do STJ e do STF ("AgInt nos EDcl no") e
// a do TST, com hífen ("E-ED-ARR-2799-09.2013.5.09.0091", "Ag-AIRR", "E-RR"), que nem era
// reconhecida (contestação, 24/09/2026: o E-ED-ARR saiu fora do gate e do manifesto).
const PREFIXO_DE_ACORDAO = '((?:(?:AgRg|AgInt|AgR|EDcl|ED|EI|EDv)\\s+(?:no|nos|na|nas|em)\\s+)*)((?:(?:EDCiv|EDv|ED|E|AgR|Ag)-)*)';
/** A cadeia de recursos internos, comparável: "AgInt nos EDcl no" e "Ag-ED-" viram "agint-ed" e "ag-ed". */
function cadeiaDeRecursos(...partes) {
  const sinonimo = { edcl: 'ed', edciv: 'ed', agr: 'agrg' };
  return partes.join(' ').toLowerCase().split(/[\s-]+/).filter((t) => t && !/^(?:no|nos|na|nas|em)$/.test(t)).map((t) => sinonimo[t] || t).join('-');
}
// Plural com enumeração ("ADIs 6.050, 6.069 e 6.082", "REsps 1.111.111/SP e 2.222.222/RJ", "HCs
// 123.456 e 654.321"): uma citação por número. Medido na contestação de 24/09/2026: as três ADIs
// passaram fora do gate e do manifesto. A grafia do plural é conferida em caixa exata ("Res." é
// resolução, não recursos extraordinários).
const CLASSE_NO_PLURAL = { ADIns: 'adi', ADIs: 'adi', ADCs: 'adc', ADPFs: 'adpf', ADOs: 'ado', Rcls: 'rcl', REsps: 'resp', AREsps: 'aresp', EREsps: 'eresp', HCs: 'hc', RHCs: 'rhc', REs: 're', AREs: 'are', RMSs: 'rms', MSs: 'ms', RRs: 'rr', AIRRs: 'airr', ARRs: 'arr', ROTs: 'rot' };
const NUMERO_NA_LISTA = '\\d(?:[\\d.]|-(?=\\d))*(?:\\s*[-/]\\s*[A-Z]{2}\\b)?';
const SUFIXO_DE_CLASSE = '(?:-[A-Za-z]{1,5})*';
const CLASSE_POR_EXTENSO = [['resp','recursos?[\\s-]+especia(?:l|is)(?![\\s-]+eleitora)'],['aresp','agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+especia(?:l|is)'],['re','recursos?[\\s-]+extraordinari[oa]s?'],['are','agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+extraordinari[oa]s?'],['hc','habeas[\\s-]+corpus'],['rhc','recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+habeas[\\s-]+corpus'],['ms','mandados?[\\s-]+de[\\s-]+seguranca'],['rms','recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+mandados?[\\s-]+de[\\s-]+seguranca'],['adi','ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade(?![\\s-]+por)'],['ado','ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade[\\s-]+por[\\s-]+omissao'],['adc','ac(?:ao|oes)[\\s-]+declaratorias?[\\s-]+de[\\s-]+constitucionalidade'],['adpf','arguic(?:ao|oes)[\\s-]+de[\\s-]+descumprimento(?:[\\s-]+de[\\s-]+preceito[\\s-]+fundamental)?'],['rcl','reclamac(?:ao|oes)[\\s-]+constitucionais?'],['rr','recursos?[\\s-]+de[\\s-]+revista'],['airr','agravos?[\\s-]+de[\\s-]+instrumento[\\s-]+em[\\s-]+recursos?[\\s-]+de[\\s-]+revista'],['respe','recursos?[\\s-]+especia(?:l|is)[\\s-]+eleitora(?:l|is)'],['irdr','incidentes?[\\s-]+de[\\s-]+resolucao[\\s-]+de[\\s-]+demandas[\\s-]+repetitivas'],['iac','incidentes?[\\s-]+de[\\s-]+assuncao[\\s-]+de[\\s-]+competencia'],['rvcr','revis(?:ao|oes)[\\s-]+crimina(?:l|is)'],['sl','suspens(?:ao|oes)[\\s-]+de[\\s-]+liminar'],['ss','suspens(?:ao|oes)[\\s-]+de[\\s-]+seguranca'],['sta','suspens(?:ao|oes)[\\s-]+de[\\s-]+tutela[\\s-]+antecipada'],['mi','mandados?[\\s-]+de[\\s-]+injuncao']];
const CLASSE_EXTENSO = CLASSE_POR_EXTENSO.map(([, rx]) => rx).join('|');
function classeDoExtenso(trecho) {
  const t = trecho.toLowerCase();
  for (const [classe, rx] of CLASSE_POR_EXTENSO) if (new RegExp(`^(?:${rx})$`).test(t)) return classe;
  return '';
}
const NUMERO_DE_ACORDAO = '(\\d(?:[\\d.]|-(?=\\d))*)(?:\\s*[-/]\\s*([A-Z]{2})\\b)?';

// Classes de tribunal local, só com a numeração única do CNJ ("Apelação Criminal nº
// 1517288-67.2019.8.26.0050"): "apelação" e "agravo" em prosa são palavras comuns, e o número
// antigo de apelação é curto e ambíguo. Medido no run de 16/09/2026: duas apelações do TJSP
// citadas na peça passavam fora da rede, e um acórdão inventado com esse formato passaria junto.
const CLASSE_TJ_POR_EXTENSO = [['apelacao', 'apelac(?:ao|oes)(?:[\\s-]+(?:criminal|criminais|civel|civeis))?'], ['agravo-de-instrumento', 'agravos?[\\s-]+de[\\s-]+instrumento(?![\\s-]+em)'], ['agravo-em-execucao', 'agravos?[\\s-]+em[\\s-]+execucao(?:[\\s-]+penal)?'], ['rese', 'recursos?[\\s-]+em[\\s-]+sentido[\\s-]+estrito'], ['embargos-infringentes', 'embargos[\\s-]+infringentes(?:[\\s-]+e[\\s-]+de[\\s-]+nulidade)?']];
const CLASSE_TJ = CLASSE_TJ_POR_EXTENSO.map(([, rx]) => rx).join('|');
const NUMERO_CNJ = '(\\d{7}-\\d{2}\\.\\d{4}\\.\\d\\.\\d{2}\\.\\d{4})';
function classeTj(trecho) {
  const t = trecho.toLowerCase();
  for (const [classe, rx] of CLASSE_TJ_POR_EXTENSO) if (new RegExp(`^(?:${rx})$`).test(t)) return classe;
  return '';
}

// O que pode ficar entre o diploma e o artigo: texto corrido sem quebra de linha, ponto-e-vírgula,
// ponto final, dois-pontos ou parêntese solto. Parêntese que abre e fecha no trecho ("art. 33
// (tráfico) da Lei 11.343/2006") passa inteiro.
const ENTRE_DIPLOMA_E_ARTIGO = '[^\\n;.:()]|\\.(?!\\s)|\\([^()\\n]{0,40}\\)';
// O trecho entre o diploma e o artigo não atravessa OUTRO diploma numerado: em "art. 222 do
// Provimento Conjunto nº 93/2020, e o Provimento CNJ nº 149/2023, art. 5º" (K16), o art. 5º era lido
// como do primeiro provimento, caía na sobreposição com o art. 222 e sumia; o mesmo com "art. 41 da
// Lei nº 8.213/1991, e a Lei nº 9.099/1995, art. 5º". O diploma mais perto do artigo é o dele.
// Artigo sem "art.", só com a sigla do código: "(CPP 400)", "CP 44, § 2º", "CPP 798, caput e §
// 1º", "CP 65, III, d". Medido em 25/09/2026 (apelação, motor 0.9.50): 24 dispositivos citados
// assim ficaram fora do manifesto e o chefe fez uma rodada de verificação à parte. Só a sigla em
// caixa alta, sem barra ou hífen colado ("TJ-CE", "Fortaleza/CE"), e o número não pode ser ano
// ("CF 1988", "CPC 73"), processo com UF ("CC 145.593/SP" é conflito de competência) nem passar
// do tamanho de um código.
const ARTIGO_ABREVIADO = `(?<![\\w/-])(${SIGLA_DE_CODIGO})\\s+(${ENUMERACAO_DE_ARTIGOS})(?![\\d.,]*\\d)(?!\\s*[-/]\\s*(?:[a-z]{2}\\b|\\d))`;
const ANO_DO_CODIGO = { cf: ['88'], cpc: ['73', '39', '15'], cc: ['16', '02'], cp: [], cpp: [] };
function artigoAbreviadoValido(sigla, enumeracao) {
  if (sigla !== sigla.toUpperCase()) return false;
  const primeiro = (enumeracao.match(/^\d[\d.]*/) || [''])[0];
  const digitos = primeiro.replace(/\./g, '');
  if (!digitos || digitos.length > 4 || Number(digitos) > 2100) return false;
  if (!primeiro.includes('.') && digitos.length === 4) return false; // ano: "CF 1988", "CC 2002"
  return !(ANO_DO_CODIGO[siglaCanonica(sigla)] || []).includes(digitos);
}

// O "e do CPC" que abre o artigo seguinte não é o diploma do artigo anterior. Medido pelo corpus de
// referência do extrator (27/09/2026, ação de alimentos da medição): em "Lei 5.478/68, art. 1º, §§ 2º e
// 3º, e do CPC, art. 99, § 3º", o padrão do artigo antes do diploma casava "art. 1º, §§ 2º e 3º, e do
// CPC" e, pela regra do M1 (o posposto prevalece), tirava o "Lei 5.478/68, art. 1º": os §§ 2º e 3º da
// Lei de Alimentos iam ao CPC. Com a conjunção antes do "do" e um artigo logo depois do diploma, o
// diploma é do artigo seguinte.
const CONJUNCAO_ANTES_DO_DO = /(?:^|[\s,])(?:e|ou)\s*$/i;
const ARTIGO_LOGO_DEPOIS = /^\s*,?\s*\(?\s*art(?:igo)?s?\.?\s*\d/i;
function diplomaDoArtigoSeguinte(m, plano) {
  if (!m[2] || !m.indices) return false;
  const fim = m.index + m[0].length;
  return CONJUNCAO_ANTES_DO_DO.test(plano.slice(m.index, m.indices[2][0])) && ARTIGO_LOGO_DEPOIS.test(plano.slice(fim, fim + 30));
}

// A lei que deu a redação ou incluiu o dispositivo não é o diploma dele. Medido pelo corpus de
// referência (27/09/2026): "(CLT, art. 71, § 4º, redação da Lei 13.467/2017)" saía como art. 71, § 4º,
// da Lei 13.467/2017 (e, pelo M1, tirava a citação da CLT), e "(art. 312, § 4º, incluído pela Lei
// 15.272/2025)" como art. 312 da Lei 15.272/2025, no habeas corpus. O artigo fica com o diploma
// anterior ou, sem ele, vira remissão, que herda do contexto ou sai sem diploma.
const DIPLOMA_QUE_ALTEROU = /(?:redacao|incluid[oa]s?|acrescid[oa]s?|acrescentad[oa]s?|introduzid[oa]s?|inserid[oa]s?|alterad[oa]s?|renumerad[oa]s?|revogad[oa]s?)(?:\s+(?:dad[oa]|conferid[oa]))?\s+(?:pel[oa]s?|d[oa]s?)?\s*$/i;
function leiQueAlterou(m, plano) {
  if (!m.indices) return false;
  const grupo = [2, 3, 4, 5, 7].find((g) => m.indices[g]);
  return grupo !== undefined && DIPLOMA_QUE_ALTEROU.test(plano.slice(m.index, m.indices[grupo][0]));
}

const TEMA_QUALIFICADO_DEPOIS = /^\s*,?\s*(?:d[aeo]s?\s+)?(?:(?:recursos?|incidentes?\s+de\s+recursos?|julgamentos?)\s+)?(?:repetitiv|repercussao\s+geral)/i;

const PADROES_DE_CITACAO = [
  { // "Súmula 7/STJ", "Súmula Vinculante 11", "SV 11", "Enunciado 331 do TST", "Súmulas 5 e 7 do STJ"
    regex: new RegExp(`\\b(sumulas?(?:\\s+vinculantes?)?|sum\\.?|sv|enunciados?|verbetes?)\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_SIMPLES})(?:\\s+da\\s+sumula)?${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m, plano) => {
      const numeros = numerosDe(m[2]);
      // O item da súmula ("Súmula 85, VI, do TST") é parte da citação: o cartório casava a Súmula 85,
      // V pelo título da Súmula 85, VI (medição de 01/10/2026, m2).
      const lista = numeros.length === 1 ? (plano.slice(m.index + m[0].length, m.index + m[0].length + 40).match(/^\s*,\s*(?:itens?\s+)?([ivxlc]+(?:\s*(?:,|e|ou)\s*[ivxlc]+)*)(?![a-z0-9])/i) || [])[1] : null;
      const itens = lista ? lista.toLowerCase().split(/\s*(?:,|\be\b|\bou\b)\s*/).filter(Boolean) : [null];
      return numeros.flatMap((numero) => itens.map((item) => ({ classe: 'sumula', numero, vinculante: /vinculante|^sv$/i.test(m[1]), orgao: (m[3] || '').toLowerCase(), ...(item ? { dispositivo: `i:${item}` } : {}) })));
    },
  },
  { // "OJ 394 da SDI-1", "OJs 162 e 233", "Orientação Jurisprudencial nº 394"
    regex: new RegExp(`\\b(?:ojs?|orientac(?:ao|oes)\\s+jurisprudenciais?|orientacao\\s+jurisprudencial)\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_SIMPLES})`, 'gi'),
    chaves: (m) => numerosDe(m[1]).map((numero) => ({ classe: 'oj', numero })),
  },
  { // "Precedente Normativo 120", "PN 120"
    regex: new RegExp(`\\b(?:pns?|precedentes?\\s+normativos?)\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_SIMPLES})`, 'gi'),
    chaves: (m) => numerosDe(m[1]).map((numero) => ({ classe: 'pn', numero })),
  },
  { // "Tema 1.234 do STJ", "Tema repetitivo 988", "Tema RG 1.075", "Temas 988 e 1.234"
    regex: new RegExp(`\\btemas?(?:\\s+(?:rg|repetitivos?|de\\s+rg|de\\s+repercussao\\s+geral))?\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_COM_PONTO})(?:\\s*(?:\\/rg|rg))?${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m, plano) => {
      const antes = plano.slice(Math.max(0, m.index - 40), m.index);
      const depois = plano.slice(m.index + m[0].length, m.index + m[0].length + 3);
      const titulo = /(?:^|\n)[ \t#*_>]*$/.test(antes) && /^\s*(?::|-|–|—|$|\r?\n)/.test(depois);
      // O qualificador também vem depois do número: "Tema 9 dos repetitivos", "Tema 9 dos recursos
      // repetitivos" (contestação trabalhista do corpus de referência, 27/09/2026: o Tema 9 do TST
      // estava no manifesto e o extrator não o via, por ter um dígito só e nenhum sinal antes).
      const qualificadoDepois = TEMA_QUALIFICADO_DEPOIS.test(plano.slice(m.index + m[0].length, m.index + m[0].length + 50));
      const qualificado = /rg|repetitiv|repercussao/i.test(m[0]) || !!m[2] || qualificadoDepois;
      return numerosDe(m[1]).filter((n) => !titulo && (n.length >= 2 || qualificado)).map((numero) => ({ classe: 'tema', numero, orgao: (m[2] || '').toLowerCase() }));
    },
  },
  { // "Apelação Criminal nº 1517288-67.2019.8.26.0050", "Agravo em Execução Penal 0001234-56.2024.8.26.0000"
    regex: new RegExp(`\\b(${CLASSE_TJ})(?![a-z])\\s*(?:n[o°º.]*\\s*)?${NUMERO_CNJ}${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m) => [{ classe: classeTj(m[1]), numero: m[2].replace(/\D/g, ''), corridas: m[2].split(/\D+/).filter(Boolean), uf: '', orgao: (m[3] || '').toLowerCase() }],
  },
  { // plural: "ADIs 6.050, 6.069 e 6.082", "REsps 1.111.111/SP e 2.222.222/RJ" (uma citação por número)
    regex: new RegExp(`\\b(${Object.keys(CLASSE_NO_PLURAL).join('|')})(?![a-z])\\s*(?:n[o°º.]*s?\\s*)?(${NUMERO_NA_LISTA}(?:\\s*(?:,|e|ou)\\s*${NUMERO_NA_LISTA})+)${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m) => {
      const classe = CLASSE_NO_PLURAL[m[1]];
      if (!classe) return [];
      const orgao = (m[3] || '').toLowerCase();
      return [...m[2].matchAll(/(\d(?:[\d.]|-(?=\d))*)(?:\s*[-/]\s*([A-Z]{2})\b)?/g)]
        .filter((n) => n[1].replace(/\D/g, '').length >= 2)
        .map((n) => ({ classe, numero: n[1].replace(/\D/g, ''), corridas: n[1].split(/\D+/).filter(Boolean), uf: n[2] || '', orgao, recurso: '' }));
    },
  },
  { // "REsp 1.234.567/SP", "AgRg no HC 654.321/MG", "ADPF 130", "ADIn 4.277", "AIRR-10553-79.2013.5.15.0090", "E-ED-ARR-2799-09.2013.5.09.0091", "SL 1395 MC-Ref/SP"
    regex: new RegExp(`\\b${PREFIXO_DE_ACORDAO}(?:(${CLASSE_CURTA})|(${CLASSE_LONGA}))${SUFIXO_DE_CLASSE}(?![a-z])[\\s-]*(n[o°º.]*\\s*)?(\\d(?:[\\d.]|-(?=\\d))*)${SUFIXO_POS_NUMERO}(?:\\s*[-/]\\s*([A-Z]{2})\\b)?${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m, plano) => {
      const numero = m[6];
      const digitos = numero.replace(/\D/g, '');
      if (digitos.length < (m[3] ? 2 : 3)) return [];
      const antes = plano.slice(Math.max(0, m.index - 1), m.index);
      if (antes === '/' || /^\d{5}-\d{3}$/.test(numero)) return []; // "Campo Grande/MS 79002-000" é endereço, não MS
      // Classe colada ao número por hífen ("MS-10043", "HC-2201") é código interno de cliente ou
      // produto, salvo a forma do TST com o número único da Justiça do Trabalho e salvo com UF,
      // tribunal ou recurso interno que a nomeiem acórdão. Medido na medição de 01/10/2026 (m3): o
      // cadastro de produtos do cliente ("MS-10043") era lido como mandado de segurança.
      const colado = /^-\d/.test(plano.slice(m.index + (m[1] || '').length + (m[2] || '').length + (m[3] || m[4]).length, m.index + m[0].length).replace(/^[a-z-]*?(?=-\d)/i, ''));
      if (colado && !m[2] && !m[1] && !m[8] && !m[9] && !/\.5\.\d{2}\./.test(numero) && !/\b(?:STF|STJ|TST|TSE|STM|TRF\d?|TJ[A-Z]{2})\b[^\n.;]{0,12}$/.test(plano.slice(Math.max(0, m.index - 20), m.index).toUpperCase())) return [];
      if (m[3] && CLASSE_AMBIGUA.test(m[3].toUpperCase())) {
        if (!CLASSE_AMBIGUA.test(m[3])) return [];
        const tribunalAntes = /\b(?:STF|STJ|TST|TSE|STM)\b[^\n.;]{0,12}$/.test(plano.slice(Math.max(0, m.index - 20), m.index));
        if (!tribunalAntes && !m[7] && !m[8] && !m[5] && !m[9]) return [];
      }
      const classe = (m[3] || m[4]).toLowerCase().replace(/^adin$/, 'adi').replace(/^rvc$/, 'rvcr').replace(/^apn$/, 'ap');
      return [{ classe, numero: digitos, corridas: numero.split(/\D+/).filter(Boolean), uf: m[8] || '', orgao: (m[9] || '').toLowerCase(), recurso: cadeiaDeRecursos(m[1] || '', m[2] || '', m[7] || '') }];
    },
  },
  { // classe por extenso: "Recurso Especial nº 1.234.567/SP", "Habeas Corpus 123.456", "Ação Direta de Inconstitucionalidade 4.277"
    regex: new RegExp(`\\b(${CLASSE_EXTENSO})(?![a-z])\\s*(?:n[o°º.]*\\s*)?${NUMERO_DE_ACORDAO}${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m) => {
      const digitos = m[2].replace(/\D/g, '');
      return digitos.length < 2 ? [] : [{ classe: classeDoExtenso(m[1]), numero: digitos, corridas: m[2].split(/\D+/).filter(Boolean), uf: m[3] || '', orgao: (m[4] || '').toLowerCase() }];
    },
  },
  { // diploma antes do artigo: "CPC, art. 300", "Lei 9.504/1997, art. 41", "IN RFB 2.110/2022, art. 10", "Código Civil, art. 186", "Lei 8.072/1990 (art. 2º, § 1º"
    lado: 'antes',
    // O trecho entre o diploma e o artigo não atravessa dois-pontos nem parêntese que não fecha
    // ali: medido em 25/09/2026 (apelação, motor 0.9.50), "(CPP 400), observado o limite do art.
    // 617" virou o título "CPP 400), observado o limite do art. 617", e "Lei de Drogas: o STJ
    // aplica o art. 400" era lido como artigo da lei. Sigla seguida de número é a forma abreviada
    // ("CPP 400"), lida pelo padrão próprio abaixo.
    regex: new RegExp(`\\b(?:(${DIPLOMA_NUMERADO})(?![a-z])${ORGAO_DO_DIPLOMA}\\s*${NUMERO_DE_LEI}|(${SIGLA_DE_CODIGO})(?![a-z])(?!\\s*\\d)|(${EXTENSO})(?![a-z])|lei\\s+(?:d[eao]s?\\s+)?(${APELIDO})(?![a-z]))(?:(?!${OUTRO_DIPLOMA_NUMERADO}|\\badct(?![a-z])|\\bato\\s+das\\s+disposicoes)(?:${ENTRE_DIPLOMA_E_ARTIGO})){0,45}?(?:\\(\\s*)?${ARTIGO}`, 'gi'),
    // Sigla de código só em maiúsculas: "cf." é "conforme", não a Constituição.
    chaves: (m) => (m[3] && m[3] !== m[3].toUpperCase() ? [] : artigosDe(m[6]).map((a) => ({ classe: 'lei', ...a, diploma: m[3] ? siglaCanonica(m[3]) : m[4] ? siglaDoExtenso(m[4]) : 'lei', numeroLei: m[5] ? leiDoApelido(m[5]) : numeroDeLei(m[2]) }))),
  },
  { // artigo antes do diploma: "art. 373, I, do CPC", "arts. 5º e 6º da CF", "art. 927 do Código Civil", "art. 41 da Lei nº 8.213/91"
    // O mesmo limite do padrão anterior: medido em 25/09/2026 (HC, motor 0.9.50), no trecho
    // citado "§ 3º do art. 312" (CPP, art. 310, § 6º)", o "art. 312" tomou o CPP do parêntese
    // seguinte, saiu como `art. 312" (CPP`, e o art. 310, § 6º ficou fora do gate e do manifesto.
    // O grupo 2 é o "do"/"da" logo antes do diploma: com ele, o diploma é o posposto ao dispositivo
    // ("art. 373, § 1º, do CPC") e prevalece sobre o diploma anterior na oração (M1, abaixo).
    lado: 'depois',
    regex: new RegExp(`${ARTIGO}(?:(?!\\bart)(?:${ENTRE_DIPLOMA_E_ARTIGO})){0,60}?\\b(?:(d[oa]s?)\\s+)?(?:(${SIGLA_DE_CODIGO})(?![a-z])|(${EXTENSO})(?![a-z])|(${DIPLOMA_NUMERADO})(?![a-z])${ORGAO_DO_DIPLOMA}\\s*${NUMERO_DE_LEI}|lei\\s+(?:d[eao]s?\\s+)?(${APELIDO})(?![a-z]))`, 'gid'),
    chaves: (m, plano) => (m[3] && m[3] !== m[3].toUpperCase()) || diplomaDoArtigoSeguinte(m, plano) || leiQueAlterou(m, plano) ? [] : artigosDe(m[1]).map((a) => ({ classe: 'lei', ...a, diploma: m[3] ? siglaCanonica(m[3]) : m[4] ? siglaDoExtenso(m[4]) : 'lei', numeroLei: m[7] ? leiDoApelido(m[7]) : numeroDeLei(m[6]) })),
  },
  { // artigo abreviado, sem "art.": "CPP 244", "CP 44, § 2º", "(CPP 400)"
    regex: new RegExp(ARTIGO_ABREVIADO, 'gi'),
    chaves: (m) => (artigoAbreviadoValido(m[1], m[2]) ? artigosDe(m[2]).map((a) => ({ classe: 'lei', ...a, diploma: siglaCanonica(m[1]), numeroLei: '' })) : []),
  },
  { // lei sem artigo: "Lei 14.905/2024", "Lei nº 13.467/2017", "LC 123/2006", "Decreto-Lei 5.452/1943".
    // Só com o ano ("Lei 8.036" solto é ambíguo) e só lei, decreto-lei, MP e emenda: portaria e
    // resolução sem artigo costumam ser o próprio ato discutido nos autos (a "Portaria SEFIN nº
    // 38/2025" do mandado de segurança), não fonte a conferir. A mesma lei citada com artigo fica com
    // o padrão do artigo (o trecho mais longo vence na sobreposição). Medido em 24/09/2026 (G4): a
    // reclamação e a negativação citavam a Lei 14.905/2024 sem artigo, fora da conta do manifesto.
    regex: new RegExp(`\\b(${LEI_SEM_ARTIGO})(?![a-z])\\s*(?:n[o°º.]*\\s*)?(\\d{1,3}(?:\\.\\d{3})+|\\d+)\\s*\\/\\s*(\\d{4}|\\d{2})(?![\\d/])`, 'gi'),
    chaves: (m) => [{ classe: 'lei', artigo: '', sufixo: '', dispositivo: '', diploma: 'lei', numeroLei: numeroDeLei(`${m[2]}/${m[3]}`) }],
  },
];

// Remissão sem diploma: "(art. 22, VIII)", "art. 62, parágrafo único, e art. 59, § 3º", "art. 22 desta
// Lei". Medido em 26/09/2026 (despejo, motor 0.9.54): a peça citava a Lei 8.245/91 uma vez e o resto por
// remissão; o extrator não via a remissão, o manifesto saiu com 34 citações e a meta deu PARCIAL no
// critério de fonte. A remissão herda o diploma quando o contexto o dá sem dúvida, nesta ordem: a mesma
// oração o nomeia antes dela ("CPC: arts. 319, VII, e 323"); ela continua a enumeração da citação
// anterior ("Lei 8.245/91, art. 62, I; art. 22, VIII"); a frase anterior cita um diploma só; o parágrafo,
// até ela, cita um diploma só. O diploma citado depois não conta ("a imputação do art. 33 não se sustenta:
// absolvição (CPP 386, VII)" é da Lei de Drogas). Parágrafo com dois diplomas não decide: "(Lei 5.478/68, art. 5º, § 7º;
// CPC, arts. 529 e 531); ...; retroação à citação (art. 13, § 2º)" é da Lei de Alimentos, e o mais
// próximo seria o CPC. Lista, título e tabela não herdam a frase de outro bloco. Sem diploma no
// contexto, a remissão sai com `sem_diploma` e nenhuma entrada do manifesto a cobre: é para o texto
// nomear o diploma, não para sumir. A herdada leva `diploma_de` (de onde veio o diploma), para o
// verificador conferir se a remissão é mesmo a ele. Artigo de outra coisa ("art. 5º do contrato", "do
// Estatuto Social", "do Regimento Interno") não é remissão a lei e fica de fora, como antes.
const REMISSAO_A_LEI = /^\s*,?\s*(?:d[oa]s?|dest[ae]s?|dess[ae]s?|nest[ae]s?)\s+(?:mesm[oa]s?\s+|referid[oa]s?\s+|citad[oa]s?\s+)?(?:lei|diploma|codigo)\b/i;
// "art. 71, § 4º, na redação introduzida pela Lei 8.923/1994": o "na" fala da redação do artigo, não
// de outra coisa a que o artigo pertença; a remissão segue (a lei que alterou não é o diploma dele).
const REDACAO_DO_ARTIGO = /^\s*,?\s*(?:n[oa]s?\s+)?(?:redacao|incluid|acrescid|acrescentad|introduzid|inserid|alterad|renumerad|revogad)/i;
// O qualificador é lido no texto com acento e não confunde verbo, outro artigo ou locução com o dono do
// artigo. Medido pelo corpus de referência (27/09/2026): "O art. 62, II, dá ao locatário" e "O art. 206
// dá à certidão" (o "dá" sem acento é "da"), "pelo art. 59, § 1º, IX, nos termos do comando", "a
// minorante do art. 33, § 4º, na fração de 2/3" e "separa o art. 33 do art. 28" tiravam o artigo da
// lista, como se fosse "art. 5º do contrato". O "no"/"na" depois de vírgula é locução, não dono.
const QUALIFICADOR_DO_ARTIGO = /^\s*(?:,?\s*(?:d[oa]s?|dest[ae]s?|dess[ae]s?|nest[ae]s?)|n[oa]s?)\s+(?!art(?:igo)?s?\b)\S/i;
// O instrumento nomeado logo antes do artigo ("Convenção, art. 15", "Regimento Interno, art. 4º", "RI
// arts. 3º e 4º", "Estatuto Social, art. 5º", "(Doc. 06, p. 1, art. 2º)"): artigo de convenção de
// condomínio, regimento, estatuto, contrato social ou de um documento do caso não é lei a verificar
// (L13, locação de 27/09/2026, motor 0.9.60: saíam como remissão sem diploma, ou herdavam a Lei do
// Inquilinato do parágrafo). O artigo de lei no mesmo parêntese ("art. 23, X; Doc. 06, p. 3, art.
// 9º") continua remissão: só o que vem depois do instrumento sai.
const INSTRUMENTO_ANTES_DO_ARTIGO = /(?:\b(?:convenc(?:ao|oes)(?:\s+d[oe]\s+condominio)?|regimentos?(?:\s+internos?)?|estatutos?(?:\s+socia(?:l|is))?|contratos?\s+socia(?:l|is)|ato\s+constitutivo|acordo\s+de\s+(?:socios|quotistas|acionistas)|regulamentos?\s+internos?)|\bdocs?\.?\s*(?:n[o°º.]*\s*)?\d+[a-z]?(?:\s*,\s*(?:pp?|fls?)\.\s*\d+(?:\s*(?:e|a|,)\s*(?:pp?\.\s*)?\d+)*)?)\s*,?\s*$/i;
const SIGLA_DE_INSTRUMENTO_ANTES = /\bRI\s*,?\s*$/;
const INICIO_DE_BLOCO = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|#|\||>)/;
const FIM_DE_FRASE = /[.!?]["”')]*\s+(?=[A-Z"“(*])/g;
const FIM_DE_ORACAO = /;|[.!?]["”')]*\s+(?=[A-Z"“(*])/g;
function blocosDoTexto(plano) {
  // Um bloco por parágrafo de Markdown: linhas seguidas sem linha em branco; item de lista, título,
  // linha de tabela e citação abrem bloco novo. `prosa` quando o bloco não é lista, título nem tabela.
  const blocos = [];
  let pos = 0;
  let atual = null;
  for (const linha of plano.split('\n')) {
    const fimDaLinha = pos + linha.length;
    if (!linha.trim()) atual = null;
    else if (!atual || INICIO_DE_BLOCO.test(linha)) {
      atual = { inicio: pos, fim: fimDaLinha, prosa: !INICIO_DE_BLOCO.test(linha) };
      blocos.push(atual);
    } else atual.fim = fimDaLinha;
    pos = fimDaLinha + 1;
  }
  return blocos;
}
// O diploma nomeado na mesma oração, antes da remissão ("CC (cópia oficial do acervo): arts. 397 e
// 1.650"): o padrão de diploma antes do artigo não atravessa dois-pontos de propósito ("Lei de Drogas: o
// STJ aplica o art. 400"), mas na remissão a oração é o contexto.
const DIPLOMA_NA_ORACAO = new RegExp(`\\b(?:(${DIPLOMA_NUMERADO})(?![a-z])${ORGAO_DO_DIPLOMA}\\s*${NUMERO_DE_LEI}|(${SIGLA_DE_CODIGO})(?![a-z])|(${EXTENSO})(?![a-z])|lei\\s+(?:d[eao]s?\\s+)?(${APELIDO})(?![a-z]))`, 'gi');
function diplomaNaOracao(oracao) {
  let achado = null;
  for (const m of oracao.matchAll(DIPLOMA_NA_ORACAO)) if (!m[3] || m[3] === m[3].toUpperCase()) achado = m;
  // Entre o diploma e a remissão, só um parêntese e a pontuação: "CPC: arts. 319" é rótulo, "Lei de
  // Drogas: o STJ aplica o art. 400" é frase sobre outra coisa.
  if (!achado || !/^\s*(?:\([^()\n]{0,80}\))?\s*[:,]?\s*(?:(?:[oa]s?|n[oa]s?|pel[oa]s?)\s+)?$/i.test(oracao.slice(achado.index + achado[0].length))) return null;
  return diplomaDoAchado(achado);
}
function diplomaDoAchado(achado) {
  const diploma = achado[3] ? siglaCanonica(achado[3]) : achado[4] ? siglaDoExtenso(achado[4]) : 'lei';
  return { bruto: achado[0].trim(), diploma, numeroLei: achado[5] ? leiDoApelido(achado[5]) : achado[2] ? numeroDeLei(achado[2]) : '' };
}
// A identidade do diploma: o código pela sigla, a lei pelo número sem o ano ("Lei 11.343/2006" e "Lei n.
// 11.343/06" são a mesma; a Lei 13.105 é o CPC).
function idDoDiploma(c) {
  const numero = String(c.numeroLei || '').split('/')[0].replace(/\D/g, '');
  return numero ? LEI_DO_CODIGO[numero] || `lei:${numero}` : c.diploma;
}
function dentroDeAspas(antes) {
  const retas = (antes.match(/"/g) || []).length;
  const abre = antes.lastIndexOf('“');
  return retas % 2 === 1 || abre > antes.lastIndexOf('”');
}
function inicioDaUltima(trecho, fronteira) {
  const todas = [...trecho.matchAll(fronteira)];
  return todas.length ? todas[todas.length - 1].index + todas[todas.length - 1][0].length : 0;
}
// "do art. 27 da mesma lei", "art. 5º do referido Código", "art. 3º do citado diploma": o texto nomeia o
// diploma pela última menção, e ela decide, antes do contexto e acima do conflito de artigo. Medido pelo
// corpus de referência (27/09/2026, inventário extrajudicial): "A multa ... do art. 27 da mesma lei"
// vinha logo depois da Lei Estadual nº 14.941/2003, mas a Resolução CNJ nº 35/2007 também tem art. 27
// citado na peça, e a remissão saía sem diploma. Lei é a última lei numerada; código, o último código;
// diploma, o último de qualquer espécie.
const DIPLOMA_NOMEADO_DEPOIS = /^\s*,?\s*(?:d[oa]\s+(?:mesm|referid|citad)[oa]|(?:dest|dess|nest)[ae](?:\s+(?:mesm|referid|citad)[oa])?)\s+(lei|codigo|diploma)\b/i;
function diplomaNomeadoDepois(depois, anteriores) {
  const m = depois.match(DIPLOMA_NOMEADO_DEPOIS);
  if (!m) return null;
  const tipo = m[1].toLowerCase();
  const serve = (c) => (tipo === 'lei' ? !!c.numeroLei && /(?:^|[^a-z])lei(?![a-z])/i.test(c.diploma_de || c.bruto)
    : tipo === 'codigo' ? !c.numeroLei && !['lei', 'cf', 'constituicao-estadual'].includes(c.diploma)
      : true);
  const ultima = anteriores.filter(serve).sort((a, b) => a.fim - b.fim).pop();
  return ultima ? { ...ultima, diploma_de: ultima.diploma_de || ultima.bruto } : null;
}
function remissoesSemDiploma(plano, text, achados) {
  // Só ancora remissão a citação que já traz artigo: "contratos posteriores à Lei 12.112/2009" nomeia
  // a lei como fato, e o "art. 40, X" do mesmo parágrafo continua sendo da Lei 8.245/91.
  const comDiploma = achados.filter((c) => c.classe === 'lei' && c.artigo && (c.diploma || c.numeroLei));
  const umSo = (lista) => (lista.length && new Set(lista.map(idDoDiploma)).size === 1 ? lista[lista.length - 1] : null);
  // O mesmo artigo citado com outro diploma em qualquer ponto da peça tira a certeza da frase e do
  // parágrafo: "(CPP 617); ...; minorante do art. 33, § 4º", com "art. 33, caput, da Lei 11.343/2006"
  // mais adiante, é da Lei de Drogas (apelação, 25/09/2026).
  const diplomasDoArtigo = new Map();
  for (const c of comDiploma) {
    const chave = semZeros(c.artigo);
    if (!diplomasDoArtigo.has(chave)) diplomasDoArtigo.set(chave, new Set());
    diplomasDoArtigo.get(chave).add(idDoDiploma(c));
  }
  const semConflito = (fonte, artigos) => (fonte && artigos.every((a) => {
    const outros = diplomasDoArtigo.get(semZeros(a.artigo));
    return !outros || outros.has(idDoDiploma(fonte));
  }) ? fonte : null);
  const entre = (de, ate) => comDiploma.filter((c) => c.inicio >= de && c.fim <= ate).sort((a, b) => a.fim - b.fim);
  const blocos = blocosDoTexto(plano);
  const saida = [];
  for (const m of plano.matchAll(new RegExp(ARTIGO, 'gi'))) {
    const inicio = m.index;
    const fim = m.index + m[0].length;
    if (achados.some((c) => inicio < c.fim && fim > c.inicio)) continue;
    const depois = plano.slice(fim, fim + 60);
    if (QUALIFICADOR_DO_ARTIGO.test(text.slice(fim, fim + 60)) && !REMISSAO_A_LEI.test(depois) && !REDACAO_DO_ARTIGO.test(depois)) continue;
    const imediato = plano.slice(Math.max(0, inicio - 80), inicio).split(/[;(\n]/).pop();
    if (INSTRUMENTO_ANTES_DO_ARTIGO.test(imediato) || SIGLA_DE_INSTRUMENTO_ANTES.test(imediato)) continue;
    // O instrumento nomeado logo antes do parêntese que abre com o artigo: "Trecho da convenção do
    // condomínio (arts. 14, 15 e 31 a 35)", no índice de anexos (A2, run de 01/10/2026: saía como
    // remissão sem diploma e virava fix alta ao redator).
    const antesDoParentese = /^\s*$/.test(imediato) && /\(\s*$/.test(plano.slice(Math.max(0, inicio - 3), inicio))
      ? plano.slice(Math.max(0, inicio - 80), inicio).replace(/\(\s*$/, '').split(/[;(\n|]/).pop()
      : null;
    if (antesDoParentese !== null && (INSTRUMENTO_ANTES_DO_ARTIGO.test(antesDoParentese) || SIGLA_DE_INSTRUMENTO_ANTES.test(antesDoParentese))) continue;
    const i = blocos.findIndex((b) => inicio >= b.inicio && inicio <= b.fim);
    const bloco = blocos[i];
    // Remissão dentro de transcrição ("previstos no § 3º do art. 312", "na forma prevista no inciso II
    // do art. 62") é a lei falando de si, não citação da peça.
    if (bloco && dentroDeAspas(plano.slice(bloco.inicio, inicio))) continue;
    let fonte = null;
    const artigos = artigosDe(m[1]);
    if (bloco) {
      const antes = plano.slice(bloco.inicio, inicio);
      const inicioDaFrase = bloco.inicio + inicioDaUltima(antes, FIM_DE_FRASE);
      const anterior = entre(bloco.inicio, inicio).pop();
      const frase = inicioDaFrase > bloco.inicio
        ? entre(bloco.inicio + inicioDaUltima(plano.slice(bloco.inicio, inicioDaFrase).replace(/\s+$/, ''), FIM_DE_FRASE), inicioDaFrase)
        : bloco.prosa && blocos[i - 1] && blocos[i - 1].prosa
          ? entre(blocos[i - 1].inicio + inicioDaUltima(plano.slice(blocos[i - 1].inicio, blocos[i - 1].fim), FIM_DE_FRASE), blocos[i - 1].fim + 1)
          : [];
      // Remissão entre parênteses logo depois do que afirma ("... ao despachar a inicial (art. 4º)") cita a
      // fonte da própria frase: vale o diploma que a frase nomeia, se ela nomeia um só, com artigo ou sem
      // ("por isso o rito é o da Lei 5.478/68 e o juiz fixa os provisórios (art. 4º)", alimentos). Em
      // texto corrido não ("no rito da Lei de Drogas: o STJ aplica o art. 400" é o CPP).
      const daFrase = /\(\s*$/.test(plano.slice(Math.max(bloco.inicio, inicio - 3), inicio))
        ? [...plano.slice(inicioDaFrase, inicio).matchAll(DIPLOMA_NA_ORACAO)].filter((d) => !d[3] || d[3] === d[3].toUpperCase()).map((d) => diplomaDoAchado(d))
        : [];
      fonte = diplomaNomeadoDepois(depois, comDiploma.filter((c) => c.fim <= inicio))
        || diplomaNaOracao(antes.slice(inicioDaUltima(antes, FIM_DE_ORACAO)))
        || (anterior && /^[\s;,]*(?:(?:e|ou|c\/c|combinado\s+com)\s+)?$/i.test(plano.slice(anterior.fim, inicio)) ? anterior : null)
        || semConflito(umSo(daFrase), artigos)
        || semConflito(umSo(frase), artigos)
        || semConflito(umSo(entre(bloco.inicio, inicio)), artigos);
    }
    const bruto = text.slice(inicio, fim).replace(/\s+/g, ' ').trim();
    for (const a of artigos) {
      const citacao = fonte
        ? { bruto, inicio, fim, classe: 'lei', ...a, diploma: fonte.diploma, numeroLei: fonte.numeroLei, diploma_de: fonte.diploma_de || fonte.bruto }
        : { bruto, inicio, fim, classe: 'lei', ...a, diploma: '', numeroLei: '', sem_diploma: true };
      saida.push(citacao);
      // A remissão que herdou o diploma o passa adiante: "Lei 8.245/91, art. 62, I; art. 22, VIII;
      // art. 23, XII" é uma enumeração só.
      if (fonte && citacao.artigo) comDiploma.push(citacao);
    }
  }
  return saida;
}

// ── Transcrição de documento do caso (K9) ──────────────────────────────────────────────────
// Medido em 26/09/2026 (defesa de auto de infração, motor 0.9.58): o extrator pegava "art. 64 do
// Decreto Estadual nº 4.410/2024" dentro da transcrição do auto (entre aspas, com "(Doc. 02, p. 2)"
// logo depois) como citação a verificar; a norma estadual não abria em fonte oficial, e a peça
// passou a omitir o artigo para contornar. O que o documento do caso diz não é citação da peça:
// é fato do caso, com a folha. Sai da lista só a transcrição IDENTIFICADA como trecho de documento
// do caso (aspas ou blockquote atribuídos a "Doc. N") E cujo texto está num documento da pasta do
// caso; sem a pasta legível, nada sai (fail-closed). A lei que a peça cita com a própria voz, ou
// transcrita com a lei como fonte ("(Lei 9.605/1998, art. 71, I)"), continua exigida.
const REFERENCIA_A_DOC = /\bDocs?\.?\s*(?:n[º°o.]*\s*)?\d+/i;
const ASPAS_COM_DOC = /(["“])([^"“”\n]{3,2000})["”](\s*\(\s*Docs?\.?\s*(?:n[º°o.]*\s*)?\d+[^)\n]{0,80}\))/g;

function normalizarParaTranscricao(t) {
  return semAcento(String(t || '')).toLowerCase().replace(/[*_`>]/g, ' ').replace(/[^a-z0-9§º°ª]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Os textos dos documentos do caso (`.md` da pasta de autos do squad), normalizados, ou null sem pasta. */
function documentosDoCaso(artifactPath) {
  const m = normalizePath(artifactPath).match(/^(.*?\/squads\/[^/]+)\/output\//);
  if (!m) return null;
  let pasta;
  try { pasta = pastaDeAutos(m[1]); } catch { return null; }
  if (!pasta || !existsSync(pasta)) return null;
  const textos = [];
  const ler = (dir, fundo) => {
    let itens = [];
    try { itens = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of itens) {
      if (it.name.startsWith('_') || it.name.startsWith('.')) continue;
      const caminho = join(dir, it.name);
      if (it.isDirectory() && fundo < 2) ler(caminho, fundo + 1);
      else if (it.isFile() && /\.(?:md|txt)$/i.test(it.name)) {
        try { textos.push(normalizarParaTranscricao(readFileSync(caminho, 'utf8'))); } catch { /* ilegível: fora */ }
      }
    }
  };
  ler(pasta, 0);
  return textos.length ? textos : null;
}

/** O trecho transcrito está num documento do caso: cada pedaço entre reticências, de 8 letras ou mais. */
function transcritoDoCaso(trecho, documentos) {
  const pedacos = String(trecho).split(/\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…/).map(normalizarParaTranscricao).filter((p) => p.length >= 8);
  return pedacos.length > 0 && pedacos.every((p) => documentos.some((d) => d.includes(p)));
}

/**
 * Os intervalos `[inicio, fim)` do texto que são transcrição de documento do caso: o conteúdo entre
 * aspas seguido de "(Doc. N...)", e o blockquote atribuído a "Doc. N" (nele, na linha que o abre ou
 * na que o fecha), quando o texto transcrito está num documento da pasta do caso.
 */
function transcricoesDoCaso(text, documentos) {
  if (!Array.isArray(documentos) || !documentos.length) return [];
  const trechos = [];
  for (const m of text.matchAll(ASPAS_COM_DOC)) {
    const inicio = m.index + m[1].length;
    if (transcritoDoCaso(m[2], documentos)) trechos.push({ inicio, fim: inicio + m[2].length });
  }
  const linhas = text.split('\n');
  const inicios = [];
  let pos = 0;
  for (const l of linhas) { inicios.push(pos); pos += l.length + 1; }
  const vizinha = (i, passo) => { for (let k = i + passo; k >= 0 && k < linhas.length; k += passo) if (linhas[k].trim()) return linhas[k]; return ''; };
  for (let i = 0; i < linhas.length; i += 1) {
    if (!/^\s{0,3}>/.test(linhas[i])) continue;
    let j = i;
    while (j + 1 < linhas.length && /^\s{0,3}>/.test(linhas[j + 1])) j += 1;
    const bloco = linhas.slice(i, j + 1).join('\n');
    const atribuido = REFERENCIA_A_DOC.test(bloco) || REFERENCIA_A_DOC.test(vizinha(i, -1)) || /^\s*\(?\s*Docs?\.?\s*(?:n[º°o.]*\s*)?\d+/i.test(vizinha(j, 1));
    const conteudo = bloco.replace(/^\s{0,3}>\s?/gm, '').replace(/\(\s*Docs?\.?[^)\n]{0,80}\)/gi, ' ');
    if (atribuido && transcritoDoCaso(conteudo, documentos)) trechos.push({ inicio: inicios[i], fim: inicios[j] + linhas[j].length });
    i = j;
  }
  return trechos;
}

/** Cada citação material do texto, com posição, linha e chave. Sobreposições ficam com a primeira. */
/**
 * A nota ao revisor (entre `<!-- nota-ao-revisor:inicio -->` e `<!-- nota-ao-revisor:fim -->`) é
 * material do revisor, que o empacotador tira da peça: o que ela cita não vai ao protocolo e não
 * entra no gate. Troca-se por espaços do mesmo tamanho, para as posições e as linhas não mudarem.
 * Achado M3 5 e M2b 4 da medição de 01/10/2026: os artigos que a nota mencionava viravam pendentes,
 * e o redator passou a escrever a nota sem número para o gate não os ler.
 */
function semNotaAoRevisor(text) {
  return String(text).replace(/(^|\n)([ \t]*<!--\s*nota-ao-revisor:inicio\s*-->[\s\S]*?<!--\s*nota-ao-revisor:fim\s*-->)/g, (m, quebra, bloco) => quebra + bloco.replace(/[^\n]/g, ' '));
}

function extrairCitacoesMateriais(text, { documentos = null } = {}) {
  const transcricoes = transcricoesDoCaso(text, documentos);
  const naTranscricao = (c) => transcricoes.some((t) => c.inicio >= t.inicio && c.fim <= t.fim);
  const plano = desacentuarPreservandoPosicoes(semNotaAoRevisor(text));
  const achados = [];
  const antepostos = new Set();
  const pospostos = [];
  for (const padrao of PADROES_DE_CITACAO) {
    padrao.regex.lastIndex = 0;
    let m;
    while ((m = padrao.regex.exec(plano))) {
      for (const chave of padrao.chaves(m, plano)) {
        const achado = { bruto: text.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(), inicio: m.index, fim: m.index + m[0].length, ...chave };
        achados.push(achado);
        if (padrao.lado === 'antes') antepostos.add(achado);
        if (padrao.lado === 'depois' && m[2]) pospostos.push(achado);
      }
    }
  }
  // O diploma posposto ao dispositivo prevalece sobre qualquer diploma anterior na oração. Medido em
  // 27/09/2026 (réplica, motor 0.9.61, M1): em "Afastado o CDC, a distribuição do ônus segue o art.
  // 373, § 1º, do CPC", o padrão de diploma antes do artigo casava a partir do CDC, começava antes e
  // tirava da sobreposição o "art. 373, § 1º, do CPC": o artigo do CPC ia ao CDC. O trecho que parte
  // de um diploma anterior e termina num artigo que tem o seu "do <diploma>" logo depois sai; o
  // artigo fica com o diploma que o segue.
  for (let k = achados.length - 1; k >= 0; k -= 1) {
    const a = achados[k];
    if (antepostos.has(a) && pospostos.some((p) => p.inicio > a.inicio && p.inicio < a.fim)) achados.splice(k, 1);
  }
  // "parágrafo único do mesmo artigo", "§ 2º do mesmo artigo", "inciso III do mesmo artigo": o
  // dispositivo do artigo citado logo antes, no mesmo parágrafo. Medido na negativação de 24/09/2026:
  // "(art. 400, caput, do CPC), sem prejuízo das medidas ... do parágrafo único do mesmo artigo"
  // saía só como o caput, e o manifesto não precisou de entrada para o parágrafo único.
  const RE_MESMO_ARTIGO = /(?<!\w)(paragrafo\s+unico|§\s*(\d+)(?:\.?\s*[o°º])?|incisos?\s+([ivxlc]+)|caput)\s+d[oa]\s+mesm[oa]\s+(?:artigo|dispositivo|art\.)/gi;
  for (const m of plano.matchAll(RE_MESMO_ARTIGO)) {
    const anterior = achados.filter((c) => c.classe === 'lei' && c.artigo && c.fim <= m.index && !/\n\s*\n/.test(plano.slice(c.fim, m.index))).sort((a, b) => b.fim - a.fim)[0];
    if (!anterior) continue;
    const dispositivo = /^paragrafo/i.test(m[1]) ? 'p:u' : m[2] ? `p:${m[2]}` : m[3] ? `i:${m[3].toLowerCase()}` : 'caput';
    achados.push({ ...anterior, bruto: text.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(), inicio: m.index, fim: m.index + m[0].length, dispositivo });
  }
  achados.push(...remissoesSemDiploma(plano, text, achados));
  achados.sort((a, b) => a.inicio - b.inicio || b.fim - a.fim);
  if (transcricoes.length) for (let k = achados.length - 1; k >= 0; k -= 1) if (naTranscricao(achados[k])) achados.splice(k, 1);
  const unicos = [];
  let linha = 1;
  let cursor = 0;
  for (const c of achados) {
    const ultimo = unicos[unicos.length - 1];
    // Enumeração ("arts. 5º e 6º") gera várias chaves no MESMO trecho; padrões diferentes no mesmo
    // trecho ("CPC, art. 300" e "art. 300 ... do CPP") não.
    if (ultimo && c.inicio < ultimo.fim && !(c.inicio === ultimo.inicio && c.fim === ultimo.fim)) continue;
    for (; cursor < c.inicio; cursor += 1) if (text.charCodeAt(cursor) === 10) linha += 1;
    c.linha = linha;
    unicos.push(c);
  }
  return unicos;
}

// O título do manifesto pode vir em sigla ou por extenso, no singular ou no plural; os dois lados valem.
const SINONIMOS_DE_CLASSE = {
  resp: ['recursos?[\\s-]+especia(?:l|is)'], aresp: ['agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+especia(?:l|is)', 'agravos?[\\s-]+em[\\s-]+resp'],
  eresp: ['embargos[\\s-]+de[\\s-]+divergencia'], re: ['recursos?[\\s-]+extraordinari[oa]s?'],
  are: ['agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+extraordinari[oa]s?', 'agravos?[\\s-]+em[\\s-]+re'], hc: ['habeas[\\s-]+corpus'],
  rhc: ['recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+habeas[\\s-]+corpus'], ms: ['mandados?[\\s-]+de[\\s-]+seguranca'],
  rms: ['recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+mandados?[\\s-]+de[\\s-]+seguranca'],
  adi: ['adin', 'ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade'], adc: ['ac(?:ao|oes)[\\s-]+declaratorias?[\\s-]+de[\\s-]+constitucionalidade'],
  adpf: ['arguic(?:ao|oes)[\\s-]+de[\\s-]+descumprimento'], ado: ['ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade[\\s-]+por[\\s-]+omissao'],
  rcl: ['reclamac(?:ao|oes)(?:[\\s-]+constitucionais?)?'], rr: ['recursos?[\\s-]+de[\\s-]+revista'],
  arr: ['agravos?[\\s-]+e[\\s-]+recursos?[\\s-]+de[\\s-]+revista'], rrag: ['rr[\\s-]+ag', 'recursos?[\\s-]+de[\\s-]+revista[\\s-]+com[\\s-]+agravo'],
  airr: ['agravos?[\\s-]+de[\\s-]+instrumento[\\s-]+em[\\s-]+recursos?[\\s-]+de[\\s-]+revista'], rot: ['recursos?[\\s-]+ordinarios?(?:[\\s-]+trabalhistas?)?'], ro: ['recursos?[\\s-]+ordinarios?'],
  irdr: ['incidentes?[\\s-]+de[\\s-]+resolucao[\\s-]+de[\\s-]+demandas[\\s-]+repetitivas'], iac: ['incidentes?[\\s-]+de[\\s-]+assuncao[\\s-]+de[\\s-]+competencia'],
  respe: ['recursos?[\\s-]+especia(?:l|is)[\\s-]+eleitora(?:l|is)', 'resp[\\s-]+eleitoral'], rvcr: ['rvc', 'revis(?:ao|oes)[\\s-]+crimina(?:l|is)'],
  sta: ['suspens(?:ao|oes)[\\s-]+de[\\s-]+tutela'], pet: ['petic(?:ao|oes)'], inq: ['inqueritos?'],
  sl: ['suspens(?:ao|oes)[\\s-]+de[\\s-]+liminar'], ss: ['suspens(?:ao|oes)[\\s-]+de[\\s-]+seguranca'],
  ap: ['apn', 'ac(?:ao|oes)[\\s-]+pena(?:l|is)(?:[\\s-]+originarias?)?'], mi: ['mandados?[\\s-]+de[\\s-]+injuncao'],
  apelacao: ['apelac(?:ao|oes)', 'apr', 'apl', 'apc'], 'agravo-de-instrumento': ['agravos?[\\s-]+de[\\s-]+instrumento', 'ai'],
  'agravo-em-execucao': ['agravos?[\\s-]+em[\\s-]+execucao', 'agepn', 'agex'], rese: ['recursos?[\\s-]+em[\\s-]+sentido[\\s-]+estrito'],
  'embargos-infringentes': ['embargos[\\s-]+infringentes'],
  sumula: ['sumulas?', 'sum', 'sv', 'enunciados?', 'verbetes?'], tema: ['temas?'],
  oj: ['oj', 'orientac(?:ao|oes)[\\s-]+jurisprudenciais?', 'orientacao[\\s-]+jurisprudencial'], pn: ['pn', 'precedentes?[\\s-]+normativos?'],
};

function semAcento(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Números que vêm DEPOIS de um token de classe no título: "Súmulas 5 e 7" → ['5', '7']. */
function numerosApos(texto, tokens) {
  const rx = new RegExp(`(?:^|[^a-z])(?:${tokens.join('|')})\\.?\\s*(?:(?:vinculantes?|repetitivos?|rg|de\\s+rg|de\\s+repercussao\\s+geral)\\s+)?(?:n[o°º.]*\\s*)?(${ENUMERACAO_COM_PONTO})`, 'g');
  const numeros = [];
  let m;
  while ((m = rx.exec(texto))) numeros.push(...numerosDe(m[1]));
  return numeros;
}
const semZeros = (n) => n.replace(/^0+(?=\d)/, '');
function temNumeroApos(texto, tokens, numero) {
  return numerosApos(texto, tokens).some((n) => semZeros(n) === semZeros(numero));
}
/** Acórdão: as corridas de dígitos do título têm de conter as da citação, em sequência
 * ("1.234.567" ↔ "1234567"; "10553-79.2013" ↔ "0010553-79.2013"). */
function temNumeroDeAcordao(texto, citacao) {
  const alvo = (citacao.corridas || [citacao.numero]).map(semZeros).join('');
  const corridas = (texto.match(/\d+/g) || []).map(semZeros);
  for (let i = 0; i < corridas.length; i += 1) {
    let junto = '';
    for (let j = i; j < corridas.length && junto.length < alvo.length; j += 1) {
      junto += corridas[j];
      if (junto === alvo) return true;
    }
  }
  return false;
}
const TRIBUNAL_NO_TITULO = /(?:^|[^a-z])(stf|supremo|stj|superior\s+tribunal\s+de\s+justica|tst|tse|stm|tnu|carf|crps|tcu|trf\d?|trt\d{0,2}|tj[a-z]{2})(?![a-z])/g;
function tribunaisDo(texto) {
  const achados = new Set();
  let m;
  TRIBUNAL_NO_TITULO.lastIndex = 0;
  while ((m = TRIBUNAL_NO_TITULO.exec(texto))) achados.add(m[1] === 'supremo' ? 'stf' : m[1].startsWith('superior') ? 'stj' : m[1]);
  return achados;
}
function tribunalCompativel(texto, orgao) {
  if (!orgao) return true;
  const doTitulo = tribunaisDo(texto);
  return doTitulo.size === 0 || doTitulo.has(orgao);
}
/** "13.105" no título são as corridas 13|105: o número procurado é uma corrida ou a junção de vizinhas. */
function temNumeroCorrido(texto, digitos) {
  const alvo = semZeros(digitos);
  const corridas = (texto.match(/\d+/g) || []);
  for (let i = 0; i < corridas.length; i += 1) {
    let junto = '';
    for (let j = i; j < corridas.length && junto.length < alvo.length; j += 1) {
      junto += j === i ? semZeros(corridas[j]) : corridas[j];
      if (junto === alvo) return true;
    }
  }
  return false;
}
function temDiploma(texto, citacao) {
  const numero = (citacao.numeroLei || '').split('/')[0].replace(/\D/g, '');
  if (numero) {
    // Diploma numerado: é o NÚMERO que identifica; "lei" sozinha não distingue. A lei que É um
    // código também é coberta pela sigla ou pelo nome do código; a lei com apelido, pelo apelido.
    if (temNumeroCorrido(texto, numero)) return true;
    if (leiDoApelido(texto) === numero) return true;
    const sigla = LEI_DO_CODIGO[numero];
    return !!sigla && (new RegExp(`(?:^|[^a-z])(?:${sigla}|${Object.keys(ALIAS_DE_SIGLA).filter((a) => ALIAS_DE_SIGLA[a] === sigla).join('|')})(?:\\/\\d{2,4})?(?![a-z])`).test(texto)
      || new RegExp(`(?:^|[^a-z])(?:${DIPLOMA_POR_EXTENSO.find(([s]) => s === sigla)[1]})(?![a-z])`).test(texto));
  }
  const sigla = citacao.diploma;
  const aliases = [sigla, ...Object.keys(ALIAS_DE_SIGLA).filter((a) => ALIAS_DE_SIGLA[a] === sigla)];
  if (new RegExp(`(?:^|[^a-z])(?:${aliases.join('|')})(?:\\/\\d{2,4})?(?![a-z])`).test(texto)) return true;
  const extenso = DIPLOMA_POR_EXTENSO.find(([s]) => s === sigla);
  if (extenso && new RegExp(`(?:^|[^a-z])(?:${extenso[1]})(?![a-z])`).test(texto)) return true;
  const lei = CODIGO_DA_LEI[sigla];
  return !!lei && temNumeroCorrido(texto, lei);
}

/** Uma citação está coberta quando alguma entrada do manifesto nomeia a MESMA classe e o MESMO
 * número (e o mesmo tribunal, quando os dois lados o dizem). `titulos` já vem desacentuado. */
function artigoNoTitulo(texto, citacao) {
  return artigosDoTitulo(texto).some((a) => semZeros(a.artigo) === semZeros(citacao.artigo)
    && a.sufixo === (citacao.sufixo || '') && dispositivoCobre(a.dispositivo, citacao.dispositivo || ''));
}
/** O item que o título dá à súmula ("Súmula 85, VI, do TST" → "vi"), ou ''. */
function itemDaSumulaNoTitulo(texto, numero) {
  const m = texto.match(new RegExp(`(?:^|[^a-z])(?:${SINONIMOS_DE_CLASSE.sumula.join('|')})\\.?\\s*(?:vinculantes?\\s+)?(?:n[o°º.]*\\s*)?${numero}(?!\\d)\\s*,\\s*(?:item\\s+)?([ivxlc]+)(?![a-z0-9])`));
  return m ? m[1] : '';
}
function citacaoCoberta(citacao, titulos) {
  return titulos.some((texto) => {
    if (citacao.classe === 'lei') {
      // Remissão sem diploma não se cobre título a título: ver `coberturaDasCitacoes`.
      if (citacao.sem_diploma || !temDiploma(texto, citacao)) return false;
      if (!citacao.artigo) return true; // lei sem artigo: o título que nomeia a lei a cobre
      return artigoNoTitulo(texto, citacao);
    }
    if (citacao.classe === 'sumula') {
      const vinculanteNoTitulo = /vinculante|(?:^|[^a-z])sv(?![a-z])/.test(texto);
      if (!!citacao.vinculante !== vinculanteNoTitulo) return false;
      if (!temNumeroApos(texto, SINONIMOS_DE_CLASSE.sumula, citacao.numero) || !tribunalCompativel(texto, citacao.orgao)) return false;
      // O título com item cobre só aquele item; sem item, a súmula inteira.
      const doTitulo = itemDaSumulaNoTitulo(texto, citacao.numero);
      return !doTitulo || !citacao.dispositivo || citacao.dispositivo === `i:${doTitulo}`;
    }
    if (citacao.classe === 'tema') return temNumeroApos(texto, SINONIMOS_DE_CLASSE.tema, citacao.numero) && tribunalCompativel(texto, citacao.orgao);
    if (citacao.classe === 'oj' || citacao.classe === 'pn') return temNumeroApos(texto, SINONIMOS_DE_CLASSE[citacao.classe], citacao.numero);
    const nomes = [citacao.classe, ...(SINONIMOS_DE_CLASSE[citacao.classe] || [])];
    // A cadeia de recursos internos antes da classe no título: "EDcl no REsp" só se cobre por um
    // título que diga "EDcl no REsp"; a citação sem cadeia ("HC 1.054.751") segue coberta pelo
    // acórdão do mesmo processo, com cadeia ou sem.
    // O incidente depois do número ("SL 1395 MC-Ref/SP") entra na mesma cadeia.
    const cadeias = [...texto.matchAll(new RegExp(`(?:^|[^a-z])((?:(?:agrg|agint|agr|edcl|ed|ei|edv)\\s+(?:no|nos|na|nas|em)\\s+|(?:edciv|edv|ed|e|agr|ag)-)*)(?:${nomes.join('|')})(?![a-z])(?:[\\s-]*(?:n[o°º.]*\\s*)?\\d(?:[\\d.]|-(?=\\d))*\\s+((?:mc|agrg|agr|edcl|ed|qo|tp|ref)(?:-(?:mc|agrg|agr|edcl|ed|qo|tp|ref))*)(?![a-z]))?`, 'g'))].map((m) => cadeiaDeRecursos(m[1], m[2] || ''));
    const temClasse = citacao.recurso ? cadeias.includes(citacao.recurso) : cadeias.length > 0;
    return temClasse && temNumeroDeAcordao(texto, citacao) && tribunalCompativel(texto, citacao.orgao);
  });
}
/** As citações do texto sem entrada no manifesto, cada chave julgada uma vez (uma peça de 3 MB
 * repete a mesma citação milhares de vezes) e cada citação distinta relatada uma vez. */
function citacoesDescobertas(citacoes, titulos) {
  return coberturaDasCitacoes(citacoes, titulos).descobertas;
}

/** A chave de identidade de uma citação: classe, número, artigo com sufixo e dispositivo, diploma,
 * tribunal. Sem o dispositivo, "art. 5º, LVI" e "art. 5º, LXIII" eram a mesma citação (G4, 24/09/2026). */
function chaveDaCitacao(c) {
  return [c.classe, c.numero, c.artigo, c.sufixo, c.dispositivo, c.diploma, c.numeroLei, c.orgao, c.vinculante ? 'sv' : '', (c.corridas || []).join('.'), c.recurso || ''].join('|');
}

/**
 * Cobertura completa: cada citação DISTINTA do texto, julgada uma vez, com o índice do título que
 * a cobre (quando há). É o que o modo `--citacoes` imprime e o que `squad-state citacoes-pendentes`
 * usa para dizer ao verificador o que ainda falta conferir e o que já foi conferido neste run.
 */
// Remissão sem diploma (`remissoesSemDiploma`): coberta quando os títulos com o mesmo artigo e
// dispositivo nomeiam UM diploma só entre os que a peça cita ("art. 59, § 3º" solto na síntese, e o
// manifesto com "Lei 8.245/91, art. 59, § 3º"). Dois diplomas possíveis ("CP, art. 33" e "Lei
// 11.343/2006, art. 33") não decidem: a remissão fica descoberta, para o texto nomear o diploma.
function indiceDaRemissao(c, titulos, diplomasDoTexto) {
  const candidatos = titulos.map((t, i) => (artigoNoTitulo(t, c) ? i : -1)).filter((i) => i >= 0);
  if (!candidatos.length) return -1;
  const nomeados = new Set();
  for (const i of candidatos) {
    const deste = new Set(diplomasDoTexto.filter((d) => temDiploma(titulos[i], d)).map(idDoDiploma));
    if (deste.size !== 1) return -1;
    nomeados.add([...deste][0]);
  }
  return nomeados.size === 1 ? candidatos[0] : -1;
}
function coberturaDasCitacoes(citacoes, titulos) {
  const vistas = new Set();
  const cobertas = [];
  const descobertas = [];
  const diplomasDoTexto = [...new Map(citacoes.filter((c) => c.classe === 'lei' && !c.sem_diploma && (c.diploma || c.numeroLei)).map((c) => [idDoDiploma(c), c])).values()];
  for (const c of citacoes) {
    const chave = chaveDaCitacao(c);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const indice = c.sem_diploma ? indiceDaRemissao(c, titulos, diplomasDoTexto) : titulos.findIndex((t) => citacaoCoberta(c, [t]));
    if (indice >= 0) cobertas.push({ ...c, chave, titulo: indice });
    else descobertas.push({ ...c, chave });
  }
  return { cobertas, descobertas };
}

/**
 * Modo de listagem para o cartório do run (`squad-state citacoes-pendentes`): imprime em JSON as
 * citações materiais do artefato e, dado um manifesto (ou qualquer JSON com `citations[].title`),
 * quais delas ele cobre. Não bloqueia nada e não grava nada: é leitura, a serviço da verificação
 * incremental — no ciclo N o verificador confere só o que mudou desde o ciclo anterior.
 */
function listarCitacoes(artefato, manifestoPath) {
  const { text } = readArtifact(artefato);
  let titulos = [];
  if (manifestoPath) {
    let manifesto;
    try {
      manifesto = JSON.parse(readFileSync(manifestoPath, 'utf8'));
    } catch (error) {
      block(`manifesto ilegível em ${manifestoPath}: ${error.message}`);
    }
    const entradas = Array.isArray(manifesto) ? manifesto : Array.isArray(manifesto && manifesto.citations) ? manifesto.citations : [];
    titulos = entradas.map((c) => semAcento(c && typeof c === 'object' ? String(c.title || '') : ''));
  }
  const citacoes = extrairCitacoesMateriais(text, { documentos: documentosDoCaso(artefato) });
  const { cobertas, descobertas } = coberturaDasCitacoes(citacoes, titulos);
  const enxuta = (c) => ({ bruto: c.bruto, linha: c.linha, classe: c.classe, numero: c.numero || '', artigo: c.artigo || '', sufixo: c.sufixo || '', dispositivo: c.dispositivo || '', diploma: c.diploma || '', numeroLei: c.numeroLei || '', orgao: c.orgao || '', ...(c.recurso ? { recurso: c.recurso } : {}), ...(c.sem_diploma ? { sem_diploma: true } : {}), ...(c.diploma_de ? { diploma_de: c.diploma_de } : {}), chave: c.chave });
  process.stdout.write(`${JSON.stringify({
    artefato,
    total: cobertas.length + descobertas.length,
    cobertas: cobertas.map((c) => ({ ...enxuta(c), titulo: c.titulo })),
    descobertas: descobertas.map(enxuta),
  }, null, 2)}\n`);
}
// ── fim das citações materiais ─────────────────────────────────────────────────────────────────


function normalizePath(value = '') {
  return String(value).replace(/\\/g, '/');
}

function inSquadOutput(filePath) {
  return /(?:^|\/)squads\/[^/]+\/output\//i.test(normalizePath(filePath));
}

/** Rascunho declarado: `minuta`/`rascunho`/`draft`/`interno` no nome, `citation_gate: draft`, nome
 * começando por `_` ou `.`. Nenhum sinal de "final" desfaz isso. */
function isDeclaredDraft(name, text) {
  return name.startsWith('_') || name.startsWith('.') || nomeRascunho(name) || DRAFT_FRONTMATTER.test(text);
}

/** Interno pela convenção de nome ou de pasta (`analise-da-contestacao`, `output/diagnostico/`).
 * O sinal EXPLÍCITO de final (`output/final/`, marcador, frontmatter) vence esta convenção. */
function isInternalByConvention(normalizedPath, name) {
  return emSubpastaInterna(normalizedPath) || nomeInterno(name);
}

function isInternalDraft(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const name = basename(normalizedPath);
  return isDeclaredDraft(name, text) || isInternalByConvention(normalizedPath, name);
}

function isFinalLegalArtifact(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const name = basename(normalizedPath);
  if (!inSquadOutput(normalizedPath) || name.endsWith(MANIFEST_SUFFIX)) return false;
  if (!SUPPORTED_EXT.test(name) || isDeclaredDraft(name, text) || relatorioDeGate(normalizedPath)) return false;
  const explicito = /\/output\/final\//i.test(normalizedPath) || FINAL_MARKER.test(text) || FINAL_FRONTMATTER.test(text);
  if (explicito) return true;
  if (isInternalByConvention(normalizedPath, name)) return false;
  return FINAL_NAME.test(name) || nomeDePeca(name) || formaDePeca(text);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function block(message) {
  process.stderr.write(`CITATION GATE (BLOQUEADO): ${message}\n`);
  process.stderr.write(
    'Esta sentinela só valida pendências, manifesto e integridade local. '
      + 'Ela NÃO consulta nem confirma fontes. Faça a verificação material em fonte primária, '
      + 'registre-a no manifesto e mantenha a revisão humana obrigatória.\n',
  );
  process.exit(EXIT_BLOCKED);
}

function cleanHash(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(value));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// `evidence` é opcional — citação conferida só por leitura continua válida —, mas
// quando vem tem de ser prova de acesso de verdade: hash hexadecimal de 64, trecho
// com texto, caminho com caminho. Evidência malformada aceita em silêncio seria
// pior que evidência ausente: a reabertura por código a trataria como comparável.
const CAMPOS_DE_EVIDENCIA = new Set(['sha256_texto', 'sha256_bytes', 'trecho', 'fonte_local', 'registro', 'dt_publicacao']);

function errosDeEvidencia(evidence, index) {
  if (evidence === undefined) return [];
  const onde = `citations[${index}].evidence`;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [`${onde} deve ser objeto`];
  const erros = [];
  for (const [chave, valor] of Object.entries(evidence)) {
    if (!CAMPOS_DE_EVIDENCIA.has(chave)) { erros.push(`${onde}.${chave} não é campo de evidência (aceitos: ${[...CAMPOS_DE_EVIDENCIA].join(', ')})`); continue; }
    if (typeof valor !== 'string' || !valor.trim()) { erros.push(`${onde}.${chave} deve ser texto não vazio`); continue; }
    if (chave.startsWith('sha256_') && !/^[a-f0-9]{64}$/.test(valor)) erros.push(`${onde}.${chave} deve ser SHA-256 hexadecimal minúsculo`);
    if (chave === 'trecho' && valor.trim().length < 8) erros.push(`${onde}.trecho é curto demais para provar acesso (mínimo 8 caracteres)`);
  }
  return erros;
}

// `artifact` nomeia a peça: o nome do arquivo, ou um caminho relativo que termine nele
// (`squads/x/output/<run>/v10/apelacao-final.md`). Medido nos runs dos moldes de 24/09/2026
// (defeito 23): o conferente gravava o caminho, o schema recusava a barra e o agente
// tentava de novo até acertar o formato. O caminho com barra só vale se apontar a peça
// que está ao lado do manifesto: absoluto, com `..` ou com barra invertida continua recusado.
function artifactConfere(valor, artifactPath) {
  if (typeof valor !== 'string' || !valor || valor.includes('\\') || valor.startsWith('/') || /^[A-Za-z]:/.test(valor)) return false;
  if (valor.split('/').some((parte) => parte === '' || parte === '.' || parte === '..')) return false;
  const alvo = normalizePath(artifactPath);
  return valor === basename(alvo) || alvo.endsWith(`/${valor}`);
}

/**
 * A situação que a cópia do acervo citada em `evidence.fonte_local` declara, ou null. O caminho é
 * relativo à raiz do projeto (a pasta acima de `squads/`, tirada do caminho do artefato) ou absoluto;
 * cópia fora de acervo/ ou ausente do disco não se lê aqui (as outras regras do manifesto cuidam dela).
 */
function textoDaCopiaCitada(citation, artifactPath) {
  const local = citation && citation.evidence && typeof citation.evidence === 'object' ? citation.evidence.fonte_local : undefined;
  if (typeof local !== 'string' || !/(^|[\\/])acervo[\\/]/.test(local)) return null;
  const alvo = normalizePath(artifactPath);
  const i = alvo.search(/(?:^|\/)squads\/[^/]+\/output\//);
  const raiz = i < 0 ? dirname(alvo) : alvo.slice(0, i + (alvo[i] === '/' ? 1 : 0));
  const caminho = isAbsolute(local) ? local : join(raiz || '.', local);
  try { return readFileSync(caminho, 'utf8'); } catch { return null; }
}
function situacaoDaCopiaCitada(citation, artifactPath) {
  const texto = textoDaCopiaCitada(citation, artifactPath);
  return texto === null ? null : situacaoDoTexto(texto).situacao;
}

function validateManifest(manifest, artifactPath, artifactBuffer, artifactText) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifesto deve ser objeto JSON'];
  if (manifest.schema_version !== '1') errors.push('schema_version deve ser "1"');
  if (manifest.kind !== 'legalsquad.citation-gate-attestation') errors.push('kind inválido');
  if (!artifactConfere(manifest.artifact, artifactPath)) errors.push(`artifact deve ser "${basename(artifactPath)}" ou um caminho relativo que termine nele (ex.: output/<run>/v8/${basename(artifactPath)})`);
  if (!/^[a-f0-9]{64}$/.test(cleanHash(manifest.artifact_sha256))) errors.push('artifact_sha256 deve ser SHA-256 hexadecimal');
  if (cleanHash(manifest.artifact_sha256) !== sha256(artifactBuffer)) errors.push('artifact_sha256 não corresponde ao artefato atual');
  if (manifest.gate_status !== 'aprovado') errors.push('gate_status deve ser "aprovado"');
  if (manifest.verification_type !== 'material') errors.push('verification_type deve ser "material"');
  if (!['citacoes_materiais', 'sem_citacoes_materiais'].includes(manifest.scope)) errors.push('scope inválido');
  if (typeof manifest.verified_by !== 'string' || !manifest.verified_by.trim()) errors.push('verified_by é obrigatório');
  if (!isIsoDate(manifest.verified_at)) errors.push('verified_at deve ser data/hora ISO 8601 válida');
  if (!Array.isArray(manifest.citations)) errors.push('citations deve ser array');

  const citations = Array.isArray(manifest.citations) ? manifest.citations : [];
  if (manifest.scope === 'citacoes_materiais' && citations.length === 0) errors.push('scope citacoes_materiais exige ao menos uma citação');
  if (manifest.scope === 'sem_citacoes_materiais' && citations.length > 0) errors.push('scope sem_citacoes_materiais exige citations vazio');
  const citacoesDoTexto = extrairCitacoesMateriais(artifactText, { documentos: documentosDoCaso(artifactPath) });
  if (citacoesDoTexto.length && manifest.scope !== 'citacoes_materiais') {
    errors.push('o artefato aparenta conter citação material; scope não pode declarar ausência');
  }
  citations.forEach((citation, index) => {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) {
      errors.push(`citations[${index}] deve ser objeto`);
      return;
    }
    if (typeof citation.title !== 'string' || !citation.title.trim()) errors.push(`citations[${index}].title é obrigatório`);
    // `verificada_no_acervo`: conferida na cópia do acervo assinado (captura oficial do curador), declarada
    // como tal, com a cópia lida em evidence.fonte_local. Medido em 24/09/2026 (G19, defeito 14): as
    // citações do TST conferidas só no acervo saíam no manifesto como `verificada`, e a meta as lia como
    // verificação na página do tribunal, que não abriu.
    // Súmula cancelada, revogada ou superada não vai à final, nem declarada como tal no manifesto nem
    // conferida numa cópia do acervo que a declara assim (29/09/2026: a Súmula 228 do TST, cancelada,
    // passava como conferida). A mensagem diz o que fazer: a citação sai da peça.
    const statusDaCitacao = String(citation.status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    const situacaoDaCopia = situacaoDaCopiaCitada(citation, artifactPath);
    if (SITUACOES_QUE_IMPEDEM.has(statusDaCitacao)) {
      errors.push(`citations[${index}] (${citation.title || 'sem título'}): ${mensagemDaSituacao(statusDaCitacao)}; retire a citação da peça`);
    } else if (SITUACOES_QUE_IMPEDEM.has(situacaoDaCopia)) {
      errors.push(`citations[${index}] (${citation.title || 'sem título'}): ${mensagemDaSituacao(situacaoDaCopia)} (a cópia do acervo lida, ${citation.evidence.fonte_local}, declara a súmula ${situacaoDaCopia}); retire a citação da peça`);
    } else if (citation.status !== 'verificada' && citation.status !== 'verificada_no_acervo') errors.push(`citations[${index}].status deve ser "verificada" ou "verificada_no_acervo"`);
    if (citation.status === 'verificada_no_acervo') {
      const local = citation.evidence && typeof citation.evidence === 'object' ? citation.evidence.fonte_local : undefined;
      if (typeof local !== 'string' || !/(^|[\\/])acervo[\\/]/.test(local)) errors.push(`citations[${index}]: verificada_no_acervo exige evidence.fonte_local com a cópia do acervo assinado que foi lida (caminho dentro de acervo/)`);
      // Lei conferida só no texto local de legislação não vai à final (decisão do dono, 06/10/2026):
      // o texto acha o artigo e a URL oficial; quem fecha a citação é a fonte oficial aberta no run.
      else if (ehLegislacaoLocal(local)) {
        const texto = textoDaCopiaCitada(citation, artifactPath);
        errors.push(`citations[${index}] (${citation.title || 'sem título'}): ${avisoDaLegislacaoLocal(texto === null ? null : coletadoAteDoTexto(texto))}`);
      }
    }
    if (!isHttpsUrl(citation.source_url)) errors.push(`citations[${index}].source_url deve ser URL HTTPS`);
    if (!isIsoDate(citation.consulted_at)) errors.push(`citations[${index}].consulted_at deve ser data/hora ISO 8601 válida`);
    errors.push(...errosDeEvidencia(citation.evidence, index));
    if (citation.verificadores !== undefined && (!Array.isArray(citation.verificadores) || !citation.verificadores.length || citation.verificadores.some((v) => typeof v !== 'string' || !v.trim()))) {
      errors.push(`citations[${index}].verificadores deve ser lista de identificadores não vazios`);
    }
  });

  // Cobertura: cada citação do texto precisa de uma entrada que a nomeie (classe + número). Um
  // manifesto com uma citação verificada não atesta as outras três — era exatamente o buraco.
  const titulos = citations.map((c) => semAcento(c && typeof c === 'object' ? String(c.title || '') : ''));
  const todasDescobertas = citacoesDescobertas(citacoesDoTexto, titulos);
  const semDiploma = todasDescobertas.filter((c) => c.sem_diploma);
  const descobertas = todasDescobertas.filter((c) => !c.sem_diploma);
  if (semDiploma.length) {
    const trechos = [...new Set(semDiploma.map((c) => `"${c.bruto}" (linha ${c.linha})`))];
    errors.push(`${semDiploma.length} remissão(ões) a artigo sem diploma no contexto (nem na oração, nem na frase anterior, nem no parágrafo) e sem entrada única no manifesto: ${trechos.slice(0, 8).join('; ')}${trechos.length > 8 ? '; …' : ''}. Nomeie o diploma no texto (ex.: "Lei 8.245/91, art. 59, § 3º") e confira a citação`);
  }
  if (descobertas.length) {
    // Um trecho com enumeração ("arts. 5º e 6º da CF") rende várias chaves; a lista mostra o trecho uma vez.
    const trechos = [...new Set(descobertas.map((c) => `"${c.bruto}" (linha ${c.linha})`))];
    const lista = trechos.slice(0, 8).join('; ');
    errors.push(`${descobertas.length} citação(ões) do texto sem entrada em citations[] com a mesma classe e o mesmo número (e, em lei, o mesmo artigo e dispositivo): ${lista}${trechos.length > 8 ? '; …' : ''}`);
  }

  errors.push(...errosDePendencia(manifest, artifactText));
  return errors;
}

// Marcador de pendência no texto e no manifesto. Até 24/09/2026 qualquer um bloqueava
// a final, inclusive o `[CONFIRMAR]` que o compilador manda o redator usar para dado
// ausente; o conferente apagava o marcador e reescrevia a peça depois da revisão (G11
// da medição dos moldes: 23 alterações na reclamação). Marcador de citação continua
// bloqueando sempre; marcador de dado (DATA_MARKER) passa se o manifesto o lista em
// `pendencias_do_profissional[]`, que a parada aprovação mostra ao profissional.
function marcadorNormalizado(m) {
  return String(m || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function errosDePendencia(manifest, artifactText) {
  const errors = [];
  const { pendencias_do_profissional: lista, ...resto } = manifest;
  // O marcador de dado que a nota ao revisor só repete da peça não é outra ocorrência (L15). O
  // manifesto gerado antes disso, que listava também as repetições da nota, continua valendo: o
  // teto de cada marcador é o total de ocorrências, com as da nota.
  // A nota que só NOMEIA o marcador ("Nenhum item [NÃO VERIFICADO]", "marcadores [CONFIRMAR] e
  // [DILIGÊNCIA]") não o usa (L17 e L18): nem trava nem vira pendência.
  const ocorrencias = ocorrenciasDePendencia(artifactText);
  const doTexto = ocorrencias.filter((o) => !o.mencao && !(o.repeteDaPeca && DATA_MARKER.test(o.marcador))).map((o) => o.marcador);
  const teto = new Map();
  for (const o of ocorrencias) if (DATA_MARKER.test(o.marcador)) teto.set(marcadorNormalizado(o.marcador), (teto.get(marcadorNormalizado(o.marcador)) || 0) + 1);
  const deCitacao = [...doTexto.filter((m) => !DATA_MARKER.test(m)), ...(JSON.stringify(resto).match(PENDING_MARKER) || [])];
  if (deCitacao.length) errors.push(`há ${deCitacao.length} marcador(es) de pendência de citação (${[...new Set(deCitacao)].join(', ')}): citação que não se verifica sai da peça antes da final`);
  // Uma entrada por OCORRÊNCIA: onze `[CONFIRMAR]` na peça são onze lugares que o
  // profissional precisa ver na aprovação, cada um com o seu `onde`.
  const noTexto = new Map();
  for (const m of doTexto.filter((x) => DATA_MARKER.test(x)).map(marcadorNormalizado)) noTexto.set(m, (noTexto.get(m) || 0) + 1);
  if (lista === undefined && !noTexto.size) return errors;
  if (!Array.isArray(lista)) {
    errors.push(`há ${[...noTexto.values()].reduce((a, b) => a + b, 0)} marcador(es) de dado sem pendencias_do_profissional[] no manifesto: ${[...noTexto.keys()].join(', ')}`);
    return errors;
  }
  const listados = new Map();
  lista.forEach((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(`pendencias_do_profissional[${i}] deve ser objeto`); return; }
    for (const campo of ['marcador', 'onde', 'procurado_em', 'diligencia']) {
      if (typeof p[campo] !== 'string' || !p[campo].trim()) errors.push(`pendencias_do_profissional[${i}].${campo} é obrigatório`);
    }
    const m = marcadorNormalizado(p.marcador);
    if (!m) return;
    if (!DATA_MARKER.test(m)) errors.push(`pendencias_do_profissional[${i}]: ${m} não é marcador de dado ([CONFIRMAR], [PREENCHER], [DILIGÊNCIA]); pendência de citação não se lista, se resolve`);
    // A menção da nota (L18) listada por manifesto anterior continua aceita: está no texto (o teto).
    else if (!noTexto.has(m) && !teto.has(m)) errors.push(`pendencias_do_profissional[${i}]: ${m} não está no texto da peça`);
    listados.set(m, (listados.get(m) || 0) + 1);
  });
  const fora = [];
  for (const [m, n] of noTexto) {
    const k = listados.get(m) || 0;
    if (k < n) fora.push(n > 1 ? `${m} (${n} no texto, ${k} na lista)` : m);
    else if (k > (teto.get(m) || n)) errors.push(`pendencias_do_profissional[] lista ${m} ${k} vez(es), e o texto o tem ${n}`);
  }
  if (fora.length) errors.push(`${fora.length} marcador(es) de dado fora de pendencias_do_profissional[]: ${fora.join(', ')}`);
  return errors;
}

function readArtifact(filePath) {
  try {
    const buffer = readFileSync(filePath);
    const isText = /\.(?:md|markdown|txt|rtf)$/i.test(filePath);
    return { buffer, text: isText ? buffer.toString('utf8').normalize('NFC') : '' };
  } catch (error) {
    block(`não foi possível ler o artefato final ${filePath}: ${error.message}`);
  }
}

function validateArtifact(filePath) {
  const { buffer, text } = readArtifact(filePath);
  if (!isFinalLegalArtifact(filePath, text)) return;

  // Marcador de citação trava antes de tudo; marcador de dado é julgado contra a lista
  // do manifesto em validateManifest (errosDePendencia).
  const pending = ocorrenciasDePendencia(text).filter((o) => !o.mencao && !DATA_MARKER.test(o.marcador)).map((o) => o.marcador);
  if (pending.length) {
    const kinds = [...new Set(pending.map((item) => item.toUpperCase()))].join(', ');
    block(`${basename(filePath)} contém ${pending.length} marcador(es) de pendência (${kinds})`);
  }

  const manifestPath = `${filePath}${MANIFEST_SUFFIX}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const squad = normalizePath(filePath).match(/(?:^|\/)(squads\/[^/]+)\/output\//);
    block(
      `manifesto ausente ou inválido para ${basename(filePath)}. `
        + `Gere ${basename(manifestPath)} do cartório do run, sem escrever à mão: `
        + `node scripts/squad-state.mjs manifesto-final ${squad ? squad[1] : 'squads/<nome>'} --peca ${normalizePath(filePath)} `
        + `(schema: scripts/citation-gate-manifest.schema.json; ${error.message}). `
        + 'A final não se grava pela ferramenta de escrita antes do manifesto: com `--de <minuta aprovada>`, o mesmo comando grava a final (só o frontmatter muda) e o manifesto numa operação',
    );
  }
  const errors = validateManifest(manifest, filePath, buffer, text);
  if (errors.length) block(`${basename(manifestPath)} inválido: ${errors.join('; ')}`);
}

function artifactFromManifest(manifestPath) {
  const name = basename(manifestPath);
  const artifactName = name.slice(0, -MANIFEST_SUFFIX.length);
  if (!artifactName || artifactName.includes('/') || artifactName.includes('\\')) block('nome de manifesto inválido');
  return join(dirname(manifestPath), artifactName);
}

function runForPath(inputPath) {
  const filePath = normalize(inputPath);
  if (!inSquadOutput(filePath)) return;
  if (filePath.endsWith(MANIFEST_SUFFIX)) {
    const artifactPath = artifactFromManifest(filePath);
    validateArtifact(artifactPath);
    return;
  }
  let text = '';
  try {
    if (/\.(?:md|markdown|txt|rtf)$/i.test(filePath)) text = readFileSync(filePath, 'utf8').normalize('NFC');
  } catch {
    // Só a classificação usa esta leitura; artefato final identificado por nome
    // será relido de modo fail-closed em validateArtifact.
  }
  if (isFinalLegalArtifact(filePath, text)) validateArtifact(filePath);
}

function pathFromHookInput(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }
  const toolInput = data && typeof data === 'object' ? (data.tool_input || {}) : {};
  const candidato = toolInput.file_path || toolInput.path || '';
  return typeof candidato === 'string' ? candidato : '';
}

const listarIndex = process.argv.indexOf('--citacoes');
if (listarIndex >= 0) {
  const artefato = process.argv[listarIndex + 1];
  if (!artefato || artefato.startsWith('--')) block('uso: verifica-citacoes.mjs --citacoes <artefato> [--manifesto <json>]');
  const manifestoIndex = process.argv.indexOf('--manifesto');
  const manifesto = manifestoIndex >= 0 ? process.argv[manifestoIndex + 1] : '';
  const abs = (p) => (isAbsolute(p) ? normalize(p) : normalize(resolve(p)));
  listarCitacoes(abs(artefato), manifesto ? abs(manifesto) : '');
  process.exit(0);
}

const checkIndex = process.argv.indexOf('--check');
if (checkIndex >= 0) {
  const requestedPath = process.argv[checkIndex + 1];
  if (!requestedPath) block('uso: verifica-citacoes.mjs --check <artefato-ou-manifesto>');
  runForPath(isAbsolute(requestedPath) ? normalize(requestedPath) : normalize(resolve(requestedPath)));
  process.exit(0);
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
const hookPath = pathFromHookInput(raw);
if (!hookPath) process.exit(0);
bloquearGravacaoEmRunFechado(normalize(hookPath));
runForPath(normalize(hookPath));
process.exit(0);

// Gravação em `output/<run_id>/` de um run que já fechou é edição de entrega
// pela porta dos fundos: sem redator, sem Citation Gate, sem termo novo. A
// alteração depois da entrega tem rota própria (`squad-state reabrir`, que
// devolve o run a `running` para os agentes e os gates fazerem a versão
// seguinte). Vale só para o hook de Write/Edit; `--check` e `--citacoes` não
// gravam nada. Ledger ilegível ou ausente não bloqueia: o run pode ser antigo.
// Run abortado (`fail`) com subagente ainda em voo: o runner não tem como parar um subagente em
// segundo plano, e o que ele grava depois do abort não pode contar como produto do run (m3 e m4,
// 01/10/2026). O hook roda depois da gravação: o arquivo vai para `_tmp/tardias/` do run, com o
// mesmo caminho relativo, e o subagente é avisado para parar. O relatório e as cópias de estado
// que o fechamento grava na raiz do run ficam onde estão.
// (A lista mora dentro da função: o hook chama daqui de cima do módulo, antes de um `const` solto.)
function desviarGravacaoTardia(filePath, raiz, squadRel, runId, dentroDoRun) {
  const doFechamento = ['RELATORIO.md', 'run-state.json', 'review-state.json', 'state.json'];
  if (!dentroDoRun || doFechamento.includes(dentroDoRun) || dentroDoRun.startsWith('_tmp/')) return;
  const destino = join(raiz, squadRel, 'output', runId, '_tmp', 'tardias', dentroDoRun);
  try {
    mkdirSync(dirname(destino), { recursive: true });
    renameSync(filePath, destino);
  } catch {
    block(`o run ${runId} de ${squadRel} foi abortado: esta gravação chegou depois e não conta, mas não deu para movê-la para _tmp/tardias/. Pare aqui; o runner decide o que fazer com ela.`);
  }
  process.stderr.write(`RUN ABORTADO: o run ${runId} de ${squadRel} foi abortado antes desta gravação. O arquivo foi para output/${runId}/_tmp/tardias/${dentroDoRun} e não conta como produto do run. Pare aqui, sem regravar: o run abortado não aceita mais trabalho.\n`);
  process.exit(EXIT_BLOCKED);
}

function bloquearGravacaoEmRunFechado(filePath) {
  const m = String(filePath).replace(/\\/g, '/').match(/(^|\/)(squads\/([^/]+))\/output\/([^/]+)\//);
  if (!m) return;
  const runNoCaminho = m[4];
  if (runNoCaminho === 'pacote' || runNoCaminho.startsWith('.')) return;
  const dentroDoRun = String(filePath).replace(/\\/g, '/').slice(String(filePath).replace(/\\/g, '/').indexOf(m[0]) + m[0].length);
  const raiz = filePath.slice(0, filePath.replace(/\\/g, '/').indexOf(m[2]));
  const ledgerPath = join(raiz, m[2], 'run-state.json');
  let ledger;
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { ledger = null; }
  // O run do caminho pode não ser o da raiz: o init do run novo guarda o ledger do anterior na pasta dele.
  let doRun = ledger && ledger.runId === runNoCaminho ? ledger : null;
  if (!doRun) { try { doRun = JSON.parse(readFileSync(join(raiz, m[2], 'output', runNoCaminho, 'run-state.json'), 'utf8')); } catch { doRun = null; } }
  if (doRun && doRun.status === 'failed') desviarGravacaoTardia(filePath, raiz, m[2], runNoCaminho, dentroDoRun);
  if (!ledger || ledger.runId !== runNoCaminho || ledger.status === 'running') return;
  // O RELATORIO.md é o rastro de auditoria que o runner grava DEPOIS do `complete`
  // (passo 1c): não é peça nem versão, e bloqueá-lo deixava o run fechado sem relatório.
  // A exceção é a JANELA do fechamento, não o nome: até uma hora depois do `endedAt`
  // do ledger o relatório entra (e se corrige); passada a janela, o rastro de um run
  // fechado é tão intocável quanto a peça (revisão de 20/09/2026).
  if (dentroDoRun === 'RELATORIO.md') {
    const fim = Date.parse(ledger.endedAt || '');
    if (!Number.isFinite(fim) || Date.now() - fim <= 60 * 60 * 1000) return;
    block(`o run ${runNoCaminho} de ${m[2]} fechou em ${ledger.endedAt}: o RELATORIO.md é rastro de auditoria e só se escreve na hora do fechamento. Para alterar a entrega, reabra o run (node scripts/squad-state.mjs reabrir ${m[2]} --modo ajustes|revisao --pedido "…").`);
  }
  block(`o run ${runNoCaminho} de ${m[2]} está "${ledger.status}": a entrega fechou, e gravar em output/ dele à mão pula redator, Citation Gate e termo de conferência. Para alterar a peça entregue, reabra o run (node scripts/squad-state.mjs reabrir ${m[2]} --modo ajustes|revisao --pedido "…") e deixe os agentes e os gates fazerem a versão seguinte.`);
}
