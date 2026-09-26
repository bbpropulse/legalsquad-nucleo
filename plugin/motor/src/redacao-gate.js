// Redação Gate — o irmão determinístico do Citation Gate.
//
// COPIADO VERBATIM para os hooks `verifica-redacao.mjs` (bloco `redacao-gate`,
// sincronizado por `npm run sync:blocos`), e não importado: o hook viaja para o
// projeto do aluno, e lá NÃO existe `src/`. O carregamento dinâmico tentava
// `legalsquad/src/redacao-gate.js` (só resolve com o pacote em node_modules, e o
// aluno instala global) e `../../src/redacao-gate.js` (aponta para {projeto}/src/,
// que não existe). Os dois falhavam, o gate caía no fail-closed e BLOQUEAVA a
// gravação da peça. Achado por um usuário ao rodar `/legalsquad atualizar`.
// A nota ao revisor (bloco `nota-ao-revisor`) vem de `src/nota-ao-revisor.js`; nos hooks, o
// mesmo bloco é copiado ao lado deste, pelo `sync:blocos`.
import { NOTA_AO_REVISOR_FIM, NOTA_AO_REVISOR_INICIO, separarNotaAoRevisor } from './nota-ao-revisor.js';

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
//    sabe ler o contrato v5. Cada elemento conta como seção da peça (título ou
//    rótulo), não como palavra solta no corpo.
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

/**
 * Andaime de pipeline que nunca deveria chegar à entrega. Mede o CORPO, sem o
 * frontmatter YAML: `run:` e `agente:` são chaves legítimas ali, metadado que o
 * empacotador já tira da peça. Medido em 25/09/2026, alimentos/reclamação: o
 * padrão sem caixa casou com a chave `run:` do frontmatter da minuta e o gate
 * reprovou "1 padrão" sem dizer qual. `Agente:`/`Run:` com caixa, porque o
 * andaime que vaza é o rótulo do pipeline, não a palavra em minúscula.
 */
