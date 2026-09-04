# Changelog

## [Unreleased]

## [0.6.1] - 2026-09-04

### Corrigido

- **O Redação Gate bloqueava a gravação da peça em TODA instalação.** O hook `verifica-redacao.mjs`
  carregava a decisão por import dinâmico de `src/redacao-gate.js`, tentando dois caminhos:
  `legalsquad/src/redacao-gate.js` (só resolve com o pacote em `node_modules`, e o aluno instala
  global) e `../../src/redacao-gate.js` (aponta para `{projeto}/src/`, que não existe). Os dois
  falhavam, e o gate caía no fail-closed — que é o comportamento certo para um gate que não consegue
  carregar a própria lógica, e que aqui significava **"REDAÇÃO GATE — BLOQUEADO"** em cima de toda
  peça, em todo projeto.

  É o mesmo defeito do `cobertura-acervo`, e o motor já tinha o mecanismo. As 452 linhas de
  `src/redacao-gate.js` — módulo puro, sem imports — viram o bloco sincronizado `redacao-gate`,
  copiado verbatim para os hooks do Claude Code e do Codex. São 7 blocos e 14 cópias, guardados pela
  suíte: divergir passa a quebrar o `check:blocos`.

  Achado por um usuário ao rodar `/legalsquad atualizar` num projeto real — não por teste nosso.

### Alterado

- **Step B do `build.prompt.md` passa a declarar a ordem de geração em três ondas** — alicerce
  (`squad.yaml` e party), topologia (`pipeline.yaml`), e só então os agentes e os steps. O que a
  onda anterior fixa, a seguinte consome.

  **A tentativa de paralelizar a onda 3 foi revertida, e o prompt agora proíbe explicitamente
  refazê-la.** A hipótese era que o minuto por arquivo fosse ida e volta de turno; o build cego
  mediu o contrário. Emitir N arquivos numa mensagem estoura o limite de saída: a mensagem é
  truncada, e o run trava. No teste, três arquivos saíram no ritmo serial de sempre, seguiram treze
  minutos de silêncio e o build morreu sem terminar. O custo é tempo de GERAR duzentas linhas, e
  esse não se comprime empacotando chamadas.

## [0.6.0] - 2026-09-04

### Corrigido

- **O squad-modelo contradizia o prompt que manda espelhá-lo.** O `build.prompt.md` diz "espelhe os
  agentes de um squad-modelo de peça já presente"; o `peca-modelo` distribuído trazia steps com
  frontmatter sem `agent:`, `execution:` nem `outputFile:`, e corpo com apenas duas seções
  (`## Para o Pipeline Runner` e `## Ação`) contra as sete que o Arquiteto tem de escrever. Ele
  escapava porque não tinha `_build/`, e a isenção dos Gates 1, 1b e 2 para squad escrito à mão é
  deliberada. **O defeito não era a isenção: era mandar espelhar um squad isento de regras que quem
  espelha tem de cumprir.** Um build cego mediu o custo — o agente teve de escolher entre o prompt e
  o modelo, e só acertou por ler com cuidado; um Arquiteto mais literal entregaria step sem seção.

  Os 11 steps foram regerados no formato do Arquiteto, com conteúdo real em cada seção (Context
  Loading nomeando os artefatos por caminho, Veto Conditions e Quality Criteria próprios de cada
  step). A fixture ganhou `_build/design.yaml`, de modo que os gates de seção passam a cobrar o
  modelo e a divergência vira falha de suíte. O `_build/` não viaja para `templates/`: o exemplo
  distribuído continua sendo squad editável, agora demonstrando o formato certo.

  Junto: `sync-templates-squads` passou a esvaziar também o `skills:` do frontmatter dos agentes.
  Sem isso, o exemplo distribuído declarava skills `demo-*` que a instalação nova não tem, e o
  primeiro `check-squad` do usuário devolvia `skill-declarada-inexistente` (erro).

- **O Citation Gate era conferido no squad inteiro, não onde a citação nasce.** Bastava
  `[NÃO VERIFICADO]` aparecer em qualquer arquivo. Provado num build cego: removidos os marcadores
  do step de redação, o squad seguia `✓ estrutura íntegra` porque a palavra sobrevivia noutro canto.
  Num squad cujo design não pediu step de pesquisa — e o `build.prompt.md` manda não criar o que o
  design não pede — isso significa peça jurídica gerada **sem disciplina de citação nenhuma**, e
  aprovada. Passa a ser cobrado na cadeia: o step que redige, o agente dele e os steps que o
  alimentam. O squad-modelo, que carrega a marca no step de pesquisa, continua correto.

- **O `build.prompt.md` quase induzia o erro `comando-da-cli-inexistente`.** A seção do Step de
  PESQUISA mandava ler o escopo autorizado "com `run-status`", solto, sem dizer como invocá-lo — e
  `npx legalsquad run-status` não existe. Foi essa linha que fez um Arquiteto escrever o comando
  inválido num squad real. Agora o prompt dá a forma correta, diz com todas as letras que é script e
  não subcomando, e a regra entrou na tabela do Step C.1.

- **Reindexar não via a conversão feita depois.** `indexar-autos` reaproveita a entrada quando o PDF
  não mudou — e a conversão para Markdown roda DEPOIS do índice, que é a ordem natural (indexar para
  saber o que há, converter em seguida). A entrada voltava do cache com `markdown: null`, o ponteiro
  nunca aparecia, e o agente seguia abrindo o PDF com o Markdown pronto ao lado. O cache passa a
  reagir à presença da conversão.

- **`files` do package.json tinha precedência sobre o `.npmignore`, e bytecode Python entrava no
  tarball.** O `.npmignore` já excluía `__pycache__/` e `*.pyc`, mas o whitelist `files` inclui
  `scripts/` inteiro e vence. Com o primeiro script `.py` do motor o teste de higiene do tarball
  acusou; o whitelist ganhou as negações explícitas.

### Alterado

- **O `contraditor` deixa de ser disparo automático e passa a ser oferta no checkpoint.** Com
  `meta_verifiers >= 3`, o runner o despachava sozinho antes do Citation Gate final. Ele custa um
  ciclo inteiro de subagente, e o tempo do run é do profissional que está esperando, não do motor.
  Agora o chefe **oferece** no checkpoint de aprovação, dizendo o custo e o que se ganha, e só
  despacha com o sim. Continua uma vez por run, com a memória no disco (`test -s
  .../contraditor.md`), e continua sem votar: ele gera os ataques, quem decide o que fazer com eles
  é o profissional. Pedido do usuário depois de sentir o custo num run real.

