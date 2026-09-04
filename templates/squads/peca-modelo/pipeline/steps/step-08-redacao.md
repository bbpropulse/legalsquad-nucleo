---
step: "08"
name: "Redação"
type: agent
agent: redator-modelo
execution: inline
description: Rui Redação redige a peça sintética: síntese primeiro, todo argumento com fundamento da pesquisa, documentos dos autos com folha, estilo do escritório e lição do juízo lidos da memória do chefe.
inputFile: squads/peca-modelo/output/pesquisa-juridica.md
outputFile: squads/peca-modelo/output/peca-modelo.md
---

# 🤖 Agente: Redação

## Para o Pipeline Runner

Rui Redação redige a peça sintética: síntese primeiro, todo argumento com fundamento da pesquisa, documentos dos autos com folha, estilo do escritório e lição do juízo lidos da memória do chefe.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

`output/pesquisa-juridica.md` (a única fonte de citação autorizada), `output/foco.md` e a memória do escritório (`npx legalsquad memoria --tipo preferencia` e `--tipo licao`).

## Instructions

### Process

1. Ler `npx legalsquad memoria --tipo preferencia` e `--tipo licao` e nomear o que aplicou.
2. Acionar `redator-modelo` (inline): síntese primeiro (pedido, teses, Temas, linha de ataque), depois o corpo; nada citado de memória; folhas dos autos.
3. Gravar no artefato declarado. Em re-execução por on_reject, aplicar só os fixes.

## Output Format

Grava em `squads/peca-modelo/output/peca-modelo.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
## SÍNTESE
1. **Pede-se** …
2. **Tese 1 — …** Governa: …

---

## I. DOS FATOS
…
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Citar lei, súmula ou precedente que não conste de `output/pesquisa-juridica.md`.
2. Deixar `[NÃO VERIFICADO]` ou `[DIVERGENTE]` sobreviver no corpo da peça.
3. Desenvolver tese que o checkpoint `diagnostico` não aprovou, ou omitir tese aprovada.
4. Em re-execução por `on_reject`, reescrever além dos `fixes`.

## Quality Criteria

- A síntese abre a peça, em até dez linhas e dentro dos primeiros 20% do texto.
- Toda afirmação de fato aponta documento e folha.
- Cada tese nomeia o Tema, súmula ou repetitivo que a governa.
