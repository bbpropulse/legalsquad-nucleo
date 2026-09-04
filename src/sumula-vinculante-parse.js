// Fatia a página individual de uma Súmula Vinculante do STF.
//
// **Por que é um módulo separado de `sumula-parse.js`.** Súmula Vinculante e
// súmula ordinária do STF são SÉRIES NUMÉRICAS DISTINTAS — a SV 10 (reserva
// de plenário) não tem relação nenhuma com a Súmula 10 ordinária (tempo de
// serviço militar). Medido em campo: o coletor de súmulas ordinárias baixou
// uma compilação "1 a 736" e um subagente citou `stf-sumula-10.md` como se
// fosse a SV 10 — o BRIEFING chegou a afirmar isso por engano. O portal do
// STF também serve as duas por fontes diferentes: a ordinária vem de uma
// compilação única em PDF; a vinculante vem de uma página HTML por súmula,
// com estrutura própria (Enunciado, Precedente Representativo, Teses de
// Repercussão Geral) que não bate com o formato "Enunciado / Órgão Julgador /
// Data" da compilação do STJ/STF ordinário.
//
// **Por que o número não vem do título.** O link de cada página usa um ID
// interno sequencial do sistema do STF (`sumula=1216`), que não é o número da
// súmula — SV 1 é `sumula=1185`, SV 10 é `sumula=1216`, sem relação
// aritmética simples. E o próprio título às vezes carrega caractere invisível
// (viu-se um zero-width space dentro de "cancelada"). O número confiável é a
// POSIÇÃO no índice ordenado da listagem oficial — por isso a função recebe o
// número como parâmetro em vez de extraí-lo do texto.

const SECAO_PRECEDENTE = /^Precedente Representativo$/m;
const SECAO_TESES = /^Teses de Reperc[uú]ss[ãa]o Geral$/m;
const MARCADOR_CANCELADA = /cance.?lada/i;

function corta(texto, inicio, regexFim) {
  const resto = texto.slice(inicio);
  const m = resto.match(regexFim);
  return (m ? resto.slice(0, m.index) : resto).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {string} textoDaPagina página individual, já em texto puro (saída de `htmlParaTexto`)
 * @param {{numeroPorPosicao: number|string}} opcoes número da SV pela posição no índice — ver nota acima
 * @returns {{numero: string, enunciado: string, cancelada: boolean, precedente: string, teses: string}}
 * @throws quando a página não traz enunciado — ver o comentário do topo de `sumula-parse.js`: enunciado
 *   ausente é erro nomeado, nunca silêncio.
 */
export function fatiarSumulaVinculante(textoDaPagina, opcoes = {}) {
  const numero = String(opcoes.numeroPorPosicao ?? '').trim();
  if (!numero) throw new Error('fatiarSumulaVinculante: numeroPorPosicao é obrigatório');

  const texto = String(textoDaPagina || '');
  const tituloMatch = texto.match(/^S[úu]mula\s+Vinculante\s+\d+[^\n]*$/m);
  if (!tituloMatch) throw new Error(`Súmula Vinculante ${numero}: título não encontrado — a página mudou de formato`);

  const cancelada = MARCADOR_CANCELADA.test(tituloMatch[0]);
  const inicioCorpo = tituloMatch.index + tituloMatch[0].length;

  const fimEnunciado = texto.slice(inicioCorpo).search(SECAO_PRECEDENTE);
  const enunciado = (fimEnunciado < 0 ? texto.slice(inicioCorpo) : texto.slice(inicioCorpo, inicioCorpo + fimEnunciado))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!enunciado) throw new Error(`Súmula Vinculante ${numero}: bloco sem enunciado — a página mudou de formato`);

  let precedente = '';
  const precedenteMatch = texto.match(SECAO_PRECEDENTE);
  if (precedenteMatch) {
    precedente = corta(texto, precedenteMatch.index + precedenteMatch[0].length, SECAO_TESES);
  }

  let teses = '';
  const tesesMatch = texto.match(SECAO_TESES);
  if (tesesMatch) {
    teses = texto.slice(tesesMatch.index + tesesMatch[0].length).replace(/\n{3,}/g, '\n\n').trim();
  }

  return { numero, enunciado, cancelada, precedente, teses };
}