### Adicionado

- **O arquivo que se declara interno no cabeçalho deixa de contar como entrega.** A lista de nomes
  internos (`revisao`, `intake`, `foco`…) é corrida perdida: cada squad inventa nomes novos. Num run
  real, `contraditor.md` entrou na contagem de pendências da ENTREGA, e o arquivo de pendências
  internas — o que carrega a avaliação de risco da própria tese e que, protocolado, é confissão —
  **disputou com a peça a escolha do empacotador**. Só não foi embrulhado no lugar dela porque havia
  dois candidatos e o empacotador recusou por ambiguidade; com um só, teria entregado o errado.
  Agora `ehArtefatoDeEntrega` aceita o texto e honra a marca no cabeçalho ("NÃO PROTOCOLAR",
  "Documento interno do run", "uso interno do escritório"). A marca só EXCLUI, nunca inclui, e vale
  só nas primeiras linhas. Nome é convenção; a declaração do autor é fato.

  Junto: `escolherArtefato` passou a usar **um predicado só** para eleger a pasta e para listar
  dentro dela. Com dois, ele elegia a pasta pelo nome e a esvaziava pelo conteúdo, respondendo
  "nenhum artefato de entrega" numa pasta que acabara de eleger por ter um.

- **`comando-da-cli-inexistente` (error).** Rodando um squad real de mandado de segurança, o step de
  pesquisa mandava ler o escopo do ledger com `npx legalsquad run-status`. **O comando não existe** —
  o runner do motor manda `node scripts/squad-state.mjs run-status`, e o Arquiteto inventou a forma
  da CLI. A falha é quase muda: imprime o banner de ajuda. O agente daquele run percebeu e caiu para
  o artefato do checkpoint, mas um menos cuidadoso teria seguido com escopo vazio sem saber por quê.
  Um step é lei para quem o executa. O validador passa a conferir todo `npx legalsquad <sub>` citado
  em step ou agente contra os subcomandos que a CLI realmente tem, e um teste cobra a paridade entre
  essa lista e o `HELP` de `bin/legalsquad.js` — cópia que ninguém confere envelhece em silêncio.

- **Seis gates que o `build.prompt.md` prometia e o validador não cobrava.** Achados por uma bateria
  de 18 avarias controladas sobre um squad real de mandado de segurança — o `check-squad` respondia
  `✓ estrutura íntegra` a todas.

  1. **`revisao-sem-verificador-citacoes` media vocabulário, não wiring.** Bastava a palavra
     `verificador-citacoes` aparecer em QUALQUER step ou agente. Provado em campo: uma menção dentro
     de um comentário no step de **intake** — que não revisa nada — satisfazia o gate com o revisor
     já sem acionar o verificador. Agora o acionamento é cobrado de quem revisa: o step revisor ou o
     arquivo do agente dele.
  2. **`revisao-nao-isolada` lia só o `squad-party.csv`.** Um step com `execution: inline` no
     frontmatter derrubava o isolamento anti-viés em silêncio. Passa a ler as duas fontes,
     fail-closed (basta uma dizer que não é subagente), e a divergência entre elas virou aviso
     próprio: `revisao-execucao-divergente`.
  3. **`output-fora-do-escopo-do-run` (error).** O prompt escreve "NEVER use `pipeline/data/` for
     outputFile" porque só sob `output/` o runner aplica o escopo por `run_id`. Gravar fora contorna
     o escopo e dois runs simultâneos se sobrescrevem — regra escrita, nunca conferida.
  4. **`aprovacao-sem-registro`.** O checkpoint de aprovação sem `outputFile` nem artefato não grava
     nada: a autorização humana da entrega fica sem rastro de quem aprovou o quê. O prompt já
     avisava em caixa; faltava o código.
  5. **`agente-sem-step`.** Agente no elenco que nenhum step aciona. O inverso já era erro; este
     lado ficava mudo, e elenco fantasma engana quem lê o squad.
  6. **`tier-do-step-contradiz-o-agente`.** O prompt define o mapa (`powerful` → opus/xhigh,
     `fast` → haiku/low) e diz que declarar um e escrever outro faz "o frontmatter mentir". Um step
     `powerful` com o agente em `haiku` passava limpo.

  Silenciosos nos cinco squads reais testados.

- **`scripts/autos-para-md.py` — os autos viram Markdown uma vez, não a cada step.** O
  `indexar-autos.mjs` inventaria a pasta e extrai texto cru com `pdftotext`: serve ao índice, mas
  deixa o agente reabrindo o PDF a cada step — 700 folhas relidas por step — e **não vê** as páginas
  sem camada de texto. Num processo real de 707 folhas eram **73** invisíveis. O conversor (PyMuPDF
  + `pymupdf4llm`, com OCR por tesseract) grava `autos/_md/<slug>/documento.md` com cada folha
  ancorada em `## fls. N`, e `indexar-autos` passa a apontar o arquivo no campo `markdown` do índice.
  Citar folha vira `grep`, não memória.

  **Em blocos de 25 folhas, não o documento inteiro.** Chamado de uma vez sobre as 707 folhas, o
  extrator ficou 10 minutos sem devolver nada: nenhum progresso, memória crescendo, e um erro no fim
  jogaria fora o trabalho todo. Processo de centenas de folhas é o caso NORMAL deste domínio. Bloco
  que falha cai para texto simples só naquele trecho e o run segue — com a degradação registrada
  folha a folha no manifesto, nunca silenciosa.

  **E sem o OCR de figura por padrão.** Medido no mesmo bloco de 25 folhas do processo real: 63,4 s
  com imagens contra 25,2 s sem — e os dois devolveram **94.952 caracteres**, a mesma saída. O que o
  caminho caro acrescenta é o texto dentro de figura numa folha que já tem camada de texto; as
  folhas que só têm imagem seguem cobertas, porque são exatamente as que o script manda ao OCR por
  conta própria, com a procedência marcada. `--com-imagens` restaura o caminho caro.

  **A imagem de conferência sai em JPEG.** Ela existe para o profissional CONFERIR o que o OCR leu,
  não para arquivar fac-símile. Em PNG a 220 dpi, as 73 folhas escaneadas de um processo real
  pesaram 151 MB — mais do que o PDF inteiro — dentro da pasta do squad, que é copiada e
  versionada. Em JPEG a 200 dpi lê igual e cabe em cerca de um sexto: medido num segundo caso, 377
  folhas com 42 de OCR couberam em 17 MB.

  **Procedência é medida, não presumida** — e a primeira versão deste script errou exatamente aí:
  o `pymupdf4llm` roda OCR por conta própria nas páginas escaneadas e devolve o texto sem dizer de
  onde veio, e 73 folhas reconhecidas por máquina saíram carimbadas como `nativo`. Agora a camada de
  texto do PDF é lida ANTES de qualquer extração e é ela que decide: `nativo`, `ocr` (com o aviso
  folha a folha e o PNG ao lado, para conferir antes de citar) ou `vazia` (nada reconhecido — nunca
  se inventa conteúdo). Afirmar procedência que não se verificou é o erro do Citation Gate uma
  camada abaixo.

