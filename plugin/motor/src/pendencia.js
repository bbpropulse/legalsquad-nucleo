// Marcador de pendência: o que o redator deixa no texto quando algo tem de ser
// conferido antes de protocolar (`[NÃO VERIFICADO]`, `[CONFERIR: a portaria]`,
// `[CONFIRMAR COM A AUTORA]`). O gate final bloqueia a gravação da peça com um
// marcador desses; a métrica do run e o termo de conferência os contam.
//
// Era uma regex copiada à mão em três lugares, e as cópias divergiram: o hook
// não conhecia `CONFIRMAR`, então a final saía "final" com `[CONFIRMAR COM A
// AUTORA]` dentro e o pacote a listava como pendência (revisão de 20/09/2026).
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo
// `scripts/sync-blocos.mjs` para `scripts/run-metricas.mjs`, para
// `scripts/squad-state.mjs` (o `manifesto-final` lê os marcadores de dado da peça)
// e para o hook `verifica-citacoes.mjs` (raiz e templates); os testes prendem a igualdade.

// >>> pendencia:begin
/**
 * Regras da gramática: a palavra-chave em CAIXA ALTA (é assim que o runner, as
 * skills e o ensaio a escrevem), com carga opcional depois de dois-pontos,
 * travessão, hífen ou espaço (`[CONFERIR: a vara]`, `[CONFIRMAR COM A AUTORA]`).
 * Caixa alta é o que separa o marcador de um link Markdown (`[Conferir o
 * inteiro teor](url)`) e de um termo técnico entre colchetes (`[hipótese de
 * incidência]`): com a flag `i`, os dois bloqueavam a gravação da final.
 * Colchete seguido de `(` é link, nunca marcador.
 */
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O|PREENCHER|A[ _]PREENCHER|DILIG[ÊE]NCIA)(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
/**
 * Marcador de DADO (o fato que depende do profissional ou do cliente), separado do
 * de citação na medição dos moldes de 24/09/2026 (G11). O de citação trava a final
 * sempre; o de dado passa se o manifesto o lista em `pendencias_do_profissional[]`,
 * e a parada aprovação o mostra. Testado sobre um marcador já casado por PENDING_MARKER.
 */
const DATA_MARKER = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:—–-]|\])/;
/** Tema sem âncora apontado pelo verificador de persuasão: contado à parte (não trava hoje). */
const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
// <<< pendencia:end

export { DATA_MARKER, PENDING_MARKER, TEMA_MARKER };
