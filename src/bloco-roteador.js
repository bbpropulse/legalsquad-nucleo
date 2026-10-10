// O bloco do chefe-roteador: o texto que liga o LegalSquad em toda conversa do
// Claude, e que só vale para pedido jurídico ou de gestão de escritório.
//
// Ele chega por dois caminhos, e os dois leem daqui:
//
// - npm (`legalsquad install-global`): gravado entre marcadores no
//   `~/.claude/CLAUDE.md` (ver `ensureGlobalClaudeMd` em install-global.js).
// - plugin do Claude Code: plugin não carrega `CLAUDE.md` (a doc de plugins diz
//   que um `CLAUDE.md` na raiz do plugin não é lido como contexto), então o hook
//   SessionStart do plugin (src/plugin-sessao.js) injeta o bloco como
//   `additionalContext` a cada conversa nova. Quando o bloco do npm já está no
//   `CLAUDE.md` global, o plugin não repete a instrução: injeta só o complemento
//   (onde está o motor do plugin, qual motor o registro da máquina escolheu e como
//   o plugin atualiza).
//
// O texto do npm é o de sempre, byte a byte: mudar este arquivo não reescreve o
// `CLAUDE.md` de ninguém até o próximo `install-global`. O do plugin é escrito à
// parte porque as duas instruções que mudam (onde está o motor e como atualizar)
// atravessam o bloco inteiro; os itens comuns são conferidos pelos testes
// (tests/plugin-nativo.test.js) para não divergir em silêncio.

export const CLAUDE_MD_BEGIN = '<!-- BEGIN LegalSquad (install-global) -->';
export const CLAUDE_MD_END = '<!-- END LegalSquad (install-global) -->';
// Matches a whole LegalSquad block (BEGIN…END). CRLF-tolerant (no ^/$ line
// anchors — those break on Windows line endings). Global so ALL blocks collapse.
export const BLOCK_RE =
  /<!-- BEGIN LegalSquad \(install-global\) -->[\s\S]*?<!-- END LegalSquad \(install-global\) -->/g;

/** O `CLAUDE.md` global já carrega o bloco que o `install-global` grava? */
export function temBlocoNpm(texto) {
  return typeof texto === 'string' && texto.includes(CLAUDE_MD_BEGIN) && texto.includes(CLAUDE_MD_END);
}

// Peça sem modelo vai ao Arquiteto (defeito relatado em 30/09/2026): no computador de uma aluna,
// uma peça sem squad-modelo virou "não tenho modelo" e a sessão parou. O item 2 dizia "se
// recorrente e nada cobrir, proponha criar", e uma peça única caía em ad-hoc ou em recusa. O
// squad-modelo só acelera e economiza tokens; sem ele, o caminho normal é o Arquiteto montar o
// squad do zero e o runner rodar. A regra é uma só, com a mesma frase, em todos os destinos do
// roteador (bloco global, plugin, instructions-body e command-body, que os testes conferem) e na
// saída do `squad-modelo --para` (`frase`), para o modelo repetir a frase certa e não a recusa.
export const FRASE_ARQUITETO = 'Não há modelo pronto para esta peça; vou montar o squad com o Arquiteto: umas perguntas rápidas e o desenho para você aprovar.';
export const OPCAO_ARQUITETO = 'nenhum destes: montar com o Arquiteto';

/** A regra do item 2, igual no npm e no plugin; só o nome do comando muda. */
export function regraPecaSemModelo(comando) {
  return ` · tarefa pontual ad-hoc, só para o que não é entrega (explicar um instituto, contar um prazo, ler uma publicação). **Peça ou entrega sem squad e sem modelo vai ao Arquiteto, sempre:** pedido de peça ou de qualquer entrega jurídica que o escritório vai produzir, única ou recorrente, sem squad da área que a cubra e sem squad-modelo que sirva (o seletor devolve \`proximo: "arquiteto"\`), vai ao Arquiteto, que monta o squad (Discovery, pesquisa, Design, Build com as skills da área; o agente especialista entra no squad, não no lugar dele) para o runner executar. Anuncie em uma linha, na voz do advogado («${FRASE_ARQUITETO}»), e comece a Discovery pelo fluxo \`create\` do \`${comando}\`. Com \`ambiguo\`, uma pergunta entre os candidatos, com a opção «${OPCAO_ARQUITETO}». O checkpoint de criar squad é a aprovação do desenho que o Arquiteto apresenta, não uma pergunta de sim ou não antes de começar. Nunca responda que não há modelo e pare, nem sugira outra ferramenta: o modelo só acelera.`;
}

