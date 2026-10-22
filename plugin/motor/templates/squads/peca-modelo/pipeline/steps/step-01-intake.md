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

Fixture sintética da área demo, sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

O `squad.yaml` (goal e success_criteria) e a memória do chefe (`node scripts/squad-state.mjs run-status squads/peca-modelo`, se houver run anterior).

## Instructions

### Process

1. Perguntar, em coleta: objetivo da peça, prazo, juízo e instância, estilo, escopo da pesquisa e ritmo do run.
2. Apresentar a recomendação de `node scripts/cobertura-acervo.mjs . --tema "{tema}" --tribunal {sigla} --instancia {1|2|superior}` como veio, e as três opções de busca externa.
3. Perguntar o **ritmo do run** com três opções, a recomendada primeiro, com o porquê e o custo em linguagem de gente: **"Rigoroso"** (recomendado para esta entrega: peça que vai a juízo: mais conferências e ataque simulado; nos nossos testes deu a nota mais estável, em cerca de 4 horas; citações conferidas por três verificadores, em geral duas rodadas de correção, até três avaliadores na conferência final de qualidade, teste de leitura rápida, pré-mortem do diagnóstico e ataque simulado ao texto, oferecido antes da aprovação) · **"Rápido"** (para rotina e minuta que você vai revisar: nos nossos testes levou cerca de 2h30 a 3h, com nota 3 a 5 pontos abaixo da melhor; uma conferência de citações; a revisão devolve o texto para correção uma vez e, se reprovar de novo, o ponto vem a você; um avaliador na conferência final de qualidade; sem teste de leitura rápida; o pré-mortem do diagnóstico (o contraditor lendo as teses antes da redação, quando a equipe o tem) roda como nos outros ritmos, e o que fica de fora é o ataque simulado ao texto antes da aprovação) · **"Equilibrado"** (opção intermediária: nos nossos testes a nota variou mais de um trabalho para outro; uma conferência de citações; uma rodada de correção na revisão; até dois avaliadores na conferência final de qualidade; teste de leitura rápida em uma passada; pré-mortem do diagnóstico como nos outros ritmos, sem o ataque simulado ao texto antes da aprovação). A recomendação vem do código (`node scripts/squad-state.mjs ritmo squads/peca-modelo` devolve `ritmo_recomendado` e `opcoes_do_intake` sob o teto do perfil do projeto: com o projeto num perfil abaixo, vale o texto que o comando devolve). Ajuste fino só se o profissional pedir (`--ciclos 1|2|3`, `--verificadores 1|3`). Gravar por código: `node scripts/squad-state.mjs ritmo squads/peca-modelo --set rapido|equilibrado|completo`.
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
Equilibrado (uma conferência de citações, uma rodada de correção na revisão, teste de leitura rápida em uma passada).
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Avançar sem a resposta do profissional registrada no `outputFile`.
2. Presumir prazo, juízo ou escopo de pesquisa que o profissional não informou.

## Quality Criteria

- A resposta literal do profissional está gravada, com a data.
- O escopo de pesquisa escolhido é um dos três oferecidos, e está nomeado.
- O ritmo do run está nomeado e gravado no ledger (`squad-state ritmo --set`).
