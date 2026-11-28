# Referência do comando /legalsquad

Os fluxos que o comando não usa no run de uma peça. O corpo do comando (SKILL.md) aponta para cá.

## Onboarding Flow (perfil da instituição)

Trigger this flow if `company.md` is empty, contains `<!-- NOT CONFIGURED -->`, or still has
placeholder `<...>` em **qualquer campo obrigatório** (Identidade, **Áreas de atuação** e **Polo de
atuação**), ou se a linha `Áreas de atuação` não existir ou estiver `(não informado)` (perfil gravado
por uma versão anterior, que não perguntava a área). Checagem mecânica: use a ferramenta **Grep** da
IDE com o padrão `<[^>]+>` e, depois, `^- Áreas de atuação:` em `{root}/_legalsquad/_memory/company.md`
(sempre na pasta do projeto; **não** use `grep` de shell, que pode falhar no Windows). Se houver
placeholder em campo obrigatório, dispare o onboarding inteiro; se só faltarem as áreas, pergunte só
elas (passo 2, a parte das áreas) e grave, sem repetir o resto.

**Curto por desenho: duas rodadas de pergunta, e a peça começa.** O `init` já gravou nome e idioma em
`preferences.md` (não repergunte; se `preferences.md` não tiver nome, pergunte só o nome, numa
linha). Não pesquise site de empresa. Nichos, sistemas processuais, e-mail, agenda e redes **não**
entram aqui: são coletados quando um run precisar deles (a parada `intake` já pergunta juízo,
tribunal e prazo) ou por `/legalsquad edit-company`.

**O LegalSquad atende qualquer área do Direito.** O motor não presume matéria: a área vem do que a
instituição declara aqui e do caso em mãos. Nunca ofereça, em pergunta nenhuma, as opções de um ramo
só (defesa/acusação/querelante é vocabulário penal; autor/réu é o cível; reclamante/reclamada é o
trabalhista); os squads prontos que chegam com os pacotes (o criminal traz seis, o trabalhista três)
não são "os squads do sistema", são os de uma área.

1. **Tipo de instituição e polo predominante, numa só AskUserQuestion com duas perguntas.**
   - Tipo: **Escritório de advocacia** (ou advogado(a) autônomo(a): responsável com OAB/UF; ética
     EAOAB + Provimento 205/2021) · **Gabinete do Ministério Público** (Promotor(a)/Procurador(a);
     regime do MP, sem publicidade advocatícia) · **Defensoria Pública** (Defensor(a); LC 80/94;
     assistidos hipossuficientes) · **Outro** (departamento jurídico, assessoria: capture o papel).
   - Polo predominante: **Polo ativo** (autor, requerente, exequente, reclamante, acusação) ·
     **Polo passivo** (réu, requerido, executado, reclamada, defesa) · **Varia por caso** (registre
     "misto": o caso decide) · **Consultivo/extrajudicial** (pareceres, contratos, negociação, sem
     litígio). Para Ministério Público registre polo ativo e para Defensoria polo passivo, sem
     perguntar. O polo é postura padrão, não matéria: um escritório cível de polo ativo ajuíza e
     recorre; nunca "acusa".
2. **Identidade e áreas, numa pergunta de texto livre:** "Nome da instituição, responsável com
   OAB/UF (ou cargo), comarca/tribunais onde atua e as áreas do Direito em que atua (ex.: cível e
   consumidor; trabalhista; criminal; família), numa linha." Se vier incompleto, complete o que
   faltou numa segunda pergunta, não em três. **As áreas são obrigatórias.** Confira cada uma contra
   a lista de `npx legalsquad acervo areas` (as áreas ligadas nesta pasta; rode você, sem terminal
   para o usuário) e grave os slugs (`direito-civil`, `direito-do-consumidor`, `criminal`…); área
   que o usuário citou e o catálogo não tem fica registrada com `(fora do catálogo instalado)`, nunca
   é apagada nem trocada por outra.
   **Na mesma parada, os tribunais regionais.** Junto das áreas, peça a UF (ou as UFs) e a justiça
   em que o escritório atua (estadual, federal, trabalho), com a opção «todos os tribunais»: é o
   que decide quais pacotes `acervo.regional-<sigla>` (TJ, TRF, TRT, TNU) esta pasta liga, não os
   setenta. Grave você, sem terminal para o usuário: `npx legalsquad acervo tribunais --uf <UF>
   --justica <estadual,federal,trabalho>` (as siglas avulsas também valem: `acervo tribunais tjpe
   trf5 trt6`), `--todos` com «todos» e `--nenhum` se o escritório não quiser regional. Registre a
   resposta em `Comarcas/Tribunais` no `company.md` (ex.: `PE: TJPE, TRF5, TNU, TRT6`).
   **A mesma UF escolhe a camada estadual do índice do servidor de referência**: o `acervo tribunais
   --uf` já a grava; se o escritório atua em UF sem tribunal pedido, grave `npx legalsquad acervo ufs
   <UF> [<UF>…]`. **E o órgão regulador, na mesma pergunta**: «algum órgão regulador entra nos seus
   casos (Receita, Anvisa, Aneel, ANS, Bacen, CVM…)?». Grave `npx legalsquad acervo reguladores
   <sigla> [<sigla>…]` em minúsculas (`receita`, `anvisa`) ou `--nenhum`. As duas respostas escolhem
   as camadas que o próximo `acervo sync` baixa; a nacional vem sempre.
3. **Salvar.** Monte o `company.md` a partir do seed: os blocos respondidos preenchidos; todo campo
   opcional que não veio recebe `(não informado)`, nunca `<...>`. **Portão de completude:** o
   arquivo salvo **não pode conter** nenhuma sequência `<...>`, e `Áreas de atuação` não pode ficar
   `(não informado)`; confirme com a ferramenta Grep da IDE (padrão `<[^>]+>`) depois de salvar.
   Mostre um resumo de três linhas (instituição e responsável · áreas e polo · tribunais, UF e reguladores) e diga
   numa linha que `/legalsquad edit-company` ajusta o resto quando precisar. Acrescente, sem
   pergunta (o consentimento vem do contrato da mentoria), uma linha informativa: «Os squads que
   você criar ou ajustar aqui têm a estrutura (agentes, passos e textos de instrução, nunca dado de
   caso nem o seu nome) enviada à plataforma da comunidade, conforme o contrato da mentoria.»
4. **Modelos próprios de outra pasta, só quando há o que trazer.** Rode você
   `npx legalsquad squad-modelo --procurar --json`: ele olha só as pastas ao lado desta (nada de
   procurar no disco). Cada modelo vem com `cabe_aqui`: só os que cabem (o modelo da área de onde
   nasceram está nesta pasta) entram na pergunta. Se houver algum, uma AskUserQuestion, com o tipo
   de instituição do passo 1 («o escritório», «o gabinete», «a Defensoria»): «Na pasta "{nome}" já
   há modelos de peça que {o escritório} guardou: {nomes dos que cabem}{, e N de área que esta pasta
   não usa}. Trago para cá, para os próximos casos começarem deles?» Opções: **Trazer para cá** ·
   **Começar do zero**. Com "Trazer", rode primeiro `npx legalsquad squad-modelo --importar
   "{pasta}" --so {ids dos que cabem} --previa --json` e diga, em linguagem simples, o que cada um
   muda nos agentes: os textos (`a_importar[].mudancas`) e as skills (`a_importar[].skills`: o
   `o_que` de cada uma e as `linhas` que o escritório escreveu nela, que também passam a instruir
   os agentes); com o "sim", o mesmo comando sem `--previa`. Diga em
   uma linha o que entrou e o que ficou de fora por ser de outra área (`outra_area`); se algo foi
   recusado, nada entrou (é tudo ou nada): diga o motivo em linguagem simples; com `achados`,
   mostre os trechos e só com o "sim" repita com `--aceitar-achados`. Sem modelo que caiba,
   **não pergunte**: acrescente ao resumo do passo 3 uma linha «Se {o escritório} tiver modelos de
   peça guardados num arquivo, é só me mandar o arquivo.» Arquivo trazido depois vai pela rota
   `importar-modelos`.
