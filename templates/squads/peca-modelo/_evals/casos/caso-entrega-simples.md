# Caso-ouro — entrega simples

**Fictício.** Nenhum dado real de cliente. Serve para rodar o `demo-squad` de
ponta a ponta e medir o output contra os `success_criteria` do `squad.yaml`.

## Input

> Preciso de uma entrega demo do tipo alfa. Objetivo: exercitar o fluxo completo.
> Fase: inicial. Documento de referência: `doc-demo-001`.

## O que um bom output deve conter

Derivado dos `success_criteria` do `squad.yaml` — a rubrica é fonte única:

1. **Objetivo e fase declarados** antes de qualquer passo avançar — o output
   abre reafirmando "objetivo: entrega demo alfa; fase: inicial".
2. **As duas revisões paralelas (A e B) emitem veredito independente** — os dois
   blocos `verdict:` aparecem no output, cada um com sua justificativa própria;
   vereditos idênticos sem justificativa distinta indicam colapso do paralelismo.
3. **Nenhum REJECT pendente** — se houve REJECT, o output final reflete os
   `fixes` aplicados, não o rascunho original.

## Sinais de falha

- Output que salta a declaração de objetivo/fase (critério 1 em NÃO ATENDE).
- Revisão B repetindo literalmente a revisão A (paralelismo aparente).
- `[NÃO VERIFICADO]` remanescente em qualquer citação do corpo.
