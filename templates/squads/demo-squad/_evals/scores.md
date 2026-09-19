# Scores de eval — demo-squad

Log de regressão preenchido pelo `/legalsquad eval`. Uma linha por avaliação;
o `npm run eval:resumo` lê esta tabela e calcula média, faixa e tendência.

Fixture sintética: todas as notas abaixo são fictícias e existem para exercitar o
parser e a detecção de regressão do motor. A última linha é **deliberadamente
abaixo da média** — é ela que prova o alerta ⚠️.

| Data | Run/Caso | Nota | Verdict | Observações |
|------|----------|------|---------|-------------|
| 2026-07-14 | caso-entrega-simples | 92 | APROVADO | todos os critérios atendidos |
| 2026-07-15 | caso-revisao-divergente | 85 | APROVADO | revisão B pediu 1 ajuste |
| 2026-07-16 | caso-entrega-simples | 88 | APROVADO | — |
| 2026-07-17 | caso-rejeicao-em-cadeia | 74 | REPROVADO | loop não convergiu em 3 ciclos |
| 2026-07-18 | caso-revisao-divergente | 8,5 | REPROVADO | nota em escala 0–10: o parser normaliza para o primeiro número |
| 2026-07-19 | caso-sem-nota | n/a | — | avaliação abortada: linha sem nota numérica é ignorada pelo resumo |
| 2026-07-20 | caso-rejeicao-em-cadeia | 61/100 | REPROVADO | nota com denominador: o parser lê 61 |
