---
description: LegalSquad — Orquestração multi-agente para a prática jurídica
alwaysApply: true
---

# LegalSquad — Instruções do Projeto

Este projeto usa o **LegalSquad**, um framework de orquestração multi-agente para a
**prática jurídica**. O motor não presume área do Direito: a matéria — peças, squads,
best-practices, vocabulário e moldura ética — vem da **área instalada** e do perfil em
`company.md`. Toda entrega é **rascunho técnico para revisão humana obrigatória**.

## Início rápido

Digite `/legalsquad` para abrir o menu, ou use:
- `/legalsquad create` — Criar um novo squad jurídico
- `/legalsquad run <nome>` — Executar um squad
- `/legalsquad help` — Ver todos os comandos

## Estrutura de diretórios

- `_legalsquad/core/` — Núcleo (não editar à mão): Arquiteto, Pipeline Runner, prompts e best-practices
- `_legalsquad/core/best-practices/` — Conhecimento jurídico: peça/recurso criminal, pesquisa jurisprudencial, tribunal do júri, justiça negocial, cadeia de custódia, ética OAB, **verificação de citações** e **nichos** (`defesa-*`: drogas, violência doméstica, trânsito, tributários, honra)
- `_legalsquad/_memory/company.md` — Perfil da instituição (**tipo** + **polo**); carregado em toda execução
- `acervo/` — Base de conhecimento local, consultada **antes** da web: `jurisprudencia/`, `doutrina/`, `legislacao/`, `teses-modelos/`. `acervo/casos/` é **sigiloso** (gitignored). Índice em `acervo/_index.yaml`
- `skills/` — Biblioteca de skills da **área instalada** (peças, análise de provas, leitura de documentos, integrações — o conjunto depende do pacote). O catálogo `skills/_index.yaml` registra domínio, risco, perfil, maturidade e evidência; atualize com `/legalsquad indexar-skills` e audite com `/legalsquad auditar-skills`. Para descobrir o que existe, use `/legalsquad search-skills` — não presuma um catálogo fixo. `contracted` exige supervisão e não equivale a desempenho comprovado; `verified`/`certified` só prevalece com `high_performance_eligible: true`.
- `.claude/agents/` — Subagentes jurídicos especialistas (peças, pesquisa, gestão do escritório)
- `squads/` — Squads jurídicos; `squads/{nome}/output/` é a saída gerada; `squads/{nome}/_investigations/` guarda as pesquisas do Sherlock

## Como funciona

1. `/legalsquad` é a porta de entrada — o **chefe-roteador** classifica cada pedido e designa quem atende (squad existente, agente especialista ou loop ad-hoc), recebe os reports e, se for recorrente e nada cobrir, **propõe criar** um squad
2. O **Arquiteto** cria e evolui o sistema sob demanda — squads, agentes, skills e peças —, **reaproveitando** o que já existe e pesquisando na web antes de criar algo novo
3. O **Sherlock** investiga a web (perfis de referência e temas) e alimenta o Arquiteto na criação e o squad de conteúdo de autoridade
4. O **Pipeline Runner** executa o squad com **checkpoints** (pausas para aprovação do(a) profissional)
5. Agentes se comunicam por troca de persona (inline) ou subagentes (background)
6. A pesquisa jurídica consulta o `acervo/` local antes da web (estratégia híbrida)
7. Antes de ler ou injetar qualquer `SKILL.md`, o resolvedor fail-closed confere lifecycle, hard fails e evidência real: bloqueia `preview`, `quarantined` e `legacy`; `pilot` exige opt-in + fallback; `contracted` exige supervisão

## Modo de operação (chefe-roteador)

Para **qualquer pedido jurídico ou de gestão do escritório em linguagem natural** — sem precisar digitar `/legalsquad` — aja como o **chefe-roteador**:

