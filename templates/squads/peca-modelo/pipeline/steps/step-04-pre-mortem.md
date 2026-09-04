---
step: "04"
name: "Pré-mortem"
type: agent
agent: adversario-modelo
execution: subagent
description: Ada Adversária despacha o contraditor em modo pré-mortem: os três ataques que a parte contrária faria às teses candidatas, com estado A RESPONDER.
inputFile: squads/peca-modelo/autos/_index.yaml
outputFile: squads/peca-modelo/output/diagnostico/pre-mortem.md
---

# 🤖 Agente: Pré-mortem

## Para o Pipeline Runner

Ada Adversária despacha o contraditor em modo pré-mortem: os três ataques que a parte contrária faria às teses candidatas, com estado A RESPONDER.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

`output/intake.md` e as teses candidatas. NÃO recebe a minuta: este é o pré-mortem, feito antes de haver texto.

## Instructions

### Process

1. Acionar `adversario-modelo` (subagente), que despacha o `contraditor` pelo nome, em contexto fresco, com as teses candidatas do intake e o índice dos autos — nunca como fork.
2. Registrar a tabela dos três ataques (fato, direito, forma) como veio, sem editar.
3. Avançar (fan-in no step-06).

## Output Format

Grava em `squads/peca-modelo/output/diagnostico/pre-mortem.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Pré-mortem

| # | Natureza | Ataque | Estado |
|---|---|---|---|
| 1 | FATO | Falta comprovante | A RESPONDER |
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Corrigir a peça: o adversário gera ataques, não conserta.
2. Inventar fato fora dos autos para fabricar um ataque.

## Quality Criteria

- Três ataques, um de fato, um de direito, um de forma.
- Cada ataque de fato aponta a folha.
