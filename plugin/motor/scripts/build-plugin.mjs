#!/usr/bin/env node
/**
 * build-plugin — GERA o plugin do Claude Code a partir das fontes que já existem.
 *
 * POR QUE GERADO E NÃO MANTIDO À MÃO
 * ----------------------------------
 * 1. O plugin não é uma cópia: é uma cópia COM UMA EDIÇÃO SISTEMÁTICA. A skill
 *    `/legalsquad` e os agentes que auditam peça declaram os gates no próprio
 *    frontmatter apontando para `${CLAUDE_PROJECT_DIR}/.claude/hooks/…` — o
 *    caminho de quem recebeu os hooks pelo `init`. Dentro de um plugin os
 *    scripts viajam no PRÓPRIO plugin, e o placeholder que a doc garante para
 *    isso é `${CLAUDE_PLUGIN_ROOT}` (https://code.claude.com/docs/en/plugins-reference).
 *    Uma terceira cópia à mão seria uma cópia que alguém precisa lembrar de
 *    reeditar — a definição de drift.
 * 2. O repo já paga o preço de manter `.claude/` e
 *    `templates/ide-templates/claude-code/.claude/` idênticos byte a byte
 *    (`tests/templates-paridade.test.js`). Uma terceira frente à mão triplicaria
 *    esse custo; gerada, ela é consequência, não obrigação.
 * 3. A versão do manifesto vem do `package.json`. Este repositório já foi mordido
 *    por número digitado duas vezes (`package-lock` em 0.2.0 com `package.json`
 *    em 0.3.0); número de versão não se digita, se lê.
 *
 * O QUE ELE NÃO FAZ
 * -----------------
 * Não inventa conteúdo. A ÚNICA diferença de conteúdo entre fonte e plugin é a
 * reescrita de caminho de hook (mais um aviso de "arquivo gerado"). Se a fonte
 * mudar de forma que a reescrita não ache o que esperava, o build FALHA — drift
 * vira erro de build, nunca um plugin silenciosamente errado.
 *
 * O MOTOR VAI DENTRO
 * ------------------
 * Para instalar só pelo Claude (sem terminal, sem npm, sem git), o plugin
 * carrega o motor inteiro em `plugin/motor/`: o mesmo conjunto que o pacote npm
 * distribui (`package.json#files`), sem `node_modules`. O Claude Code copia para
 * o cache só a pasta do plugin ("Files outside the plugin directory aren't
 * copied", https://code.claude.com/docs/en/plugins/loading), então o motor não
 * pode morar fora dela. `plugin/motor/` é GERADO e NÃO versionado (está no
 * .gitignore): versioná-lo seria uma segunda cópia de src/ a cada commit. Quem
 * publica é o `scripts/build-dist.mjs`, que o embute direto das fontes na árvore
 * pública. As dependências de runtime do motor (docx para o .docx da entrega,
 * @inquirer para os prompts interativos) vão num `package.json` com
 * `package-lock.json` na raiz do plugin: a doc garante que o Claude Code roda
 * `npm ci --ignore-scripts` ali ao instalar e ao atualizar o plugin.
 *
 * USO
 * ---
 *   node scripts/build-plugin.mjs           grava (inclui plugin/motor/)
 *   node scripts/build-plugin.mjs --check   não grava; sai 1 se houver divergência
 *                                           (só na parte versionada)
 */
import { readFile, writeFile, mkdir, readdir, rm, stat, chmod } from 'node:fs/promises';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');

/**
 * Fonte única do plugin. É o template do Claude Code — a MESMA árvore que o
 * `install-global` copia para `~/.claude/` — e não o `.claude/` do repo, porque
 * é ela que o tarball npm publica (`package.json#files`). Plugin e npm passam
 * assim a distribuir literalmente os mesmos bytes.
 */
export const FONTE = join(ROOT, 'templates', 'ide-templates', 'claude-code', '.claude');

/** Raiz do plugin. Gerada e VERSIONADA: o marketplace a serve por caminho relativo. */
export const PLUGIN = join(ROOT, 'plugin');

export const NOME_PLUGIN = 'legalsquad';
export const REPO_URL = 'https://github.com/bbpropulse/legalsquad-nucleo';