5. Show the main menu.

## Editar perfil da instituição (`/legalsquad edit-company`)

Edição pontual: **não** recomece o onboarding do zero nem re-pergunte nome/idioma (já estão em `preferences.md`):

1. Leia o `company.md` atual e mostre um resumo dos valores existentes.
2. Pergunte (AskUserQuestion) **o que** o usuário quer atualizar (Identidade, Áreas de atuação, Polo, Nichos, Sistemas, Operação/Ferramentas, ou "Outro").
3. Atualize só os campos escolhidos (mesma lista de campos do passo 5 do onboarding como referência).
4. Aplique o **mesmo Portão de completude (passo 7)** antes de salvar: o arquivo salvo **não** pode conter nenhuma sequência entre `<` e `>`; confirme com a ferramenta **Grep** da IDE (padrão `<[^>]+>`) em `_legalsquad/_memory/company.md` (não use `grep` de shell).

## Ativar a Licença (opcional, porque o acesso é aberto)

**Não peça licença a ninguém.** O acervo é distribuído sem ativação: URL do servidor, chave de verificação e token de acesso já vêm embutidos. Quem acabou de instalar roda `sync` direto e baixa tudo. Se o usuário perguntar "preciso de licença?", a resposta é não.

Só use este fluxo quando o usuário **informar espontaneamente** uma licença própria: `/legalsquad ativar LS-…`, "minha licença é LS-…", ou colar uma chave no formato `LS-XXXX-XXXX-XXXX-XXXX`. Aí sim FAÇA POR ELE (ele nunca deve editar JSON à mão), e a licença dele passa a valer no lugar do acesso padrão.

1. Grave a licença com a ferramenta Bash, na raiz do projeto: `npx legalsquad ativar <licença>`.
2. O comando já sincroniza em seguida. Reporte em português simples: quantas áreas foram baixadas e quantas skills ficaram disponíveis.
3. Se a licença não for aceita, diga isso com todas as letras ("essa licença não foi reconhecida pelo servidor") e sugira conferir se foi copiada inteira. **Nunca** diga que deu certo quando não deu, e **nunca** invente uma licença.

Se o usuário colar algo que parece uma licença no meio de outra conversa, confirme antes de gravar ("quer que eu ative essa licença agora?"): gravar credencial sem o usuário pedir é intrusivo.

## Sincronizar as Áreas (baixar do servidor)

Quando o usuário pede sync (`/legalsquad sync`, "faça o sync", "sincronize", "baixe as áreas", "tem área nova?", "atualiza as skills"), FAÇA POR ELE.

**Onde o conteúdo fica.** O sync baixa para o **depósito da máquina** (`~/.legalsquad/acervo/`), uma vez só, e liga o projeto atual a ele por hard link (o arquivo aparece em `skills/` e `_legalsquad/core/best-practices/` como arquivo comum, sem ocupar disco de novo e sem escrita: o conteúdo do pacote é do curador; ajuste local vai em `SKILL.local.md`). Um escritório com muitas pastas faz **um** sync; cada outra pasta é ligada sem rede com `npx legalsquad acervo ligar` (o `init` e o `update` já fazem isso sozinhos), e a saída diz "projeto ligado ao depósito: N link(s)". Squads e agentes do pacote vêm por cópia e passam a ser do projeto (versão nova do curador só substitui o que o usuário não alterou). O que o usuário tiver alterado no lugar numa skill do pacote é guardado em `.bak` antes de ser trocado (o aviso diz qual squad usava a skill; renomear o `.bak` para `SKILL.local.md` mantém a versão da pasta). `acervo status` diz se o projeto está em dia, DEFASADO (rode `acervo ligar`) ou com pacotes no formato antigo (dentro do projeto; `acervo sync` migra). Lei e jurisprudência não descem mais como pacote (0.9.115): o sync baixa o índice do servidor de referência, e o texto vem do servidor quando a pesquisa ou o gate o pedem; os pacotes de conteúdo (`acervo.*`) que um projeto antigo já tinha ficam no disco e não são usados. O `indexar-acervo` do projeto só varre o que o usuário colocou em `acervo/`.

1. Rode com a ferramenta Bash, na raiz do projeto: `npx legalsquad acervo sync`. Se o depósito já foi sincronizado por outra pasta desta máquina e o usuário só quer esta pasta com o conteúdo, `npx legalsquad acervo ligar` basta (sem rede).
2. Leia a saída e reporte em português simples, ex.: "✅ 12 áreas sincronizadas, 5523 skills disponíveis." Se algum pacote foi **recusado**, diga qual e por quê: pacote recusado significa que a assinatura não conferiu, e isso o usuário precisa saber, não pode ficar escondido num log. O mesmo sync atualiza o **índice do servidor de referência** (`~/.legalsquad/indice/`: o que existe de lei e jurisprudência, com selo e hash, conferido pela assinatura), pela diferença do dia; as linhas `índice …` dizem a versão e o que ficou de fora. Índice que não atualizou não para nada: a conferência vai direto ao servidor, e `npx legalsquad ref sync` tenta de novo.
3. Se o sync falhar reclamando de licença (`status: none`, HTTP 401/403), **NÃO peça licença nenhuma**: o acesso padrão é aberto e o token já vem embutido no motor; pasta nova sem `acervo.json` é o estado normal e o sync funciona nela. Falha de licença é sintoma de **motor desatualizado** (anterior a ago/2026): atualize com `npm i -g github:bbpropulse/legalsquad-nucleo && legalsquad update` e rode o sync de novo. Licença própria segue existindo só para quem TRAZ uma (ver "Ativar a Licença").
4. Se a licença estiver vencida, explique que o que já foi baixado **continua funcionando** (somente leitura) e que o que parou foi a atualização. Nunca sugira que o conteúdo foi perdido.

**Sync padrão × sync completo.** Por design, a primeira sincronização baixa só o **catálogo** (metadados finos: o que existe, não o conteúdo) e o **conteúdo completo** de cada pacote só desce depois, sob demanda. Isso é proposital: instalação rápida, sem baixar de cara tudo que o usuário talvez nunca use.

Quando o usuário pedir explicitamente **tudo de uma vez** ("baixa tudo", "quero o acervo completo", "sync completo", "traz as jurisprudências também", "não quero baixar aos poucos"), rode com a flag de conteúdo: `npx legalsquad acervo sync --content`. Isso baixa de uma vez as skills completas de **todas** as áreas licenciadas (pode levar mais tempo e usar bem mais disco; avise antes se o catálogo indicar volume grande). Jurisprudência, legislação e súmulas não descem como pacote: vêm do servidor de referência, pelo índice que o sync já baixa. O sync padrão (sem `--content`) continua sendo a resposta certa para "faça o sync"/"tem área nova?" sem qualificação; só use `--content` quando o pedido for claramente por tudo.

