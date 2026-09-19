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

1. Perguntar, em coleta: objetivo da peça, prazo, juízo e instância, estilo, escopo da pesquisa e ritmo do run.
2. Apresentar a recomendação de `node scripts/cobertura-acervo.mjs . --tema "{tema}" --tribunal {sigla} --instancia {1|2|superior}` como veio, e as três opções de busca externa.
3. Perguntar o **ritmo do run** com três opções e o custo em linguagem de gente: **"Rápido"** (1 verificador por gate, 1 ciclo de revisão, sem persuasão nem red-team) · **"Equilibrado"** (1 verificador, 2 ciclos, persuasão em uma passada) · **"Rigoroso"** (o que o squad declara: consenso de 3, 3 ciclos, persuasão e red-team). Ajuste fino só se o profissional pedir (`--ciclos 1|2|3`, `--verificadores 1|3`). Gravar por código: `node scripts/squad-state.mjs ritmo squads/peca-modelo --set rapido|equilibrado|completo`.
4. Gravar a resposta literal e a data no outputFile; só avançar com a resposta registrada.

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

## Ritmo do run
Equilibrado (1 verificador por gate, 2 ciclos de revisão, persuasão em uma passada).
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Avançar sem a resposta do profissional registrada no `outputFile`.
2. Presumir prazo, juízo ou escopo de pesquisa que o profissional não informou.

## Quality Criteria

- A resposta literal do profissional está gravada, com a data.
- O escopo de pesquisa escolhido é um dos três oferecidos, e está nomeado.
- O ritmo do run está nomeado e gravado no ledger (`squad-state ritmo --set`).
