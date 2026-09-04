# LegalSquad

Motor de orquestração multi-agente para o Direito.

**Áreas do Direito não vivem neste repositório.** Elas chegam como **pacotes assinados**
(skills + squads + best-practices + acervo) baixados por `sync` e liberados por licença.

## Instalar e atualizar — pelo GitHub

O motor **não é distribuído pelo npm**. `npx legalsquad` numa máquina limpa falha com
`404 Not Found - GET https://registry.npmjs.org/legalsquad`, porque o pacote não existe no
registro público. Instale e atualize a partir deste repositório:


> **Requisito: Node 22.15 ou mais novo.** O motor verifica pacotes com o zstd nativo do
> `node:zlib`, que só existe a partir dessa versão; em Node 20 a instalação passa e o
> `acervo sync` quebra na primeira verificação.

> **Requisito: Node 22.15 ou mais novo.** O motor verifica pacotes com o zstd nativo do
> `node:zlib`, que só existe a partir dessa versão; em Node 20 a instalação passa e o
> `acervo sync` quebra na primeira verificação.

```bash
npm install -g github:bbpropulse/legalsquad-nucleo
```

O mesmo comando **instala e atualiza** — rodá-lo de novo troca o motor pela versão mais recente
de `main`. Depois disso o comando `legalsquad` existe no PATH e todos os `npx legalsquad …` deste
README funcionam (o `npx` encontra o pacote no prefix global antes de tentar o registro).

Cada projeto tem seus próprios dados. Dentro da pasta do projeto:

```bash
legalsquad init --yes --lang "português"
```

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
idempotente — rodar de novo sem novidade devolve `0 aplicado(s)`.

### Alternativa no Claude Code: instalar como plugin

Quem usa Claude Code pode receber a **superfície de comando** por plugin, a partir do marketplace
da bbpropulse — este mesmo repositório:

```bash
claude plugin marketplace add bbpropulse/legalsquad-nucleo
claude plugin install legalsquad@bbpropulse
```

Isso instala a skill `/legalsquad:legalsquad`, os cinco agentes de núcleo (`verificador-citacoes`,
`avaliador-squad`, `catalog-scout`, `verificador-persuasao`, `contraditor`) e os gates
determinísticos de citação e redação, atualizando-os com `claude plugin update`.

**O plugin não substitui o `npm install -g`.** Ele é um caminho **alternativo** de distribuição da
superfície de comando; o **motor** (`legalsquad init`, `update`, `acervo sync`, empacotador)
continua vindo do GitHub, e o bloco global de `CLAUDE.md` que liga o chefe-roteador em toda conversa
continua sendo trabalho do `legalsquad install-global` — plugin não injeta `CLAUDE.md`. Os dois
caminhos coexistem sem conflito: quem já instalou pelo npm não precisa mudar nada.

Nenhuma **matéria jurídica de área** viaja no plugin (skills de matéria, squads, best-practices,
acervo, agentes especialistas): elas continuam chegando como pacotes assinados por
`legalsquad acervo sync`.

O plugin é **gerado** de `templates/ide-templates/claude-code/.claude/` por
`npm run build:plugin`; `npm run check:plugin` reprova se `plugin/` divergir da fonte.

## O arranjo

**Este repositório é autocontido.** Ele não depende de nenhum diretório vizinho e não lê
repositório algum além de si próprio. As áreas do Direito chegam **de forma remota**, como pacotes
assinados verificados no cliente.

O conteúdo de cada área é autorado por seu **curador**, fora daqui. O LegalSquad **executa** o que
foi baixado — e, quando pedido, **empacota um diretório que lhe apontem**.

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