/**
 * Descrição do PLUGIN, que não é a descrição do pacote npm: o que aparece no
 * gerenciador de plugins do Claude é para quem vai instalar, e precisa dizer o
 * que chega (tudo o que o advogado usa, inclusive o motor) e o único
 * pré-requisito que o plugin não resolve sozinho (o Node.js).
 */
export const DESCRICAO =
  'LegalSquad para o Claude Code: orquestração multi-agente para a prática jurídica, ' +
  'instalada só pelo Claude, sem terminal. Traz o motor (init, sync das áreas do Direito, ' +
  'squads, empacotador), a skill /legalsquad, os agentes de núcleo (verificador de citações, ' +
  'avaliador de squad, catalog-scout, verificador de persuasão, contraditor) e os gates ' +
  'determinísticos de citação e redação. Requer Node.js 22.15 ou mais novo.';

// ── A reescrita ─────────────────────────────────────────────────────────────
// De onde o `init` põe os hooks (dentro do projeto do usuário) para onde o plugin
// os carrega (dentro do próprio plugin). `${CLAUDE_PLUGIN_ROOT}` + `/scripts/` é
// a forma do exemplo oficial em plugins-reference; `${CLAUDE_PROJECT_DIR}` num
// plugin apontaria para o projeto do usuário, que pode não ter `.claude/hooks/`.
export const DE = '${CLAUDE_PROJECT_DIR}/.claude/hooks/';
export const PARA = '${CLAUDE_PLUGIN_ROOT}/scripts/';

/**
 * Aplica a reescrita e EXIGE o número de ocorrências esperado. Se a fonte for
 * reescrita lá em cima e o caminho sumir (ou aparecer de novo), este erro é o
 * único jeito de a divergência não virar um plugin com gate apontando para o
 * nada. Falhar alto é o ponto.
 */
export function reescreverCaminhosDeHook(texto, esperadas) {
  const ocorrencias = texto.split(DE).length - 1;
  if (ocorrencias !== esperadas) {
    throw new Error(
      `build-plugin: esperava ${esperadas} ocorrência(s) de "${DE}" e achei ${ocorrencias}. ` +
        'A fonte mudou — confira o frontmatter antes de regenerar o plugin.'
    );
  }
  return texto.split(DE).join(PARA);
}

/**
 * Aviso de arquivo gerado, como comentário YAML no topo do frontmatter.
 *
 * A última frase existe por um motivo específico: o comentário da fonte diz, em
 * prosa, que aquela skill chega por `install-global` ou por `init`, "nunca por
 * plugin". Era verdade quando foi escrito. Nesta cópia deixou de ser — e reescrever
 * a frase da fonte por regex seria uma regra frágil, presa à quebra de linha de
 * hoje. O aviso a supera de cima, sem depender de como ela está redigida.
 */