- **Paridade `scripts/` ↔ `templates/scripts/` por VARREDURA.** Os testes de espelho eram um por
  arquivo, escritos à mão: script novo nos dois lados não ganhava teste até alguém lembrar — e
  "lembrar" é o que a paridade existe para não depender. Agora um teste varre o par e cobra todo
  arquivo presente dos dois lados, inclusive os que ainda não nasceram.

- **`build.prompt.md`: as seis lacunas que um build CEGO expôs.** Um Arquiteto construiu o mesmo
  squad proibido de abrir `src/squad-check.js` — como faz qualquer usuário de `/legalsquad create`.
  Veredito: o prompt basta para a parte difícil (doutrina de agentes, gates, fase zero) e falha na
  **sintaxe dos artefatos estruturais**, justamente os que o validador reprova por código. Ele só
  passou porque foi ler `templates/squads/peca-modelo/` no motor — caminho que o prompt nunca
  nomeia e que a casa do projeto não tem instalado. Agora estão escritos: o esqueleto completo do
  `pipeline.yaml` (era "Pipeline entry point", uma linha, para um arquivo que o `check-squad`
  confere campo a campo), o bloco `agents:` do `squad.yaml` (só denunciado pelo nome de um código de
  erro), o cabeçalho do `squad-party.csv`, a regra do nome aliterado no lugar onde o nome é escrito,
  e o caminho do squad-modelo. A sexta era a única que quebra o RUN e não a validação: sem `autos/`,
  a fase zero tem de apontar o `inputFile` para `output/intake.md` — o runner para o step quando o
  arquivo não existe, e nenhum gate de design-time vê isso.

- **`parallel_group`: a independência dos irmãos passa a ser conferida.** O `build.prompt.md` define
  o grupo paralelo como "só para `execution: subagent` INDEPENDENTES (sem `depends_on` entre si, sem
  o mesmo `outputFile`)" — regra escrita e nunca implementada. Quebrando um squad real de propósito,
  as duas avarias saíam com `✓ estrutura íntegra`: um step esperando por um irmão que roda ao mesmo
  tempo (corrida — o arquivo pode não existir, ou ser o do run anterior) e dois irmãos gravando o
  mesmo `outputFile` (um sobrescreve o outro, e qual vence depende de quem terminar por último).
  Dois códigos novos, ambos `error`: `parallel-group-com-dependencia-interna` e
  `parallel-group-com-saida-colidente`.

- **`output-sem-consumidor` — o espelho de `input-sem-produtor`.** É a falha clássica da EDIÇÃO:
  acrescenta-se um agente, ele passa a gravar um artefato, ninguém o pluga a jusante, e o validador
  aprova. O critério é topológico, não por nome — quem não tem dependente é o fim do pipeline e
  legitimamente não tem leitor; quem tem, e mesmo assim não é lido por ninguém, produz trabalho que
  não chega a lugar nenhum. Aviso, não erro. Silencioso nas fixtures e em 4 dos 5 squads reais
  testados; o único achado é verdadeiro (um checkpoint que grava a decisão de aprovação do humano
  e o step seguinte nunca a lê).

### Corrigido

- **O Gate 1c reprovava agente instalado — e contradizia o instalador deste motor.**
  `especialista-nao-instalado` é ERROR e barra o squad; ele procurava o subagente só em
  `{projeto}/.claude/agents/`. Num projeto real o advogado tinha **38 agentes em
  `~/.claude/agents/`** (onde o `install-global` DESTE motor os põe) e 3 no projeto — e um
  `resumo-processo` instalado, funcional e acionado sem problema pelo runner era acusado de ausente.
  Passa a olhar os dois escopos, na ordem em que o harness resolve, e a mensagem diz onde procurou.
  Um gate que reprova o que funciona custa mais caro do que um gate que não roda: ensina a ignorá-lo.

- **`artefato-sem-produtor` e `input-sem-produtor` discordavam sobre quem produz um arquivo.** No
  mesmo arquivo, a dez linhas de distância: `input-sem-produtor` contava `outputFile` (frontmatter)
  **e** `output.artifacts`; `artefato-sem-produtor` contava só o segundo — e o desacordo sai como
  ERRO. Um step que declara a saída onde o formato de step do `build.prompt.md` manda declarar era
  acusado de não produzir nada. Os dois passam a contar as duas formas, com o caminho normalizado a
  partir de `output/` nos dois lados. É a mesma dívida do `check-squad` × `compilar-workflow`.

- **O squad-semente do `init` era reprovado pelo validador do próprio motor.** O `demo-squad` que
  toda instalação nova recebe declara `status: "placeholder"` e traz só o `squad.yaml`, de
  propósito. `check-squad demo-squad` — a primeira coisa que um usuário novo roda — devolvia quatro
  erros (goal, success_criteria, party, pipeline) sobre um arquivo que o instalador acabara de pôr
  ali e que se descreve como placeholder na linha 12. Agora é reconhecido: uma linha dizendo o que
  ele é e que `npx legalsquad update` o substitui pelo exemplo completo.

- **`empacotar` dizia que não havia `.md` com o `.md` à vista na pasta.** `ehArtefatoDeEntrega`
  recusa nome de rascunho (`minuta`, `rascunho`, `draft`) e de peça interna (`revisao`, `intake`,
  `foco`, `diagnostico`…) — e faz certo, é trabalho, não entrega. Só que "minuta" é como os prompts
  chamam a peça EM PROSA, então gravá-la como `minuta.md` é o erro natural de quem os leu, e a
  resposta era "nenhum artefato de entrega (.md) em …", mandando procurar o que não faltava. O erro
  passa a nomear os arquivos recusados, dizer que a recusa é por nome e dar a saída (renomear ou
  `--artefato`). Achado rodando o ciclo completo num install limpo do dist.

