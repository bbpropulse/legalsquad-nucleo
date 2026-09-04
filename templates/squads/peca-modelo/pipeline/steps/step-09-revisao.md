---
step: "09"
name: "Revisão"
type: agent
agent: revisor-modelo
execution: subagent
description: Regina Revisão revisa em contexto fresco e emite veredito estruturado (APPROVE/REJECT + fixes), condicionado ao verificador de citações.
inputFile: squads/peca-modelo/output/peca-modelo.md
outputFile: squads/peca-modelo/output/revisao.md
---

# 🤖 Agente: Revisão

## Para o Pipeline Runner

Regina Revisão revisa em contexto fresco e emite veredito estruturado (APPROVE/REJECT + fixes), condicionado ao verificador de citações.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

A minuta em `output/peca-modelo.md`, o foco em `output/foco.md` e a pesquisa em `output/pesquisa-juridica.md`.

## Instructions

### Process

1. Acionar `revisor-modelo` (subagente). O outputFile começa por um bloco YAML parseável:
   ```yaml
   verdict: APPROVE | REJECT
   fixes:
     - <o que muda, onde, por quê>   # vazio em APPROVE
   ```
2. Antes do APPROVE, o `verificador-citacoes` sobre a peça e a pesquisa; nenhum marcador pendente remanescente.
3. Em REJECT → on_reject para o step-08 com os fixes; teto max_review_cycles.

## Output Format

Grava em `squads/peca-modelo/output/revisao.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```yaml
verdict: REJECT
fixes:
  - onde: "Capítulo II"
    o_que: "Apontar a folha da afirmação"
    por_que: "Fato sem localização nos autos"
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Aprovar sem o veredito do `verificador-citacoes` sobre toda citação da minuta.
2. Reescrever a peça: o revisor emite veredito e fixes, não redige.

## Quality Criteria

- O bloco `verdict`/`fixes` abre o output e é parseável pelo runner.
- Cada fix é aplicável sem reescrever a peça.