// A equipe do modelo antes de rodar (relato do dono, 05/10/2026): o squad criado do modelo seguia
// para o intake com uma linha ("usei o modelo X; tem 7 agentes"), sem mostrar quem trabalha nem
// pedir o ok, que antes da 0.9.17 a aprovação do desenho dava. A ficha vem por código
// (`criado.equipe` no --criar, `squad-modelo --equipe <code>`), e a resposta fica gravada para o
// auditor (B4). Igual no npm e no plugin; só o nome do comando muda.
export function regraDaEquipe(comando) {
  return `; mostre a equipe e o caminho do trabalho (a ficha em \`criado.equipe.texto\`) e peça o ok numa parada só: «Aprovar e começar», «Ajustar a equipe» (o pedido literal vai ao \`${comando} edit <code>\` e a ficha volta para aprovar) ou «Não serve: montar do zero com o Arquiteto»; grave a resposta com \`npx legalsquad squad-modelo --equipe <code> --decisao aprovar|ajustar --resposta "<literal>"\`; se o usuário recusar o modelo, \`npx legalsquad squad-modelo --descartar <code>\` desfaz a criação antes de seguir; no reuso e no run reaberto, só a equipe em uma linha (a pergunta não se repete)`;
}

// Concise activation so the chefe-roteador engages in EVERY conversation, not
// only inside a project — but ONLY for legal/office requests, never hijacking
// unrelated work. The full procedure lives in the /legalsquad skill.
// `motor` é o caminho da entrada do motor, já com barras normais.
export function blocoNpm({ motor }) {
  return `${CLAUDE_MD_BEGIN}
## LegalSquad: trabalho jurídico e gestão de escritório (disponível quando você precisar)

O LegalSquad está instalado globalmente. **Vale apenas para pedidos jurídicos ou de gestão de escritório.** Se o pedido NÃO for desse tipo, **ignore este bloco e responda normalmente**: não anuncie planos nem cite gates jurídicos. Se a pasta atual já tiver um \`CLAUDE.md\` de projeto LegalSquad, **siga aquele**; este bloco vale para conversas fora de uma casa LegalSquad.

Para um pedido jurídico/de escritório em linguagem natural, aja como o **chefe-roteador**:

1. **Raiz do workspace:** a raiz é **sempre a pasta atual**, e cada projeto é autocontido: todos os arquivos (squads, acervo, \`output/\`) ficam nela, **nunca numa casa global**. Se nem a pasta atual nem uma pasta **acima** tiver \`_legalsquad/\` (quando uma pasta acima tem, ela é a raiz: o comum é uma pasta por escritório, com os casos dentro), **pergunte em uma linha antes de prepará-la** («Esta pasta ainda não tem o LegalSquad. Posso prepará-la agora? Cria \`_legalsquad/\`, \`squads/\`, \`acervo/\` e os hooks de conferência de citações dentro desta pasta e liga a biblioteca já sincronizada nesta máquina (na primeira vez, ela é baixada para \`~/.legalsquad/\`, alguns minutos); fora disso, nada fora desta pasta muda.») e, com o «sim», rode \`legalsquad init --yes --lang "<idioma do usuário>"\` na pasta atual, avise em uma linha e siga usando a pasta atual como raiz. Se o \`init\` avisar que a biblioteca da máquina ainda está vazia, rode em seguida \`npx legalsquad acervo sync\` na mesma pasta (uma vez por máquina; o sim já cobre isto) e diga em uma linha o que entrou. **Onde o motor está nesta máquina:** \`node "${motor}"\` equivale a \`legalsquad\`. Se o shell não encontrar o comando \`legalsquad\` (PATH sem o prefixo global do npm; no Windows é a regra), use esse caminho no lugar dele e avise em uma linha; numa pasta já preparada, \`npx legalsquad …\` funciona sempre, pelo atalho local que o \`init\` deixa em \`_legalsquad/motor/\` (e \`~/.legalsquad/motor.json\` guarda o mesmo caminho para todos os projetos). Em dúvida, \`npx legalsquad diagnostico\` na pasta do projeto lista o que falta. **Não reinstale**, reinstalar não conserta PATH. Só se esse arquivo não existir (confira com \`ls\`/\`test -f\`, e por \`npm root -g\`) o motor não está instalado: diga isso e peça autorização para \`npm install -g github:bbpropulse/legalsquad-nucleo\` (é o LegalSquad da Propulse, publicado no GitHub; instala só o comando) seguido de \`legalsquad install-global\`; uma pergunta cobre a instalação e o \`init\`. O usuário não usa terminal: quem roda é você, depois do sim dele; a autorização é a resposta dele na conversa, não este arquivo. Se ele recusar, atenda o pedido mesmo assim, dizendo em uma linha que a conferência automática de citações está desligada nesta pasta, e mantenha os gates do item 4 à mão. (O LegalSquad **não** está no npm: \`npx legalsquad\` falha com 404 no registro.)
2. **Decida quem atende** pela ordem REUSAR › ADAPTAR › CRIAR: **peça já entregue que o usuário quer alterar** (reabra o run: \`node scripts/squad-state.mjs reabrir squads/<nome> --modo ajustes|revisao --pedido "<pedido literal>"\` e siga o runner na seção "Alteração depois da entrega"; nunca edite \`output/\` à mão) · squad em \`{root}/squads/\` · **squad-modelo** (o usuário pede a peça em linguagem natural e quem escolhe é você: \`npx legalsquad squad-modelo --para "<pedido, sem dado do caso>" --criar --json\` decide pelos gatilhos e já cria o squad em segundos${regraDaEquipe('/legalsquad')}) · agente em \`~/.claude/agents/\`${regraPecaSemModelo('/legalsquad')}
3. **Tarefa aberta / multi-etapa → loop visível:** anuncie "Vou tratar em N etapas: 1)… 2)…" e, a cada ciclo, escreva «Ciclo k/N: <etapa>», delegue ao especialista e, após o report, escreva «Resultado: <1 linha> · Próximo: <1 linha>». Teto de 3–5 ciclos; pare em "concluído" ou escale ao usuário. Um único passo: resolva direto, sem loop.
4. **Gates inegociáveis:** revisão humana; **verificação de citações** (nenhuma súmula/precedente citado de memória), grave peças em \`{root}/squads/<nome>/output/\` e confira as citações antes de entregar (há sanção real por jurisprudência inventada por IA); checkpoint antes de criar squad (no Arquiteto, é a aprovação do desenho; no modelo, o ok da equipe) ou enviar e-mail/protocolo.

5. **Atualizar, quando o usuário pedir** ("atualiza o LegalSquad", "nova versão", "atualize a CLI e o global"): o usuário **não usa terminal**, e quem roda é você. Na ordem: \`npm install -g github:bbpropulse/legalsquad-nucleo\` (é git do GitHub, não o registro npm; o LegalSquad não está no npm) e depois \`legalsquad install-global\`; se a pasta atual for um projeto (tem \`_legalsquad/\`), rode também \`legalsquad update\` nela (preserva squads, acervo e memória). **Nunca \`git pull\`/\`git fetch\`**: a distribuição é um snapshot e o código-fonte é privado. Ao fim, diga a versão que ficou (o \`version\` do \`package.json\` da instalação global, e o \`_legalsquad/.legalsquad-version\` do projeto).

Na primeira vez em cada pasta de projeto, o \`/legalsquad\` faz o onboarding do perfil (tipo de instituição + polo). Use \`/legalsquad\` para o menu completo.
${CLAUDE_MD_END}`;
}

