// A nota ao revisor: o material que o "Contrato de saída" da skill de peça pede
// (status, minuta como rascunho técnico, matriz fato-prova-tese, riscos, lacunas,
// próximos passos e checkpoint humano) é trabalho para quem revisa, não texto da
// peça. Ele vive na minuta, no fim, entre duas linhas de comentário:
//
//   <!-- nota-ao-revisor:inicio -->
//   ## Nota técnica ao revisor
//   **Status:** partial ...
//   <!-- nota-ao-revisor:fim -->
//
// Medido em 25/09/2026, alimentos/reclamação (motor 0.9.53): o Redação Gate
// cobrava essas seções na minuta, o runner proíbe a conferente de editar texto
// ao promover a final, e a "Nota técnica ao advogado revisor" saiu no .docx e no
// .pdf do pacote de protocolo. Com o bloco marcado, o gate conta a cobertura só
// dentro dele, a final continua sendo a minuta sem caneta, e o empacotador tira o
// bloco da peça e o entrega à parte (`NOTA-AO-REVISOR.md`). Quem retira é o
// código, nunca a conferente.
//
// Módulo PURO (só texto e regex). SINCRONIA: o bloco entre os marcadores é
// copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o hook de redação (raiz,
// .codex e templates), que o usa na cobertura, e para o empacotador (raiz e
// templates). Nenhum import.

// >>> nota-ao-revisor:begin
/** As duas linhas que delimitam a nota ao revisor, sozinhas na linha. */
export const NOTA_AO_REVISOR_INICIO = '<!-- nota-ao-revisor:inicio -->';
export const NOTA_AO_REVISOR_FIM = '<!-- nota-ao-revisor:fim -->';
const RE_NOTA_AO_REVISOR = /^[ \t]*<!--\s*nota-ao-revisor:(inicio|fim)\s*-->[ \t]*$/;

/**
 * Separa a peça da nota ao revisor. Devolve `{ peca, nota, blocos, erro }`: `peca`
 * é o texto sem os blocos (e sem as linhas de marcador), `nota` é o miolo dos
 * blocos, `blocos` quantos havia. Marcador fora de ordem (fim sem início, início
 * dentro de outro, início sem fim) é `erro`, e aí nada se separa: `peca` volta
 * como veio e `nota` vazia, para ninguém tirar da peça metade do que devia.
 */
export function separarNotaAoRevisor(texto) {
  const linhas = String(texto ?? '').split('\n');
  const peca = [];
  const nota = [];
  let aberto = -1;
  let blocos = 0;
  for (const [i, linha] of linhas.entries()) {
    const m = linha.replace(/\r$/, '').match(RE_NOTA_AO_REVISOR);
    if (!m) { (aberto >= 0 ? nota : peca).push(linha); continue; }
    if (m[1] === 'inicio') {
      if (aberto >= 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor aberta na linha ${i + 1} dentro de outra (aberta na linha ${aberto + 1})` };
      aberto = i;
      continue;
    }
    if (aberto < 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor fechada na linha ${i + 1} sem ter sido aberta` };
    aberto = -1;
    blocos += 1;
  }
  if (aberto >= 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor aberta na linha ${aberto + 1} e nunca fechada (${NOTA_AO_REVISOR_FIM})` };
  return { peca: peca.join('\n'), nota: nota.join('\n').trim(), blocos, erro: null };
}
// <<< nota-ao-revisor:end