- **O Gate 1c inteiro nunca rodava, e o `check-squad` dizia "estrutura íntegra" mesmo assim.**
  `checarReusoDeEspecialistas` lia `specialist_agents` só de `_build/discovery.yaml`; o
  `build.prompt.md` manda escrever `_build/design.yaml`, e é o que o Arquiteto grava em campo.
  Rodado contra um squad real de 5 agentes com três especialistas declarados, o validador respondia
  verde sem ter conferido reuso nenhum — o pior tipo de verde, o que afirma o que não olhou. Passa a
  ler as duas fontes, e a mensagem nomeia qual delas escolheu o especialista. Achado ao construir um
  squad de verdade, não por leitura de código.

- **Um squad de peça sem os dois campos declarados escapava do Gate 4 INTEIRO.** A detecção de
  "entrega peça" tinha dois sinais, e ambos eram campos declarados (`citation_verifiers` e uma skill
  `delivery_type: legal-draft`). Quem esquecesse os dois não produzia sinal, saía da população dos
  checks de peça e recebia "estrutura íntegra" sem que veredito, revisor isolado, Citation Gate ou
  ética/sigilo tivessem sido conferidos uma única vez. Terceiro sinal, que não depende de ninguém
  declarar nada: acionar `verificador-citacoes` ou `verificador-persuasao` no pipeline — subagentes
  que só existem para entrega que cita fonte.

- **`success-criteria-insuficiente` mentia na causa.** O parser exigia exatamente dois espaços de
  indentação; a mesma rubrica escrita com quatro (YAML igualmente válido) ou inline virava
  "0 critério(s); esperado 3–6", acusando de não ter escrito a rubrica quem a tinha escrito. Passa a
  usar `listaDeTopo`, que lê qualquer indentação e a forma inline, e a mensagem de zero diz que não
  achou a lista. A faixa 3–6 continua igual.

- **Step fora da indentação do template era chamado de inexistente.** `parseSteps` ancora nas
  colunas do template e assim continua (ali a indentação é estrutural). Mas um step escrito noutra
  coluna sumia da lista e os checks de grafo o acusavam com `depends_on "step-03" não é um step` —
  mandando procurar o erro onde ele não está. `depends-on-invalido`, `on-reject-invalido`,
  `checkpoint-invalido` e `pipeline-sem-steps` passam a reconhecer o id presente no arquivo e a
  apontar a indentação. Continuam reprovando: o que o validador não lê, o runner não roda.

### Alterado

- **`build.prompt.md`: cinco contradições e ambiguidades que custaram retrabalho num build real.**
  (1) O `model_tier` do step listava "reviewer, writer, researcher → powerful" enquanto a seção de
  calibragem manda NÃO declarar `model:` nos steps de juízo; o bloco agora explica os dois valores,
  diz que omitir é a terceira opção e a mais comum, e registra que `model:` e `model_tier:` são
  sinônimos para o compilador. (2) "Corrija todo `✖` e todo `⚠` das famílias abaixo" deixava ler que
  só os erros tabelados contavam — agora diz que a tabela é guia de leitura, não a lista dos erros.
  (3) O teto de "máx 2 rodadas" era o mesmo texto em C.1 e C.2: agora são tetos separados, a rodada
  inicial não conta, e está escrito o que fazer quando sai limpo de primeira (seguir para C.2).
  (4) C.2 prometia "leia só os arquivos que estes itens pedem" e os itens pedem todos: a economia é
  ler menos DE CADA arquivo, e o texto agora diz isso. (5) A Fase zero exigia um `parallel_group` de
  quatro steps nomeados enquanto o Step A proíbe criar o que o design não pediu — o grupo passa a ter
  os steps que os agentes do design cobrem, com o que ficou sem dono indo para o report.

- **Um squad podia passar no `check-squad` e ser recusado pelo compilador.** O
  `tools/compilar-workflow.mjs` lê o bloco `agents:` do `squad.yaml` (MIKE-CHEFE §7); todo o resto
  do validador lê o `squad-party.csv`. Ninguém confrontava as duas fontes, e um squad real passava
  limpo aqui e morria lá com "agent «X» não está declarado em squad.yaml". O validador agora avisa,
  nomeando o compilador. Aviso, não erro: o run pelo runner não depende desse bloco.
- **A espera pelo humano era medida por sorteio.** `run-metricas` casava o carimbo do checkpoint
  (que usa o id do step) com o `label` do step no ledger, e o runner mandava passar em `--label` o
  "id **ou** rótulo". Com "step-01" a métrica media; com "Foco do Caso" devolvia "não medido"; e em
  `parallel_group`, onde o rótulo nunca é um id, era sempre imedível. É uma das quatro linhas do
  baseline da Fase 0. O ledger passa a carimbar `stepId` (novo `--step` no subcomando `step`), a
  junção é por id, o rótulo fica como heurística de compatibilidade, e o runner separa os dois
  campos. Achado ao instrumentar um run real.

- **A Fase 4 nunca empacotou um run real.** O runner grava por `squad-path` em
  `output/{run_id}/v{N}/arquivo.md` e chama `empacotar.mjs squads/{name} --run {run_id}` sem
  `--artefato`; o empacotador varria só a RAIZ de `output/`. Resultado: "nenhum artefato de entrega"
  em todo run que seguisse o runner — e, pior que falhar, um `.md` esquecido na raiz por um fluxo
  antigo faria empacotar a peça ERRADA em silêncio. A busca agora desce o run, da versão mais alta
  para a mais baixa, com a raiz por último (instalação anterior ao escopo por run continua
  funcionando). Achado ao empacotar uma contestação real.
- **`cobertura-acervo` estava morto em toda instalação.** O script que decide a pesquisa em camadas
  (Fase 3 — se o acervo local cobre o tema ou se vale buscar no tribunal) importava
  `../src/acervo-search.js`, caminho que só resolve no repositório do motor. No projeto do aluno,
  `ERR_MODULE_NOT_FOUND` na primeira chamada. A paridade byte a byte não pegava: as duas cópias eram
  idênticas **e as duas erradas para o destino**. O leitor do índice agora vem por bloco sincronizado
  (`acervo-index`, o sexto do `sync-blocos`), e dois testes prendem: o script não importa `src/`, e
  nenhum script distribuído ao aluno importa. Achado ao rodar um caso real.