function banner(origemRel, temReescrita) {
  const transformacao = temReescrita
    ? [
        '│ Transformação: os hooks apontam para ${CLAUDE_PLUGIN_ROOT}/scripts/ (os',
        '│ scripts viajam DENTRO do plugin) no lugar de ${CLAUDE_PROJECT_DIR}/.claude/',
        '│ hooks/ (os scripts que o `legalsquad init` copia para o projeto). É a',
        '│ ÚNICA diferença de conteúdo em relação à fonte.',
        '│ Onde o comentário abaixo disser que este arquivo "nunca" chega por plugin,',
        '│ leia "também chega por plugin": esta cópia É a do plugin. O resto do',
        '│ comentário (evento, tipo de hook, forma shell) vale palavra por palavra.',
      ]
    : ['│ Transformação: nenhuma. Cópia literal da fonte, com este aviso.'];

  return [
    '# ┌─ ARQUIVO GERADO: não edite aqui ──────────────────────────────────────────',
    `# │ Fonte: templates/ide-templates/claude-code/.claude/${origemRel}`,
    '# │ Gerador: scripts/build-plugin.mjs · Regenerar: npm run build:plugin',
    ...transformacao.map((linha) => `# ${linha}`),
    '# └───────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}

/** Insere o aviso logo depois do `---` que abre o frontmatter (âncora estável). */
function inserirBanner(texto, aviso) {
  const abertura = texto.startsWith('---\r\n') ? '---\r\n' : '---\n';
  if (!texto.startsWith(abertura)) {
    throw new Error('build-plugin: fonte sem frontmatter na primeira linha — não sei onde avisar.');
  }
  const eol = abertura === '---\r\n' ? '\r\n' : '\n';
  return abertura + aviso.replace(/\n/g, eol) + texto.slice(abertura.length);
}

/**
 * O mapa do plugin. Esta lista é a fronteira: o que não está aqui NÃO viaja.
 *
 * `reescritas` é o número de caminhos de hook que o arquivo declara — conferido
 * a cada build. `catalog-scout` é read-only e não declara gate nenhum, por isso 0.
 */
export const ARQUIVOS = [
  { origem: 'skills/legalsquad/SKILL.md', destino: 'skills/legalsquad/SKILL.md', reescritas: 3 },
  { origem: 'agents/verificador-citacoes.md', destino: 'agents/verificador-citacoes.md', reescritas: 2 },
  { origem: 'agents/avaliador-squad.md', destino: 'agents/avaliador-squad.md', reescritas: 2 },
  // PERSUASAO.md §4-§5: os dois operam sobre squads/*/output e carregam o mesmo
  // par de gates no frontmatter — 2 caminhos de hook cada, como os juízes acima.
  { origem: 'agents/verificador-persuasao.md', destino: 'agents/verificador-persuasao.md', reescritas: 2 },
  { origem: 'agents/contraditor.md', destino: 'agents/contraditor.md', reescritas: 2 },
  { origem: 'agents/catalog-scout.md', destino: 'agents/catalog-scout.md', reescritas: 0 },
  // Os hooks são CÓPIA LITERAL, sem aviso nenhum: o Citation Gate do plugin tem
  // de ser byte a byte o mesmo código do gate do repo, e um comentário a mais já
  // quebraria a igualdade que `tests/templates-paridade.test.js` guarda.
  { origem: 'hooks/verifica-citacoes.mjs', destino: 'scripts/verifica-citacoes.mjs', literal: true },
  { origem: 'hooks/verifica-redacao.mjs', destino: 'scripts/verifica-redacao.mjs', literal: true },
  { origem: 'hooks/guarda-memoria.mjs', destino: 'scripts/guarda-memoria.mjs', literal: true },
  // O disparador dos hooks do PROJETO (o mesmo que o install-global copia para
  // ~/.claude/hooks/): acha a raiz pelo arquivo tocado e roda os hooks dela.
  { origem: 'hooks/legalsquad-disparador.mjs', destino: 'scripts/legalsquad-disparador.mjs', literal: true },
];

/**
 * Manifesto mínimo que valida — não manifesto rico que inventa. Todo campo aqui
 * está documentado em https://code.claude.com/docs/en/plugins-reference
 * ("Plugin manifest schema"); campo não documentado não entra, nem "porque seria
 * útil". Nenhum caminho de componente é declarado: `skills/`, `agents/` e
 * `hooks/hooks.json` estão nos lugares padrão, e declarar caminho que a doc já
 * assume só cria mais uma coisa para divergir.
 */
export async function montarManifesto() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
  const autor = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return {
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    name: NOME_PLUGIN,
    description: DESCRICAO,
    // Lida do package.json de propósito. Ver o cabeçalho deste arquivo.
    version: pkg.version,
    author: { name: autor },
    homepage: REPO_URL,
    repository: REPO_URL,
    license: pkg.license,
    keywords: pkg.keywords,
  };
}

/**
 * Os hooks que o plugin liga sozinho. Três papéis, cada um no escopo mais
 * estreito que o resolve:
 *
 * 1. `SessionStart` (motor/src/plugin-sessao.js): a instalação sem terminal. Grava
 *    o registro da máquina (~/.legalsquad/motor.json) e injeta o bloco do
 *    roteador como `additionalContext` (plugin não carrega CLAUDE.md). Forma
 *    shell de propósito: sem Node no computador, `node` nem existe para dizer o
 *    que falta, então o aviso em português sai do próprio shell (sh no macOS e
 *    no Linux, Git Bash no Windows, pela doc de hooks).
 *
 * 2. O BACKSTOP de citações. A decisão da §4 da spec MIKE-CHEFE foi tirar os
 *    gates do hook de máquina e pô-los no frontmatter da skill e dos agentes, que
 *    viajam no plugin e valem no escopo certo (a sessão jurídica, o agente
 *    rodando). O que sobra aqui é o mesmo backstop que o `install-global` grava
 *    em `~/.claude/settings.json`, com o mesmo escopo e o mesmo rótulo:
 *      • só `verifica-citacoes` como hook de máquina (nunca `verifica-redacao`):
 *        gate de redação disparando em pasta que não é trabalho jurídico é
 *        exatamente o excesso que essa estratificação existe para desfazer;
 *      • `PostToolUse`, que pelo contrato da plataforma não bloqueia: reporta. E
 *        o script só age dentro de `squads/<nome>/output/`, então em repositório
 *        nenhum-a-ver ele sai calado.
 *    Quem tiver o `install-global` E o plugin verá o backstop rodar duas vezes. É
 *    ruído, não erro: os dois são advisory e idempotentes.
 *
 * 3. O disparador dos hooks do PROJETO (`pre` e `post` de Write|Edit), o mesmo
 *    que o `install-global` registra. Não é gate de máquina: ele sobe a partir do
 *    arquivo tocado até `_legalsquad/` e, sem raiz, sai 0 sem ler nada; com raiz,
 *    roda os hooks DA RAIZ (o de redação só em `squads/*\/output/`, como no
 *    projeto). Resolve a sessão aberta fora da raiz do projeto (defeito 34 da
 *    medição dos moldes). Quem também tem o do `install-global` não o vê duas
 *    vezes: a cópia do plugin cede a vez à da máquina.
 */
export function montarHooks() {
  const semNode = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'O plugin LegalSquad está instalado, mas o Node.js não foi encontrado neste computador, e o motor do LegalSquad roda em Node. ' +
        'Para pedidos jurídicos: diga ao usuário, em linguagem simples, que falta instalar o Node.js (versão LTS, 22.15 ou mais nova) pelo instalador de https://nodejs.org, com as opções padrão, e depois fechar e abrir o Claude. ' +
        'Não instale o LegalSquad por npm nem por git, e não tente instalar o Node por conta própria. Até lá, os gates de citação também não rodam: nenhuma súmula ou precedente citado de memória.',
    },
    systemMessage:
      'LegalSquad: falta o Node.js neste computador. Baixe o instalador da versão LTS em https://nodejs.org, instale com as opções padrão e abra o Claude de novo.',
  });
  if (semNode.includes("'")) throw new Error('build-plugin: o aviso sem Node não pode ter aspas simples (vai entre aspas simples no shell).');

  return {
    description: 'LegalSquad: prepara a máquina no início da conversa, backstop de citações e disparador dos hooks do projeto.',
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'if command -v node >/dev/null 2>&1; then ' +
                `node "\${CLAUDE_PLUGIN_ROOT}/${PASTA_MOTOR}/src/plugin-sessao.js"; ` +
                `else printf '%s\\n' '${semNode}'; fi`,
              timeout: 30,
              statusMessage: 'LegalSquad · preparando o motor desta máquina',
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [
            {
              type: 'command',
              command: `node "${PARA}legalsquad-disparador.mjs" pre`,
              statusMessage: 'LegalSquad · guarda de memória do projeto do arquivo',
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [
            {
              type: 'command',
              command: `node "${PARA}verifica-citacoes.mjs"`,
              statusMessage: 'LegalSquad · backstop de citações (advisory)',
            },
            {
              type: 'command',
              command: `node "${PARA}legalsquad-disparador.mjs" post`,
              statusMessage: 'LegalSquad · gates do projeto do arquivo',
            },
          ],
        },
      ],
    },
  };
}