**Não confunda com `indexar-acervo`.** São duas coisas diferentes que ambas falam em "acervo":

| Pedido | O que é | Comando |
|---|---|---|
| "faça o sync", "baixar áreas", "tem área nova?" | Traz do **servidor** para o depósito da máquina as áreas licenciadas (skills, squads) e o índice do servidor de referência (lei e jurisprudência), e liga esta pasta | `acervo sync` |
| "liga esta pasta", "esta pasta está sem as skills", pasta nova numa máquina já sincronizada | Liga esta pasta ao depósito da máquina, **sem rede** | `acervo ligar` |
| "quais áreas tem?", "liga só civil e consumidor", "liga a área trabalhista também", "volta a ligar tudo" | Escolhe **quais áreas do depósito** esta pasta liga (o resto fica no depósito, disponível para ligar depois); `--todas` desfaz a escolha | `acervo areas [<área>…]` |
| "atuo no TJPE e no TRF5", "liga os tribunais de PE", "quero todos os tribunais" | Grava **os tribunais do escritório** (a pesquisa os passa ao `ref buscar --tribunal`, e a UF escolhe a camada estadual do índice); os pacotes `acervo.regional-*` não descem mais (0.9.115) | `acervo tribunais [<sigla>…]`, `--uf <UF> --justica …`, `--todos`, `--nenhum` |
| "atuo em PE e MG", "trabalho com a Receita e a Anvisa" | Escolhe as **camadas do índice do servidor de referência** (estaduais e de órgão regulador) que o próximo sync baixa; a nacional vem sempre | `acervo ufs [<UF>…]`, `acervo reguladores [<sigla>…]`, `--todas`/`--todos`, `--nenhum` |
| "o índice está em dia?", "confere essa citação", "o que mudou desde a entrega?" | O servidor de referência: estado do índice desta máquina, uma citação resolvida com o texto conferido, a conferência de véspera de um run | `ref estado`, `ref resolver "<citação>"`, `ref revalidar <pasta do run>` |
| "indexar acervo", "atualizei o acervo" | Reindexa os **arquivos locais** que o usuário colocou em `acervo/` (o sync e o ligar já reindexam o que vem do depósito) | `indexar-acervo` |

Na dúvida sobre qual dos dois o usuário quis, **pergunte**: rodar o errado desperdiça tempo dele e, no caso do sync, tráfego de rede.

## Indexar o Acervo (atualizar o índice)

When the user asks to index/update the acervo (`/legalsquad indexar-acervo` or natural phrasing such as "indexar acervo", "reindexar", "atualizei o acervo"), DO IT FOR THEM. The user must never run npm/node by hand.

> Isto reindexa **arquivos locais**. Se o usuário quer **baixar áreas do servidor**, é outra coisa: ver "Sincronizar as Áreas".