const ANDAIME = [
  /\(tese\s+\d+\)/i,
  /^\s*Agente:\s/m,
  /^\s*Run:\s/m,
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

// Cobertura como ESTRUTURA, não como palavra (medição dos moldes de 24/09/2026,
// G17). O termo-cabeça solto em qualquer ponto do texto media o acaso: no HC da
// medição, "status" passou por uma citação ("permaneceu com status 'minuta'"); na
// reclamação, "matriz" pela "matriz e filial" do CNPJ; e onde a palavra faltava,
// o redator a inseria na prosa para passar. Cada bullet do "Contrato de saída" é
// um elemento da entrega, e a entrega o traz como SEÇÃO: um título, um rótulo em
// negrito no começo da linha (`**Status:** partial`) ou um rótulo simples
// (`Status: ready`). O elemento é nomeado pelos núcleos do bullet (em "riscos,
// lacunas, próximos passos e checkpoint humano", qualquer um dos quatro nomeia a
// seção); o bullet de campo (`status: ready, partial ou blocked`) exige o rótulo
// COM um dos valores. Citação (blockquote) e tabela não são estrutura da peça.
const PALAVRAS_VAZIAS_DA_SECAO = new Set(['para', 'como', 'pelo', 'pela', 'pelos', 'pelas', 'com', 'sem', 'cada', 'toda', 'todo', 'todos', 'todas', 'qualquer', 'sobre', 'entre', 'quando', 'onde', 'uma', 'umas', 'seus', 'suas']);

function nucleoDaSecao(trecho) {
  return normalizar(trecho).split(/[^a-z0-9_]+/).find((p) => (p.length >= 4 || p.includes('_')) && !PALAVRAS_VAZIAS_DA_SECAO.has(p)) || null;
}

/**
 * Seções exigidas pelo `## Contrato de saída`: uma por bullet, `{rotulo, nucleos,
 * valores}`. `valores` só no bullet de campo (`termo: a, b ou c`).
 */
export function extrairSecoesDeSaida(contrato) {
  const bloco = String(contrato || '').match(/^##\s+Contrato de sa[íi]da\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m);
  if (!bloco) return [];
  const secoes = [];
  for (const linha of bloco[1].split('\n')) {
    const item = linha.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (!item) continue;
    const campo = item.match(/^([^:]{2,40}):\s*(.+)$/);
    if (campo) {
      const valores = normalizar(campo[2]).replace(/[`*_"']/g, '').split(/\s*(?:,|\/|\||\bou\b|\bor\b)\s*/).map((v) => v.trim()).filter(Boolean);
      const nucleo = nucleoDaSecao(campo[1]);
      if (nucleo && valores.length && valores.every((v) => /^[a-z0-9_-]{2,20}$/.test(v))) {
        secoes.push({ rotulo: item, nucleos: [nucleo], valores });
        continue;
      }
    }
    const nucleos = [...new Set(item.split(/\s*,\s*|\s+e\s+|\s+ou\s+|\s+como\s+|;\s*/).map(nucleoDaSecao).filter(Boolean))];
    if (nucleos.length) secoes.push({ rotulo: item, nucleos, valores: null });
  }
  return secoes;
}

/**
 * As linhas que dão ESTRUTURA à peça, normalizadas: título; rótulo em negrito no
 * começo da linha (com o valor, quando o rótulo termina em dois-pontos); rótulo
 * simples de até quatro palavras seguido de dois-pontos. Corpo, citação e tabela
 * ficam de fora.
 */
function linhasDeEstrutura(texto) {
  const linhas = [];
  const todas = String(texto || '').split('\n');
  for (const [i, bruta] of todas.entries()) {
    if (/^\s*>/.test(bruta) || /^\s*\|/.test(bruta)) continue;
    const titulo = bruta.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (titulo) {
      // Título sem valor na linha leva o começo da primeira linha de texto depois dele: "### Status"
      // com "partial" embaixo é o campo preenchido. Medido em 26/09/2026 (despejo, motor 0.9.54): a
      // nota ao revisor trazia "### Status" e o valor na linha seguinte, e a cobertura o dava por ausente.
      const seguinte = todas.slice(i + 1).find((l) => l.trim());
      const valor = seguinte && !/^\s{0,3}#{1,6}\s/.test(seguinte) && !/^\s*(?:>|\||<!--)/.test(seguinte) ? seguinte.replace(/^\s*(?:[-*+]\s+)?(?:\*\*|__)?/, '').slice(0, 40) : '';
      linhas.push(normalizar(titulo[1]));
      // Só o campo (`status: ready, partial ou blocked`) lê o valor de baixo: a seção sem valor
      // continua nomeada só pelo título, para a primeira linha do texto não nomear outra seção.
      if (valor) linhas.push(`${CAMPO_EM_DUAS_LINHAS}${normalizar(`${titulo[1]}: ${valor}`)}`);
      continue;
    }
    const negrito = bruta.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)(.+?)(?:\*\*|__)(.{0,40})/);
    if (negrito) {
      const rotulo = negrito[1].trim();
      linhas.push(normalizar(/:$/.test(rotulo) || /^\s*:/.test(negrito[2]) ? `${rotulo} ${negrito[2]}` : rotulo));
      continue;
    }
    const simples = bruta.match(/^\s*(?:[-*+]\s+)?([^\s:|#>*`][^:|\n]{0,40}):\s*(.{0,40})/);
    if (simples && simples[1].trim().split(/\s+/).length <= 4) linhas.push(normalizar(`${simples[1]}: ${simples[2]}`));
  }
  return linhas;
}

function formasDoNucleo(nucleo) {
  const base = nucleo.replace(/s$/, '');
  return [...new Set([nucleo, base, `${base}s`])].filter((f) => f.length >= 3).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const CAMPO_EM_DUAS_LINHAS = '\u0000';
function secaoPresente(secao, estrutura) {
  const nome = new RegExp(`\\b(?:${secao.nucleos.flatMap(formasDoNucleo).join('|')})\\b`);
  if (!secao.valores) return estrutura.some((linha) => !linha.startsWith(CAMPO_EM_DUAS_LINHAS) && nome.test(linha));
  const valores = secao.valores.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const campo = new RegExp(`${nome.source}[^a-z0-9]{0,8}(?:${valores})\\b`);
  return estrutura.some((linha) => campo.test(linha));
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
//
// Onde o documento está depende de onde ele vem (campo `origem` do índice,
// medição dos moldes de 24/09/2026, G17). Documento dos AUTOS está numa folha:
// fls., f., e-fls. ou ID. Documento do CLIENTE (pasta pré-processual, documento
// avulso que acompanha a inicial ou o HC) não tem folha: está no
// Doc. N que a peça junta, e na página dele (`Doc. 03, p. 2`, `p. 2`). Cobrar
// folha dele reprovava a declaração da mãe no HC em todas as versões e levava o
// redator a escrever "Doc. 02, fls. 1" para documento que nunca foi juntado.
// Origem desconhecida (índice sem o campo e sem texto para deduzir) é tratada
// como autos: a régua estrita, a de sempre.
//
// Sem processo (`processo: nenhum` no squad.yaml: contrato, escritura, requerimento
// ao registro), a pasta inteira é do cliente: não há folha, e todo documento vale
// pelo Doc. N e pela página, qualquer que seja a origem que o indexador deduziu.
// No procedimento administrativo (`processo: administrativo`), os autos são do
// órgão e numeram por folha ou por documento: as duas âncoras valem. Medido na
// onda extrajudicial de 25/09/2026: o contrato de locação reprovava por "folha".
const REFERENCIA_DE_FOLHA = /\b(?:e-?fls?\.?|fls?\.|folhas?|f\.)\s*\d+|\bid\s*\d{4,}\b/i;
const REFERENCIA_DE_DOCUMENTO = /\bdocs?\.\s*(?:n[.oº°]\s*)?(?:[a-z]-?)?\d+|\bdocumentos?\s+n[.oº°]\s*\d+|\banexos?\s+(?:n[.oº°]\s*)?\d+|\b(?:p|pp|pag|pags)\.\s*\d+/i;
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

// Palavras do nome do arquivo que não nomeiam o documento: o rótulo de pasta que
// o indexador usa para tipo genérico (`documento`, `doc`, `anexo`) e o que diz da
// cópia, não do conteúdo. Medido em 24/09/2026 (G17): em
// `02-documento-extrato-ctps-digital.md`, a palavra mais longa era "documento", e
// a peça só passava escrevendo "documento" junto da folha. Número e data do nome
// também saem: a peça escreve "holerites", não "fev2025".
const GENERICAS_DO_NOME = new Set(['documento', 'documentos', 'doc', 'docs', 'anexo', 'anexos', 'copia', 'copias', 'arquivo', 'digitalizado', 'digitalizada', 'scan', 'scaneado', 'extraido', 'extraida']);
/** Palavras do nome que identificam o documento, na ordem do nome (no máximo três: o sintagma que o nomeia). */
const PALAVRAS_DO_NOME = 3;
/** As palavras do nome têm de aparecer JUNTAS: da primeira à última, no máximo isto. */
const SINTAGMA_DO_NOME = 60;

function padraoDeMencao(doc) {
  const porTipo = MENCAO_POR_TIPO[semAcento(doc.tipo)];
  if (porTipo) return { re: porTipo, palavras: null };
  // documento/desconhecido e tipos sem vocabulário próprio (ata, auto, declaração,
  // comprovante): pelo nome do arquivo, como sintagma. Todas as palavras que
  // identificam o documento, juntas, não a mais longa solta no parágrafo: a
  // ata `12-ata-audiencia-instrucao-julgamento.md` casava com qualquer
  // "julgamento" num parágrafo que falasse da audiência de instrução (G17).
  const tronco = semAcento(String(doc.arquivo).split('/').pop()).replace(/\.[a-z0-9]+$/, '').replace(/^[\d\s._-]+/, '');
  const palavras = tronco.split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !/\d/.test(t) && !GENERICAS_DO_NOME.has(t))
    .slice(0, PALAVRAS_DO_NOME);
  if (!palavras.length) return null;
  return { re: null, palavras };
}

/** Ocorrências da menção no parágrafo normalizado: `[inicio, fim]` de cada uma. */
function ocorrenciasDaMencao(paragrafo, padrao) {
  const achados = [];
  if (padrao.re) {
    const re = new RegExp(padrao.re.source, padrao.re.flags.includes('g') ? padrao.re.flags : `${padrao.re.flags}g`);
    let m;
    while ((m = re.exec(paragrafo))) {
      achados.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return achados;
  }
  // Sintagma do nome: cada ocorrência da primeira palavra abre uma janela, e as
  // demais têm de estar nela (em qualquer ordem, com preposições entre elas).
  const posicoes = padrao.palavras.map((w) => [...paragrafo.matchAll(new RegExp(`\\b${w}`, 'g'))].map((m) => [m.index, m.index + m[0].length]));
  if (posicoes.some((lista) => !lista.length)) return achados;
  for (const [ini, fim] of posicoes[0]) {
    let a = ini;
    let b = fim;
    // Junto é na mesma frase: "…na audiência de instrução. O julgamento desta
    // apelação…" não nomeia a ata.
    const mesmaFrase = (x, y) => !/[.;!?]\s/.test(paragrafo.slice(Math.min(x, a), Math.max(y, b)));
    const junto = posicoes.slice(1).every((lista) => {
      const perto = lista.find(([x, y]) => Math.max(y, b) - Math.min(x, a) <= SINTAGMA_DO_NOME && mesmaFrase(x, y));
      if (!perto) return false;
      a = Math.min(a, perto[0]);
      b = Math.max(b, perto[1]);
      return true;
    });
    if (junto) achados.push([a, b]);
  }
  return achados;
}

/**
 * A linha da lista de anexos ou de documentos abre com a âncora e descreve o
 * documento depois dela: "Doc. 07, fls. 1: Companhia X, edital do Pregão…". A
 * âncora vale para a linha inteira, por longe que a descrição vá.
 */
function linhaAbertaPelaReferencia(paragrafo, posicao, referencia) {
  const ini = paragrafo.lastIndexOf('\n', posicao - 1) + 1;
  const cabeca = paragrafo.slice(ini, posicao).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?[*_]*/, '');
  const rotulo = cabeca.match(/^([^:;]{0,40})[:;]/);
  // Só o item que o rótulo abre: depois de um ponto final, a frase é outra.
  return Boolean(rotulo && referencia.test(rotulo[1]) && !/[.!?]\s/.test(cabeca.slice(rotulo[0].length)));
}

/**
 * Linha de tabela é um registro: a âncora vale para a linha inteira, esteja na
 * célula que for ("| Exoneração do fiador | Doc. 05, fl. 1 | COMPROVADO |"), e a
 * coluna cujo cabeçalho é a âncora (`| Doc. |`, `| Fls. |`) ancora a célula da
 * linha: "| R-07 | Relatório do canal de ética |" sob "| Doc. | Descrição |".
 */
function linhaDeTabelaAncorada(paragrafo, posicao, referencia) {
  const linhas = paragrafo.split('\n');
  let resto = posicao;
  let i = 0;
  while (i < linhas.length - 1 && resto > linhas[i].length) { resto -= linhas[i].length + 1; i += 1; }
  const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (!/^\s*\|/.test(linhas[i])) return false;
  if (referencia.test(linhas[i])) return true;
  let cabeca = i;
  while (cabeca > 0 && /^\s*\|/.test(linhas[cabeca - 1])) cabeca -= 1;
  if (cabeca === i) return false;
  const titulos = celulas(linhas[cabeca]);
  return celulas(linhas[i]).some((c, k) => titulos[k] && referencia.test(`${titulos[k]} ${c}`));
}

/**
 * O que está entre aspas na linha é transcrição (súmula, lei, depoimento), como o
 * blockquote: fala do fato, não do documento. Medido em 24/09/2026 (G17): a
 * Súmula 656 do STJ, citada entre aspas no despejo ("A exoneração do fiador
 * depende da notificação…"), casava com o nome da notificação de exoneração do
 * fiador. Troca-se por espaços do mesmo tamanho, para as posições não mudarem.
 */
function semTrechoEntreAspas(texto) {
  return texto.replace(/"[^"\n]{1,600}"|“[^”\n]{1,600}”/g, (m) => ' '.repeat(m.length));
}

/** Numa cópia normalizada do parágrafo: há menção? e alguma menção tem a referência na janela? */
function mencaoComFolha(paragrafo, padrao, referencia) {
  const achados = ocorrenciasDaMencao(semTrechoEntreAspas(paragrafo), padrao);
  for (const [ini, fim] of achados) {
    const janela = paragrafo.slice(Math.max(0, ini - JANELA_ANTES), Math.min(paragrafo.length, fim + JANELA_DEPOIS));
    if (referencia.test(janela) || linhaAbertaPelaReferencia(paragrafo, ini, referencia) || linhaDeTabelaAncorada(paragrafo, ini, referencia)) {
      return { mencao: true, folha: true };
    }
  }
  return { mencao: achados.length > 0, folha: false };
}

/** O documento é lido como do cliente (Doc. N ou página) pela origem, ou por não haver processo. */
const doCliente = (doc, processo) => doc.origem === 'cliente' || processo === 'nenhum';

/** A âncora que vale para o documento: folha para o dos autos, Doc. N ou página para o do cliente. */
function referenciaPara(doc, processo = null) {
  if (!doCliente(doc, processo) && processo !== 'administrativo') return REFERENCIA_DE_FOLHA;
  return { test: (janela) => REFERENCIA_DE_FOLHA.test(janela) || REFERENCIA_DE_DOCUMENTO.test(janela) };
}

/**
 * Avalia o sinal `folhas`. `autos` é a lista de documentos do índice
 * (`{arquivo, tipo, paginas, origem}`); `processo` é o do squad.yaml (`judicial`,
 * `administrativo`, `nenhum`; ausente, judicial). Devolve `{sinal, motivo, semFolha}`.
 */
export function avaliarFolhas(texto, autos = [], { processo = null } = {}) {
  const docs = (Array.isArray(autos) ? autos : []).filter((d) => d && d.arquivo);
  if (!docs.length) {
    return {
      sinal: NAO_AVALIADO,
      motivo: processo === 'nenhum'
        ? 'folhas NÃO AVALIADAS: sem índice dos documentos do cliente (autos/_index.yaml) no squad; sem processo, a peça aponta cada documento pelo Doc. N e pela página, e o gate só confere o que o run indexou (node scripts/indexar-autos.mjs squads/<nome>).'
        : 'folhas NÃO AVALIADAS: sem autos/_index.yaml no squad; a peça não pode citar folhas de autos que o run não indexou (node scripts/indexar-autos.mjs squads/<nome>).',
      semFolha: [],
    };
  }
  const paragrafos = String(texto || '')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n'))
    .filter((p) => p.trim());
  const normalizados = paragrafos.map((p) => semAcento(p));
  const semFolha = [];
  const semFolhaDosAutos = [];
  const semAncoraDoCliente = [];
  let mencionados = 0;
  for (const doc of docs) {
    const padrao = padraoDeMencao(doc);
    if (!padrao) continue;
    const referencia = referenciaPara(doc, processo);
    const resultados = normalizados.map((p) => mencaoComFolha(p, padrao, referencia)).filter((r) => r.mencao);
    if (!resultados.length) continue;
    mencionados += 1;
    if (resultados.some((r) => r.folha)) continue;
    const nome = `${doc.tipo || 'documento'} (${doc.arquivo})`;
    semFolha.push(nome);
    (doCliente(doc, processo) ? semAncoraDoCliente : semFolhaDosAutos).push(nome);
  }
  if (!mencionados) {
    return { sinal: NAO_AVALIADO, motivo: 'folhas NÃO AVALIADAS: a peça não menciona nenhum documento do índice dos autos.', semFolha };
  }
  if (semFolha.length) {
    const partes = [];
    if (semFolhaDosAutos.length) partes.push(`${semFolhaDosAutos.join(', ')}: documento dos autos mencionado sem a folha ou o ID onde está (${processo === 'administrativo' ? 'fls. N, Doc. N ou ID N' : 'fls. N, f. N, e-fls. N ou ID N'})`);
    if (semAncoraDoCliente.length) partes.push(`${semAncoraDoCliente.join(', ')}: documento do cliente (${processo === 'nenhum' ? 'sem processo' : 'fora dos autos'}) mencionado sem dizer onde está (Doc. N, ou Doc. N, p. N)`);
    return {
      sinal: 'reprovado',
      motivo: `folhas REPROVADAS: ${partes.join('; ')}. O índice diz o que existe; a peça diz onde está.`,
      semFolha,
    };
  }
  return { sinal: 'aprovado', motivo: null, semFolha };
}

/**
 * Perfis cujo "Contrato de saída" descreve o material do revisor, não a peça: o
 * `legal-drafting` de `_legalsquad/core/skill-quality-profiles.json` pede status,
 * minuta como rascunho técnico, matriz fato-prova-tese e riscos, lacunas, próximos
 * passos e checkpoint humano. Os outros perfis (análise, parecer, cálculo) pedem o
 * próprio conteúdo da entrega, que conta onde estiver.
 */
const PERFIS_DA_NOTA_AO_REVISOR = new Set(['legal-drafting']);

/** O perfil que o arquivo de contrato declara (`Perfil: \`legal-drafting\``), ou null. */
function perfilDoContrato(texto) {
  return String(texto || '').match(/^Perfil:\s*`?([\w-]+)`?\s*$/m)?.[1] || null;
}

export function avaliarRedacao({ artefato, entrada, contratos = [], vicios = VICIOS_DE_REDACAO, autos = [], reader = 'juiz', final = false, processo = null }) {
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
  // O contrato vem como texto ou como `{ texto, origem }` (o hook passa o caminho
  // do `references/high-performance-contract.md` de cada skill): a mensagem diz de
  // onde veio cada exigência. Medido em 25/09/2026, alimentos/reclamação: o gate
  // dizia "exigido pelo contrato de saída da skill", o SKILL.md não tem essa seção
  // (ela mora no arquivo de referência que o SKILL.md linka) e a origem ficou a
  // descobrir. A seção do perfil `legal-drafting` é material do revisor: conta só
  // dentro da nota ao revisor (bloco `nota-ao-revisor`), que o empacotador tira da peça.
  const secoes = [];
  for (const c of contratos) {
    const textoDoContrato = typeof c === 'string' ? c : String((c && c.texto) || '');
    const origem = c && typeof c === 'object' && c.origem ? String(c.origem) : null;
    const daNota = PERFIS_DA_NOTA_AO_REVISOR.has(perfilDoContrato(textoDoContrato));
    for (const secao of extrairSecoesDeSaida(textoDoContrato)) {
      const igual = secoes.find((s) => normalizar(s.rotulo) === normalizar(secao.rotulo));
      if (igual) {
        if (origem && !igual.origens.includes(origem)) igual.origens.push(origem);
        igual.daNota = igual.daNota || daNota;
        continue;
      }
      secoes.push({ ...secao, origens: origem ? [origem] : [], daNota });
    }
  }
  const origens = [...new Set(secoes.flatMap((s) => s.origens))];
  const deOnde = origens.length ? `"## Contrato de saída" de ${origens.join(', ')}` : 'contrato de saída da skill';
  if (final) {
    // O "Contrato de saída" da skill descreve a MINUTA (status, rascunho
    // técnico, matriz fato-prova-tese, riscos e checkpoint humano): material
    // para quem revisa, não para o juízo. O conferente remove tudo isso ao
    // fechar a versão final (`citation_gate: final`), por desenho, e a peça
    // limpa reprovava aqui exatamente por estar limpa (medido em 15/09/2026).
    // A cobertura foi medida na minuta, no step de redação; na final não há o
    // que medir, e `nao-avaliado` nunca aprova nem reprova sozinho.
    sinais.cobertura = NAO_AVALIADO;
    problemas.push('cobertura NÃO AVALIADA: artefato final (citation_gate: final, ou <peça>-final.md com o manifesto ao lado); o contrato de saída da skill descreve a minuta e foi medido nela.');
  } else if (secoes.length === 0) {
    // Área não instalada, ou skill sem contrato v5. Desliga esta dimensão, não o
    // gate inteiro — degradação por dimensão, como o runner faz.
    sinais.cobertura = NAO_AVALIADO;
    problemas.push('cobertura NÃO AVALIADA: nenhum "Contrato de saída" encontrado nas skills declaradas.');
  } else {
    const nota = separarNotaAoRevisor(texto);
    if (nota.erro) {
      sinais.cobertura = 'reprovado';
      problemas.push(`cobertura REPROVADA: ${nota.erro}. A nota ao revisor abre com ${NOTA_AO_REVISOR_INICIO} e fecha com ${NOTA_AO_REVISOR_FIM}, cada um sozinho na linha.`);
    } else {
      const estrutura = linhasDeEstrutura(texto);
      const naNota = linhasDeEstrutura(nota.nota);
      const naPeca = linhasDeEstrutura(nota.peca);
      const ausentes = [];
      const foraDaNota = [];
      for (const s of secoes) {
        if (!s.daNota) { if (!secaoPresente(s, estrutura)) ausentes.push(s); continue; }
        if (secaoPresente(s, naNota)) continue;
        (secaoPresente(s, naPeca) ? foraDaNota : ausentes).push(s);
      }
      const rotulos = (lista) => lista.map((s) => `"${s.rotulo}"`).join(', ');
      const partes = [];
      if (ausentes.length) partes.push(`a minuta não traz como seção ${rotulos(ausentes)}, exigido pelo ${deOnde}.`);
      if (foraDaNota.length) partes.push(`${rotulos(foraDaNota)} está na peça, fora da nota ao revisor: é material de revisão (perfil legal-drafting) e só sai da peça protocolada dentro dela.`);
      if (partes.length) {
        sinais.cobertura = 'reprovado';
        problemas.push(
          `cobertura REPROVADA: ${partes.join(' ')} `
          + `Cada elemento entra como título, rótulo em negrito (**Status:** partial) ou rótulo simples (Status: ready); a palavra solta no corpo não conta. O material do revisor vai no fim da minuta, entre ${NOTA_AO_REVISOR_INICIO} e ${NOTA_AO_REVISOR_FIM}.`
        );
      } else {
        sinais.cobertura = 'aprovado';
      }
    }
  }

  // ── 3. Andaime vazado ───────────────────────────────────────────────────
  const corpo = texto.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const vazamentos = ANDAIME.map((padrao) => corpo.match(padrao)).filter(Boolean);
  if (vazamentos.length) {
    sinais.andaime = 'reprovado';
    // O trecho nomeado é a linha onde o padrão casou, para quem libera saber o que liberar.
    const trechoDoVazamento = (m) => {
      const inicio = m.index + (m[0].length - m[0].trimStart().length);
      return JSON.stringify(corpo.slice(inicio).split('\n')[0].trim().slice(0, 60));
    };
    problemas.push(`andaime REPROVADO: template do pipeline vazou para a entrega (${vazamentos.length} padrão/ões: ${vazamentos.map(trechoDoVazamento).join(', ')}).`);
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
        `travessão REPROVADO: ${travessoes} travessão(ões) na prosa redigida, marca de texto de IA. `
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
        `vícios REPROVADO: ${total} marcas de redação genérica fora de citação: ${achados.join('; ')}. `
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
  // pelo verifica-contrato; conteúdo de autoridade (`reader: publico`) abre
  // com gancho. O sinal `frente` não se aplica a nenhum dos dois: NÃO AVALIADO.
  const leitor = String(reader || '').toLowerCase();
  if (leitor === 'contraparte' || leitor === 'publico') {
    for (let i = problemas.length - 1; i >= 0; i--) if (/^frente /i.test(problemas[i])) problemas.splice(i, 1);
    sinais.frente = NAO_AVALIADO;
    problemas.push(leitor === 'contraparte'
      ? 'frente NÃO AVALIADA: contrato (reader: contraparte); o quadro-resumo é cobrado pelo verifica-contrato, não pela síntese de peça.'
      : 'frente NÃO AVALIADA: conteúdo de autoridade (reader: publico) abre com gancho, não com síntese de peça; o gancho é cobrado pelo revisor.');
  }

  // ── 6. Folhas ────────────────────────────────────────────────────────────
  const folhas = avaliarFolhas(texto, autos, { processo });
  sinais.folhas = folhas.sinal;
  if (folhas.motivo) problemas.push(folhas.motivo);

  return {
    ok: !Object.values(sinais).includes('reprovado'),
    problemas,
    sinais,
  };
}
// <<< redacao-gate:end