// ── O motor dentro do plugin ─────────────────────────────────────────────────

/** Pasta do motor dentro do plugin. `${CLAUDE_PLUGIN_ROOT}/motor/bin/legalsquad.js`. */
export const PASTA_MOTOR = 'motor';

/**
 * O que NÃO entra no motor embutido, com o caminho relativo à raiz do repo. É o
 * filtro do `build-dist.mjs` (o conjunto público), mais os artefatos de build do
 * painel: o `dashboard` viaja como fonte, e o `legalsquad dashboard` instala as
 * dependências dele no projeto quando o painel é aberto.
 */
const FORA_DO_MOTOR =
  /(^|\/)(node_modules|\.git|__pycache__)(\/|$)|\.pyc$|tsconfig\.tsbuildinfo$|(^|\/)\.DS_Store$|^dashboard\/(dist|test-results)(\/|$)/;

/**
 * O conjunto do motor: exatamente `package.json#files` (o que o `npm install -g`
 * instala) mais o próprio `package.json` e a licença. Testes, docs de
 * desenvolvimento e `node_modules` ficam de fora por construção: não estão em
 * `files`.
 */
export async function entradasDoMotor(raiz = ROOT) {
  const pkg = JSON.parse(await readFile(join(raiz, 'package.json'), 'utf-8'));
  return [...(pkg.files || []).filter((e) => !e.startsWith('!')), 'package.json', 'LICENSE.md'];
}

