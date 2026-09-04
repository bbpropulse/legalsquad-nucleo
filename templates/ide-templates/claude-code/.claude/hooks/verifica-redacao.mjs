#!/usr/bin/env node
/**
 * Redação Gate — sentinela determinística contra peça RASA.
 *
 * Irmão do Citation Gate, e complementar a ele: aquele bloqueia citação pendente
 * e inventada; este bloqueia o esqueleto bem formatado que não tem os fatos do
 * caso dentro. `skills:` no squad.yaml é declaração, e o `check-squad` confere
 * que a skill existe — mas existir não é ter sido lida nem aplicada.
 *
 * FAZ (fail-closed no escopo):
 * - identifica artefatos jurídicos finais em squads/<squad>/output/;
 * - ANCORAGEM: a peça cita os identificadores do caso (nº, data, valor, sigla)?
 * - COBERTURA: contempla o "Contrato de saída" que a skill declara?
 * - ANDAIME: template do pipeline vazou para a entrega?
 * - VÍCIOS: densidade de marcas de IA fora de citação, e travessão na prosa redigida;
 * - FRENTE: peça longa abre com bloco de síntese nos primeiros 20% (PERSUASAO.md §3)?
 * - FOLHAS: documento dos autos mencionado na peça vem com a folha ou o ID (autos/_index.yaml)?
 *
 * NÃO FAZ:
 * - não julga mérito, estilo nem correção jurídica;
 * - não substitui o revisor isolado nem a revisão humana;
 * - não exige hash dos SKILL.md como "prova de leitura" — hash de arquivo se
 *   produz rodando um script, sem nenhum modelo ter lido nada.
 *
 * A DECISÃO mora em `src/redacao-gate.js`, testada. Este arquivo é casca: lê o
 * disco, monta o contexto e reporta. Se não conseguir carregar o módulo, BLOQUEIA
 * — gate que vira no-op em silêncio é pior que gate nenhum, porque passa a
 * sensação de que existe proteção.
 */
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const EXIT_BLOCKED = 2;
const SUPPORTED_EXT = /\.(?:md|txt|rtf)$/i;
const MANIFEST_SUFFIX = /\.(?:citation|redacao)-gate\.json$/i;
const LEGAL_NAME = /(?:^|[-_.])(?:peti[çc][ãa]o|peticao|pe[çc]a|peca|recurso|apela[çc][ãa]o|apelacao|agravo|habeas[-_]?corpus|hc|resposta[-_]?acusa[çc][ãa]o|memoriais|alega[çc][õo]es|contrarraz[õo]es|raz[õo]es|queixa[-_]?crime|den[úu]ncia|notifica[çc][ãa]o|parecer|contrato|acordo)(?:[-_.]|$)/i;
const FINAL_NAME = /(?:^|[-_.])final(?:[-_.]|$)/i;
const DRAFT_NAME = /(?:^|[-_.])(?:minuta|rascunho|draft|intern[oa])(?:[-_.]|$)/i;
const INTERNAL_NAME = /^(?:revis[ãa]o|aprova[çc][ãa]o|checklist|relat[óo]rio|pesquisa|resumo|diagn[óo]stico|fatos|teses|estrat[ée]gia|intake)(?:[-_.]|$)/i;

function p(value = '') {
  return String(value).replace(/\\/g, '/');
}

function block(message) {
  process.stderr.write(`REDAÇÃO GATE — BLOQUEADO: ${message}\n`);
  process.exit(EXIT_BLOCKED);
}

