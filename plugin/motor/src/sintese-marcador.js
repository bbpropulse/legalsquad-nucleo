// O marcador de síntese: a linha que abre o bloco de síntese da peça (PERSUASAO.md §3). Quem o lê
// são dois: o Redação Gate, no sinal 5 (frente: a síntese nos primeiros 20% da peça), e o
// `squad-state persuasao-carimbo`, que guarda o hash da síntese que o gate 4.6 aprovou para o
// `manifesto-final` comparar com a da final. Medido em 27/09/2026 (réplica, motor 0.9.61, M2): a
// síntese abria em negrito ("**Síntese da réplica.** A autora pede..."), o Redação Gate a aceitava
// e o carimbo, que só reconhecia título `#`, gravou `sintese_sha256: null`: a síntese ficou fora da
// comparação. Um reconhecimento só, nos dois.
//
// Módulo PURO (só texto e regex). SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo
// `scripts/sync-blocos.mjs` para o hook de redação (raiz, .codex e templates), ao lado do bloco
// `redacao-gate`, e para o `squad-state` (raiz e templates). Nenhum import.

// >>> sintese-marcador:begin
/**
 * As palavras que abrem um bloco de síntese, como a peça as escreve. É daqui que o gate monta o
 * reconhecimento e que o contrato de redação (`src/contrato-redacao.js`) diz ao redator o que é
 * aceito: uma lista só, para o squad não ensinar "## O essencial" e o gate recusar (achados M2b 3 e
 * M4 do plano motor leve, outubro de 2026).
 */
const PALAVRAS_DE_SINTESE = Object.freeze(['Síntese', 'Em síntese', 'Resumo', 'Sumário', 'Tese', 'Teses']);
/**
 * Texto (já normalizado: sem acento, minúsculo) que abre um bloco de síntese.
 * Casa por palavra inteira, não por prefixo solto: `tese` não é `tesouraria`.
 */
const MARCADOR_DE_SINTESE = new RegExp(`^(?:${PALAVRAS_DE_SINTESE
  .map((p) => p.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).join('\\s+'))
  .sort((x, y) => y.length - x.length)
  .join('|')})\\b`);

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
 * linha redigida: quem chama já tirou o blockquote, porque `> ## Síntese`
 * transcrito de um acórdão não é a síntese da peça. Devolve `false`, `'heading'`
 * ou `'negrito'` (o carimbo precisa saber onde a seção acaba).
 */
export function ehMarcadorDeSintese(linha) {
  const heading = linha.match(/^\s*#{1,3}\s+(.+?)\s*$/);
  const negrito = heading ? null : linha.match(/^\s*\*\*(.+?)\*\*/);
  const bruto = heading?.[1] ?? negrito?.[1];
  if (!bruto) return false;
  const texto = String(bruto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .trim()
    .replace(/\s+#+\s*$/, '') // fecho opcional do heading ATX: `## Síntese ##`
    .replace(/^[*_]+/, '') // `## **Síntese**`
    .replace(PREFIXO_DE_HEADING, '')
    .replace(PREPOSICAO_DE_HEADING, '');
  return MARCADOR_DE_SINTESE.test(texto) ? (heading ? 'heading' : 'negrito') : false;
}
// <<< sintese-marcador:end

export { PALAVRAS_DE_SINTESE, MARCADOR_DE_SINTESE };