### Corrigido

- **CI verde pela primeira vez.** Duas causas, em camadas. A primeira era o `engines: >=20` mentindo:
  o CI rodava Node 20, que não tem o zstd nativo do `node:zlib`, e a suíte inteira morria no import —
  resolvido na 0.5.6, que passou o CI para 22. A segunda ficou visível só depois: dois testes de
  `chefe --status` cobravam a saída do LaunchAgent do macOS através do bin de verdade, e no Linux o
  comando responde (corretamente) que não grava nem lê agendamento naquela plataforma. Os dois agora
  cobrem **as duas plataformas** — o invariante que vale em ambas (o horário padrão nunca é anunciado
  como se fosse o agendado) mais o que cada uma promete. É o que o cabeçalho do próprio arquivo já
  estabelecia para o núcleo, que recebe `plataforma` injetada para ser testado em qualquer máquina.

## [0.5.8] - 2026-09-03

## [0.5.8] - 2026-09-03

### Corrigido — o catálogo de evals não acompanhava as skills transversais

- **`skills/_evals/*.json` viaja com o pacote `transversal`**, como o catálogo de best-practices já
  fazia. O arquivo não mora sob nenhum id de skill, então caía inteiro no balde da área; num pacote
  100% transversal a área não é emitida e o catálogo sumia. Sem o caso, `eval_linked` reprova, a
  skill cai em hard fail e o resolvedor a bloqueia. Medido ao recontratar o `transversal` em
  03/09/2026: 70 skills publicadas com o contrato inteiro e **zero casos**, todas recusadas no
  runtime. Duplicar é inócuo — mesmos bytes, mesmo caminho, e o leitor já funde todo `.json` de
  `_evals/`.

## [0.5.7] - 2026-09-03

## [0.5.7] - 2026-09-03

### Corrigido — o catálogo de evals de cada área colidia, e isso bloqueava as skills

- **`skills/_evals/catalog-v5.json` viaja com o nome da área** (`catalog-v5.<area>.json`). Toda área
  trazia o seu catálogo de casos no MESMO caminho de instalação, e `pack-apply` escreve arquivo a
  arquivo: a última área instalada vencia e as outras sumiam. Diferente da colisão equivalente das
  best-practices (corrigida antes), esta não deixava a área só invisível para a busca — sem o caso de
  eval, `eval_linked` reprova, a skill cai em hard fail e **o resolvedor a bloqueia**. Medido numa
  instalação de aluno com as 11 áreas contratadas publicadas: 6.621 skills no disco, catálogo com 263
  casos e **252 skills executáveis**; as outras 6.369 recusadas com `structural-gate-failed`, apesar
  de o pacote trazer o contrato inteiro. O leitor já fundia todo `.json` de `_evals/`: só a escrita
  precisava do nome por área. Áreas precisam ser republicadas para a correção chegar ao aluno.

## [0.5.6] - 2026-09-03

## [0.5.6] - 2026-09-03

### As skills passam a ser executáveis, e o motor diz a verdade sobre o que exige

- **Node 22.15 ou mais novo, declarado.** O motor verifica pacotes com o zstd nativo do `node:zlib`,
  que só existe a partir dessa versão; `engines` dizia 20 e o aluno em Node 20 instalava sem erro e
  quebrava no primeiro `acervo sync`. `engines`, CI e README agora dizem 22.15.
- **`publish-pack` lê `ADMIN_SECRET` do ambiente.** Por flag, o segredo ficava no histórico do shell e
  na lista de processos. A flag continua aceita, com aviso.
- **Busca de skills 5× mais rápida.** `search-skills` relia todo `SKILL.md` a cada consulta: 2,3 s
  numa instalação de aluno (6.584 skills). Um cache do catálogo, gravado junto com o índice a cada
  `sync`/`indexar-skills`/`contract-skills`, derruba para 0,4 s com o mesmo resultado; skill
  adicionada ou removida à mão invalida o cache. O cache é local: nunca viaja no pacote nem no git.
- **Os squads-exemplo ensinam o formato canônico.** `demo-squad` e `peca-modelo` — os que toda
  instalação recebe — tinham agentes no formato legado `.custom.md` (overlay com `base_agent`), o
  que o `check-squad` reprova em squad do Arquiteto. Agora são `.agent.md` completos: todas as
  seções obrigatórias, `model`/`effort`/`maxTurns` calibrados. O gerador da fixture emite o mesmo.
- **A suíte deixou de sincronizar produção.** Um teste fazia um `sync` real contra o servidor — 35
  pacotes, 93 s de uma suíte de 93 s, e dependia de rede. A afirmação ("não pede licença") se prova
  com um servidor de fixture em 20 ms; o sync real fica opt-in (`LEGALSQUAD_TESTE_REDE=1`).

### Na curadoria (repositório de conteúdo, não no motor)

- **Contrato operacional v5 aplicado em 15 áreas.** Toda skill de pacote era recusada pelo resolvedor
  do motor (`structural-gate-failed`): sem bloco de contrato, sem `references/high-performance-contract.md`,
  sem `agents/openai.yaml`, sem caso de eval vinculado. Com o contrato, 6.500+ skills passam no gate;
  ficam bloqueadas 77 de perfil de cálculo sem motor determinístico declarado (lista no repositório de
  curadoria). Chega ao aluno quando os pacotes forem republicados.

### Documentação

- CLAUDE.md: o motor **embarca** as chaves públicas (anel), não "não embarca". Auditoria: M13 fechado.

## [0.5.5] - 2026-09-03

## [0.5.5] - 2026-09-03

### Rotação da chave de assinatura — o motor confia num anel

- **A privada `prod-2026-07` foi perdida** (formatação de máquina). Os 35 pacotes no ar continuam
  verificáveis pela pública, que não se perde; mas nada novo podia ser assinado. O motor passa a
  confiar num **anel** (`CHAVES_PUBLICAS_PRODUCAO`): `prod-2026-07` para o que está publicado,
  `prod-2026-09` para o que vem. O `sync` escolhe pela `signing_kid` do manifesto; pacote sem kid
  (os de 2026.08.14) é tentado contra cada chave; kid que o anel não conhece é recusado com a causa
  certa — "atualize o LegalSquad" — e nunca como adulteração. Chave própria por arquivo continua
  substituindo o anel inteiro.