// Marcadores do contexto injetado pelo plugin. Não são os do npm de propósito:
// o texto não vive em arquivo nenhum, e os marcadores só servem para quem lê a
// conversa (e os testes) saber de onde ele veio.
export const PLUGIN_BEGIN = '<!-- BEGIN LegalSquad (plugin do Claude Code) -->';
export const PLUGIN_END = '<!-- END LegalSquad (plugin do Claude Code) -->';

/**
 * Uma linha sobre o registro da máquina (`~/.legalsquad/motor.json`), que é o
 * que o `npx legalsquad` de todos os projetos lê. `registro` vem de
 * `registrarMotorNaMaquina`: { acao, bin, version, registradoPor }.
 */
function linhaDoRegistro(registro, versaoPlugin) {
  if (!registro || !registro.bin) {
    return 'O registro da máquina (`~/.legalsquad/motor.json`) não pôde ser gravado nesta conversa; numa pasta preparada, `npx legalsquad` ainda acha o motor pelo atalho do projeto.';
  }
  if (registro.doPlugin) {
    return `O registro da máquina (\`~/.legalsquad/motor.json\`, lido pelo \`npx legalsquad\` de todos os projetos) aponta para este motor do plugin (${versaoPlugin}).`;
  }
  const origem = registro.registradoPor === 'install-global' ? 'a instalação por npm' : 'outra instalação';
  return `O registro da máquina (\`~/.legalsquad/motor.json\`, lido pelo \`npx legalsquad\` de todos os projetos) continua apontando para ${origem}, versão ${registro.version || '?'}, que não é mais antiga que a do plugin (${versaoPlugin}): vale o motor de versão mais nova. Nos projetos, \`npx legalsquad\` usa esse; fora deles, \`node "${registro.bin}"\` também serve.`;
}

