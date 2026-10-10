# LegalSquad

Motor de orquestração multi-agente para o Direito.

**Áreas do Direito não vivem neste repositório.** Elas chegam como **pacotes assinados**
(skills + squads + best-practices + acervo) baixados por `sync` e liberados por licença.

## Instalar pelo Claude, sem terminal

É o caminho para quem não usa terminal: o LegalSquad inteiro, **com o motor**, chega como plugin do
Claude Code, sem npm e sem git. Serve para o Claude Code no terminal e para a aba **Code** do app
Claude.

**Antes, uma vez por computador: o Node.js.** O LegalSquad roda sobre o Node.js 22.15 ou mais novo.
Se o computador não tem, baixe o instalador da versão **LTS** em https://nodejs.org, instale com as
opções padrão e feche e abra o Claude. Se faltar, o plugin avisa em português no início da conversa.

**No Claude Code**, digite numa conversa, uma linha de cada vez:

```text
/plugin marketplace add bbpropulse/legalsquad-nucleo
/plugin install legalsquad@bbpropulse
```

A primeira cadastra a loja de plugins da bbpropulse (este repositório); a segunda abre a ficha do
plugin, onde você escolhe **Install for you (user scope)**. Se o Claude pedir, rode
`/reload-plugins` ou abra uma conversa nova.
Os mesmos dois passos existem como comando de terminal, para quem instala por script:
`claude plugin marketplace add bbpropulse/legalsquad-nucleo` e
`claude plugin install legalsquad@bbpropulse`.

**No app Claude (aba Code)**, numa sessão local: botão **+** ao lado da caixa de mensagem,
**Plugins**, **Add plugin**, escolha `legalsquad` e o escopo do seu usuário. O navegador de
plugins do app mostra as lojas já cadastradas; se a da bbpropulse ainda não aparecer, cadastre-a
uma vez pelo Claude Code com a primeira linha acima (o terminal, o app e o VS Code do mesmo
computador leem as mesmas configurações).

Pronto: abra a pasta do escritório e peça em português o que precisa, ou digite
`/legalsquad:legalsquad`. Na primeira conversa, o plugin registra o motor neste computador e liga
o chefe-roteador; na primeira vez em cada pasta, o Claude pergunta antes de prepará-la e baixa a
biblioteca das áreas do Direito.

**Atualizar:** `/plugin`, aba dos instalados, `legalsquad`, **Update now**; ou ative a atualização
automática da loja `bbpropulse` na aba **Marketplaces** do `/plugin` (loja de terceiros vem com ela
desligada). A versão nova vale a partir da conversa seguinte. Para trazer as correções a um projeto
já preparado, peça ao Claude "atualiza o LegalSquad nesta pasta": ele roda o `legalsquad update`
ali.

O que o plugin faz sozinho, no início de cada conversa (hook `SessionStart`): grava
`~/.legalsquad/motor.json` apontando para o motor do plugin, que é o que o `npx legalsquad` de todos
os projetos lê, e entrega ao Claude o bloco do chefe-roteador (plugin não carrega `CLAUDE.md`). O
comando `legalsquad` fica no PATH do shell do Claude pela pasta `bin/` do plugin. Quem já instalou
pelo npm pode instalar o plugin também: os dois convivem, o bloco global não é repetido, e o
registro fica com o motor de versão mais nova.

Nenhuma **matéria jurídica de área** viaja no plugin (skills de matéria, squads, best-practices,
acervo, agentes especialistas): elas chegam como pacotes assinados por `legalsquad acervo sync`.
O plugin é **gerado** por `npm run build:plugin` (o motor, em `plugin/motor/`, é gerado e não é
versionado; a árvore pública o recebe do `build-dist`); `npm run check:plugin` reprova se a parte
versionada de `plugin/` divergir da fonte.

## Instalar e atualizar pelo GitHub (npm, pelo terminal)

O motor **não é distribuído pelo npm**. `npx legalsquad` numa máquina limpa falha com
`404 Not Found - GET https://registry.npmjs.org/legalsquad`, porque o pacote não existe no
registro público. Instale e atualize a partir deste repositório:


> **Requisito: Node 22.15 ou mais novo.** O motor verifica pacotes com o zstd nativo do
> `node:zlib`, que só existe a partir dessa versão; em Node 20 a instalação passa e o
> `acervo sync` quebra na primeira verificação.

```bash
npm install -g github:bbpropulse/legalsquad-nucleo
```

O mesmo comando **instala e atualiza**: rodá-lo de novo troca o motor pela versão mais recente
de `main`. Depois disso o comando `legalsquad` existe no PATH e todos os `npx legalsquad …` deste
README funcionam (o `npx` encontra o pacote no prefix global antes de tentar o registro).

Cada projeto tem seus próprios dados. Dentro da pasta do projeto:

```bash
legalsquad init --yes --lang "português"
```

**Uma pasta por escritório, com os casos dentro.** O projeto é a pasta do escritório (ou do
advogado); cada processo entra como subpasta de caso. Abrir o Claude Code dentro da pasta de um
caso continua usando o LegalSquad da pasta acima, e a CLI segue a mesma regra: `npx legalsquad …`
rodado em `Processos/<caso>/autos/` age sobre o escritório (a raiz usada sai no stderr). Quem prefere várias pastas independentes não
paga por isso: o conteúdo sincronizado (skills, best-practices, jurisprudência) fica **uma vez**
no **depósito da máquina**, `~/.legalsquad/acervo/`, e cada pasta é ligada a ele por hard link,
sem disco extra e sem rede (`legalsquad acervo ligar`; o `init` e o `update` já ligam sozinhos).
Um `acervo sync` por máquina basta: no primeiro projeto da máquina o `init` avisa que a biblioteca
ainda está vazia e o assistente roda o sync em seguida (alguns minutos; 645 MB em 14/09/2026).
Cada pasta pode ligar **só as áreas do escritório** (`legalsquad acervo areas direito-civil
direito-do-consumidor`; `acervo areas` lista o que há; `--todas` volta a tudo): o resto fica no
depósito, e a busca de skills avisa quando o que você pediu existe numa área ainda não ligada. O conteúdo ligado é somente leitura (é do curador); o ajuste
local de uma skill vai em `SKILL.local.md`, e o que você tiver alterado no lugar é guardado em
`.bak` antes de ser trocado pela versão do curador. Squads e agentes de área são copiados e passam
a ser do projeto (uma versão nova do pacote os atualiza só se você não os tiver alterado). Pacote
revogado pelo curador some do depósito e dos projetos. `acervo status` diz se o projeto está em
dia, DEFASADO (o depósito mudou; rode `acervo ligar`) ou no formato antigo (pacotes dentro do
projeto; um `acervo sync` os migra). Os julgados dos pacotes chegam **já indexados**: o índice de
cada pacote é gerado uma vez no depósito e viaja com ele; o `indexar-acervo` do projeto só varre o
que você colocou em `acervo/`. A busca (`search-acervo`) acha um julgado pelo identificador
("Súmula 54 STJ", "REsp 1.132.866/SP") antes de qualquer tema, e um verbete que não existe não
devolve identificador exato: é o que o verificador de citações lê. O `install-global` registra o motor em `~/.legalsquad/motor.json`
para todos os projetos da máquina, e `legalsquad diagnostico` (ou `npx legalsquad diagnostico` no
projeto) diz o que esta máquina consegue fazer: node, npm, PATH, atalho, depósito, hard link no
volume, bit somente-leitura, caminhos longos (no Windows) e pasta de nuvem. É o comando para
rodar numa máquina Windows e colar o resultado; a prova completa é `node scripts/e2e-aluno.mjs
--json relatorio.json` (o teste de montagem inteiro, numa HOME isolada, sem tocar a sua).

