---
step: "05"
name: "Temas do acervo"
type: agent
agent: leitor-acervo-modelo
execution: subagent
description: Téo Temas procura no acervo local o Tema, súmula ou repetitivo que governa cada tese candidata; o que o acervo não tem sai como [TEMA A CONFERIR].
inputFile: squads/peca-modelo/autos/_index.yaml
outputFile: squads/peca-modelo/output/diagnostico/temas.md
---

# 🤖 Agente: Temas do acervo

## Para o Pipeline Runner

Téo Temas procura no acervo local o Tema, súmula ou repetitivo que governa cada tese candidata; o que o acervo não tem sai como [TEMA A CONFERIR].

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

`output/intake.md` e o acervo instalado (`acervo/_index.yaml`).

## Instructions

### Process

1. Acionar `leitor-acervo-modelo` (subagente) — busca local, por Grep nos campos tema e tags do acervo/_index.yaml, nunca lendo o índice inteiro.
2. Registrar a tabela tese → Tema no artefato declarado.
3. Avançar (fan-in no step-06).

## Output Format

Grava em `squads/peca-modelo/output/diagnostico/temas.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Temas do acervo

| Tese | Governa | Conferido em |
|---|---|---|
| Tese A | Tema 000 (demo) | acervo/_index.yaml |
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Citar precedente sem a fonte onde foi conferido.
2. Apresentar silêncio do acervo como inexistência da tese.

## Quality Criteria

- Cada tese candidata vem com o Tema, súmula ou repetitivo que a governa, ou marcada `[TEMA A CONFERIR]`.
- A consulta ao acervo está registrada antes de qualquer outra fonte.
