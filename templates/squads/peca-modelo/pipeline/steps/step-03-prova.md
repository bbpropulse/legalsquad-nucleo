---
step: "03"
name: "Prova e contradições"
type: agent
agent: leitor-prova-modelo
execution: subagent
description: Paulo Prova diz o que a prova dos autos sustenta e o que contradiz, com folhas.
inputFile: squads/peca-modelo/autos/_index.yaml
outputFile: squads/peca-modelo/output/diagnostico/contradicoes.md
---

# 🤖 Agente: Prova e contradições

## Para o Pipeline Runner

Paulo Prova diz o que a prova dos autos sustenta e o que contradiz, com folhas.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

`output/intake.md` e os documentos de prova indicados no índice dos autos.

## Instructions

### Process

1. Acionar `leitor-prova-modelo` (subagente) sobre o índice dos autos.
2. Registrar as contradições no artefato declarado, cada uma com folha ou ID.
3. Avançar (fan-in no step-06).

## Output Format

Grava em `squads/peca-modelo/output/diagnostico/contradicoes.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Prova e contradições

| Afirmação | Onde | Contradiz | Onde |
|---|---|---|---|
| Entrega em 10/01 | doc. 02, fls. 3 | Recebimento em 08/01 | doc. 03, fls. 1 |
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Concluir pela procedência ou improcedência: aqui se confrontam provas, não se decide.
2. Tratar ausência de prova como prova de ausência.

## Quality Criteria

- Cada contradição aponta as duas folhas que se contradizem.
- Confiança declarada quando a leitura depende de OCR.
