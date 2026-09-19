---
step: "02"
name: "Resumo do caso"
type: agent
agent: leitor-resumo-modelo
execution: subagent
description: Rita Resumo lê o índice dos autos (autos/_index.yaml e _texto/) e diz o que o caso é, com folhas.
inputFile: squads/peca-modelo/autos/_index.yaml
outputFile: squads/peca-modelo/output/diagnostico/resumo.md
---

# 🤖 Agente: Resumo do caso

## Para o Pipeline Runner

Rita Resumo lê o índice dos autos (autos/_index.yaml e _texto/) e diz o que o caso é, com folhas.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

`output/intake.md` (o escopo aprovado) e o índice dos autos, quando houver `autos/_index.yaml`.

## Instructions

### Process

1. Acionar `leitor-resumo-modelo` (subagente, contexto fresco) sobre o índice dos autos — nunca reler os PDFs inteiros.
2. Registrar o resumo no artefato declarado, cada afirmação com a folha ou o ID de onde vem.
3. Avançar (fan-in no step-06).

## Output Format

Grava em `squads/peca-modelo/output/diagnostico/resumo.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Resumo do caso

- Partes: A x B (doc. 01, fls. 2)
- Valor: R$ 10.000,00 (doc. 01, fls. 4)

## Lacunas
- Não há comprovante de pagamento nos autos.
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Interpretar o que os documentos significam: este step inventaria, não conclui.
2. Afirmar fato sem apontar o documento e a folha.

## Quality Criteria

- Cada linha do resumo aponta documento e folha.
- O que não está nos autos aparece como lacuna declarada.