async function medir(dir) {
  let arquivos = 0;
  let bytes = 0;
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      const m = await medir(caminho);
      arquivos += m.arquivos;
      bytes += m.bytes;
    } else {
      arquivos++;
      bytes += (await stat(caminho)).size;
    }
  }
  return { arquivos, bytes };
}

/**
 * Copia o motor para `<destinoPlugin>/motor/`, do zero (a pasta é gerada: nada
 * nela é do usuário). Devolve { destino, arquivos, bytes }.
 */
export async function embutirMotor(destinoPlugin, { raiz = ROOT } = {}) {
  const destino = join(destinoPlugin, PASTA_MOTOR);
  rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  for (const entrada of await entradasDoMotor(raiz)) {
    const rel = entrada.replace(/\/$/, '');
    const origem = join(raiz, rel);
    if (!existsSync(origem)) continue;
    mkdirSync(dirname(join(destino, rel)), { recursive: true });
    cpSync(origem, join(destino, rel), {
      recursive: true,
      filter: (caminho) => !FORA_DO_MOTOR.test(relative(raiz, caminho).split(sep).join('/')),
    });
  }
  return { destino, ...(await medir(destino)) };
}

// ── O comando `legalsquad` no shell do Claude ────────────────────────────────

// "Files here are on the Bash tool's PATH while the plugin is enabled"
// (plugins-reference, "Standard layout"). Com isso, todo `legalsquad …` que a
// skill, o runner e o bloco do roteador já escrevem funciona sem npm. O preço,
// declarado na mesma linha da doc: claude.ai e Cowork não instalam plugin com
// `bin/`. O alvo aqui é o Claude Code (terminal e aba Code do app), onde o motor
// roda na máquina do advogado.
const BIN_SH = `#!/bin/sh
# LegalSquad: o comando \`legalsquad\` no shell do Claude Code, vindo do plugin.
# Gerado por scripts/build-plugin.mjs. Roda o motor embutido em ../${PASTA_MOTOR}/.
aqui=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "LegalSquad: o Node.js não foi encontrado neste computador. Instale a versão LTS pelo instalador de https://nodejs.org e abra o Claude de novo." >&2
  exit 127
fi
exec node "$aqui/../${PASTA_MOTOR}/bin/legalsquad.js" "$@"
`;

// PowerShell (a ferramenta do Claude Code no Windows sem Git Bash) acha `.cmd` no
// PATH. Sem acento: o console do cmd não garante UTF-8.
const BIN_CMD = [
  '@ECHO off',
  'REM LegalSquad: o comando legalsquad no Windows, vindo do plugin. Gerado por scripts/build-plugin.mjs.',
  'WHERE node >NUL 2>NUL || (ECHO LegalSquad: o Node.js nao foi encontrado neste computador. Instale a versao LTS pelo instalador de https://nodejs.org e abra o Claude de novo. 1>&2 & EXIT /b 127)',
  `node "%~dp0..\\${PASTA_MOTOR}\\bin\\legalsquad.js" %*`,
  '',
].join('\r\n');