/** `squads/<code>/output/...` → a raiz do projeto e o code do squad. */
function contexto(filePath) {
  const m = p(filePath).match(/^(.*?)\/squads\/([^/]+)\/output\//i);
  return m ? { raiz: m[1] || '.', squad: m[2] } : null;
}

function ehArtefatoFinal(filePath, texto) {
  const nome = basename(p(filePath));
  if (MANIFEST_SUFFIX.test(nome) || !SUPPORTED_EXT.test(nome)) return false;
  if (nome.startsWith('_') || nome.startsWith('.')) return false;
  if (DRAFT_NAME.test(nome) || INTERNAL_NAME.test(nome)) return false;
  return /\/output\/final\//i.test(p(filePath)) || FINAL_NAME.test(nome) || LEGAL_NAME.test(nome)
    || /<!--\s*LEGALSQUAD:REDACAO-GATE:FINAL\s*-->/i.test(texto);
}

/** O material do caso: os demais artefatos que o pipeline já produziu. */
function entradaDoCaso(outputDir, alvo) {
  if (!existsSync(outputDir)) return '';
  return readdirSync(outputDir)
    .filter((f) => SUPPORTED_EXT.test(f) && !MANIFEST_SUFFIX.test(f) && join(outputDir, f) !== alvo)
    .map((f) => { try { return readFileSync(join(outputDir, f), 'utf8'); } catch { return ''; } })
    .join('\n');
}

/** Ids em `skills:` — lista de bloco (squad.yaml) ou inline (frontmatter). */
function skillsDeclaradas(texto) {
  const inline = texto.match(/^\s*skills:\s*\[([^\]]*)\]\s*$/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const bloco = texto.match(/^skills:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (!bloco) return [];
  return bloco[1].split('\n')
    .map((l) => l.match(/^\s*-\s+(.+?)\s*$/)?.[1]).filter(Boolean)
    .map((s) => s.replace(/^["']|["']$/g, ''));
}

function contratosDasSkills(raiz, squadDir) {
  const ids = new Set();
  const fontes = [join(squadDir, 'squad.yaml')];
  const agentsDir = join(squadDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((x) => x.endsWith('.md'))) fontes.push(join(agentsDir, f));
  }
  for (const arquivo of fontes) {
    if (!existsSync(arquivo)) continue;
    for (const id of skillsDeclaradas(readFileSync(arquivo, 'utf8'))) ids.add(id);
  }

  const contratos = [];
  for (const id of ids) {
    const caminho = join(raiz, 'skills', id, 'references', 'high-performance-contract.md');
    if (existsSync(caminho)) {
      try { contratos.push(readFileSync(caminho, 'utf8')); } catch { /* ilegível vira ausente */ }
    }
  }
  return contratos;
}

/** `reader:` do squad.yaml — quem lê a peça (juiz · contraparte · cliente); default juiz. */
function readerDoSquad(squadDir) {
  const caminho = join(squadDir, 'squad.yaml');
  if (!existsSync(caminho)) return 'juiz';
  try {
    const m = readFileSync(caminho, 'utf8').match(/^reader:[ \t]*["']?([a-z]+)/mi);
    return m ? m[1].toLowerCase() : 'juiz';
  } catch { return 'juiz'; }
}

/** Documentos do índice dos autos (`autos/_index.yaml`, gerado pelo indexar-autos) — só o que o sinal `folhas` usa. */
function lerIndiceDeAutos(squadDir) {
  const caminho = join(squadDir, 'autos', '_index.yaml');
  if (!existsSync(caminho)) return [];
  const semAspas = (v) => { const t = String(v).trim(); try { return JSON.parse(t); } catch { return t.replace(/^["']|["']$/g, ''); } };
  const docs = [];
  let atual = null;
  let texto;
  try { texto = readFileSync(caminho, 'utf8'); } catch { return []; }
  for (const linha of texto.split('\n')) {
    const novo = linha.match(/^\s*-\s+arquivo:\s*(.+)$/);
    if (novo) { atual = { arquivo: semAspas(novo[1]) }; docs.push(atual); continue; }
    const campo = atual && linha.match(/^\s+(tipo|paginas):\s*(.+)$/);
    if (campo) atual[campo[1]] = campo[1] === 'paginas' ? (campo[2].trim() === 'null' ? null : Number(campo[2])) : campo[2].trim();
  }
  return docs;
}

// A decisão do gate vem COPIADA de `src/redacao-gate.js`, não importada: este
// arquivo viaja para o projeto do aluno, onde `src/` não existe. O import
// dinâmico anterior falhava nos dois caminhos que tentava e o gate caía no
// fail-closed, bloqueando a gravação da peça em toda instalação.
// >>> redacao-gate:begin
//
// O Citation Gate bloqueia citação pendente e inventada. Ele NÃO bloqueia peça
// rasa: um esqueleto bem formatado, sem os fatos do caso, passa por ele inteiro.
// `skills:` no squad.yaml é declaração; o `check-squad` confere que a skill
// existe — mas existir não é ter sido lida nem aplicada.
//
// Módulo PURO de propósito. O gate de citação tem 225 linhas de lógica dentro do
// hook, o que o torna difícil de testar; aqui o hook é casca e a decisão mora
// aqui, exercitada por teste.
//
// ── Três sinais, em ordem de força ────────────────────────────────────────
//
// 1. ANCORAGEM — a peça cita os identificadores do caso? É o único que mede
//    profundidade. Peça rasa é genérica por construção: serve para qualquer
//    caso, e por isso não cita âncora nenhuma.
// 2. COBERTURA — a peça contempla o "Contrato de saída" que a skill declara?
//    Derivado da skill, não hardcoded: o núcleo não sabe o que é uma petição,
//    sabe ler o contrato v5.
// 3. ANDAIME — template vazou para a entrega? Reprova sozinho, como os outros:
//    `{{variavel}}` ou `[INSERIR]` numa peça protocolada é indefensável, e um
//    sinal que só corrobora deixaria isso passar sempre que os demais
//    aprovassem. O risco conhecido é o inverso — blacklist em prosa gera falso
//    positivo (`(tese 1)` citando um repetitivo, p.ex.) —, e ele é aceito
//    porque reprovar aqui não apaga nem reescreve nada: o gate PARA e escala ao
//    humano com o padrão nomeado, que então libera em um passo.
//
// Os sinais 4 (vícios de redação) e 5 (frente: síntese nos primeiros 20% da
// peça, PERSUASAO.md §3) estão documentados junto ao código que os mede.
//
// O que NÃO se faz aqui: exigir hash dos SKILL.md como prova de leitura. Hash de
// arquivo se produz rodando um script, sem nenhum modelo ter consumido nada — é
// carimbo automático, o mesmo defeito do re-bind de evidência de promoção. A
// força do Citation Gate vem de refutar o manifesto olhando o artefato; é essa
// propriedade que este módulo copia, não o formato do manifesto.

const NAO_AVALIADO = 'nao-avaliado';

/** Andaime de pipeline que nunca deveria chegar à entrega. */
const ANDAIME = [
  /\(tese\s+\d+\)/i,
  /^\s*Agente:\s/im,
  /^\s*Run:\s/im,
  /^\s*step[-_]?\d+\s*:/im,
  /\{\{\s*[a-z_.]+\s*\}\}/i,
  /\[(?:INSERIR|PREENCHER|TODO|XXX)\]/i,
];

/**
 * Identificadores do caso: número de processo, data, valor, sigla/parte em caixa
 * alta. Vocabulário jurídico comum NÃO entra — ele aparece em qualquer peça e
 * não distingue caso nenhum, que é justamente o que se quer medir.
 */
export function extrairAncoras(texto) {
  const fonte = String(texto || '');
  const ancoras = new Set();

  // Qualquer token com dígito: processo, data, valor, artigo, competência.
  for (const bruto of fonte.match(/[0-9][0-9./:-]*[0-9]|[0-9]/g) || []) {
    if (bruto.replace(/\D/g, '').length >= 4) ancoras.add(bruto);
  }
  // Siglas e partes em caixa alta (ACME, LTDA, INSS) — 3+ letras para não pegar
  // início de frase nem numeral romano curto.
  for (const bruto of fonte.match(/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{3,}\b/g) || []) ancoras.add(bruto);

  return [...ancoras];
}

/**
 * Elementos obrigatórios da entrega, lidos do bloco `## Contrato de saída` do
 * contrato v5. Cada bullet contribui o seu termo-cabeça.
 */
export function extrairExigenciasDeSaida(contrato) {
  // `$(?![\s\S])` é fim de STRING. Um `$` solto, com a flag /m, casaria fim de
  // LINHA e a captura preguiçosa pararia no primeiro bullet — lendo uma
  // exigência de quatro e aprovando peça que falta três.
  const bloco = String(contrato || '').match(/^##\s+Contrato de sa[íi]da\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m);
  if (!bloco) return [];

  const exigencias = new Set();
  for (const linha of bloco[1].split('\n')) {
    const item = linha.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (!item) continue;
    // Termo-cabeça: primeira palavra significativa do bullet.
    const cabeca = item.split(/[\s:,]/).find((p) => p.length >= 4);
    if (cabeca) exigencias.add(cabeca.toLowerCase());
  }
  return [...exigencias];
}

function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * V\u00edcios que denunciam texto de IA numa pe\u00e7a \u2014 par mec\u00e2nico da best-practice
 * `redacao-sem-marcas-de-ia`, que julga os treze padr\u00f5es. Aqui s\u00f3 entram os que
 * d\u00e1 para CONTAR sem interpretar; tr\u00edade ornamental e cita\u00e7\u00e3o decorativa ficam
 * com o guia, porque exigem ler o argumento.
 *
 * Isto \u00e9 estilo do portugu\u00eas forense, n\u00e3o instituto jur\u00eddico \u2014 mesma natureza
 * da lista `ANDAIME` acima, e por isso mora no n\u00facleo. Ainda assim vem por
 * par\u00e2metro em `avaliarRedacao`: uma \u00e1rea em outro idioma traz a sua.
 */
const VICIOS_DE_REDACAO = [
  {
    id: 'assercao-sem-prova',
    rotulo: 'afirma a conclus\u00e3o em vez de demonstr\u00e1-la',
    regex: /\b(?:[\u00e9e]\s+cedi[\u00e7c]o\s+que|resta[m]?\s+(?:cristalino|evidente|claro|patente)|n[\u00e3a]o\s+h[\u00e1a]\s+d[\u00fau]vidas?\s+de\s+que|[\u00e9e]\s+not[\u00f3o]rio\s+que|[\u00e9e]\s+ineg[\u00e1a]vel\s+que)/gi,
  },
  {
    id: 'conectivo-em-cadeia',
    rotulo: 'conectivo pesado como enchimento',
    regex: /\b(?:outrossim|destarte|ademais|nesse\s+diapas[\u00e3a]o|por\s+derradeiro|d'?outra\s+banda)\b/gi,
  },
  {
    id: 'superlativo-empilhado',
    rotulo: 'superlativo no lugar de prova',
    regex: /\b(?:absolutamente|totalmente|completamente|manifestamente|flagrantemente|inquestionavelmente)\s+\p{L}+/giu,
  },
  {
    id: 'fecho-generico',
    rotulo: 'fecho de estilo, sem pedido espec\u00edfico',
    regex: /\bmedida\s+de\s+(?:mais\s+)?l[\u00edi]dima\s+justi[\u00e7c]a|\bpor\s+ser\s+medida\s+de\s+justi[\u00e7c]a/gi,
  },
];

/** Acima disto, o ac\u00famulo deixa de ser escolha de estilo e vira enchimento. */
const LIMITE_DE_VICIOS = 4;

/**
 * Remove o que a pe\u00e7a CITA, deixando s\u00f3 o que ela REDIGE.
 *
 * Blockquote \u00e9 fonte: ementa, dispositivo, depoimento. Contar o estilo de quem
 * escreveu a ementa contra quem a transcreveu empurraria o redator a adulterar
 * a cita\u00e7\u00e3o para passar no gate \u2014 exatamente o que a best-practice pro\u00edbe.
 */
function semCitacoes(texto) {
  return String(texto || '')
    .split('\n')
    .filter((linha) => !/^\s*>/.test(linha))
    .join('\n');
}

/**
 * Frente (PERSUASAO.md §3). Abaixo deste número de linhas redigidas a peça é
 * curta e a síntese não é exigida: manifestação de duas páginas não precisa
 * dela, e exigi-la ensinaria a inflar. Acima, o marcador tem de aparecer nos
 * primeiros 20% das linhas redigidas, com piso de PISO_DA_JANELA linhas.
 */
const LIMIAR_DE_FRENTE = 40;
const PISO_DA_JANELA = 8;

/**
 * Texto (já normalizado: sem acento, minúsculo) que abre um bloco de síntese.
 * Casa por palavra inteira, não por prefixo solto: `tese` não é `tesouraria`.
 */
const MARCADOR_DE_SINTESE = /^(?:em\s+)?sintese\b|^resumo\b|^sumario\b|^teses?\b/;

/**
 * O que a peça real põe ANTES da palavra de síntese num heading forense: o
 * enumerador (`1.`, `1.1`, `2)`, `I.`, `II -`, `a)`) e a preposição que costuma
 * segui-lo (`DA SÍNTESE`). A §3 diz "comece com"; `## I. DA SÍNTESE` obedece
 * ao espírito e reprová-la seria o gate mentindo sobre quem cumpriu. Tolerar o
 * prefixo não afrouxa a regra: depois dele, o texto ainda tem de COMEÇAR pela
 * palavra de síntese. Roman/letra exigem pontuação ou traço para não engolir
 * palavra comum (`civil`, `a`).
 */
const PREFIXO_DE_HEADING = /^(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+(?:[.)]|(?=\s+[-\u2013\u2014:]))|[a-z][.)])\s*(?:[-\u2013\u2014:]\s*)?/;
const PREPOSICAO_DE_HEADING = /^d[aeo]s?\s+/;

/**
 * Heading (`#`, `##`, `###`) ou linha que abre em negrito (`**...**`) cujo texto
 * começa por síntese / em síntese / resumo / sumário / tese(s). Só chega aqui
 * linha redigida: `semCitacoes` já tirou o blockquote, porque `> ## Síntese`
 * transcrito de um acórdão não é a síntese da peça.
 */
function ehMarcadorDeSintese(linha) {
  const heading = linha.match(/^\s*#{1,3}\s+(.+?)\s*$/);
  const negrito = heading ? null : linha.match(/^\s*\*\*(.+?)\*\*/);
  const bruto = heading?.[1] ?? negrito?.[1];
  if (!bruto) return false;
  const texto = normalizar(bruto)
    .trim()
    .replace(/\s+#+\s*$/, '') // fecho opcional do heading ATX: `## Síntese ##`
    .replace(/^[*_]+/, '') // `## **Síntese**`
    .replace(PREFIXO_DE_HEADING, '')
    .replace(PREPOSICAO_DE_HEADING, '');
  return MARCADOR_DE_SINTESE.test(texto);
}

/**
 * Avalia uma peça. Devolve `{ ok, problemas[], sinais }`, onde cada sinal é
 * `aprovado`, `reprovado` ou `nao-avaliado`.
 *
 * **`nao-avaliado` nunca é aprovação.** O que não dá para verificar é declarado,
 * não presumido — mesma regra que o runner aplica à best-practice de redação
 * ausente. Aprovar em silêncio seria o gate mentindo exatamente onde deveria calar.
 */
// ── 6º sinal: folhas ─────────────────────────────────────────────────────────
// Peça que cita as folhas (PLANO-ORQUESTRADOR.md, Fase 5). O índice dos autos
// (`autos/_index.yaml`, Fase 2) diz que documentos existem; a peça diz onde
// cada um está. Para cada documento indexado que a peça menciona — pelo tipo
// (contestação, sentença, certidão…) ou pelo nome do arquivo —, ao menos um
// parágrafo que o menciona tem de trazer a folha ou o ID. Blockquote não conta.
const REFERENCIA_DE_FOLHA = /\b(?:e-?fls?\.?|fls?\.|folhas?|f\.)\s*\d+|\bid\s*\d{4,}\b/i;
const MENCAO_POR_TIPO = {
  inicial: /peticao inicial|\binicial\b|exordial/,
  contestacao: /contestacao/,
  replica: /\breplica\b/,
  sentenca: /sentenca/,
  acordao: /acordao/,
  decisao: /\bdecisao\b/,
  certidao: /certidao/,
  intimacao: /intimacao/,
  procuracao: /procuracao/,
  contrato: /\bcontrato\b/,
  laudo: /\blaudo\b/,
};
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// A folha tem de vir JUNTO da menção — "a contestação (fls. 45)", "fls. 45, a
// contestação", "o laudo, ID 2048…" — não em qualquer ponto do parágrafo: um
// `fls.` do laudo não serve para a contestação citada na mesma frase.
const JANELA_ANTES = 30;
const JANELA_DEPOIS = 40;

function padraoDeMencao(doc) {
  const porTipo = MENCAO_POR_TIPO[semAcento(doc.tipo)];
  if (porTipo) return { re: porTipo, requer: [] };
  // documento/desconhecido: pelo nome do arquivo (sem prefixo numérico e extensão);
  // a menção é a palavra mais longa do nome, e as demais têm de estar no parágrafo.
  const tronco = semAcento(doc.arquivo).replace(/\.[a-z0-9]+$/, '').replace(/^[\d\s._-]+/, '');
  const tokens = tronco.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  if (!tokens.length) return null;
  const principal = [...tokens].sort((a, b) => b.length - a.length)[0];
  return { re: new RegExp(`\\b${principal}`), requer: tokens.filter((t) => t !== principal) };
}

/** Numa cópia normalizada do parágrafo: há menção? e alguma menção tem folha na janela? */
function mencaoComFolha(paragrafo, padrao) {
  if (padrao.requer.some((t) => !paragrafo.includes(t))) return { mencao: false, folha: false };
  const re = new RegExp(padrao.re.source, padrao.re.flags.includes('g') ? padrao.re.flags : `${padrao.re.flags}g`);
  let m;
  let mencao = false;
  while ((m = re.exec(paragrafo))) {
    mencao = true;
    const ini = Math.max(0, m.index - JANELA_ANTES);
    const fim = Math.min(paragrafo.length, m.index + m[0].length + JANELA_DEPOIS);
    if (REFERENCIA_DE_FOLHA.test(paragrafo.slice(ini, fim))) return { mencao: true, folha: true };
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return { mencao, folha: false };
}

/**
 * Avalia o sinal `folhas`. `autos` é a lista de documentos do índice
 * (`{arquivo, tipo, paginas}`). Devolve `{sinal, motivo, semFolha}`.
 */
export function avaliarFolhas(texto, autos = []) {
  const docs = (Array.isArray(autos) ? autos : []).filter((d) => d && d.arquivo);
  if (!docs.length) {
    return {
      sinal: NAO_AVALIADO,
      motivo: 'folhas NÃO AVALIADAS: sem autos/_index.yaml no squad — a peça não pode citar folhas de autos que o run não indexou (node scripts/indexar-autos.mjs squads/<nome>).',
      semFolha: [],
    };
  }
  const paragrafos = String(texto || '')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n'))
    .filter((p) => p.trim());
  const semFolha = [];
  let mencionados = 0;
  for (const doc of docs) {
    const padrao = padraoDeMencao(doc);
    if (!padrao) continue;
    const resultados = paragrafos.map((p) => mencaoComFolha(semAcento(p), padrao)).filter((r) => r.mencao);
    if (!resultados.length) continue;
    mencionados += 1;
    if (!resultados.some((r) => r.folha)) semFolha.push(`${doc.tipo || 'documento'} (${doc.arquivo})`);
  }
  if (!mencionados) {
    return { sinal: NAO_AVALIADO, motivo: 'folhas NÃO AVALIADAS: a peça não menciona nenhum documento do índice dos autos.', semFolha };
  }
  if (semFolha.length) {
    return {
      sinal: 'reprovado',
      motivo: `folhas REPROVADAS: ${semFolha.join(', ')} — documento dos autos mencionado sem a folha ou o ID onde está (fls. N, f. N, e-fls. N ou ID N). O índice diz o que existe; a peça diz onde está.`,
      semFolha,
    };
  }
  return { sinal: 'aprovado', motivo: null, semFolha };
}

export function avaliarRedacao({ artefato, entrada, contratos = [], vicios = VICIOS_DE_REDACAO, autos = [], reader = 'juiz' }) {
  const texto = String(artefato || '');
  const problemas = [];
  const sinais = {};

  // ── 1. Ancoragem ao caso ────────────────────────────────────────────────
  const ancoras = extrairAncoras(entrada);
  if (ancoras.length === 0) {
    sinais.ancoragem = NAO_AVALIADO;
    problemas.push(
      'ancoragem NÃO AVALIADA: o material de entrada não tem identificadores (número, data, valor, '
      + 'sigla) para confrontar. Sem eles não dá para distinguir peça do caso de peça genérica.'
    );
  } else {
    const usadas = ancoras.filter((a) => texto.includes(a));
    if (usadas.length === 0) {
      sinais.ancoragem = 'reprovado';
      problemas.push(
        `ancoragem REPROVADA: a peça não cita nenhum dos ${ancoras.length} identificadores do caso `
        + `(ex.: ${ancoras.slice(0, 3).join(', ')}). Peça que serve para qualquer caso é peça rasa.`
      );
    } else {
      sinais.ancoragem = 'aprovado';
    }
  }

  // ── 2. Cobertura do contrato de saída ───────────────────────────────────
  const exigencias = [...new Set(contratos.flatMap((c) => extrairExigenciasDeSaida(c)))];
  if (exigencias.length === 0) {
    // Área não instalada, ou skill sem contrato v5. Desliga esta dimensão, não o
    // gate inteiro — degradação por dimensão, como o runner faz.
    sinais.cobertura = NAO_AVALIADO;
    problemas.push('cobertura NÃO AVALIADA: nenhum "Contrato de saída" encontrado nas skills declaradas.');
  } else {
    const corpo = normalizar(texto);
    const faltando = exigencias.filter((e) => !corpo.includes(normalizar(e)));
    if (faltando.length) {
      sinais.cobertura = 'reprovado';
      problemas.push(`cobertura REPROVADA: a peça não contempla ${faltando.join(', ')} — exigido pelo contrato da skill.`);
    } else {
      sinais.cobertura = 'aprovado';
    }
  }

  // ── 3. Andaime vazado ───────────────────────────────────────────────────
  const vazamentos = ANDAIME.filter((padrao) => padrao.test(texto));
  if (vazamentos.length) {
    sinais.andaime = 'reprovado';
    problemas.push(`andaime REPROVADO: template do pipeline vazou para a entrega (${vazamentos.length} padrão/ões).`);
  } else {
    sinais.andaime = 'aprovado';
  }

  // ── 4. Vícios de redação (marcas de IA) ─────────────────────────────────
  // Mede DENSIDADE fora de citação. Presença isolada não reprova: "outrossim"
  // uma vez é conectivo, e reprovar aí ensinaria a evitar a palavra em vez de
  // evitar o enchimento — o gate viraria superstição.
  const lista = Array.isArray(vicios) ? vicios.filter((v) => v && v.regex) : [];
  if (!lista.length) {
    sinais.vicios = NAO_AVALIADO;
    problemas.push('vícios NÃO AVALIADOS: nenhuma lista de padrões de redação foi fornecida ao gate.');
  } else {
    const redigido = semCitacoes(texto);

    // ── Travessão de IA: tolerância ZERO no que a peça REDIGE ──────────────
    // Regra de produto, distinta da densidade: o travessão (—, ou – espaçado
    // como conector) é a marca tipográfica de texto de IA, e a prosa forense
    // brasileira não precisa dele — vírgula, dois-pontos, parênteses ou ponto
    // resolvem. Diferente de "outrossim" (palavra legítima em dose), UM
    // travessão já denuncia; por isso não entra na conta de densidade: é
    // reprovação própria. Citações (blockquote) ficam de fora — ementa
    // transcrita com travessão é fidelidade à fonte, não estilo do redator. O
    // hífen (-) nunca casa: palavra composta e "art. 1.035-A" são intocáveis.
    const travessoes = (redigido.match(/\u2014|\s\u2013\s/g) || []).length;
    if (travessoes > 0) {
      sinais.vicios = 'reprovado';
      problemas.push(
        `travessão REPROVADO: ${travessoes} travessão(ões) na prosa redigida — marca de texto de IA. `
        + 'Reescreva com vírgula, dois-pontos, parênteses ou ponto final; travessão só sobrevive dentro de citação transcrita.'
      );
    }
    const achados = [];
    let total = 0;
    for (const vicio of lista) {
      const n = (redigido.match(vicio.regex) || []).length;
      if (n) {
        total += n;
        achados.push(`${vicio.id}${vicio.rotulo ? ` (${vicio.rotulo})` : ''} ×${n}`);
      }
    }
    if (total > LIMITE_DE_VICIOS) {
      sinais.vicios = 'reprovado';
      problemas.push(
        `vícios REPROVADO: ${total} marcas de redação genérica fora de citação — ${achados.join('; ')}. `
        + 'Troque a asserção pela demonstração e corte o conectivo de enchimento (ver `redacao-sem-marcas-de-ia`).'
      );
    } else if (sinais.vicios !== 'reprovado') {
      // Não sobrescreve a reprovação do travessão acima.
      sinais.vicios = 'aprovado';
    }
  }

  // ── 5. Frente: síntese nos primeiros 20% ────────────────────────────────
  // Front-loading como regra de produto (PERSUASAO.md §3). O juiz recebe a
  // peça já triada ou resumida por IA, e o que não sobrevive ao resumo ele não
  // lê. Peça longa abre com um bloco de síntese (pedido, teses numeradas,
  // Temas/súmulas) nos primeiros 20% do que REDIGE. Mesma natureza do
  // travessão: não há dose legítima, ou a síntese está no começo ou o segundo
  // leitor não a vê. O gate não julga se a síntese é boa (isso é o verificador
  // de persuasão); garante que existe um lugar para ser julgada. Blockquote
  // não é redação: fica fora da conta e não serve de marcador.
  const linhasRedigidas = semCitacoes(texto).split('\n').filter((linha) => linha.trim() !== '');
  const total = linhasRedigidas.length;
  if (total < LIMIAR_DE_FRENTE) {
    // Peça curta não é peça aprovada em frente; é peça não medida.
    sinais.frente = NAO_AVALIADO;
    problemas.push(
      `frente NÃO AVALIADA: peça curta (${total} linhas redigidas); síntese só é exigida a partir de ${LIMIAR_DE_FRENTE}.`
    );
  } else {
    // ceil(total / 5) é o "20%" da spec sem passar por ponto flutuante.
    const janela = Math.max(PISO_DA_JANELA, Math.ceil(total / 5));
    const posicao = linhasRedigidas.findIndex(ehMarcadorDeSintese);
    if (posicao >= 0 && posicao < janela) {
      sinais.frente = 'aprovado';
    } else {
      sinais.frente = 'reprovado';
      const onde = posicao >= 0
        ? `o primeiro marcador só aparece na linha redigida ${posicao + 1} (${JSON.stringify(linhasRedigidas[posicao].trim().slice(0, 60))})`
        : 'não há marcador em toda a peça';
      problemas.push(
        `frente REPROVADA: nenhum marcador de síntese nos primeiros ${janela} de ${total} linhas redigidas; ${onde}. `
        + 'Abra a peça com um bloco de síntese: pedido, teses numeradas e os Temas/súmulas que as governam, em até dez linhas.'
      );
    }
  }

  // Pontas por tipo (PLANO-ORQUESTRADOR.md, Fase 7): contrato (`reader:
  // contraparte`) não abre com síntese de peça — o quadro-resumo é cobrado
  // pelo verifica-contrato. O sinal `frente` não se aplica: NÃO AVALIADO.
  if (String(reader || '').toLowerCase() === 'contraparte') {
    for (let i = problemas.length - 1; i >= 0; i--) if (/^frente /i.test(problemas[i])) problemas.splice(i, 1);
    sinais.frente = NAO_AVALIADO;
    problemas.push('frente NÃO AVALIADA: contrato (reader: contraparte) — o quadro-resumo é cobrado pelo verifica-contrato, não pela síntese de peça.');
  }

  // ── 6. Folhas ────────────────────────────────────────────────────────────
  const folhas = avaliarFolhas(texto, autos);
  sinais.folhas = folhas.sinal;
  if (folhas.motivo) problemas.push(folhas.motivo);

  return {
    ok: !Object.values(sinais).includes('reprovado'),
    problemas,
    sinais,
  };
}
// <<< redacao-gate:end

const carregarAvaliador = async () => avaliarRedacao;

/**
 * Avalia um arquivo, SEM a heurística de "é artefato final?". Usado tanto pelo
 * modo passivo (que aplica a heurística por cima) quanto pelo `--json` — o
 * runner que chama `--json` já sabe que este é o output do step de redação; a
 * heurística de nome existe só para escopar o hook automático, que dispara sem
 * ninguém ter dito "isto é uma peça".
 *
 * Devolve `null` quando não há como avaliar (fora de squads/*​/output/, ou
 * ilegível) — distinto de `{ok: true}` ou `{ok: false}`.
 */
async function avaliarArquivo(filePath) {
  const ctx = contexto(filePath);
  if (!ctx) return null;

  let texto = '';
  try { texto = readFileSync(filePath, 'utf8'); } catch { return null; }

  const squadDir = join(ctx.raiz, 'squads', ctx.squad);
  const avaliarRedacao = await carregarAvaliador();
  return avaliarRedacao({
    artefato: texto,
    entrada: entradaDoCaso(dirname(filePath), filePath),
    contratos: contratosDasSkills(ctx.raiz, squadDir),
    autos: lerIndiceDeAutos(squadDir),
    reader: readerDoSquad(squadDir),
  });
}

/** Modo PASSIVO (PostToolUse) — só age sobre o que parece artefato final. */
async function rodar(filePath) {
  const alvo = normalize(filePath);
  let texto = '';
  try { texto = readFileSync(alvo, 'utf8'); } catch { return; }
  if (!contexto(alvo) || !ehArtefatoFinal(alvo, texto)) return;

  const veredito = await avaliarArquivo(alvo);
  if (!veredito) return;
  if (!veredito.ok) block(`${basename(alvo)}\n  · ${veredito.problemas.join('\n  · ')}`);
  for (const aviso of veredito.problemas) process.stderr.write(`REDAÇÃO GATE — aviso: ${aviso}\n`);
}

const checkIndex = process.argv.indexOf('--check');
if (checkIndex >= 0) {
  const pedido = process.argv[checkIndex + 1];
  if (!pedido) block('uso: verifica-redacao.mjs --check <artefato> [--json]');
  const alvo = isAbsolute(pedido) ? normalize(pedido) : normalize(resolve(pedido));

  if (process.argv.includes('--json')) {
    // Consulta, não enforcement. O runner usa isto para saber COMO está a
    // minuta e decidir REJECT/ADVANCE dentro do loop de revisão — nunca sai
    // com erro aqui, mesmo reprovado: quem decide o que fazer é quem chamou.
    const veredito = await avaliarArquivo(alvo);
    process.stdout.write(JSON.stringify(veredito ?? { ok: null, problemas: ['fora de squads/*/output/ ou ilegível'], sinais: {} }));
    process.exit(0);
  }

  await rodar(alvo);
  process.exit(0);
}

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { process.exit(0); }
let entrada = {};
try { entrada = JSON.parse(raw); } catch { process.exit(0); }
const caminho = (entrada.tool_input || {}).file_path || (entrada.tool_input || {}).path || '';
if (!caminho) process.exit(0);
await rodar(normalize(caminho));
process.exit(0);