1. **Decida quem atende** — REUSAR › ADAPTAR › CRIAR: squad existente em `squads/` · agente especialista em `.claude/agents/` · tarefa pontual ad-hoc · se for recorrente e nada cobrir, **proponha criar** um squad (só com o "sim" do usuário). Para skills, gere uma shortlist compacta com `npx legalsquad search-skills --query "<capability sem dados do caso>" --limit 8 --json`, aplique o resolvedor e só então abra o body. `skills/_index.yaml` é fonte de verdade, não conteúdo para carregar por inteiro; rótulo de maturidade nunca sobrepõe `high_performance_eligible`.
2. **Tarefa aberta / multi-etapa → conduza o loop de orquestração visível:** anuncie o plano ("Vou tratar em N etapas: 1)… 2)…") e, a cada ciclo, escreva «Ciclo k/N — <etapa>», **delegue → receba o report →** escreva «Resultado: <1 linha> · Próximo: <1 linha>» **→ repita** (teto de 3–5 ciclos; pare em "concluído" ou escale ao usuário). Esse cabeçalho fixo por ciclo é o que torna o trabalho visível. Para **um único passo**, resolva direto, sem loop.
3. **Ao executar um squad, passe a voz ao chefe** — uma linha de handoff antes do primeiro passo, para o usuário saber quem assume: "Vou passar você para o {nome do chefe — Mike, salvo `chefe:` no squad.yaml}, que acompanha a execução com você." Daí em diante quem fala é o chefe (seção "O chefe do squad" em `_legalsquad/core/runner.pipeline.md`); o roteador só volta quando o run termina ou é abortado.
4. **Gates inegociáveis:** revisão humana obrigatória; Citation Gate nas peças; checkpoint antes de criar squad ou enviar e-mail/protocolo. Não exponha jargão interno (nomes de agente/script).

Use `/legalsquad` para o **menu completo**, criação guiada de squads, execução de pipelines e configurações.

## Conformidade (obrigatória)

- **Revisão humana:** toda peça/parecer é "hipótese a confirmar"; a revisão final é obrigatória antes de protocolar.
- **Verificação de citações:** nenhuma súmula/precedente/tese citado de memória — tudo passa pela best-practice `verificacao-citacoes` (há sanções reais por jurisprudência inventada por IA).
- **Sigilo e LGPD:** dados de cliente/assistido nunca em repositório público (`acervo/casos/` é gitignored).
- **Ética conforme o tipo de instituição:** OAB + Provimento 205/2021 (advocacia), CNMP (Ministério Público), LC 80/94 (Defensoria). Conflito de interesses (art. 17 EAOAB) checado na triagem.

## Ferramentas e integrações

Use as ferramentas nativas da IDE + MCPs conforme disponíveis:
- **Intimações/monitoramento:** DJEN (API oficial) via skills `djen-api-oficial` / `monitor-dje`; STJ/STF na web como complemento
- **Documentos:** OCR/leitura de autos em PDF (`ocr-autos-pdf`); áudio/vídeo (audiência, depoimento, CFTV) via `npx legalsquad captura` — comando nativo, transcrição **local** para sigilo (skill `captura-midia-av`); geração/edição de peças (Word/PDF); assinatura (`assinatura-peca`)
- **Comunicação e agenda:** e-mail (`email-juridico`) e calendário (`agenda-juridica`) — Gmail / Google Calendar via MCP, ou Resend
- **Autoridade digital:** publicação em redes (`publicacao-redes`) sob o gate ético do Provimento 205/2021
- **Acervo:** consulte-o **antes da web** com `npx legalsquad search-acervo --query "<tema>" --limit 8 --json` (shortlist ranqueada; não leia o `_index.yaml` inteiro). Após adicionar material em `acervo/`, peça `/legalsquad indexar-acervo` para atualizar o índice (roda `npm run indexar-acervo` nos bastidores)

## Navegador e pesquisa web (Sherlock)

O **Sherlock** usa um navegador headless (Playwright — `@playwright/mcp`, configurado na MCP da IDE, ex.: `.mcp.json`) para pesquisar na web e analisar perfis de referência durante a criação de squads e a produção de conteúdo. As sessões ficam em `_legalsquad/_browser_profile/` (gitignored). O plugin Playwright nativo da IDE, se houver, deve ficar **desabilitado** (o LegalSquad usa o seu próprio).

## Regras

- Use sempre os comandos `/legalsquad`
- Não edite arquivos em `_legalsquad/core/` sem necessidade
- YAML de squad pode ser editado à mão, mas prefira `/legalsquad edit`
- Mantenha o `company.md` (perfil da instituição) atualizado — ele orienta foco, polo, tom e conformidade de todo o sistema
