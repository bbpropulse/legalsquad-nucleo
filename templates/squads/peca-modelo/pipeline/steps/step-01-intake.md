---
step: "01"
name: "Intake"
type: checkpoint
description: Coleta do profissional: objetivo, prazo, juízo e instância, estilo, e o escopo da pesquisa (com a recomendação da cobertura do acervo).
outputFile: squads/peca-modelo/output/intake.md
---

# 🛑 Checkpoint: Intake

## Para o Pipeline Runner

Coleta do profissional: objetivo, prazo, juízo e instância, estilo, e o escopo da pesquisa (com a recomendação da cobertura do acervo).

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

O `squad.yaml` (goal e success_criteria) e a memória do chefe (`node scripts/squad-state.mjs run-status squads/peca-modelo`, se houver run anterior).

## Instructions

### Process

1. Perguntar, em coleta: objetivo da peça, prazo, juízo e instância, estilo, escopo da pesquisa.
2. Apresentar a recomendação de `node scripts/cobertura-acervo.mjs . --tema "{tema}" --tribunal {sigla} --instancia {1|2|superior}` como veio, e as três opções de busca externa.
3. Gravar a resposta literal e a data no outputFile; só avançar com a resposta registrada.

## Output Format

Grava em `squads/peca-modelo/output/intake.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Intake

**Coletado em:** 2026-07-20

## Objetivo
Peça sintética da área demo.

## Escopo da pesquisa
Acervo local + superiores. Sem busca externa.
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Avançar sem a resposta do profissional registrada no `outputFile`.
2. Presumir prazo, juízo ou escopo de pesquisa que o profissional não informou.

## Quality Criteria

- A resposta literal do profissional está gravada, com a data.
- O escopo de pesquisa escolhido é um dos três oferecidos, e está nomeado.
