# Caso-ouro — rejeição em cadeia

**Fictício.** Exercita o caminho de exceção do harness: o loop de revisão com
`on_reject`, o feedback-delta e o teto de ciclos.

## Input

> Entrega demo do tipo beta, com um defeito plantado: o rascunho omite a fase.
> Objetivo: verificar se a revisão detecta e se o loop devolve à redação.

## O que um bom output deve conter

1. **Pelo menos uma revisão emite REJECT** com `fixes` específicos (o quê, onde),
   não um "precisa melhorar" genérico.
2. **O loop devolve ao passo de redação** e a re-execução aplica **apenas os
   `fixes`** — o output re-redigido preserva o que já estava aprovado
   ("no loop, cirurgia").
3. **O teto de ciclos é respeitado**: em não-convergência, o pipeline escala ao
   usuário em vez de repetir indefinidamente.

## Sinais de falha

- Reescrita integral do rascunho a cada ciclo (feedback-delta ignorado).
- Loop que ultrapassa `max_review_cycles` sem escalar.
- APPROVE emitido com o defeito plantado ainda presente.