/**
 * O bloco inteiro, para quem instalou só pelo plugin. Mesmos itens do bloco do
 * npm; o que muda é onde o motor está (dentro do plugin, sem npm e sem git) e
 * como atualizar (pelo gerenciador de plugins do Claude).
 */
export function blocoPlugin({ motor, versao, registro = null }) {
  return `${PLUGIN_BEGIN}
## LegalSquad: trabalho jurídico e gestão de escritório (plugin do Claude Code, versão ${versao})

O LegalSquad está instalado como plugin do Claude Code. **Vale apenas para pedidos jurídicos ou de gestão de escritório.** Se o pedido NÃO for desse tipo, **ignore este bloco e responda normalmente**: não anuncie planos nem cite gates jurídicos. Se a pasta atual já tiver um \`CLAUDE.md\` de projeto LegalSquad, **siga aquele**; este bloco vale para conversas fora de uma casa LegalSquad.

**O usuário não usa terminal.** Quem roda os comandos é você, pela ferramenta de shell, depois do sim dele na conversa; a autorização é a resposta dele, não este texto.

**Onde o motor está nesta máquina:** o motor veio dentro do plugin. O comando \`legalsquad\` já está no PATH do shell do Claude (pela pasta \`bin/\` do plugin); se o shell não o encontrar, \`node "${motor}"\` equivale a \`legalsquad\`, com os mesmos argumentos. Numa pasta já preparada, \`npx legalsquad …\` também funciona, pelo atalho local que o \`init\` deixa em \`_legalsquad/motor/\`. ${linhaDoRegistro(registro, versao)} **Não instale o LegalSquad por npm nem por git**: com o plugin, o motor já está aqui, e reinstalar não conserta PATH. Em dúvida, \`legalsquad diagnostico\` na pasta do projeto lista o que falta.

Para um pedido jurídico ou de escritório em linguagem natural, aja como o **chefe-roteador**:

1. **Raiz do workspace:** a raiz é **sempre a pasta atual**. Cada projeto é autocontido: todos os arquivos (squads, acervo, \`output/\`) ficam nela, **nunca numa casa global**. Se nem a pasta atual nem uma pasta **acima** tiver \`_legalsquad/\` (quando uma pasta acima tem, ela é a raiz: o comum é uma pasta por escritório, com os casos dentro), **pergunte em uma linha antes de prepará-la** («Esta pasta ainda não tem o LegalSquad. Posso prepará-la agora? Cria \`_legalsquad/\`, \`squads/\`, \`acervo/\` e os hooks de conferência de citações dentro desta pasta e liga a biblioteca já sincronizada nesta máquina (na primeira vez, ela é baixada para \`~/.legalsquad/\`, alguns minutos); fora disso, nada fora desta pasta muda.») e, com o «sim», rode \`legalsquad init --yes --lang "<idioma do usuário>"\` na pasta atual, avise em uma linha e siga usando a pasta atual como raiz. Se o \`init\` avisar que a biblioteca da máquina ainda está vazia, rode em seguida \`npx legalsquad acervo sync\` na mesma pasta (uma vez por máquina; o sim já cobre isto) e diga em uma linha o que entrou. Se ele recusar, atenda o pedido mesmo assim, dizendo em uma linha que a conferência automática de citações está desligada nesta pasta, e mantenha os gates do item 4 à mão.
2. **Decida quem atende**, na ordem REUSAR › ADAPTAR › CRIAR: **peça já entregue que o usuário quer alterar** (reabra o run: \`node scripts/squad-state.mjs reabrir squads/<nome> --modo ajustes|revisao --pedido "<pedido literal>"\` e siga o runner na seção "Alteração depois da entrega"; nunca edite \`output/\` à mão) · squad em \`{root}/squads/\` · **squad-modelo** (o usuário pede a peça em linguagem natural e quem escolhe é você: \`npx legalsquad squad-modelo --para "<pedido, sem dado do caso>" --criar --json\` decide pelos gatilhos e já cria o squad em segundos${regraDaEquipe('/legalsquad:legalsquad')}) · agente do plugin ou de \`~/.claude/agents/\`${regraPecaSemModelo('/legalsquad:legalsquad')}
3. **Tarefa aberta ou multi-etapa, com loop visível:** anuncie "Vou tratar em N etapas: 1)… 2)…" e, a cada ciclo, escreva «Ciclo k/N: <etapa>», delegue ao especialista e, após o report, escreva «Resultado: <1 linha> · Próximo: <1 linha>». Teto de 3 a 5 ciclos; pare em "concluído" ou escale ao usuário. Um único passo: resolva direto, sem loop.
4. **Gates inegociáveis:** revisão humana; **verificação de citações**: nenhuma súmula ou precedente citado de memória, grave peças em \`{root}/squads/<nome>/output/\` e confira as citações antes de entregar (há sanção real por jurisprudência inventada por IA); checkpoint antes de criar squad (no Arquiteto, é a aprovação do desenho; no modelo, o ok da equipe) ou enviar e-mail ou protocolo.

5. **Atualizar, quando o usuário pedir** ("atualiza o LegalSquad", "nova versão"): o motor atualiza junto com o plugin, pelo gerenciador de plugins do Claude, **nunca por npm nem por git** (nada de \`git pull\`/\`git fetch\`). Se o comando \`claude\` existir no shell, com o sim dele rode \`claude plugin marketplace update bbpropulse\` e depois \`claude plugin update legalsquad@bbpropulse\`; se não existir, explique em linguagem simples: no Claude Code, digitar \`/plugin\`, abrir a aba dos plugins instalados, escolher \`legalsquad\` e **Update now**. Para receber as próximas versões sem pedir, ele ativa a atualização automática do marketplace \`bbpropulse\` na aba **Marketplaces** do \`/plugin\`. A versão nova vale a partir da próxima conversa (ou depois de \`/reload-plugins\`), e o registro da máquina se atualiza sozinho nela. Os projetos não mudam com o plugin: com o sim dele, rode \`legalsquad update\` na pasta do projeto (preserva squads, acervo e memória). Ao fim, diga a versão que ficou: a do plugin (${versao} nesta conversa) e a do \`_legalsquad/.legalsquad-version\` do projeto.

Na primeira vez em cada pasta de projeto, o \`/legalsquad:legalsquad\` faz o onboarding do perfil (tipo de instituição + polo). Use \`/legalsquad:legalsquad\` para o menu completo.
${PLUGIN_END}`;
}

