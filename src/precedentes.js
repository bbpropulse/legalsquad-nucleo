// Monta a seção de precedentes de uma skill a partir do acervo de informativos.
//
// ## O que este módulo trata como verdade, e o que não
//
// O acervo de jurisprudência são downloads oficiais dos informativos de STJ,
// STF, TSE e TST — proveniência legítima, com `fonte_url` e o PDF de origem
// registrados. Mas informativo é **resumo editorial do tribunal**, não o
// acórdão: todo arquivo do acervo carrega, do próprio publicador, a ressalva
// "não substitui a conferência do acórdão oficial", e a confiança é
// `DISCOVERY_ONLY` em 100% dos 55.825 documentos.
//
// Daí o desenho: o que este módulo entrega com confiança é a **identificação**
// do precedente — número do processo, relator, órgão julgador, data. Isso é
// dado de catálogo, é exato, e é justamente o que o agente mais erra ao citar
// de memória. A **tese** vem junto, mas marcada `[NÃO VERIFICADO]`, porque é
// resumo e não holding conferida.
//
// Um agente que recebe "REsp 1.860.018-RJ, Rel. Min. Mauro Campbell Marques,
// Primeira Seção, 23/06/2021" tem o que buscar no acórdão oficial. Um agente
// que recebe "há precedente do STJ nesse sentido" não tem nada — e é aí que
// ele inventa o número.
//
// ## Heterogeneidade do corpus, medida
//
// STJ moderno usa campos nomeados (`PROCESSO` / `RAMO DO DIREITO` / `TEMA`) —
// 5.254 documentos. STF, TSE e TST usam texto corrido, legível mas sem campos.
// Informativos antigos do TSE (PDF de duas colunas) vêm com as colunas
// intercaladas e são ilegíveis. Por isso a tese sai do campo `TEMA` quando
// existe e do TÍTULO quando não — o título vem do metadado, que é limpo nos
// dois casos, em vez do corpo, que só é confiável num deles.

const MAXIMO_DE_PRECEDENTES = 5;

// Mesma string que abre o bloco em `montarPrecedentes` — exportada para que
// `contemPrecedentesIdentificados` detecte pelo texto real gerado, nunca por
// uma cópia que pode divergir em silêncio.
export const MARCADOR_PRECEDENTES = '## Precedentes a conferir';

/**
 * A skill traz precedente REALMENTE identificado?
 *
 * Terceira porta de substância, ao lado de `linhas_proprias` e
 * `base_legal_verificada`. Necessária pelo mesmo motivo das outras duas:
 * skills irmãs do mesmo tema citam o MESMO julgado (legitimamente), então
 * nenhuma linha conta como "própria" e 4.517 skills com precedente real
 * apareciam como título oco — trabalho feito e invisível para o Arquiteto.
 *
 * Exige o marcador, a linha de **Identificação** e a de **Fonte**: um heading
 * solto dizendo "há julgados sobre o tema" não identifica nada e continua
 * sendo lacuna.
 */
export function contemPrecedentesIdentificados(texto) {
  const conteudo = String(texto || '');
  if (!conteudo.includes(MARCADOR_PRECEDENTES)) return false;
  const apos = conteudo.slice(conteudo.indexOf(MARCADOR_PRECEDENTES));
  return /^- \*\*Identificação:\*\*\s+\S/m.test(apos) && /^- \*\*Fonte:\*\*\s+`https?:\/\//m.test(apos);
}

function campoDoFrontmatter(raw, nome) {
  const m = String(raw).match(new RegExp(`^${nome}:\\s*"?(.*?)"?\\s*$`, 'm'));
  const valor = (m?.[1] || '').trim();
  return valor && valor !== 'null' ? valor : '';
}

function corpoDoInformativo(raw) {
  return String(raw).split('## Conteúdo do informativo')[1]?.split('## Proveniência')[0]?.trim() || '';
}

/**
 * Tese a partir do campo `TEMA` do informativo estruturado do STJ. Para em
 * `DESTAQUE`/`INFORMAÇÕES` (campos seguintes) para não arrastar o inteiro
 * teor do resumo — e nunca começa no `PROCESSO`, que é cabeçalho.
 */
function teseDoCampoTema(corpo) {
  const m = corpo.match(/\bTEMA\b\s+([\s\S]*?)(?=\n\s*(?:DESTAQUE|INFORMAÇÕES|INFORMACOES|LEGISLAÇÃO|LEGISLACAO)\b|$)/);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} raw conteúdo de um `.md` do acervo de jurisprudência
 * @returns {{tribunal, processo, relator, orgao, data, tese, fonte}|null}
 *   `null` quando não há número de processo: sem ele não há o que conferir no
 *   acórdão, e "existe um precedente do STJ" não identificado é pior que
 *   silêncio — convida o agente a preencher o número de cabeça.
 */
export function extrairPrecedente(raw) {
  const processo = campoDoFrontmatter(raw, 'processo');
  if (!processo) return null;

  const corpo = corpoDoInformativo(raw);
  const titulo = (String(raw).match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';
  // Campo TEMA quando o informativo é estruturado; título quando é texto
  // corrido. O título vem do metadado — limpo mesmo quando o corpo veio de
  // um PDF de duas colunas mal extraído.
  const tese = teseDoCampoTema(corpo) || titulo;

  return {
    tribunal: campoDoFrontmatter(raw, 'tribunal'),
    processo,
    relator: campoDoFrontmatter(raw, 'relator'),
    orgao: campoDoFrontmatter(raw, 'orgao_julgador'),
    data: campoDoFrontmatter(raw, 'data_julgamento'),
    tese,
    fonte: campoDoFrontmatter(raw, 'fonte_url'),
  };
}

/**
 * Bloco markdown com os precedentes, ou `''` se não houver nenhum válido.
 */
export function montarPrecedentes(precedentes) {
  const validos = (precedentes || []).filter(Boolean).slice(0, MAXIMO_DE_PRECEDENTES);
  if (!validos.length) return '';

  const linhas = [
    MARCADOR_PRECEDENTES,
    '',
    'Identificação extraída dos **informativos oficiais** dos tribunais, no acervo',
    'local. O número do processo, o relator, o órgão julgador e a data são dados',
    'de catálogo e podem ser usados para localizar o acórdão.',
    '',
    '**A tese abaixo é resumo de informativo e NÃO substitui a conferência do**',
    '**acórdão oficial** — por isso vai marcada `[NÃO VERIFICADO]`. Abra o inteiro',
    'teor antes de fundamentar nela.',
    '',
  ];

  for (const p of validos) {
    const identificacao = [p.processo, p.relator && `Rel. ${p.relator}`, p.orgao, p.data]
      .filter(Boolean)
      .join(', ');
    linhas.push(`### ${p.tribunal} — ${p.processo}`, '');
    linhas.push(`- **Identificação:** ${identificacao}`);
    if (p.tese) linhas.push(`- **Tema (resumo do informativo):** ${p.tese} [NÃO VERIFICADO]`);
    if (p.fonte) linhas.push(`- **Fonte:** \`${p.fonte}\``);
    linhas.push('');
  }

  return linhas.join('\n');
}