- **Quem está em 0.5.4 ou anterior** verá os pacotes novos recusados com essa mensagem até
  atualizar. Nada é apagado: o pacote antigo continua instalado.

## [0.5.4] - 2026-09-03

## [0.5.4] - 2026-09-03

### Corrigido

- **`update` também semeia o squad-exemplo que falta.** A 0.5.2 trocava o placeholder do
  `demo-squad`, mas quem instalou antes do `peca-modelo` existir não o recebia — `squads/` é do
  usuário e o update não o toca. Seed do motor AUSENTE agora entra inteiro; placeholder é substituído
  com backup; squad com qualquer outro `squad.yaml` continua intocado.

## [0.5.3] - 2026-09-03

## [0.5.3] - 2026-09-03

### Corrigido

- **`check-squad` lia a lista `checkpoints:` como vazia quando cada parada vinha explicada na própria
  linha** (`- step-01  # Carteira: OAB, período`) — o formato dos squads de pacote. Todo squad
  instalado de área recebia `sem-checkpoint` ("nenhum checkpoint humano declarado") tendo três.
  Mesma classe do comentário inline nos artefatos, mesma correção: o comentário sai antes de comparar.

## [0.5.2] - 2026-09-03

## [0.5.2] - 2026-09-03

### O que a instalação entrega passa no validador

- **O `demo-squad` placeholder morreu.** O motor distribuía um exemplo de um arquivo só —
  `squad.yaml` sem pipeline, agentes ou harness — e o aluno via quatro erros no `check-squad` do
  exemplo que o próprio motor instalou. `templates/squads/` agora é GERADO da fixture sintética por
  `scripts/sync-templates-squads.mjs`: `demo-squad` inteiro e, novidade, `peca-modelo`, o squad de
  referência do caminho canônico (três paradas, `reader`, fase zero, autos, pacote), que até então
  só existia dentro dos testes. Skills e best-practices de demo saem na geração; os dois passam no
  `check-squad` sem nenhuma área instalada, e um teste prende a paridade fixture ↔ template.
- **`update` troca o placeholder das instalações existentes.** `squads/` é do usuário e o update
  nunca o toca; o placeholder é do motor (`status: "placeholder"`) e é o único substituído, com
  backup do `squad.yaml` e sem sobrescrever arquivo que já exista.

### Corrigido no `check-squad`

- `web_search`/`web_fetch` — tool-skills nativas que o Build manda declarar — eram aceitas num laço e
  acusadas de "inexistentes" no outro; todo squad de conteúdo instalado de pacote saía com dois erros.
- Artefato com comentário inline (`- output/carta.md  # só no caminho "declinar"`) não era o mesmo
  artefato do topo do pipeline: falso `artefato-sem-produtor`.
- Steps adjacentes sem linha em branco perdiam o último artefato do bloco (o parser exigia `\n`).
- O `demo-squad` da fixture passa a aliterar os nomes dos revisores, como o Gate 0 pede.

### Arquiteto

- **M13 fechado:** "the standard 6 tones" não existia em lugar nenhum e o modelo inventava seis por
  squad. O conjunto está definido (didático, institucional, opinativo, alerta, narrativo, técnico);
  o usuário edita o arquivo gerado, mas ele nasce igual toda vez.

## [0.5.1] - 2026-09-03

## [0.5.1] - 2026-09-03

### O fim da criação de squad deixou de demorar mais que a criação

- **Gates do Arquiteto em código.** O Step C do `build.prompt.md` mandava o modelo reler cada
  arquivo gerado, gate a gate (0, 1, 1b, 1c, 2, 2b, 3 e a metade mecânica do 4), com "máx 2
  tentativas" cada. Agora são regras do `check-squad`, com teste: `nome-de-agente-fora-do-padrao`,
  `secoes-de-agente-ausentes`, `task-ausente`/`task-frontmatter-incompleto`/`task-secao-ausente`,
  `especialista-nao-instalado`/`especialista-nao-referenciado`, `step-secao-ausente`,
  `input-sem-produtor`, e para squad de peça `revisao-sem-veredito`, `revisao-pelo-proprio-autor`,
  `revisao-nao-isolada`, `revisao-sem-verificador-citacoes`, `pesquisa-sem-citation-gate`,
  `sem-etica-sigilo`. O Step C virou "rode o validador, corrija a saída, leia só os quatro itens
  de juízo". O contrato de seções só é cobrado de squad que passou pelo Arquiteto (tem `_build/`);
  nome do agente e regras de peça valem para todo squad.
- **`audit-skills --skill <id>`.** O Gate 5 auditava a biblioteca inteira para conferir a skill que
  o squad acabou de criar — meio minuto e milhares de linhas numa instalação de aluno. O escopo
  audita só as pedidas e não sobrescreve o retrato da biblioteca em `_quality-report.json`.
- **`/legalsquad edit <name>` tem fluxo.** O comando roteava para um "Edit Squad flow" que não
  existia no Arquiteto — "acrescente um agente" virava rebuild completo ou improviso sem
  validação. O fluxo lê o que existe, muda só a peça pedida, valida por comando, apresenta o diff.

### Corrigido

- **`acervo sync` regenera `skills/_index.yaml`.** Numa instalação limpa de aluno, 6.584 skills em
  disco conviviam com um índice que dizia "0 skills" — o índice é a fonte do Arquiteto e do
  `catalog-scout`, e só `update` o regenerava. Só o índice: `check-skills` continua comando à parte.
- **A suíte está verde: 1.202 testes, 0 falhas.** As 7 falhas carregadas desde o F0 como "dívida
  conhecida" eram fósseis da era CriminalSquad; os testes agora exercitam o mesmo mecanismo contra
  a fixture sintética, por injeção do bundle (`_skillsBundle`). `npm run verify` verde pela
  primeira vez desde o F0.
- O squad-modelo `peca-modelo` cumpre o que o validador passou a cobrar: revisora aliterada
  ("Regina Revisão"), bloco `verdict:` parseável no step de revisão, `etica-oab-sigilo` referenciada.

## [0.5.0] - 2026-09-03

### As duas pontas do run

O advogado sente dois momentos: o que aparece na tela nos primeiros minutos e o
que sai pronto no final. Os gates continuam sendo o piso; esta versão constrói
as duas pontas (`docs/specs/legalsquad/ENTREGA.md` e `PLANO-ORQUESTRADOR.md`).

