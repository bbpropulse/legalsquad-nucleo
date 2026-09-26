<!-- ARQUIVO GERADO por scripts/build-plugin.mjs. Não edite aqui. -->

# LegalSquad: plugin do Claude Code

Versão 0.9.58. Tudo o que o LegalSquad precisa vem neste plugin, inclusive o motor: não é
preciso abrir o terminal, nem instalar nada pelo npm ou pelo git.

## Antes de começar: o Node.js

O LegalSquad roda sobre o Node.js (versão 22.15 ou mais nova). Se o computador ainda não tem,
baixe o instalador da versão **LTS** em https://nodejs.org, instale com as opções padrão e feche e
abra o Claude. Se faltar, o próprio plugin avisa em português no início da conversa.

## Instalar pelo Claude Code

Numa conversa do Claude Code, digite estas duas linhas, uma de cada vez:

```text
/plugin marketplace add bbpropulse/legalsquad-nucleo
/plugin install legalsquad@bbpropulse
```

A primeira cadastra a loja de plugins da bbpropulse (só uma vez por computador). A segunda abre a
ficha do plugin: escolha **Install for you (user scope)**, para ter o LegalSquad em todas as
pastas. Se o Claude pedir, rode `/reload-plugins` ou abra uma conversa nova.

## Instalar pelo app Claude (aba Code)

Numa sessão local da aba **Code**, clique no **+** ao lado da caixa de mensagem, escolha
**Plugins** e depois **Add plugin**; procure `legalsquad` e escolha o escopo do seu usuário. O
navegador de plugins do app mostra os plugins das lojas já cadastradas: se a loja da bbpropulse
ainda não aparecer, cadastre-a uma vez pelo Claude Code (`/plugin marketplace add
bbpropulse/legalsquad-nucleo`). O terminal, o app e o VS Code do mesmo computador leem as mesmas
configurações, então o plugin instalado em um aparece nos outros.

## Usar

Abra a pasta do escritório e peça em português o que precisa, ou digite
`/legalsquad:legalsquad` para o menu. Na primeira vez em cada pasta, o Claude pergunta antes de
prepará-la. Na primeira conversa depois de instalar, o plugin registra o motor neste computador;
não há mais nada a fazer.

## Atualizar

No Claude Code: `/plugin`, aba dos plugins instalados, `legalsquad`, **Update now**. Para receber as
versões novas sem pedir, ative a atualização automática da loja `bbpropulse` na aba
**Marketplaces** do `/plugin` (lojas de terceiros vêm com ela desligada). A versão nova vale a
partir da conversa seguinte. As pastas dos projetos não mudam sozinhas: peça ao Claude
"atualiza o LegalSquad nesta pasta" e ele roda o `legalsquad update` nela.

## O que vem aqui

- `motor/`: o motor (o mesmo conjunto do pacote npm, sem `node_modules`);
- `bin/legalsquad`: o comando `legalsquad` no shell do Claude, enquanto o plugin está ativo;
- `skills/legalsquad/`: a skill `/legalsquad:legalsquad`, com os gates de citação e redação;
- `agents/`: os cinco agentes de núcleo (`verificador-citacoes`, `avaliador-squad`,
  `catalog-scout`, `verificador-persuasao`, `contraditor`);
- `scripts/`: os hooks determinísticos, byte a byte iguais aos do motor;
- `hooks/hooks.json`: a preparação do início da conversa, o backstop de citações e o disparador
  dos hooks do projeto;
- `package.json` e `package-lock.json`: as dependências do motor (`docx`, para a peça em
  .docx), que o Claude Code instala sozinho ao instalar ou atualizar o plugin.

## O que NÃO vem aqui

Nenhuma **matéria jurídica de área** (skills de matéria, squads, best-practices, acervo, agentes
especialistas): as áreas do Direito chegam como pacotes assinados pelo `legalsquad acervo sync`,
que o Claude roda na primeira pasta preparada. Nem memória, nem `squads/*/output/`, nem
`skills/_evals/results/`.

Quem já instalou pelo npm (`legalsquad install-global`) pode instalar o plugin também: os dois
convivem, e vale o motor de versão mais nova.
