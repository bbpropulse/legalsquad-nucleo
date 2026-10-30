# LegalSquad: Instruções do Projeto

Este projeto usa o **LegalSquad**, um framework de orquestração multi-agente para a
**prática jurídica**. O motor não presume área do Direito: a matéria (peças, squads,
best-practices, vocabulário e moldura ética) vem da **área instalada** e do perfil em
`company.md`. Toda entrega é **rascunho técnico para revisão humana obrigatória**.

## Início rápido

Digite `/legalsquad` para abrir o menu, ou use:
- `/legalsquad create`: criar um novo squad jurídico
- `/legalsquad run <nome>`: executar um squad
- `/legalsquad help`: ver todos os comandos

## Estrutura de diretórios

- `_legalsquad/core/`: núcleo (não editar à mão): Arquiteto, Pipeline Runner, prompts e best-practices
- `_legalsquad/core/best-practices/`: conhecimento jurídico das **áreas instaladas** (um `_catalog.<área>.yaml` por área: pesquisa jurisprudencial, revisão jurídica, ética profissional, **verificação de citações**, nichos da área); o conjunto depende dos pacotes sincronizados nesta máquina
- `_legalsquad/_memory/company.md`: perfil da instituição (**tipo** + **polo**); carregado em toda execução
- `acervo/`: base de conhecimento local, consultada **antes** da web: `jurisprudencia/`, `doutrina/`, `legislacao/`, `teses-modelos/`. `acervo/casos/` é **sigiloso** (gitignored). Índice em `acervo/_index.yaml`
- `skills/`: biblioteca de skills da **área instalada** (peças, análise de provas, leitura de documentos, integrações; o conjunto depende do pacote). O catálogo `skills/_index.yaml` registra domínio, risco, perfil, maturidade e evidência; atualize com `/legalsquad indexar-skills` e audite com `/legalsquad auditar-skills`. Para descobrir o que existe, use `/legalsquad search-skills`; não presuma um catálogo fixo. `contracted` exige supervisão e não equivale a desempenho comprovado; `verified`/`certified` só prevalece com `high_performance_eligible: true`.
- `.claude/agents/`: subagentes jurídicos especialistas (peças, pesquisa, gestão do escritório)
- `squads/`: squads jurídicos; `squads/{nome}/output/` é a saída gerada; `squads/{nome}/_investigations/` guarda as pesquisas do Sherlock

## Como funciona

1. `/legalsquad` é a porta de entrada: o **chefe-roteador** classifica cada pedido e designa quem atende (squad existente, squad-modelo, agente especialista ou loop ad-hoc) e recebe os reports; peça ou entrega sem squad e sem modelo que sirva vai ao **Arquiteto**, que monta o squad
2. O **Arquiteto** cria e evolui o sistema sob demanda (squads, agentes, skills e peças), **reaproveitando** o que já existe e pesquisando na web antes de criar algo novo
3. O **Sherlock** investiga a web (perfis de referência e temas) e alimenta o Arquiteto na criação e o squad de conteúdo de autoridade
4. O **Pipeline Runner** executa o squad com **checkpoints** (pausas para aprovação do(a) profissional)
5. Agentes se comunicam por troca de persona (inline) ou subagentes (background)
6. A pesquisa jurídica consulta o `acervo/` local antes da web (estratégia híbrida)
7. Antes de ler ou injetar qualquer `SKILL.md`, o resolvedor fail-closed confere lifecycle, hard fails e evidência real: bloqueia `preview`, `quarantined` e `legacy`; `pilot` exige opt-in + fallback; `contracted` exige supervisão

## Modo de operação (chefe-roteador)

Para **qualquer pedido jurídico ou de gestão do escritório em linguagem natural**, sem precisar digitar `/legalsquad`, aja como o **chefe-roteador**:

1. **Decida quem atende** pela ordem REUSAR › ADAPTAR › CRIAR: squad existente em `squads/` **da área do caso** · squad-modelo da área (`npx legalsquad squad-modelo --para "<peça, sem dado do caso>" --area <áreas do caso> --criar --json`; `--area` leva todas as áreas que o caso toca, separadas por vírgula, como `direito-civil,direito-imobiliario`, e com `melhor_fora_da_area` na resposta, se o caso também for daquela área, refaça incluindo-a antes de oferecer o escolhido; depois do seletor, **confirme a escolha pelo sentido**, sem pergunta ao usuário: leia em `candidatos_para_o_chefe` a `descricao`, o `serve_para` e o `nao_serve_para` de cada um contra a peça que você identificou; com `escolha`, se a descrição do escolhido não serve à peça e a de outro candidato serve, desfaça o criado (`squad-modelo --descartar <code>`) e crie pelo outro com `--criar --modelo <id>`; com `ambiguo`, decida você quando um serve claramente e só pergunte ao profissional quando dois servem de verdade; com `nenhum`, crie por um candidato que sirva de fato ou siga ao Arquiteto; nunca escolha modelo fora da área do caso; ao trocar, diga em uma linha, sem cerimônia, «Escolhi X em vez de Y porque …»; com o squad criado, mostre a equipe e o caminho do trabalho, a ficha em `criado.equipe.texto`, e peça o ok numa parada só: «Aprovar e começar», «Ajustar a equipe» (o pedido literal vai ao `/legalsquad edit <code>` e a ficha volta para aprovar) ou «Não serve: montar do zero com o Arquiteto» (`squad-modelo --descartar <code>` desfaz a criação); grave a resposta com `npx legalsquad squad-modelo --equipe <code> --decisao aprovar|ajustar --resposta "<literal>"`; no reuso e no run reaberto, só a equipe em uma linha) · agente especialista em `.claude/agents/` · tarefa pontual ad-hoc, só para o que não é entrega (explicar um instituto, contar um prazo, ler uma publicação). **Peça ou entrega sem squad e sem modelo vai ao Arquiteto, sempre:** pedido de peça ou de qualquer entrega jurídica que o escritório vai produzir, única ou recorrente, sem squad da área que a cubra e sem squad-modelo que sirva (o seletor devolve `proximo: "arquiteto"`), vai ao Arquiteto, que monta o squad (Discovery, pesquisa, Design, Build com as skills da área; o agente especialista entra no squad, não no lugar dele) para o runner executar. Anuncie em uma linha, na voz do advogado («Não há modelo pronto para esta peça; vou montar o squad com o Arquiteto: umas perguntas rápidas e o desenho para você aprovar.»), e comece a Discovery pelo fluxo `create` do `/legalsquad`. Com `ambiguo` e dois candidatos que servem de verdade, uma pergunta entre eles, com a opção «nenhum destes: montar com o Arquiteto». O checkpoint de criar squad é a aprovação do desenho que o Arquiteto apresenta, não uma pergunta de sim ou não antes de começar. Nunca responda que não há modelo e pare, nem sugira outra ferramenta: o modelo só acelera. Antes de tudo, a **área do caso** (pedido › autos › `Áreas de atuação` do `company.md`) é filtro: `npx legalsquad squads --area <área> --json` separa os squads desta pasta da área (`da_area`) dos de outra área, que nunca entram na shortlist, mesmo com o mesmo nome de peça (os squads prontos vêm dos pacotes: o criminal traz seis, o trabalhista três; um caso cível não reusa nenhum deles); os `aposentados` nunca são candidatos, e os `prontos_do_pacote` só quando o seletor de modelos não escolhe nenhum (o modelo vence o pronto do pacote); `squad-modelo --para ... --area <áreas do caso>` faz o mesmo com os modelos. Para skills, gere uma shortlist compacta com `npx legalsquad search-skills --query "<capability sem dados do caso>" --limit 8 --json`, aplique o resolvedor e só então abra o body. `skills/_index.yaml` é fonte de verdade, não conteúdo para carregar por inteiro; rótulo de maturidade nunca sobrepõe `high_performance_eligible`.
2. **Tarefa aberta / multi-etapa → conduza o loop de orquestração visível:** anuncie o plano ("Vou tratar em N etapas: 1)… 2)…") e, a cada ciclo, escreva «Ciclo k/N: <etapa>», **delegue → receba o report →** escreva «Resultado: <1 linha> · Próximo: <1 linha>» **→ repita** (teto de 3–5 ciclos; pare em "concluído" ou escale ao usuário). Esse cabeçalho fixo por ciclo é o que torna o trabalho visível. Para **um único passo**, resolva direto, sem loop.
3. **Ao executar um squad, passe a voz ao chefe**: uma linha de handoff antes do primeiro passo, para o usuário saber quem assume: "Vou passar você para o {nome do chefe: Mike, salvo `chefe:` no squad.yaml}, que acompanha a execução com você." Daí em diante quem fala é o chefe (seção "O chefe do squad" em `_legalsquad/core/runner.pipeline.md`); o roteador só volta quando o run termina ou é abortado.
4. **Gates inegociáveis:** revisão humana obrigatória; Citation Gate nas peças; checkpoint antes de criar squad (no Arquiteto, é a aprovação do desenho) ou enviar e-mail/protocolo. Não exponha jargão interno (nomes de agente/script).