/** Arquivos que precisam do bit de execução (o `bin/` vai para o PATH). */
export const EXECUTAVEIS = new Set(['bin/legalsquad']);

// ── Dependências de runtime do motor ─────────────────────────────────────────

/**
 * `package.json` + `package-lock.json` na raiz do plugin, com as MESMAS
 * dependências de runtime do motor e as MESMAS versões travadas do lock do repo.
 * A doc (plugins/loading, "Node.js package dependencies"): ao copiar o plugin
 * para o cache, o Claude Code roda `npm ci --ignore-scripts` onde houver
 * `package.json` e `package-lock.json` na raiz. O motor em `motor/` resolve
 * `docx` subindo até `node_modules/` da raiz do plugin. Se o `npm ci` falhar
 * (sem npm, sem rede), nada quebra além do .docx da entrega, que já avisa.
 */
export async function montarDependencias(raiz = ROOT) {
  const pkg = JSON.parse(await readFile(join(raiz, 'package.json'), 'utf-8'));
  const lock = JSON.parse(await readFile(join(raiz, 'package-lock.json'), 'utf-8'));
  const nome = `${NOME_PLUGIN}-plugin`;
  const dependencias = { ...(pkg.dependencies || {}) };
  const manifesto = {
    name: nome,
    version: pkg.version,
    private: true,
    description: 'Dependências de runtime do motor LegalSquad embutido neste plugin (instaladas pelo Claude Code com npm ci).',
    license: pkg.license,
    dependencies: dependencias,
    engines: pkg.engines,
  };
  const pacotes = {
    '': { name: nome, version: pkg.version, license: pkg.license, dependencies: dependencias, engines: pkg.engines },
  };
  for (const [caminho, info] of Object.entries(lock.packages || {})) {
    if (!caminho || info.dev) continue;
    pacotes[caminho] = info;
  }
  for (const dep of Object.keys(dependencias)) {
    if (!pacotes[`node_modules/${dep}`]) {
      throw new Error(`build-plugin: ${dep} está em dependencies e não no package-lock.json; rode npm install antes.`);
    }
  }
  const travado = { name: nome, version: pkg.version, lockfileVersion: lock.lockfileVersion, requires: true, packages: pacotes };
  return {
    'package.json': JSON.stringify(manifesto, null, 2) + '\n',
    'package-lock.json': JSON.stringify(travado, null, 2) + '\n',
  };
}

