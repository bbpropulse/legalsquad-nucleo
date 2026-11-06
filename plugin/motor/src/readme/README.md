# LegalSquad

Crie squads de agentes de IA que trabalham juntos — direto do seu IDE.

## Como Usar

Abra esta pasta no seu IDE e digite:

```
/legalsquad
```

Isso abre o menu principal. De lá você pode criar squads, executá-los e mais.

Para atualizar e auditar a biblioteca distribuída:

```
/legalsquad indexar-skills
/legalsquad auditar-skills
```

O relatório separa skills apenas `contracted` das `verified`/`certified`; disponibilidade não equivale a desempenho comprovado. O runtime também bloqueia lifecycle inseguro e só aceita promoção quando `high_performance_eligible: true`, calculado a partir de evidência vinculada à versão exata da skill. A descoberta usa uma shortlist local compacta em vez de carregar todo o catálogo no contexto. Toda saída jurídica continua sujeita à revisão humana.

Você também pode ser direto — descreva o que quer em linguagem natural:

```
/legalsquad crie um squad para escrever posts no LinkedIn sobre IA
/legalsquad execute o squad meu-squad
```

## Criar um Squad

Digite `/legalsquad` e escolha "Criar squad" no menu, ou seja direto:

```
/legalsquad crie um squad para [o que você precisa]
```

O Arquiteto fará algumas perguntas, projetará o squad e configurará tudo automaticamente.

## Executar um Squad

Digite `/legalsquad` e escolha "Executar squad" no menu, ou seja direto:

```
/legalsquad execute o squad <nome-do-squad>
```

O squad executa automaticamente, pausando apenas nos checkpoints de decisão.

## Escritório Virtual

```bash
npx legalsquad dashboard
```

O comando prepara as dependências na primeira abertura, inicia o servidor Node local e abre
o navegador. Na IDE, peça `/legalsquad dashboard`. Use `--no-open` para só iniciar o servidor
ou `--port 5180` para preferir outra porta. `Ctrl+C` encerra o painel.

Veja o escritório de advocacia em pixel art: uma sala por squad, agentes nas mesas,
atividades, repasses e aprovações em tempo real. Selecione uma equipe para entrar na sala.
Agentes cadastrados ficam aguardando até o runner registrar trabalho em `state.json`.
Aprovações e execução continuam na conversa da IDE. A demonstração oferecida pelo painel
usa dados fictícios, sem criar squads ou executar agentes.

---

# LegalSquad (English)

Create AI squads that work together — right from your IDE.

## How to Use

Open this folder in your IDE and type:

```
/legalsquad
```

This opens the main menu. From there you can create squads, run them, and more.

To refresh and audit the distributed skill library:

```
/legalsquad indexar-skills
/legalsquad auditar-skills
```

The report separates structurally `contracted` skills from behaviorally `verified`/`certified` ones. Runtime blocks unsafe lifecycle states and accepts promotion only when `high_performance_eligible: true`, computed from evidence bound to the exact skill version. Discovery uses a compact local shortlist instead of loading the full catalogue into context. Availability is not proof of performance, and legal outputs still require human review.

You can also be direct — describe what you want in plain language:

```
/legalsquad create a squad for writing LinkedIn posts about AI
/legalsquad run my-squad
```

## Create a Squad

Type `/legalsquad` and choose "Create squad" from the menu, or be direct:

```
/legalsquad create a squad for [what you need]
```

The Architect will ask a few questions, design the squad, and set everything up automatically.

## Run a Squad

Type `/legalsquad` and choose "Run squad" from the menu, or be direct:

```
/legalsquad run the <squad-name> squad
```

The squad runs automatically, pausing only at decision checkpoints.

## Virtual Office

```bash
npx legalsquad dashboard
```

The command installs dashboard dependencies on first use, starts the local Node server and
opens your browser. Use `--no-open` for server only or `--port 5180` to prefer another port.
Press Ctrl+C to stop. The pixel-art law office shows squads, registered agents, live work,
handoffs and approval checkpoints. Approvals and execution remain in your IDE conversation.
The optional demo is clearly labeled and never writes project data or runs agents.