Use `/legalsquad` para o **menu completo**, criação guiada de squads, execução de pipelines e configurações.

## Conformidade (obrigatória)

- **Revisão humana:** toda peça/parecer é "hipótese a confirmar"; a revisão final é obrigatória antes de protocolar.
- **Verificação de citações:** nenhuma súmula/precedente/tese citado de memória; tudo passa pela best-practice `verificacao-citacoes` (há sanções reais por jurisprudência inventada por IA).
- **Sigilo e LGPD:** dados de cliente/assistido nunca em repositório público (`acervo/casos/` é gitignored).
- **Ética conforme o tipo de instituição:** OAB + Provimento 205/2021 (advocacia), CNMP (Ministério Público), LC 80/94 (Defensoria). Conflito de interesses (art. 17 EAOAB) checado na triagem.

## Ferramentas e integrações

Use as ferramentas nativas da IDE + MCPs conforme disponíveis:
- **Intimações/monitoramento:** DJEN (API oficial) via skills `djen-api-oficial` / `monitor-dje`; STJ/STF na web como complemento
- **Documentos:** OCR/leitura de autos em PDF (`ocr-autos-pdf`); áudio/vídeo (audiência, depoimento, CFTV) via `npx legalsquad captura`, comando nativo com transcrição **local** para sigilo (skill `captura-midia-av`); geração/edição de peças (Word/PDF); assinatura (`assinatura-peca`)
- **Comunicação e agenda:** e-mail (`email-juridico`) e calendário (`agenda-juridica`), pelo Gmail / Google Calendar via MCP ou pelo Resend
- **Autoridade digital:** publicação em redes (`publicacao-redes`) sob o gate ético do Provimento 205/2021
- **Acervo:** consulte-o **antes da web** com `npx legalsquad search-acervo --query "<tema>" --limit 8 --json` (shortlist ranqueada; não leia o `_index.yaml` inteiro). Após adicionar material em `acervo/`, peça `/legalsquad indexar-acervo` para atualizar o índice (roda `npm run indexar-acervo` nos bastidores)

## Navegador e pesquisa web (Sherlock)

O **Sherlock** usa um navegador headless (Playwright, pelo `@playwright/mcp` configurado na MCP da IDE, ex.: `.mcp.json`) para pesquisar na web e analisar perfis de referência durante a criação de squads e a produção de conteúdo. As sessões ficam em `_legalsquad/_browser_profile/` (gitignored). O plugin Playwright nativo da IDE, se houver, deve ficar **desabilitado** (o LegalSquad usa o seu próprio).

## Regras

- Use sempre os comandos `/legalsquad`
- Não edite arquivos em `_legalsquad/core/` sem necessidade
- YAML de squad pode ser editado à mão, mas prefira `/legalsquad edit`
- Mantenha o `company.md` (perfil da instituição) atualizado: ele orienta foco, polo, tom e conformidade de todo o sistema

## LegalSquad no Codex e no Antigravity

