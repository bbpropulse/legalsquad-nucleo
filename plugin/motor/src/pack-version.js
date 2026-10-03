// Versão de pacote — calendário `AAAA.MM.SEQ` (SPEC §6.1).
//
// Módulo puro porque a comparação é a única coisa que separa "republiquei a
// correção" de "achei que tinha republicado". O servidor guarda por versão e
// serve a maior como `latest`: um pacote publicado com número menor sobe,
// responde 200, e continua invisível — o curador vê sucesso e o usuário
// continua baixando o conteúdo antigo.
//
// Aconteceu de verdade nesta base: um build sem `--version` saiu como
// `2026.08.1` quando a produção estava em `2026.08.11`. Os 14 pacotes subiram,
// o publish disse "publicado", e a `latest` não se moveu.

/** `AAAA.MM.SEQ` — três componentes numéricos, nada de `v`, nada de sufixo. */
const FORMATO = /^(\d{4})\.(\d{1,2})\.(\d+)$/;

function componentes(versao, papel) {
  const casa = typeof versao === 'string' ? versao.trim().match(FORMATO) : null;
  if (!casa) {
    throw new Error(
      `pack-version: versão ${papel} ilegível: ${JSON.stringify(versao)} — ` +
        'esperado calendário AAAA.MM.SEQ (ex.: 2026.08.14). "Não sei ler" não vira "pode publicar".'
    );
  }
  return [Number(casa[1]), Number(casa[2]), Number(casa[3])];
}

/**
 * Ordem entre duas versões: negativo se `a < b`, zero se iguais, positivo se
 * `a > b`. NUMÉRICO por componente — comparar como texto poria `2026.08.10`
 * antes de `2026.08.9`, que é o mesmo defeito do `v10 > v9`.
 */
export function compararVersao(a, b) {
  const va = componentes(a, 'candidata');
  const vb = componentes(b, 'comparada');
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/**
 * A candidata supera o que já está publicado?
 *
 * Ausência de `publicada` significa pack novo — qualquer versão válida avança.
 * Igual NÃO avança: reempacotar com o mesmo número depois de corrigir conteúdo
 * é o engano comum, e aceitá-lo em silêncio deixa o curador convicto de ter
 * publicado uma correção que ninguém vai receber.
 */
export function versaoAvanca(candidata, publicada) {
  if (publicada === null || publicada === undefined || publicada === '') {
    componentes(candidata, 'candidata'); // valida mesmo sem ter com quem comparar
    return true;
  }
  return compararVersao(candidata, publicada) > 0;
}
