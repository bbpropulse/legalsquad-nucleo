---
step: "08"
name: "Revisão B"
type: agent
description: Raquel Revisão B confere o checklist de consistência, em paralelo com a Revisão A.
---

# 🤖 Agente: Revisão B

## Para o Pipeline Runner

Raquel Revisão B confere o checklist de consistência, em paralelo com a Revisão A.

Fixture sintética da área demo — sem matéria jurídica real.

## Ação

1. Acionar a persona `revisor-demo-b` (subagent).
2. Registrar o resultado nos artefatos declarados em `output.artifacts` deste step no pipeline.yaml.
3. Avançar para o próximo step.
