---
step: "06"
name: "Diagnóstico"
type: checkpoint
description: A parada diagnostico: o chefe consolida os quatro leitores numa tela (o que o caso é, o que ganha, o que perde, Temas, ataques) e o profissional confirma ou edita o foco e dá a linha de ataque.
outputFile: squads/peca-modelo/output/foco.md
---

# 🛑 Checkpoint: Diagnóstico

## Para o Pipeline Runner

A parada diagnostico: o chefe consolida os quatro leitores numa tela (o que o caso é, o que ganha, o que perde, Temas, ataques) e o profissional confirma ou edita o foco e dá a linha de ataque.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

Os quatro artefatos da fase zero, lidos por caminho e não por atalho:

- `squads/peca-modelo/output/diagnostico/resumo.md`
- `squads/peca-modelo/output/diagnostico/contradicoes.md`
- `squads/peca-modelo/output/diagnostico/pre-mortem.md`
- `squads/peca-modelo/output/diagnostico/temas.md`

Um fan-in lê N arquivos e `inputFile` é singular: por isso os quatro vão nomeados aqui, que é onde o validador procura o consumidor de cada artefato.

## Instructions

### Process

1. Mostrar a tela de Diagnóstico com a fonte de cada linha nomeada (os quatro arquivos em output/diagnostico/).
2. Perguntar, em coleta: teses confirmadas e a linha de ataque (a frase que o juiz precisa lembrar).
3. Gravar a resposta literal e a data no outputFile; só avançar com a resposta registrada.

## Output Format

Grava em `squads/peca-modelo/output/foco.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Foco aprovado

**Decidido em:** 2026-07-20

## Teses aprovadas
1. Tese A

## O que a peça NÃO deve fazer
- Não rediscutir o mérito de X.
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Seguir para a redação sem o foco aprovado gravado.
2. Apresentar ao profissional conclusão que os quatro artefatos não sustentam.

## Quality Criteria

- Os quatro outputs são apresentados, cada um em uma linha.
- A decisão do profissional está gravada em `output/foco.md`.
