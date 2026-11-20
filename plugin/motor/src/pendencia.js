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

export { DATA_MARKER, PENDING_MARKER, TEMA_MARKER, LINHA_DA_NOTA_AO_REVISOR, ocorrenciasDePendencia };