- **Três paradas humanas, com nome.** Squad de entrega jurídica para o
  profissional exatamente três vezes — `intake` (objetivo, prazo, juízo, estilo
  e o escopo da pesquisa), `diagnostico` (foco, teses e a linha de ataque) e
  `aprovacao` (o pacote, o que o juiz lê primeiro, e as propostas de memória
  agrupadas) —, mais o checkpoint imediatamente antes de qualquer ato
  irreversível. Antes eram cinco ou mais, espalhadas. O `check-squad` avisa
  quando um squad declara paradas a mais ou sem nome canônico.
- **Fase zero: os autos indexados uma vez.** Os PDFs do processo ficam em
  `squads/<nome>/autos/`; `scripts/indexar-autos.mjs` gera o índice (tipo do
  documento inferido pelo nome ou pelo cabeçalho, páginas, datas, número CNJ,
  começo de cada peça com CPF e CNPJ mascarados) e cacheia o texto quando há
  `pdftotext`. Sem poppler, marca `nao-extraivel-localmente` e não tenta
  parsear PDF à mão; escaneado vira `nao-extraivel` e o agente lê por página.
  Dali em diante os agentes leem o índice em vez de reabrir cada PDF a cada
  step. **O MCP do PJe não é fonte de autos** — segue em teste, fora do
  orquestrador.
- **Diagnóstico em paralelo.** O `parallel_group: diagnostico` despacha quatro
  leitores read-only sobre o índice (resumo do caso, contradições da prova,
  `contraditor` em modo pré-mortem e Temas do acervo), e a parada `diagnostico`
  consolida os quatro numa tela, com a fonte de cada linha nomeada.
- **Pacote pronto para protocolar.** `scripts/empacotar.mjs` monta, a partir da
  saída do run: a peça em `.docx` no estilo forense
  (`_legalsquad/core/estilo-forense.json`, sobrescrito por
  `_legalsquad/estilo-escritorio.json` do escritório sem tocar o script), PDF
  quando houver LibreOffice, o **termo de conferência** gerado só dos ledgers
  (citações com status e fonte, gates e ciclos, cada parada humana com carimbo
  e resposta mascarada, pendências com a linha), a lista de documentos a juntar
  cruzada com o índice dos autos, os próximos passos e um manifesto com
  SHA-256. A parada `aprovacao` roda o empacotador antes de perguntar: o que se
  aprova é o pacote, não um Markdown.
- **Persuasão como mecanismo — a peça tem dois leitores, e o segundo lê
  primeiro** (`docs/specs/legalsquad/PERSUASAO.md`). O juiz recebe a petição já
  triada por IA, e o que não sobrevive ao resumo ele não lê. Entram: o sinal
  `frente` no Redação Gate (peça longa abre com síntese nos primeiros 20%; peça
  curta é `nao-avaliado`, nunca reprovada), o agente `verificador-persuasao` no
  **Gate de Sobrevivência ao Resumo (Passo 4.6)** — resumo de triagem hostil,
  inventário de pedidos, teses e Temas, veredito `SOBREVIVE`/`PERDIDO` e
  `TEMA NAO ANCORADO` — e o agente `contraditor`, red team que **não vota**,
  com os três ataques mais fortes (fato, direito, forma) e o estado
  `ANTECIPADO`/`DESCOBERTO`. A opção "Red-team antes de seguir" do checkpoint
  deixou de ser rótulo e passou a ter comportamento.
- **Sexto sinal do Redação Gate: `folhas`.** Documento dos autos mencionado na
  peça vem com a folha ou o ID onde está (`fls. N`, `f. N`, `e-fls. N`,
  `ID N`), numa janela curta em torno da menção — um `fls.` do laudo não serve
  para a contestação citada na mesma frase. Sem índice ou sem menção,
  `nao-avaliado`, nunca aprovado.
- **Pesquisa em camadas.** Superiores, vinculantes do tribunal competente
  (IRDR, IAC, súmulas) e o acervo local entram **sempre**; a busca externa de
  acórdãos ordinários do tribunal local é decidida no `intake`, com a
  recomendação que `scripts/cobertura-acervo.mjs` calcula da cobertura real do
  acervo por tribunal e tema. O que vem de fora entra no acervo, para o próximo
  run cair na camada barata. A pesquisa passa a sair ordenada por força
  vinculante, e a tabela "Tema que governa cada tese" nasce nela — o gate 4.6
  vira rede, não descoberta.
- **`reader` decide o gate.** `reader: juiz | contraparte | cliente` no
  `squad.yaml` (default `juiz`): peça e parecer pagam a sobrevivência ao
  resumo; contrato paga a **consistência interna** (Passo 4.7,
  `scripts/verifica-contrato.mjs` — termos definidos, remissões, numeração,
  contradições de prazo, valor, multa, foro e índice, campos em aberto), e não
  é cobrado por síntese de peça. O `check-squad` expõe os gates por tipo.
- **Métricas do run, lidas do ledger.** `scripts/run-metricas.mjs` devolve
  duração, tempo até o primeiro artefato, paradas humanas, espera pelo humano,
  ciclos e REJECTs por gate e pendências na entrega; o `RELATORIO.md` publica a
  seção. Ausência de medida sai como "não medido" — nunca zero inventado.
- **Varredura determinística do DJEN.** `scripts/orchestra/djen-varredura.mjs`
  consulta a API pública de comunicações do CNJ por OAB e UF, pagina, grava no
  cache com dedupe pelo hash do próprio diário e registra a varredura **só em
  sucesso** — falha de rede não vira frescor. A data fatal continua sendo do
  profissional: o script grava `fatal: null`. O briefing do chefe roda a
  varredura antes das fontes quando existe `_legalsquad/_memory/djen.json`.
- **Estilo do escritório e lição do juízo entram na redação**, lidos da memória
  do chefe antes de escrever, não só na revisão.
- **Squad-modelo `peca-modelo`** com o caminho canônico inteiro, e o guia
  `docs/specs/legalsquad/MIGRACAO-SQUADS-0.5.md` para migrar squads desenhados
  antes desta versão. Nada quebra sem migrar: o validador avisa, não reprova.

### Mudou