/** README do plugin: para quem instala, em linguagem de escritório. */
function montarReadme(versao) {
  return `<!-- ARQUIVO GERADO por scripts/build-plugin.mjs. Não edite aqui. -->

# LegalSquad: plugin do Claude Code

Versão ${versao}. Tudo o que o LegalSquad precisa vem neste plugin, inclusive o motor: não é
preciso abrir o terminal, nem instalar nada pelo npm ou pelo git.

## Antes de começar: o Node.js

O LegalSquad roda sobre o Node.js (versão 22.15 ou mais nova). Se o computador ainda não tem,
baixe o instalador da versão **LTS** em https://nodejs.org, instale com as opções padrão e feche e
abra o Claude. Se faltar, o próprio plugin avisa em português no início da conversa.

## Instalar pelo Claude Code

Numa conversa do Claude Code, digite estas duas linhas, uma de cada vez:

\`\`\`text
/plugin marketplace add bbpropulse/legalsquad-nucleo
/plugin install ${NOME_PLUGIN}@bbpropulse
\`\`\`

A primeira cadastra a loja de plugins da bbpropulse (só uma vez por computador). A segunda abre a
ficha do plugin: escolha **Install for you (user scope)**, para ter o LegalSquad em todas as
pastas. Se o Claude pedir, rode \`/reload-plugins\` ou abra uma conversa nova.

## Instalar pelo app Claude (aba Code)

Numa sessão local da aba **Code**, clique no **+** ao lado da caixa de mensagem, escolha
**Plugins** e depois **Add plugin**; procure \`${NOME_PLUGIN}\` e escolha o escopo do seu usuário. O
navegador de plugins do app mostra os plugins das lojas já cadastradas: se a loja da bbpropulse
ainda não aparecer, cadastre-a uma vez pelo Claude Code (\`/plugin marketplace add
bbpropulse/legalsquad-nucleo\`). O terminal, o app e o VS Code do mesmo computador leem as mesmas
configurações, então o plugin instalado em um aparece nos outros.

## Usar

Abra a pasta do escritório e peça em português o que precisa, ou digite
\`/legalsquad:legalsquad\` para o menu. Na primeira vez em cada pasta, o Claude pergunta antes de
prepará-la. Na primeira conversa depois de instalar, o plugin registra o motor neste computador;
não há mais nada a fazer.

## Atualizar

No Claude Code: \`/plugin\`, aba dos plugins instalados, \`${NOME_PLUGIN}\`, **Update now**. Para receber as
versões novas sem pedir, ative a atualização automática da loja \`bbpropulse\` na aba
**Marketplaces** do \`/plugin\` (lojas de terceiros vêm com ela desligada). A versão nova vale a
partir da conversa seguinte. As pastas dos projetos não mudam sozinhas: peça ao Claude
"atualiza o LegalSquad nesta pasta" e ele roda o \`legalsquad update\` nela.

## O que vem aqui

- \`${PASTA_MOTOR}/\`: o motor (o mesmo conjunto do pacote npm, sem \`node_modules\`);
- \`bin/legalsquad\`: o comando \`legalsquad\` no shell do Claude, enquanto o plugin está ativo;
- \`skills/legalsquad/\`: a skill \`/legalsquad:legalsquad\`, com os gates de citação e redação;
- \`agents/\`: os cinco agentes de núcleo (\`verificador-citacoes\`, \`avaliador-squad\`,
  \`catalog-scout\`, \`verificador-persuasao\`, \`contraditor\`);
- \`scripts/\`: os hooks determinísticos, byte a byte iguais aos do motor;
- \`hooks/hooks.json\`: a preparação do início da conversa, o backstop de citações e o disparador
  dos hooks do projeto;
- \`package.json\` e \`package-lock.json\`: as dependências do motor (\`docx\`, para a peça em
  .docx), que o Claude Code instala sozinho ao instalar ou atualizar o plugin.

## O que NÃO vem aqui

Nenhuma **matéria jurídica de área** (skills de matéria, squads, best-practices, acervo, agentes
especialistas): as áreas do Direito chegam como pacotes assinados pelo \`legalsquad acervo sync\`,
que o Claude roda na primeira pasta preparada. Nem memória, nem \`squads/*/output/\`, nem
\`skills/_evals/results/\`.

Quem já instalou pelo npm (\`legalsquad install-global\`) pode instalar o plugin também: os dois
convivem, e vale o motor de versão mais nova.
`;
}

/** Monta, em memória, a árvore VERSIONADA do plugin: caminho relativo → conteúdo. */
export async function montarArvore() {
  const arvore = new Map();

  for (const item of ARQUIVOS) {
    const bruto = await readFile(join(FONTE, item.origem), 'utf-8');
    if (item.literal) {
      arvore.set(item.destino, bruto);
      continue;
    }
    const reescrito = reescreverCaminhosDeHook(bruto, item.reescritas);
    arvore.set(item.destino, inserirBanner(reescrito, banner(item.origem, item.reescritas > 0)));
  }

  const manifesto = await montarManifesto();
  arvore.set('.claude-plugin/plugin.json', JSON.stringify(manifesto, null, 2) + '\n');
  arvore.set('hooks/hooks.json', JSON.stringify(montarHooks(), null, 2) + '\n');
  arvore.set('README.md', montarReadme(manifesto.version));
  arvore.set('bin/legalsquad', BIN_SH);
  arvore.set('bin/legalsquad.cmd', BIN_CMD);
  for (const [rel, conteudo] of Object.entries(await montarDependencias())) arvore.set(rel, conteudo);

  return arvore;
}

/**
 * Pastas do plugin em disco que NÃO são da árvore versionada: o motor embutido
 * (gerado por `embutirMotor`) e o `node_modules` que o `npm ci` do Claude Code
 * cria. Nem divergência, nem "sobrando".
 */
export const GERADOS_FORA_DA_ARVORE = [`${PASTA_MOTOR}/`, 'node_modules/'];