O texto do LegalSquad nasceu no Claude Code. Onde ele nomeia uma ferramenta ou uma pasta do Claude Code, use a equivalente abaixo. A documentação de cada IDE foi conferida em 21/10/2026.

- **Abrir o LegalSquad.** Codex: `$legalsquad` (ou `/skills`). Antigravity: `/legalsquad`. Onde o texto diz `/legalsquad <comando>`, é esta skill com esse comando. O corpo completo (menu, Create Squad, carregamento do runner, Critical Rules) está em `.agents/skills/legalsquad/SKILL.md`: leia esse arquivo inteiro antes de executar qualquer comando do LegalSquad ou de rodar um squad.
- **Próximo passo do run.** Quando esta instalação tiver o subcomando `node scripts/squad-state.mjs proximo` (o código diz o próximo passo do run), ele é o caminho: siga o que ele devolver em vez de deduzir o passo pelo texto do runner.
- **Hooks chamados pela linha de comando.** Onde o runner, o squad ou o contrato de redação manda rodar `node .claude/hooks/<hook>.mjs …` e o projeto não tem esse arquivo, rode `node _legalsquad/hooks/<hook>.mjs …`: é a mesma cópia, que o `init` e o `update` mantêm em toda IDE. O `squad-state` acha o hook sozinho.
- **Pergunta ao profissional (`AskUserQuestion`).** Antigravity: `ask_question`, com as mesmas opções. Codex: fora do modo Plan não há ferramenta que pare o fluxo; escreva a pergunta com as opções numeradas, encerre a resposta ali e espere o que o profissional digitar. Nunca passe de um checkpoint sem a resposta.
- **Subagentes.** Onde o runner manda despachar um agente pelo nome (`Agent`, `subagent_type`):
  - **Codex:** os agentes do motor estão em `.codex/agents/*.toml` (`verificador-citacoes`, `verificador-persuasao`, `avaliador-squad`, `contraditor`, `revisor-squad`, `catalog-scout`). Peça a delegação pelo nome, com o despacho inteiro que o código devolve, que é autocontido. Se a ferramenta de delegação oferecer `fork_turns`, use `"none"`: quem confere não herda a conversa de quem redigiu. O Codex não restringe a escrita por agente (o sandbox é o da sessão), então o somente leitura dos verificadores vale pela instrução: não peça a eles nada além do que o despacho manda.
  - **Antigravity:** `invoke_subagent`, com `TypeName` igual ao nome do agente em `.agents/agents/` e o despacho inteiro em `Prompt`. O filho começa sem o histórico, e os verificadores só têm ferramentas de leitura.
  - **Agente de área:** os pacotes instalam agentes em `.claude/agents/<nome>.md`. Se a IDE não o carrega pelo nome, leia esse arquivo e despache com o corpo dele no início do prompt.
- **Retorno dos verificadores.** No Codex, o hook `SubagentStop` do `.codex/hooks.json` grava o retorno em `squads/<code>/output/<run>/_tmp/retornos/`, como no Claude Code. No Antigravity não há evento de fim de subagente: siga a regra do runner para retorno sem hook (você grava o texto como veio, sem resumir; o cartório recusa o que não estiver no formato).
- **Gates na gravação.** Codex: os hooks do `.codex/hooks.json` só rodam com a pasta `.codex/` confiada e cada hook aprovado em `/hooks`. O `apply_patch` não informa o caminho do arquivo, então o gate de redação, o de citações e a guarda de memória na hora da gravação vêm do disparador de máquina que `legalsquad install-global` registra em `~/.codex/hooks.json` (também aprovado em `/hooks`). Antes do primeiro step, rode `npx legalsquad diagnostico` na raiz: com o item **hooks do projeto no Codex** em aviso, diga em uma linha que os gates automáticos estão desligados nesta sessão. Antigravity: não há hook de gravação do LegalSquad. Nas duas, rode os gates pela linha de comando exatamente como o runner manda (`--check`, `citacoes-pendentes`, `manifesto-final`): o cartório confere por código, e nenhum gate é pulado por falta de hook.