- **Abertura do run em código.** O `run_id` é gerado pelo `init` no fuso do
  foro, com desempate de colisão e criação da pasta do run, e devolvido em
  JSON; o runner não faz mais aritmética de data de cabeça. O `init` agora
  **sempre** abre o ledger — antes, sem `--run`, o run ficava sem ledger e não
  era retomável. A normalização de `memories.md` e `runs.md` também virou
  código, **idempotente e não destrutiva**: garante as seções que faltam sem
  descartar o que o escritório escreveu (a instrução anterior mandava
  sobrescrever sem salvar o conteúdo).
- **Auditoria de prompts aplicada** ao runner, ao prompt de build e aos agentes
  de núcleo: marcadores de pressão, válvulas de escape manuais, narrativa de
  migração e pisos numéricos saíram; a orientação atual de prompting registra
  que instrução prescritiva demais reduz a qualidade. Relatório e diff em
  `docs/baseline/`.
- **Despacho de verificadores sempre por agente nomeado, nunca como fork.** O
  fork herda a conversa inteira, inclusive o raciocínio de quem redigiu, e
  destruiria o anti-viés que justifica o subagente.
- Aprendizado técnico que vale para qualquer squad passa a ser `licao` da
  memória do chefe, sob o gate M3. Antes era gravado em
  `_legalsquad/core/best-practices/`, que é conteúdo de pacote: o `sync`
  renomeava por cima e o aprendizado **desaparecia em silêncio**.

### Para quem já usa

- **Dependência nova (`docx`)**: depois de `legalsquad update`, rode
  `npm install` no projeto uma vez — é o que habilita o pacote em `.docx`.
- Squads criados antes desta versão continuam funcionando. Para ganhar as três
  paradas, o diagnóstico e o pacote, siga
  `docs/specs/legalsquad/MIGRACAO-SQUADS-0.5.md`.

## [0.4.0] - 2026-08-31

- **Contrato de autonomia do chefe (M0–M4)**: `chefe.autonomia_max` no
  `squad.yaml` trava o teto de decisão do chefe (M0 narra · M1 roteia e
  delega · M2 gere o ciclo dentro dos tetos · M3 propõe estrutura, só
  executa com o "sim" · M4 nunca: protocolar, enviar, assinar, publicar,
  pagar). Checkpoint de nível M3 passa sempre pela pergunta estruturada de
  aprovação (Aprovar e seguir · Ajustar · Red-team antes de seguir · Parar
  aqui), com o texto equivalente herdado onde a ferramenta não suportar o
  formato.
- **Gates de citação e redação saem do hook de máquina para o frontmatter**:
  antes o gate era instalado uma vez em toda a máquina, inclusive fora de
  projeto jurídico, e por isso nascia advisory. Agora a skill `/legalsquad`
  e os agentes de citação e avaliação declaram os dois gates no próprio
  frontmatter, valendo para a sessão jurídica que os invocou; o hook de
  máquina vira backstop.
- **Memória do chefe, com trava de LGPD por mecanismo**: o chefe passa a
  guardar fato, preferência, decisão e lição por projeto, um arquivo por
  fato. Toda escrita passa por um detector de dado identificável (CPF/CNPJ
  com dígito verificador, número OAB, número CNJ, e-mail, telefone) que
  BARRA a gravação antes de tocar o disco. O diretório de memória nunca é
  versionado, por decisão declarada.
- **Rituais agendados**: `legalsquad chefe --briefing` reúne prazos do dia,
  intimações recentes e carteira numa única leitura, narrada; `chefe
  --agendar [--aplicar] [--hora]` monta e mostra a minuta do agendamento
  diário e só grava com o "sim" explícito.
- **`model`, `effort` e `maxTurns` saem da prosa para o frontmatter dos
  agentes**: tabela de calibragem por papel (resolução mecânica de citação
  em haiku/low; julgamento de aderência temática e meta em opus/high;
  redator e revisor de peça em opus/xhigh), validada pelo `squad-check`.
- **Compilador `pipeline.yaml` → Workflow**: o `pipeline.yaml` continua
  sendo a única fonte da regra do squad; um passo de build agora o traduz
  para um script Workflow determinístico e auditável, sem duplicar a regra
  em dois lugares.
- **LegalSquad como plugin do Claude Code**: instalação e atualização por
  `claude plugin marketplace add` / `claude plugin install`, como
  alternativa ao instalador global. Gerado automaticamente a partir da
  mesma fonte que o pacote npm distribui, nunca mantido à mão.
- **Acervo**: DL 3.365/1941 (Desapropriação) somado à coleta de direito
  administrativo; corpus de direito do consumidor ampliado; dicionário de
  sinônimos de busca mais que dobrado.
- **Correções**: o painel do escritório deixava de mostrar o desfecho de um
  run em reconexão ou sob polling, e voltou a mostrar; `squad-check` deixava
  passar `chefe:` malformado quando escrito em estilo de uma linha só, e
  passou a recusar; a sincronização dos blocos compartilhados do motor
  passa a garantir, por construção, que uma falha no meio da propagação
  nunca deixa uma cópia parcialmente atualizada.

## 0.3.0 — 2026-08-22

- **Mike (chefe de squad) de alta performance**: abertura com a meta, narração
  do rigor dos gates (citações verificadas, ciclos, meta critério a critério),
  escalada e falhas traduzidas, checkpoint emoldurado, retomada com molde,
  handoff explícito roteador→chefe.
- **Arquiteto — análise profunda de skills por agente**: Phase D.5 (matriz de
  cobertura, inspeção via `detail-skill`, registro auditável por agente),
  busca com variantes + léxico do curador (`skills/_lexico*.yaml`), filtros
  `--delivery-type/--risk/--quality-profile`, `negative_triggers` como
  penalidade de frase no ranking.
- **Comandos novos**: `detail-skill <id>` (digest estrutural de uma skill);
  registro de uso por ciclo de revisão em `skills/_evals/uso/`.
- **Run ledger com tempo**: `startedAt`/`endedAt`, histórico `steps[]` e
  carimbo de checkpoints — retomada e entrega com duração real.
- **Correções**: fluxo de atualização aponta para o dist público
  (`legalsquad-nucleo`); assistente não pede mais licença (acesso aberto
  embutido); extração de frames compatível com ffmpeg 8+ (`-fps_mode`).

## 0.1.0 — 2026-07/08

- Motor F0–F3: empacotador de áreas, sync assinado (Ed25519) com o servidor de
  acervo, gates de citação e redação, squads jurídicos padrão-ouro.