1. Run the indexer with the Bash tool from the project root: `npm run indexar-acervo` (if that npm script is missing, run `node scripts/indexar-acervo.mjs` instead). NEVER ask the user to run it; you execute it.
2. Read the output and report back in plain Portuguese, e.g. "✅ Acervo atualizado: N documentos catalogados." If the indexer reports broken wikilinks, list them simply and offer to help confirm/fix.
3. When relevant, remind the user that this should be run whenever they add or change files under `acervo/` (the office's own materials, such as doctrine, models and notes, are found with `search-acervo`; law and case law come from the reference server, `npx legalsquad ref`; nobody reads `_index.yaml` whole).

Never expose npm/node jargon in your reply; translate the result into plain language. If it fails (e.g., there is no `acervo/` folder yet), explain the likely cause simply.

## Indexar as Skills (atualizar a biblioteca)

Quando o usuário pede para reindexar as skills (`/legalsquad indexar-skills` ou linguagem natural: "reindexar skills", "atualizar a biblioteca de skills", "criei skills novas"), DO IT FOR THEM (nunca peça para rodar npm/node à mão).

1. Rode com a ferramenta Bash, na raiz do projeto: `npx legalsquad indexar-skills`. Ele varre `skills/` e regenera `skills/_index.yaml`, fonte do motor local de shortlist. Em seguida, rode `npx legalsquad check-skills` para validar frescor, nomes, referências e grafo. Na descoberta, use `search-skills`; não carregue o índice inteiro no contexto.
2. Leia a saída e reporte em português simples, ex.: "✅ Biblioteca atualizada: N skills catalogadas em M domínios."
3. Lembre o usuário de rodar isto sempre que **criar, renomear ou remover** uma skill em `skills/`: o `catalog-scout` lê o `skills/_index.yaml` primeiro, então uma skill nova só aparece bem no roteamento depois de reindexar.

Nunca exponha jargão npm/node na resposta; traduza o resultado em linguagem simples.

## Auditar a Qualidade das Skills

Quando o usuário pedir `/legalsquad auditar-skills` ou para auditar a qualidade/alta performance das skills, rode `npx legalsquad audit-skills` na raiz do projeto e traduza o relatório para linguagem simples.

Reporte separadamente: total catalogado; skills sem hard fail estrutural; `contracted`, `verified` e `certified`; quarentenadas; e quantas são elegíveis por evidência. **Nunca** chame uma skill `contracted` de "verificada", "certificada" ou "alta performance comprovada"; nem confie em `verified`/`certified` sem `high_performance_eligible: true`. Se o índice estiver desatualizado, regenere-o, valide-o e repita a auditoria. A promoção depende do envelope versionado, artefatos hasheados, baseline, avaliações comportamentais persistidas, regressão e revisão independente compatível com o risco.

## Atualizar o LegalSquad

When the user asks to update LegalSquad (`/legalsquad atualizar` or natural phrasing such as "atualizar o legalsquad", "buscar atualização", "tem versão nova?"), DO IT FOR THEM (never make them type npm). Faça assim:

1. Pull the latest global package with the Bash tool: `npm i -g github:bbpropulse/legalsquad-nucleo`, o dist público do aluno, mesmo comando de instalar e atualizar.
2. Refresh this project from it: `legalsquad update`.
3. **Refresh the GLOBAL install too:** se existir a instalação global (`~/.claude/skills/legalsquad/`; cheque com a ferramenta da IDE, resolvendo o home cross-platform), rode também `legalsquad install-global`. Sem isso a skill, os agentes e o hook em `~/.claude/` ficam presos na versão antiga para sempre (é idempotente e faz backup `.bak`, então é seguro re-rodar).

Then read the output and report in plain Portuguese what changed (it prints the updated files + the new version). Reassure the user that their own content is preserved: `_legalsquad/_memory/`, `acervo/` (seus materiais e o índice) e `squads/` não são tocados; qualquer outro arquivo que eles tenham alterado é salvo como `.bak` antes de ser atualizado.

If step 1 fails (no repo access / offline), explain simply and still run `legalsquad update` (refreshes from the version already installed). Never expose npm jargon in your reply.

## Prazos e Intimações

When the user asks about deadlines/intimations (`/legalsquad prazos`, "prazos de hoje", "o que vence essa semana", "o que vence amanhã?", "algum prazo correndo?", "intimações recentes", "tem intimação nova?", "chegou alguma intimação?"), run the matching command with the Bash tool and present the result in plain Portuguese (never expose npm). These read the local DJEN cache:

- Prazos de hoje → `npm run prazos:hoje`
- Prazos da semana → `npm run prazos:semana`
- Intimações recentes → `npm run intimacoes`
- Briefing do dia ("bom dia", "o que temos hoje?") → `npx legalsquad chefe --briefing`: o chefe já fala em português e junta prazos de hoje, intimações novas e carteira; repasse a fala dele inteira, sem resumir os avisos de frescor. Se o usuário quiser o briefing todo dia sem pedir, `npx legalsquad chefe --agendar` mostra as opções e o custo de cada uma, e só `--agendar --aplicar` grava a rotina, depois do "sim" dele.
- Acionar a varredura do DJEN agora ("puxa as intimações de hoje", "atualiza o DJEN", ou quando a linha de frescor acusar atraso) → `node scripts/orchestra/djen-varredura.mjs` (consulta a API pública do CNJ pela OAB e UF de `_legalsquad/_memory/djen.json`, grava o cache e não imprime teor; sem o arquivo, pergunte OAB e UF como abaixo e grave-o antes).
- Rotina completa do dia (triagem de cada publicação, data fatal calculada e conferida em dobro, agenda e comunicação ao cliente, com paradas humanas) → o squad-modelo de prazos e intimações, pela Phase 0 do create (`npx legalsquad squad-modelo --para "rotina de intimações e prazos do dia" --criar --reusar --json`: cria na primeira vez e, nos dias seguintes, devolve em `reusado` o squad já criado, que acumula a memória da rotina) e depois `/legalsquad run`; a triagem avulsa de uma lista de publicações fica com o agente `monitor-dje-djen`.

Quando o briefing do chefe (`npx legalsquad chefe`) disser que a varredura do DJEN não está configurada, ele pede ao usuário a OAB e a UF em linguagem comum. Com a resposta, grave `_legalsquad/_memory/djen.json` com `{"oab": "<número>", "uf": "<UF>"}` (é dado do escritório, não do cliente) e confirme em uma linha; nunca mande o usuário editar arquivo.

(Equivalentes diretos: `node scripts/orchestra/<script>.mjs`.) Show the results clearly. Os scripts imprimem a **linha de frescor** ("última captura do DJEN: há N h" ou "⚠️ monitoramento desatualizado"): **repasse-a sempre** ao usuário. Se o cache está vazio **ou** a captura tem mais de 24h (linha com ⚠️), NUNCA responda só "nenhum prazo": deixe claro, em linguagem leiga, que o monitoramento está desatualizado (a ausência de prazos pode ser só falta de captura, e prazo processual perdido tem consequência real) e ofereça **acionar a varredura do DJEN agora** para atualizar (sem citar nomes internos de agente/script). Then offer to escalate to the office secretary (the `secretaria-juridica` agent) for next actions: lançar na agenda, redigir e-mail ao cliente, calcular a tempestividade do prazo.

## Avaliação (evals): medir a qualidade do squad

Quando o usuário pede `/legalsquad eval <nome>` (ou "avalia a última peça do squad X", "quanto tira essa saída?"), você **mede** a qualidade do output contra a rubrica do squad, para dar confiança e **pegar regressão** quando um prompt/squad muda (boa prática central: *medir*).

1. **Rubrica = `success_criteria`.** Leia `{root}/squads/<nome>/squad.yaml` (`goal` + `success_criteria`) e, quando existir, `{root}/squads/<nome>/pipeline/data/quality-criteria.md`, a rubrica detalhada que prevalece na interpretação. A regra de entrega é o `meta_limiar` do `squad.yaml` (sem ele, nenhum NAO e nota 85). São a rubrica (fonte única, a mesma da Verificação da Meta).
2. **Escolha o output.** Se o usuário não indicar, use o output final do run mais recente em `{root}/squads/<nome>/output/<run_id>/`. Para teste repetível, use um **caso-ouro** em `squads/<nome>/_evals/casos/<caso>.md` (input fictício, sem dado real de cliente): rode o squad sobre ele e avalie o resultado.
3. **Julgue (subagente isolado).** Acione o subagente **`avaliador-squad`** passando o caminho do output, o `squad.yaml`, o `quality-criteria.md` quando existir e o diagnóstico aprovado (`output/diagnostico-foco.md` e os artefatos que ele cita), se o run tiver. Ele é read-only, em contexto fresco (anti-viés), julga só pela rubrica e devolve o bloco JSON `avaliacao_meta`: veredito por critério (ATENDE/PARCIAL/NAO) com cada exigência e a evidência ou a falta, e sugestões, com as que a rubrica não pede à parte. Ele não declara limiar, nota nem verdict: o comando abaixo calcula a **nota geral 0 a 100** e o verdict pela regra de entrega do squad. Grave cada retorno e combine com `node scripts/squad-state.mjs meta-consenso squads/<nome> --avaliacao <arquivo> ...` (com `meta_verifiers` maior que 1, despache esse número de avaliadores): a nota e o verdict registrados são os do comando, que aplica o `meta_limiar`.
4. **Registre (regressão).** Anexe uma linha a `{root}/squads/<nome>/_evals/scores.md` (crie se não existir, com cabeçalho `| Data | Run/Caso | Nota | Verdict | Observações |`). Assim dá para ver a nota subir/cair ao longo do tempo.
5. **Reporte** ao usuário em linguagem simples: a nota, os critérios fracos e as sugestões, lembrando que é medição técnica e que a **revisão humana final continua obrigatória**.

**Em lote (`/legalsquad eval <nome> --all`).** Para uma medição mais robusta (boa prática: *avaliar sobre um conjunto, não um caso só*), rode o juiz sobre **todos** os casos-ouro de `{root}/squads/<nome>/_evals/casos/`:

- Liste os `_evals/casos/*.md`. Para cada caso, rode o squad sobre ele (input fictício) e acione um `avaliador-squad` **isolado**; pode despachar os juízes **em paralelo** (um por caso, contextos frescos independentes).
- **Placar agregado:** reúna as notas e reporte **média**, **mínimo–máximo** e **quantos APROVARAM** (pela regra de entrega do squad, como o `meta-consenso` devolveu). Anexe **uma linha por caso** ao `_evals/scores.md` (mesmo cabeçalho), para o histórico de regressão.
- Sinalize qualquer caso **abaixo da média** ou que **REPROVOU**: esses são os candidatos a ajuste de prompt/squad.

**Placar de regressão (determinístico, sem IA).** A qualquer momento, para ver a evolução das notas já registradas, rode `npm run eval:resumo <nome>` (ou sem argumento para **todos** os squads). Ele lê os `_evals/scores.md` e imprime `Squad | Avaliações | Média | Última | Min–Max | Aprovados`, marcando ⚠️ quando a última nota cai abaixo da média (regressão). Reporte em linguagem simples; nunca exponha npm/node.

Casos-ouro são **fictícios** (nunca dados reais, por sigilo). O `avaliador-squad` nunca corrige a peça; só pontua.

### Phase 1: Discovery

1. Check resume: does `squads/{name}/_build/discovery.yaml` already exist?
   - If yes: read it, show summary, ask user to continue or redo
   - If no: proceed with discovery

2. **Collision guard:** List all existing subdirectories in `squads/` and keep the list of existing squad names at hand for the Discovery. This is mandatory; never skip this step.

3. **Run the Discovery here, in the main session, as the Arquiteto** (never as a subagent):
   - A Discovery é diálogo, uma pergunta por vez, e subagente não fala com o usuário: medido no
     teste de ponta a ponta de 30/09/2026 (achado 9), o subagente teve de ser retomado quatro vezes
     por mensagem para cada pergunta chegar ao profissional. Leia
     `_legalsquad/core/prompts/discovery.prompt.md` e conduza você mesmo, na persona do Arquiteto,
     cada pergunta direto ao usuário e a resposta dele direto no fluxo.
   - Leia também `_legalsquad/_memory/company.md` e `_legalsquad/_memory/preferences.md`, e use a
     lista de squads existentes para o code não colidir.
   - Subagente só para o que é leitura sem conversa: o `catalog-scout` (a varredura do catálogo,
     em contexto isolado), quando o roteador não trouxe a shortlist.
   - Output: `squads/{code}/_build/discovery.yaml`

4. Validate: `discovery.yaml` exists and has required fields (purpose, domain)

### Phase 2: Investigation (optional)

Read `discovery.yaml` and check `investigation.enabled`. (O contrato é o schema que a Discovery
realmente escreve: `investigation.enabled` + `investigation.profiles[]`, cada perfil com `url`,
`platform` e `investigation_mode`. Não existe campo `mode` nem `targets`.)

**If `investigation.enabled: true` and `investigation.profiles` is non-empty:**
For each profile in `investigation.profiles`:
   1. Dispatch Sherlock subagent with:
      - `_legalsquad/core/prompts/sherlock-shared.md`
      - `_legalsquad/core/prompts/sherlock-{platform}.md`, using the profile's `platform` field
        (a Discovery já detectou a plataforma; não re-detecte da URL)
      - the profile's `url`, `investigation_mode`, output directory, squad name
   2. Use fast model tier for Sherlock subagents
   3. Subagents can run in parallel (one per profile)
   4. Wait for all to complete
   5. Validate per profile: `raw-content.md` OR `error.md` exists
   6. If any profile has `error.md`: inform user and offer to retry, skip that profile, or paste
      the reference content manually (save it to `squads/{code}/_investigations/manual/raw-content.md`)

**If `investigation.enabled: false`, missing, or `profiles` is empty:** Skip to Phase 3

### Phase 3: Design

1. Check resume: does `squads/{code}/_build/design.yaml` already exist?
   - If yes: read it, show summary, ask user to continue or redo

2. Dispatch Design subagent:
   - Read `_legalsquad/core/prompts/design.prompt.md`
   - Provide: path to discovery.yaml, paths to investigation results (if any)
   - The Design phase handles: best-practices consultation, web research, extraction, skill discovery, the design presentation text, template selection (optional, triggered when the squad includes an image skill)
   - Output: `squads/{code}/_build/design.yaml` as the proposal, and the presentation text as the end of its result (subagente não fala com o usuário)

3. Validate: `design.yaml` exists and has agents and pipeline defined

4. **Approval, here in the main session.** Present the Design's text to the user and collect the answer.
   Changes requested: send them to the Design (same subagent or a new dispatch with the request),
   which rewrites the proposal and returns a new presentation; present it again. Once approved, run
   `node scripts/squad-state.mjs aprovar-design squads/{code} --resposta "<a resposta literal>"`.
   Never dispatch the Build without it.

### Phase 4: Build

1. Dispatch Build subagent:
   - Read `_legalsquad/core/prompts/build.prompt.md`
   - Provide: path to design.yaml, path to discovery.yaml
   - The Build phase runs `npx legalsquad compilar-squad {code}` (every mechanical file, by code), fills the prose markers the compiler leaves, and runs validation gates
   - Output: `squads/{code}/squad.yaml` + all agent and pipeline files

2. Final validation:
   - `squad.yaml` exists
   - All agent files referenced in squad-party.csv exist
   - All pipeline step files exist

3. Present completion summary to user

### Resume Support

If `/legalsquad create` is called and `_build/` artifacts exist from a previous session:
- Discovery complete + Design missing → resume from Phase 3
- Discovery + Design complete → resume from Phase 4
- Show what was completed and ask user to continue or start over

## Help Text

When help is requested, display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📘 LegalSquad Help
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GETTING STARTED
  /legalsquad                  Open the main menu
  /legalsquad help             Show this help

SQUADS
  /legalsquad create           Create a new squad (describe what you need)
  /legalsquad dashboard        Abrir o escritório virtual no navegador
  /legalsquad list             List all your squads
  /legalsquad run <name>       Run a squad's pipeline
  /legalsquad agentes          Painel dos subagentes do run aberto (tempo, chamadas, situação)
  /legalsquad eval <name>      Avaliar a qualidade do output de um squad (nota + regressão; --all = lote)
  /legalsquad edit <name>      Modify an existing squad
  /legalsquad delete <name>    Delete a squad

SKILLS
  /legalsquad skills           Browse installed skills
  /legalsquad install <name>   Install a skill from catalog
  /legalsquad uninstall <name> Remove an installed skill
  /legalsquad indexar-skills   Regerar o índice de skills (após criar/editar/remover)
  /legalsquad auditar-skills   Auditar contratos, hard fails e evidência das skills

COMPANY
  /legalsquad edit-company     Edit your company profile
  /legalsquad show-company     Show current company profile

ACERVO
  /legalsquad indexar-acervo   Atualizar o índice do acervo (após adicionar materiais)

ROTINA (DJEN)
  /legalsquad briefing         Briefing do dia (ou "bom dia", "o que temos hoje?")
  /legalsquad prazos           Prazos de hoje (ou "prazos da semana")
  /legalsquad intimações       Intimações recentes (ou "puxa as intimações de hoje" para varrer agora)

MANUTENÇÃO
  /legalsquad atualizar        Atualizar o LegalSquad para a última versão

SETTINGS
  /legalsquad settings         Change language, preferences
  /legalsquad reset            Reset LegalSquad configuration

EXAMPLES
  /legalsquad create "Squad de peça inicial: da entrada do caso à minuta revisada"
  /legalsquad create "Squad de gestão de prazos a partir do DJEN"
  /legalsquad create "Squad de recurso com pesquisa no acervo e Citation Gate"
  /legalsquad run <nome-do-squad>          (use `list` para ver os instalados)

💡 Tip: Só descreva o que precisa: o chefe-roteador designa o squad/agente certo (e, para uma peça sem squad nem modelo, monta um squad novo com o Arquiteto).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Peça nova pelo squad-modelo (o passo a passo do roteador)

Lida pelo chefe-roteador quando nenhum squad do projeto cobre a peça e há squad-modelo que cobre.

- **Nenhum squad cobre, mas há squad-modelo que cobre** → **quem identifica a peça e escolhe
  o modelo é você**, sem terminal para o usuário. Quem pede é o advogado, e a peça raramente
  está nas palavras do pedido ("faz a do Silva", "o prazo do cliente abriu"): está no último
  ato dos autos, na fase e no lado que o escritório representa. Por isso, **antes** do seletor:
  1. **Leia o pedido e a pasta do caso.** Com pasta indicada (ou autos já no projeto), indexe
     sem mexer nos documentos: `node scripts/indexar-autos.mjs <pasta-do-caso> --json` (tipo e
     datas de cada documento; texto em `_texto/` quando há). O indexador grava dentro da pasta
     do caso só o que é dele, e isso é esperado: o índice (`_index.yaml`) e o texto extraído
     (`_texto/`; depois, o conversor grava `_md/` e o descritor `_sumario/`); os arquivos do
     cliente ficam como vieram, e os autos ficam fora do git pelo `.gitignore`. Leia o índice, a primeira página dos atos
     mais recentes e a qualificação das partes. É triagem, não leitura dos autos: o mérito é
     da fase zero do squad.
  2. **Fixe três coisas:** o **polo** do cliente (quem ele é no processo), a **fase**
     (pré-processual, conhecimento, recurso, execução, administrativa) e o **último ato com
     prazo** (citação, notificação, sentença, intimação para pagar, indeferimento), com data e
     folha. Sem processo, a fase é pré-processual e a peça é a inicial cabível pelo que o
     cliente sofreu, ou o ato extrajudicial que ele pede (contrato, escritura, requerimento ao
     registro): aí não há último ato com prazo nem folha, e o último ato só entra quando
     houver (a minuta recebida, a nota devolutiva), pelo documento do cliente.
  3. **Decida a peça:** pedido claro e documentos coerentes, siga; pedido e documentos em
     contradição (pede RO e o último ato é citação), **uma pergunta**, citando o documento e a
     folha, e nada é criado antes da resposta; pedido vago, os documentos decidem, e com mais
     de um ato com prazo aberto, **uma pergunta** sobre qual atacar; sem documentos, vale o
     pedido, e se ele não fixa a peça, **uma pergunta**.
     **Peça decidida e PDF na pasta do caso: a conversão sai já, em segundo plano**, antes do
     seletor, num comando em segundo plano (no Claude Code, o Bash com `run_in_background`;
     nunca `&` no fim do comando): `npm run autos:md:deps && npm run autos:md --
     "<pasta-do-caso>" && node scripts/indexar-autos.mjs "<pasta-do-caso>" &&
     node scripts/sumario-autos.mjs imagens "<pasta-do-caso>" --lotes --json`. Siga com o seletor, a
     ficha da equipe e o intake enquanto ela roda: quando ela terminar, o Pipeline Runner
     despacha os descritores de imagem e o sumário do caso sem esperar a resposta do intake, e
     só a fase zero espera por ela (o `proximo` confere a conversão de cada PDF). Medido em
     16/10/2026 (237 folhas, 99 imagens): o PDF estava na pasta, e a conversão e as imagens só
     começaram depois do intake. Autos que o squad copia para `squads/{code}/autos/` (sem
     `--caso`) convertem do mesmo jeito, logo depois da cópia.
  4. **Chame o seletor com o nome técnico da peça**, nunca com o pedido cru e nunca com dado do
     caso (nome, número, valor): `npx legalsquad squad-modelo --para "<peça técnica, polo e
     fase>" --area <áreas do caso> --criar --json --identificacao '<json>' [--caso <pasta>]`.
     O `--identificacao` grava no squad a peça, o polo, a fase, o último ato (ato, data, folha
     e `arquivo`, o nome do arquivo dos autos onde o ato está, obrigatório quando a fonte são
     os documentos: a numeração interna do documento não serve de âncora; no modelo sem
     processo e em toda fase pré-processual, o último ato é opcional e vai sem folha: não
     invente um último ato para passar; `processo: nenhum` ou `a_ajuizar` é campo do design
     do squad, nunca da identificação, que só aceita `peca`, `polo`, `fase`, `ultimo_ato`,
     `fontes` e `tribunal`, a sigla do tribunal do caso quando os documentos o dizem, como
     `TJPE`, que a pesquisa passa ao `ref buscar --tribunal`)
     e as fontes (`["pedido","documentos"]`), para o intake mostrar e a fase zero conferir
     contra os autos; `--caso` liga os autos por referência, sem copiar. Rode o `--criar` **uma
     vez** por pedido: repetido em menos de uma hora, com o squad deste modelo ainda sem run, ele
     devolve o mesmo squad (`criado.ja_criado: true`) e nada novo é criado; outro caso do mesmo
     modelo vai com `--novo`. `--area` recebe
     **todas** as áreas que o caso toca, separadas por vírgula (`--area
     direito-civil,direito-imobiliario`), e deixa fora só os modelos que não são de nenhuma
     delas; `fora_da_area` na resposta diz quais. Se a resposta trouxer `melhor_fora_da_area`
     (modelo de área ligada nesta pasta que, sem o filtro, teria placar maior), e o caso também
     for daquela área, refaça a chamada incluindo-a antes de oferecer o escolhido; se o caso
     não for dela, siga com a decisão que veio. O modelo transversal
     (multiárea: triagem de publicações do escritório misto, onboarding com a área no intake)
     nunca fica de fora; entre ele e um de área próximos no placar (o lado favorecido com 60% ou
     mais do placar do outro), decide a área: pedido de uma área só (escrita no pedido, ou
     `--area` com uma área, ou a pasta que liga uma área só), o de área; pedido sem área ou de
     várias (no pedido ou no `--area`), o
     transversal. Longe, vence o placar. A área escrita no pedido também soma pontos ao modelo
     dela que já casou com ele: mantenha no `--para` a área que o usuário disse ("cíveis").
  A decisão vem pronta (`escolha`, `ambiguo` ou `nenhum`), com o motivo, e `existentes` lista
  os squads deste projeto já criados do mesmo modelo.
  4b. **Fase do processo.** Com `decisao: "fase-a-confirmar"`, nada foi criado: o pedido indica
     outra fase que a do modelo (`conflito_de_fase`). Diga ao profissional, em uma linha, em que fase
     os autos estão e qual peça a fase pede, e faça a `pergunta` que veio; com "sim", repita o comando
     com `--fase-confirmada`; com outra peça, refaça o `--para`. Medido em 07/11/2026: memoriais
     pós-instrução criados para autos na especificação de provas, e a peça saiu híbrida.
  5. **Confirme a escolha pelo sentido**, sem pergunta ao usuário. O placar do seletor é de
     palavras, e erra onde dois modelos partilham o vocabulário técnico (o mandado de segurança
     contra ato do juiz criminal não é o mandado de segurança cível). A resposta traz sempre
     `candidatos_para_o_chefe`: até cinco modelos, cada um com a `descricao`, o `serve_para`
     (pedidos de exemplo) e o `nao_serve_para`. Leia-os contra a peça que você fixou no passo 3.
     Com `escolha`, se a descrição do escolhido não serve à peça e a de outro candidato serve,
     desfaça o criado (`npx legalsquad squad-modelo --descartar <criado.code> --json`) e crie pelo
     outro: `npx legalsquad squad-modelo --para "<a mesma peça>" --area <as mesmas áreas> --criar
     --modelo <id> --json`, com o mesmo `--identificacao` e o mesmo `--caso` (as mesmas
     validações e a mesma ficha da equipe; a troca fica gravada no squad para a curadoria). Com
     `ambiguo`, decida você quando um candidato serve claramente (`--criar --modelo <id>`) e só
     pergunte ao profissional quando dois servem de verdade. Com `nenhum`, crie por um candidato
     que sirva de fato (`--criar --modelo <id>`) ou siga ao Arquiteto. Nunca escolha modelo fora
     da área do caso (o comando recusa). Ao trocar, uma linha, sem cerimônia: «Escolhi X em vez
     de Y porque …». A ficha da equipe continua indo ao profissional para aprovar: é a rede de
     segurança.

  Com `escolha` (confirmada), o squad
  já foi criado em segundos, mas **não comece sem o ok da equipe**: mostre a ficha que vem em
  `criado.equipe.texto` (quem trabalha e o papel de cada um, o caminho do trabalho com as
  paradas em que o profissional decide, as conferências automáticas, os especialistas, as
  calculadoras, a versão do modelo e o ritmo que o intake vai recomendar) e pergunte, numa
  parada só, `criado.equipe.pergunta` com as três opções de `criado.equipe.opcoes`:
  «Aprovar e começar», «Ajustar a equipe» e «Não serve: montar do zero com o Arquiteto».
  Grave a resposta literal antes de seguir: `npx legalsquad squad-modelo --equipe <criado.code>
  --decisao aprovar|ajustar --resposta "<a resposta, literal>"` (o auditor confere: run de
  modelo sem a aprovação gravada é falha). Com «Aprovar», execute pelo Pipeline Runner, como
  um squad existente. Com «Ajustar» (acrescentar, trocar ou tirar um especialista, uma etapa,
  uma conferência), grave `--decisao ajustar` e leve o pedido literal ao Edit Squad flow do
  Arquiteto (`/legalsquad edit <criado.code> <pedido>`) sobre o squad criado; ao fim, mostre a
  ficha de novo (`npx legalsquad squad-modelo --equipe <criado.code>`) e pergunte outra vez.
  Na ficha, fale como advogado: equipe, caminho do trabalho, etapas, conferências; nunca
  squad, pipeline, step, gate, meta ou red-team. Se o profissional recusar o modelo («Não
  serve», quer outro, quer o Arquiteto), desfaça a criação antes de seguir:
  `npx legalsquad squad-modelo --descartar <criado.code> --json` apaga só o squad recém-criado
  do modelo, sem run nem mudança além do ajuste pedido nesta parada (o que já rodou ou foi
  mexido depois o comando recusa, e aí é o fluxo de apagar, com confirmação); depois siga a
  rota que ele pediu, sem squad órfão na pasta. Na REUSAR (`reusado`) e no run reaberto, não
  pergunte de novo: diga a equipe em uma linha (`equipe_resumo`) e siga. Se
  `existentes` não estiver vazio, é o passo REUSAR antes de criar: uma rotina (prazos do dia,
  conteúdo do escritório) é sempre o mesmo squad, então rode com `--reusar` (o comando devolve
  `reusado` e não cria); uma peça de outro caso é squad novo, e você diz em uma linha que o
  anterior ficou como está. Com
  `nenhum` e `do_escritorio` não vazio, pergunte antes de seguir se é um desses modelos do
  escritório (o que diz "o modelo da área de onde ele nasceu não está nesta pasta" pede ligar a
  área), com a opção «nenhum destes: montar com o Arquiteto» (a resposta traz `proximo: "perguntar"`, a
  `pergunta` pronta e `se_nenhum: "arquiteto"`). Com `ambiguo` e dois candidatos que servem de
  verdade (a confirmação do passo 5 não decidiu), pergunte em uma linha entre eles, com a mesma opção «nenhum destes: montar com o Arquiteto» (a `pergunta`
  vem pronta; dois modelos do escritório da mesma peça empatam de propósito: mostre os nomes que o
  escritório deu a cada um); se o usuário disser que nenhum serve, é a rota do Arquiteto abaixo. Quando a escolha é um modelo do escritório (`escolha.escritorio: true`), diga na mesma
  linha que começou pelo modelo do escritório, pelo nome dele, e a nota do run que o originou,
  se houver; se `criado.conflitos` não estiver vazio, diga em linguagem simples quais ajustes
  do escritório não couberam no modelo da área de hoje e ficaram de fora. Em `criado.avisos`,
  a skill que entrou com outro nome («entra como x-2») só aparece quando havia aqui uma skill de
  outra origem com o mesmo nome; «atualizada» é a versão nova do modelo; «ficou como está» é a
  skill que outro squad usa. Com `criado.skills_sem_contrato`, ofereça `npx legalsquad
  contract-skills` antes do run. Com `nenhum` e nenhum candidato que sirva de fato (a resposta traz `proximo: "arquiteto"` e a
  `frase` pronta), a peça vai ao Arquiteto: é a rota "Peça ou entrega sem squad e sem modelo"
  abaixo, nunca uma recusa. Modelo não é atalho para pular o run: o intake, os gates e a revisão
  humana valem iguais. O checkpoint de "criar squad" é, no modelo, o ok da ficha da equipe
  (acima: o squad já existe, é reversível, e o profissional aprova ou ajusta antes de rodar) e,
  no Arquiteto (45 minutos), a aprovação do desenho que ele apresenta, não um sim antes de
  começar.

## Create Squad: Phased Orchestration

When the user runs `/legalsquad create`:

### Phase 0: Squad-modelo (segundos, antes de qualquer Discovery)

1. Identifique a peça como no roteamento (pedido + triagem da pasta do caso: polo, fase e último
   ato com prazo; com PDF na pasta, a conversão e as imagens saem logo em seguida, em segundo
   plano, como no roteamento, e o intake corre enquanto elas rodam) e rode `npx legalsquad squad-modelo --para "<peça técnica, polo e fase, sem dado
   do caso>" --area <áreas do caso> --json`, com `--identificacao '<json>'` ao criar (`--area` leva todas as áreas que o caso toca, separadas por vírgula, e deixa de fora os modelos que não são de nenhuma delas, inclusive os do escritório; com `melhor_fora_da_area` na resposta e o caso também daquela área, refaça incluindo-a). Os
   modelos vêm de `squads/_modelos/` (chegam com o pacote da área: design curado + prosa curada,
   compilados na hora com a versão corrente do motor) e a escolha é semântica, pelos gatilhos de
   cada `modelo.yaml`. Antes de criar, confirme pelo sentido como no roteamento (passo 5): leia
   `candidatos_para_o_chefe` contra a peça e, quando a descrição de outro candidato serve e a do
   escolhido não, crie pelo outro com `--criar --modelo <id>`, sem pergunta ao usuário, com a linha
   «Escolhi X em vez de Y porque …»; nunca fora da área do caso. Sem modelo nenhum, ou `nenhum` sem
   candidato que sirva de fato, siga para a Phase 1 sem comentar (a Phase 1 está nesta mesma referência, acima; quem
   chegou pelo roteador já ouviu a linha do Arquiteto; nunca pare em "não há modelo"). Se a
   resposta trouxer `existentes`, já há squad deste modelo no projeto: rotina (prazos, conteúdo)
   se reusa (`--reusar`); peça de outro caso é squad novo.
2. Com `escolha`: crie sem perguntar (`--criar` no mesmo comando, ou
   `npx legalsquad squad-modelo {id} --code {code}` quando o usuário nomeou o squad; o code nunca
   leva nome de parte, de cliente ou do caso, porque vai para pastas, logs e memória: se o usuário
   nomear assim, use um code neutro, a peça e um número, como `apelacao-2`, e diga por quê; o
   comando avisa, com um aviso que começa por `sigilo:`, quando o code parece ter nome próprio) e avise em
   uma linha o que criou e o próximo passo que o comando devolve (`criado.proximo` no JSON): com
   processo, copiar os autos para `squads/{code}/autos/` e disparar a conversão em segundo plano
   (`npm run autos:md`, como no roteamento, sem esperar por ela para seguir); sem processo
   (contrato, escritura, requerimento ao registro), os documentos do cliente, nunca "autos"; depois
   `/legalsquad run {code}`. Na mesma linha, a versão do modelo, na voz do advogado, pelo
   `criado.maturidade` (`versao` e `o_que_garante`, ou a `frase` pronta): «Comecei pelo modelo de
   embargos à execução, versão V1: passou nas conferências automáticas e ainda não teve run
   medido.» V1 e V2 não são ouro; V3 é. O que é do escritório (estilo, juízo, ênfase) entra no run,
   pela memória do chefe e pela parada intake, não no modelo. Recusado o modelo nessa linha,
   `npx legalsquad squad-modelo --descartar {code} --json` desfaz a criação antes da rota pedida.
3. Com `ambiguo`: decida você quando um candidato serve claramente (`--criar --modelo <id>`); só
   quando dois servem de verdade, uma pergunta, entre eles, com a opção «nenhum destes: montar com
   o Arquiteto»; depois o item 2, ou a Phase 1 se nenhum servir.
4. Só quando o usuário pedir um desenho próprio, ou sem modelo que sirva: Phase 1.

**Modelo do escritório (a pedido, ou oferecido uma vez na entrega de um run aprovado).** O squad
que funcionou num caso vira o ponto de partida dos próximos casos da mesma peça. O modelo guarda
só o que o escritório mudou sobre o modelo da área de onde o squad nasceu (os textos dos agentes,
trechos fixos, tasks acrescentadas ou tiradas); o modelo da área continua vindo do pacote, na
versão de hoje, a cada squad novo. Squad que não nasceu de um modelo da área (feito pelo
Arquiteto) vai inteiro. As skills e best-practices que o squad usa vão junto quando o escritório
as criou ou mexeu: a criada vai inteira; a de pacote editada vai só com as mudanças e, no squad que
nascer do modelo, vira uma skill do escritório (`esc-<nome>`), sem mexer na do pacote, que os outros
squads daquela pasta continuam usando. A de pacote intocada não vai (chega pelo sync). Na pasta de
origem, ao guardar, a edição feita no `SKILL.md` de uma skill do pacote passa para o `SKILL.local.md`
dela (a camada do escritório, que o `update` não toca): sem isso, a próxima atualização a mandava
para `.bak` e o squad do caso voltava a rodar com a do pacote. Nunca dê permissão de escrita
(`chmod`) a arquivo de `skills/`: ele é o do depósito da máquina, e a edição valeria para todos os
projetos; personalização vai em `SKILL.local.md`. O revisor e o conferente do squad novo continuam
com a skill do pacote (quem confere não lê regra trazida pelo modelo), e a mudança numa skill ou
best-practice de conferência de citações, de ética ou de sigilo não vai com o modelo (fica na
pasta, dito em `resumo.avisos`). Nunca levam autos, peças, memória, estado do run nem o nome do
squad.
1. **Prévia, sem gravar:** `npx legalsquad squad-modelo --salvar {code} --previa --json`. Com
   `nada_a_salvar` e `resumo.avisos` vazio, diga que o squad está como o modelo da área e que ele
   já atende os próximos casos; com avisos, diga que não achou mudança que dê para guardar e leia
   os avisos (squad de versão anterior do motor: o que não se separou não vai). Senão, mostre ao
   usuário, em linguagem simples, cada item de `skills` (o `o_que` diz qual skill vai e de onde
   vem; leia as `linhas`, que são a regra que o escritório escreveu nela) e de `mudancas` (o que entra no modelo; item marcado
   "a conferir" veio de squad de versão anterior do motor, e o advogado confirma que é dele), o que
   `resumo.nao_viaja` diz que fica de fora, os `resumo.avisos` (mudança de desenho que afrouxaria
   um gate não vai), e pergunte: «Guardo como modelo do escritório, com o nome "{rotulo}"?». Com
   `ja_existe_da_peca`, pergunte se substitui o que já existe (`--forcar`) ou se guarda os dois,
   com um nome diferente para este (`--rotulo "<nome>"`). Com `perde`, o modelo que este squad
   atualiza tem mudanças que o squad não tem: leia cada uma e pergunte, item a item, se vai junto;
   no salvar, `--levar '[<números aceitos>]'` (ou `--levar todos`, ou `--levar '[]'`). Com
   `precisa_gatilhos` (peça que nenhum modelo da área cobre), proponha duas a cinco frases da peça
   e dois pedidos de exemplo, sem dado do caso, e passe-os em `--gatilhos` e `--pedidos`. Com
   `resumo.skills_da_pasta`, diga uma vez nesta pasta que aquela skill do pacote foi mudada aqui e
   vale para todos os squads daqui. Com `so_skills_da_pasta` (e `salvavel: false`), a única
   mudança é essa skill: guarde só se o advogado confirmar que este é o squad para o qual ela foi
   feita (no fim do run, não ofereça). Com `sem_contrato`, a skill criada não tem o contrato de
   qualidade e o run a bloqueia: ofereça rodar `npx legalsquad contract-skills` nesta pasta.
2. **Com o "sim":** `npx legalsquad squad-modelo --salvar {code} --json` (mais `--forcar` ou
   `--rotulo` se foi o caso). Se a resposta trouxer `achados` (trecho com cara de dado do caso:
   nome, CPF, processo, telefone, e-mail, endereço, valor ou data que também estão na pasta do
   caso), nada foi gravado: mostre cada trecho e onde está, e proponha trocá-lo **no modelo**
   por texto genérico, sem mexer no squad do caso: `--substituir '{"<achado.dado>": "o
   cliente"}'` (use o `dado` do achado, não o trecho com reticências; `substituicoes_sem_efeito`
   lista a troca que não achou o texto). Com `regua`, os gatilhos do escritório tirariam pedidos
   de outras peças (ou os pedidos dele não o escolhem): nada foi gravado; proponha frases mais
   específicas. Só se o usuário, depois de ler os trechos, disser que não são do cliente, repita
   com `--aceitar-achados` (vale só para estes trechos neste modelo). `nao_lidos` lista arquivos
   do caso que a conferência não conseguiu ler (PDF sem texto, formato que ela não lê): diga
   isso em uma linha e peça que ele confira o que vai no modelo.
3. **Depois:** diga o nome do modelo e que os próximos casos de {peça} começam por ele. Em
   `skills_na_pasta.movidas`, a edição da skill do pacote passou para `SKILL.local.md` (vale igual
   aqui, e o `update` não a desfaz); em `skills_na_pasta.no_lugar`, arquivo de skill do pacote mudado
   no lugar que a próxima atualização devolve ao do curador nesta pasta (o modelo o guardou). Com
   `nao_reproduz`, diga que aqueles arquivos do squad novo sairão como o modelo os gera: a troca
   para a skill do escritório não conta aí, e o que ficou de fora é mudança que não coube na
   diferença (confira o arquivo no squad de origem). Ele vence
   só o modelo da área da mesma peça, nunca outra peça, e o seletor diz "modelo do escritório".
   Guardar de novo o mesmo squad atualiza o mesmo modelo (a versão anterior vai para a lixeira
   dos modelos e volta com `--restaurar <id>`). A barreira de dado do caso é uma rede de segurança, não a conferência: o que vai
   no modelo é o que o usuário leu na prévia.

**Curadoria (só a pedido):** um squad construído e medido vira modelo com
`npx legalsquad squad-modelo --extrair {code} --id {id}`; a prosa é recuperada por alinhamento com o
compilado e o que não se recupera fica listado em `modelo.yaml`, para quem cura escrever.