Dentro de uma pasta preparada, `npx legalsquad …` funciona **mesmo quando o comando `legalsquad`
não está no PATH** (no Windows, o shell que o Claude Code abre normalmente não tem
`%APPDATA%\npm`): o `init` deixa um atalho local em `_legalsquad/motor/` e em
`node_modules/.bin/legalsquad` que acha o motor instalado sozinho. Fora de uma pasta preparada, o
bloco global que o `install-global` grava no `~/.claude/CLAUDE.md` traz o caminho completo do
motor (`node "<…>/bin/legalsquad.js"`), que substitui `legalsquad` em qualquer shell.

Para trazer as correções do motor a um projeto **já inicializado**, depois de atualizar o global:

```bash
legalsquad update
```

Ele substitui os arquivos de sistema (`_legalsquad/`, prompts, agentes), faz backup `.bak` do que
troca e **preserva** `_memory/`, `acervo/`, `agents/`, `squads/` e as skills sincronizadas.

As áreas do Direito atualizam por um caminho separado, contra o servidor de acervo:

```bash
legalsquad acervo sync
```

Ele baixa só o que mudou de versão, restaura arquivo de pacote que tenha sido apagado, e é
idempotente: rodar de novo sem novidade devolve `0 aplicado(s)`.

## Escritório virtual

Abra o escritório de advocacia em pixel art com um comando, dentro do projeto:

```bash
legalsquad dashboard
```

No checkout do motor, use `npm run dashboard`. O comando instala as dependências do painel
na primeira abertura, inicia o servidor Node em `127.0.0.1` e abre o navegador. Na IDE,
`/legalsquad dashboard` aciona o mesmo fluxo. A porta preferida é 5173; se estiver ocupada,
o servidor imprime a próxima disponível. `--port 5180` muda a preferência e `--no-open`
inicia sem abrir uma aba. `Ctrl+C` encerra o servidor.

A visão geral mostra uma sala por squad, com biblioteca, mesas e recepção. Clique no squad
para acompanhar seus agentes, atividades, repasses de documentos, progresso e pedidos de
aprovação. Arraste o cenário ou use os controles de zoom. Equipes cadastradas em
`squad-party.csv` (ou nos objetos `agents` do `squad.yaml`) aparecem aguardando mesmo sem run.
O trabalho exibido vem de `squads/<squad>/state.json`, atualizado pelo runner via WebSocket,
com fallback por consulta periódica. Aprovações e execução continuam na conversa da IDE.

Sem squads, o painel oferece uma **demonstração identificada**, com dados fictícios somente
em memória. Ela não inicia agentes e não grava dados do projeto. O painel é local e não
transmite o estado dos casos a serviços externos.

## Contribuição dos squads à comunidade

Conforme o contrato da mentoria e da comunidade, **a estrutura dos squads que você cria ou ajusta
é enviada à plataforma da comunidade**, sem dado de caso e sem o seu nome. Sobe só o que o modelo
do escritório levaria (`squad-modelo --exportar`): agentes, passos, textos de instrução e skills do
escritório, e só de squad que chegou a um run aprovado e mudou em relação ao modelo da área. Autos,
peças, memória, estado do run, `identificacao.json` e `caso.json` nunca sobem, nem o nome do aluno
ou do escritório; a instalação é identificada por um código pseudônimo.

Antes do envio roda a mesma varredura de dado do caso do modelo do escritório, contra a pasta do
caso e contra o perfil do escritório. Se ela achar algo, ou não conseguir ler todos os documentos
do caso, aquele squad não sobe, e o chefe avisa numa linha. O que chega vai para uma caixa de
entrada privada: passa por curadoria e testes, e só o aprovado vira modelo num pacote publicado.
Sem rede, nada quebra: o envio fica para a próxima vez.

Para desligar (instalação que não é da comunidade), use `LEGALSQUAD_CONTRIBUIR=0` no ambiente ou
`"contribuir": false` em `_legalsquad/config/acervo.json`.

## O arranjo

**Este repositório é autocontido.** Ele não depende de nenhum diretório vizinho e não lê
repositório algum além de si próprio. As áreas do Direito chegam **de forma remota**, como pacotes
assinados verificados no cliente.

