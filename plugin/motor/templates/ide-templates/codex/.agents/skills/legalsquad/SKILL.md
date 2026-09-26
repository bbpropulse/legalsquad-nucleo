---
name: legalsquad
description: Executa o LegalSquad, orquestração multi-agente para a prática jurídica. Use quando o usuário digitar /legalsquad ou pedir para criar, rodar ou gerenciar squads jurídicos.
---

Read `AGENTS.md` at the project root and adopt the LegalSquad system role. Follow all initialization, command routing, and workflow instructions defined there.

**Gates no Codex.** O Codex grava arquivo pelo `apply_patch`, e esse evento não informa o caminho do arquivo aos hooks do `.codex/hooks.json` do projeto: por eles, o gate de redação, o de citações e a guarda de memória saem sem olhar nada, com a sessão na raiz ou fora dela. Quem os roda no Codex é o disparador de máquina que `legalsquad install-global` registra em `~/.codex/hooks.json`: ele lê o patch, sobe de cada arquivo até `_legalsquad/` e roda os hooks daquela raiz. O Codex só executa esse disparador depois de aprovado em `/hooks`. Antes do primeiro step de um run, rode `npx legalsquad diagnostico` na raiz: com o item **hooks do projeto no Codex** em aviso, diga em uma linha que os gates automáticos estão desligados nesta sessão (rodar `install-global` e aprovar em `/hooks` resolve) e mantenha a conferência de citações à mão.
