---
step: "10"
name: "Conferência de entrega"
type: agent
agent: conferente-modelo
execution: subagent
description: Caio Conferência consolida a versão final revisada e é o ponto onde os gates de entrega se ancoram — Citation Gate final com voting e verificação da meta — fora do loop de revisão.
inputFile: squads/peca-modelo/output/peca-modelo.md
outputFile: squads/peca-modelo/output/peca-modelo-final.md
---

# 🤖 Agente: Conferência de entrega

## Para o Pipeline Runner

Caio Conferência consolida a versão final revisada e é o ponto onde os gates de entrega se ancoram — Citation Gate final com voting e verificação da meta — fora do loop de revisão.

Fixture sintética da área demo — sem matéria jurídica real. Squad-modelo do caminho canônico.

## Context Loading

A minuta em `squads/peca-modelo/output/peca-modelo.md`, o veredito em `squads/peca-modelo/output/revisao.md` e o manifesto do Citation Gate. Este step fecha a entrega FORA do loop de revisão.

## Instructions

### Process

1. Acionar `conferente-modelo` (subagente): grava a versão final revisada em output/peca-modelo-final.md sem reescrever o mérito.
2. Os gates deste step: Citation Gate final com `citation_verifiers: 3` (voting) e Verificação da Meta com `meta_verifiers: 3`; o Gate de Sobrevivência ao Resumo (Passo 4.6) e o contraditor automático rodam aqui, porque este é o último step antes da aprovação.
3. Avançar para a parada aprovacao só com os gates passados.

## Output Format

Grava em `squads/peca-modelo/output/peca-modelo-final.md`. O artefato é Markdown, com o cabeçalho de primeiro nível nomeando o que o step produz. Um exemplo completo está na seção seguinte.

## Output Example

```markdown
# Conferência de entrega

- Citações: 12 conferidas, 0 pendentes
- Artefato: output/peca-modelo-final.md
```

## Veto Conditions

Reject and redo if ANY of these are true:
1. Fechar a entrega com marcador de citação pendente.
2. Alterar o texto da peça: aqui se confere e se empacota.

## Quality Criteria

- Toda citação foi conferida, e o manifesto registra o veredito.
- O artefato final está no caminho declarado.