O conteúdo de cada área é autorado por seu **curador**, fora daqui. O LegalSquad **executa** o que
foi baixado e, quando pedido, **empacota um diretório que lhe apontem**.

O `build-area` é **genérico**: recebe o caminho do conteúdo por argumento, nunca conhece um
repositório específico, e **jamais escreve na origem**.

## O que está aqui (motor)

Roteador e loop de orquestração · Arquiteto · Pipeline Runner e checkpoints · resolvedor
fail-closed (lifecycle/evidência) · Citation Gate · CLI · `captura` (áudio/vídeo) · indexadores ·
integrações (DJEN, e-mail, agenda) · dashboard.

## O que **não** está aqui (vira pacote)

Skills de matéria · squads · best-practices jurídicas · acervo · perfis de instituição ·
calculadoras específicas de área.

## O briefing da manhã, e como agendá-lo

`legalsquad chefe` encadeia os prazos de hoje, as intimações recentes e a carteira, e entrega tudo
na voz do chefe do squad. Ele não inventa nada: toda linha é re-apresentação do que os scripts do
seu projeto emitiram.

```bash
legalsquad chefe                 # o briefing do dia
legalsquad chefe --json          # o mesmo agregado, cru, para automação
legalsquad chefe --agendar       # o que é preciso para ele rodar sozinho
legalsquad chefe --status        # há ritual agendado? quando rodou pela última vez?
```

**Nada é agendado automaticamente.** `--agendar` só **mostra**: o comando exato, o custo real de
cada caminho e o snippet pronto para copiar. Ele não grava arquivo nenhum. Se você quiser que o
LegalSquad grave por você, o "sim" é explícito:

```bash
legalsquad chefe --agendar --aplicar          # grava o LaunchAgent (macOS)
legalsquad chefe --agendar --aplicar --hora 07:30
```

Mesmo aí ele para no meio do caminho de propósito: grava o arquivo e **não roda `launchctl`**.
Carregar o agente é o passo que faz algo começar a disparar sozinho na sua máquina, e esse passo
fica com você. Rodar o comando duas vezes não duplica nada, e mudar o horário atualiza o mesmo
agendamento em vez de criar um segundo.

Três avisos honestos, porque eles mudam a sua escolha:

- **A rotina na nuvem não serve para este ritual.** Ela roda sem a sua máquina ligada, mas parte de
  um clone novo do repositório e não enxerga arquivo local. O briefing lê o cache do DJEN e a
  carteira, que ficam na sua máquina e são ignorados pelo git. Na nuvem, ele não acharia os dados.
- **A tarefa agendada do app Desktop funciona**, e é o caminho quando você quer que o Claude leia o
  briefing e aja. Ela se cria pela interface do app, ou pedindo ao Claude numa sessão do Desktop.
  Não existe comando de terminal para registrá-la.
- **O log do agendamento guarda o briefing inteiro**, com número de processo e nome de cliente. Ele
  fica em `_legalsquad/_memory/`, que o git ignora e o pacote nunca leva.

Fora do macOS, o `--agendar` entrega a linha de `crontab` pronta e não instala nada por conta
própria: instalar crontab reescreve a sua tabela inteira, e um erro ali apagaria agendamentos que
não são nossos. No Windows, falta suporte.

## Documentação

A doc do dia a dia é o [`GUIA-ALUNO.md`](GUIA-ALUNO.md), e o [`INSTALL.md`](INSTALL.md) cobre a
instalação. As especificações de arquitetura — o corte núcleo × pacote, o formato de pacote,
assinatura e sync — são documentos de desenvolvimento e vivem no repositório de desenvolvimento,
não nesta árvore de distribuição.

## Regras do projeto

1. **Nenhum passo escreve nos repos de conteúdo.** O `build-area` é somente leitura.
2. **Motor novo só aqui.** O CriminalSquad está em manutenção (correção crítica apenas).
3. **Uma área só vira pacote com curador responsável.**
