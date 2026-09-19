---
step: "09"
name: "Revisão"
type: agent
agent: revisor-modelo
execution: subagent
description: Regina Revisão revisa em contexto fresco e emite veredito estruturado (APPROVE/REJECT + fixes), condicionado ao verificador de citações.
inputFile: squads/peca-modelo/output/peca-modelo-minuta.md
outputFile: squads/peca-modelo/output/revisao.md
---

# 🤖 Agente: Revisão

## Para o Pipeline Runner

Regina Revisão revisa em contexto fresco e emite veredito estruturado (APPROVE/REJECT + fixes), condicionado ao verificador de citações.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

A minuta em `output/peca-modelo-minuta.md`, o foco em `output/foco.md` e a pesquisa em `output/pesquisa-juridica.md`.

## Instructions

### Process

1. Acionar `revisor-modelo` (subagente). O outputFile começa por um bloco YAML parseável, com a gravidade no prefixo de cada correção (`critica`, `alta`, `media`, `baixa`; só crítica e alta sustentam REJECT):
   ```yaml
   verdict: APPROVE | REJECT
   fixes:
     - "alta: <o que muda, onde, por quê>"
   ajustes:
     - "baixa: <correção de forma, aplicada sem rodada nova>"
   ```
2. Antes do APPROVE, o `verificador-citacoes` sobre a peça e a pesquisa (só as `pendentes` do cartório, `citacoes-pendentes`); nenhum marcador pendente remanescente; a tabela dele, com fonte e hora, vai ao cartório em `--citacoes`.
3. A partir do ciclo 2, conferir primeiro os fixes do ciclo anterior (aplicado, não aplicado, regressão); defeito novo só reprova se crítico ou alto. Em REJECT → on_reject para o step-08 com os fixes; teto max_review_cycles.

## Output Format

Grava em `squads/peca-modelo/output/revisao.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```yaml
verdict: REJECT
fixes:
  - "alta: Capítulo II: apontar a folha da afirmação (fato sem localização nos autos)"
ajustes:
  - "baixa: hífen na ênclise do § 3"
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Aprovar sem o veredito do `verificador-citacoes` sobre toda citação da minuta.
2. Reescrever a peça: o revisor emite veredito e fixes, não redige.

## Quality Criteria

- O bloco `verdict`/`fixes` abre o output e é parseável pelo runner, com a gravidade em cada fix.
- Cada fix é aplicável sem reescrever a peça.
