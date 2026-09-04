---
step: "11"
name: "Aprovação"
type: checkpoint
description: A parada aprovacao: o profissional aprova o pacote (docx, PDF quando houver, termo de conferência, anexos, próximos passos), vê o que o juiz lê primeiro e pode pedir red-team; as propostas de memória vêm agrupadas aqui.
outputFile: squads/peca-modelo/output/aprovacao.md
---

# 🛑 Checkpoint: Aprovação

## Para o Pipeline Runner

A parada aprovacao: o profissional aprova o pacote (docx, PDF quando houver, termo de conferência, anexos, próximos passos), vê o que o juiz lê primeiro e pode pedir red-team; as propostas de memória vêm agrupadas aqui.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

A peça final em `output/peca-modelo-final.md` e o relatório de conferência.

## Instructions

### Process

1. Rodar `node scripts/empacotar.mjs squads/peca-modelo --run {run_id}` e mostrar os caminhos do pacote.
2. Mostrar "O que o juiz lê primeiro" com a fonte nomeada; oferecer Aprovar e seguir · Ajustar · Red-team antes de seguir · Parar aqui.
3. Apresentar, agrupadas, as propostas de memória; gravar a decisão no outputFile.

## Output Format

Grava em `squads/peca-modelo/output/aprovacao.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Aprovação

**Aprovado em:** 2026-07-20 por [profissional]

## Memória proposta
- Estilo: sem superlativos
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Protocolar, enviar ou publicar: a entrega é rascunho técnico, e o ato é do profissional.
2. Registrar aprovação que o profissional não deu.

## Quality Criteria

- A decisão do profissional está gravada, com a data.
- As propostas de memória do run são apresentadas agrupadas.
