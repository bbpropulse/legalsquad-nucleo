---
step: "07"
name: "Pesquisa"
type: agent
agent: pesquisador-modelo
execution: subagent
description: Pia Pesquisa pesquisa em camadas conforme o escopo do intake e entrega a tabela Tema por tese; toda citação não confirmada sai [NÃO VERIFICADO].
inputFile: squads/peca-modelo/output/foco.md
outputFile: squads/peca-modelo/output/pesquisa-juridica.md
---

# 🤖 Agente: Pesquisa

## Para o Pipeline Runner

Pia Pesquisa pesquisa em camadas conforme o escopo do intake e entrega a tabela Tema por tese; toda citação não confirmada sai [NÃO VERIFICADO].

Fixture sintética da área demo, sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

`output/foco.md` (as teses aprovadas) e o escopo autorizado, lido do ledger com `node scripts/squad-state.mjs run-status squads/peca-modelo`, nunca de memória.

## Instructions

### Process

1. Acionar `pesquisador-modelo` (subagente): superiores e vinculantes do tribunal sempre; busca externa só se o intake autorizou (ler a resposta no ledger com run-status). Lei e jurisprudência só pelo servidor de referência: `npx legalsquad ref buscar "<tema>" --area <área>`, `npx legalsquad ref resolver "<citação>"` (id, selo, vigência) e `npx legalsquad ref ler <id>` (texto conferido); nunca o acervo local nem `Read` nos `_index.yaml`. O que o `ref` não acha vai à fonte oficial por código (`node scripts/fonte-oficial.mjs --out <pasta do run>/fontes`).
2. Registrar a pesquisa com a tabela "Tema que governa cada tese" (com o id, o selo e a `url_oficial` do `ref`) e os precedentes por força vinculante.
3. Avançar.

## Output Format

Grava em `squads/peca-modelo/output/pesquisa-juridica.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Pesquisa jurídica

| Dispositivo | Conferido? | Fonte |
|---|---|---|
| Lei demo, art. 1º | sim | fonte-oficial-demo |

`[NÃO VERIFICADO]`: precedente X, sem URL oficial no servidor de referência nem na fonte oficial.
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Citar de memória: toda lei, súmula, tese ou acórdão vai com a fonte onde foi conferido.
2. Buscar fora do escopo que o checkpoint `intake` autorizou.

## Quality Criteria

- Toda citação traz órgão, número, relator, data e fonte, ou sai marcada `[NÃO VERIFICADO]`.
- O que a fonte contradiz sai marcado `[DIVERGENTE]`.