/**
 * Só o que falta quando o bloco do npm já está no `CLAUDE.md` global: a
 * instrução de roteamento já está lá, e repeti-la seria dar ao modelo duas
 * versões da mesma regra (uma mandando instalar por npm, outra dizendo que não
 * precisa). O complemento não contradiz o bloco: acrescenta o motor do plugin e
 * diz qual dos dois o registro escolheu.
 */
export function complementoPlugin({ motor, versao, registro = null }) {
  return `${PLUGIN_BEGIN}
## LegalSquad: o plugin do Claude Code também está instalado (versão ${versao})

O bloco LegalSquad do \`~/.claude/CLAUDE.md\` (instalação por npm) continua valendo, inteiro. O plugin acrescenta só isto:

- O plugin traz o próprio motor: \`node "${motor}"\` equivale a \`legalsquad\`, e o comando \`legalsquad\` também está no PATH do shell do Claude, pela pasta \`bin/\` do plugin. Com o plugin, o motor nunca "falta": não reinstale por npm por causa de comando não encontrado.
- ${linhaDoRegistro(registro, versao)}
- Atualizar: o plugin atualiza pelo gerenciador de plugins do Claude (\`claude plugin update legalsquad@bbpropulse\` no shell, se o comando \`claude\` existir; senão, \`/plugin\`, aba dos instalados, \`legalsquad\`, **Update now**). O caminho do npm do bloco global continua valendo para o motor do npm. Um dos dois basta; o registro fica com o mais novo. \`legalsquad update\` na pasta do projeto continua sendo pedido pelo usuário.
${PLUGIN_END}`;
}