/** Lista recursivamente os arquivos do plugin em disco (caminhos relativos, POSIX). */
export async function listarEmDisco(dir, base = dir) {
  let entradas;
  try {
    entradas = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const achados = [];
  for (const entrada of entradas) {
    const caminho = join(dir, entrada.name);
    const rel = relative(base, caminho).split(sep).join(posix.sep);
    if (entrada.isDirectory()) {
      if (GERADOS_FORA_DA_ARVORE.includes(`${rel}/`)) continue;
      achados.push(...(await listarEmDisco(caminho, base)));
    } else achados.push(rel);
  }
  return achados;
}

async function ehExecutavel(caminho) {
  if (process.platform === 'win32') return true; // sem bit de execução no NTFS
  try {
    return ((await stat(caminho)).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Gera o plugin. Com `{ check: true }` nada é gravado: devolve o que estaria
 * fora de sincronia na parte versionada (é assim que `tests/plugin.test.js`
 * prende a paridade, no mesmo molde do `buildIdeTemplates`). Sem `check`, grava a
 * parte versionada e embute o motor em `plugin/motor/` (`{ motor: false }` pula
 * esse passo).
 *
 * Arquivo que existe em disco e não está na árvore entra como divergência
 * `sobrando:`, e é o que impede alguém de acrescentar matéria jurídica ao plugin
 * na mão e ninguém perceber.
 */
export async function buildPlugin({ check = false, motor = true } = {}) {
  const arvore = await montarArvore();
  const divergentes = [];

  for (const [rel, conteudo] of arvore) {
    const destino = join(PLUGIN, ...rel.split(posix.sep));
    let atual = null;
    try {
      atual = await readFile(destino, 'utf-8');
    } catch {
      // ainda não existe
    }
    const precisaExecutar = EXECUTAVEIS.has(rel);
    if (atual === conteudo && (!precisaExecutar || (await ehExecutavel(destino)))) continue;
    divergentes.push(atual === conteudo ? `sem bit de execução: ${rel}` : rel);
    if (!check) {
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, conteudo, 'utf-8');
      if (precisaExecutar) await chmod(destino, 0o755);
    }
  }

  for (const rel of await listarEmDisco(PLUGIN)) {
    if (arvore.has(rel)) continue;
    divergentes.push(`sobrando: ${rel}`);
    if (!check) await rm(join(PLUGIN, ...rel.split(posix.sep)), { force: true });
  }

  if (!check && motor) await embutirMotor(PLUGIN);

  return divergentes;
}

/**
 * Gera o plugin inteiro (parte versionada + motor) numa pasta qualquer, direto
 * das fontes. É o que os testes usam para simular o cache do Claude Code
 * (`cache/<marketplace>/<plugin>/<versão>/`) sem depender do `plugin/` local.
 */
export async function gerarPluginEm(destino, { raiz = ROOT } = {}) {
  for (const [rel, conteudo] of await montarArvore()) {
    const caminho = join(destino, ...rel.split(posix.sep));
    await mkdir(dirname(caminho), { recursive: true });
    await writeFile(caminho, conteudo, 'utf-8');
    if (EXECUTAVEIS.has(rel)) await chmod(caminho, 0o755);
  }
  return embutirMotor(destino, { raiz });
}

// Execução direta: `node scripts/build-plugin.mjs [--check]`
const ehPrincipal = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehPrincipal) {
  const check = process.argv.includes('--check');
  const divergentes = await buildPlugin({ check });
  if (divergentes.length === 0) {
    console.log('plugin/ está em sincronia com templates/ide-templates/claude-code/.claude/.');
  } else if (check) {
    console.error(
      `plugin/ fora de sincronia (${divergentes.length}):\n  ${divergentes.join('\n  ')}\n` +
        'Rode `npm run build:plugin`.'
    );
    process.exit(1);
  } else {
    console.log(`plugin/ regenerado (${divergentes.length}):\n  ${divergentes.join('\n  ')}`);
  }
  if (!check) {
    const { arquivos, bytes } = await medir(join(PLUGIN, PASTA_MOTOR));
    console.log(`plugin/${PASTA_MOTOR}/ embutido: ${arquivos} arquivos, ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
  }
}
