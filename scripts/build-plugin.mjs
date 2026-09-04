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
 * USO
 * ---
 *   node scripts/build-plugin.mjs           grava
 *   node scripts/build-plugin.mjs --check   não grava; sai 1 se houver divergência
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
 * Descrição do PLUGIN, que não é a descrição do pacote npm: o plugin distribui a
 * superfície de comando (skill + agentes de núcleo + gates), enquanto o motor
 * (CLI `legalsquad`, `init`, `sync`, empacotador) continua vindo do GitHub. Dizer
 * o contrário no gerenciador de plugins prometeria o que o plugin não entrega.
 */
export const DESCRICAO =
  'Superfície de comando do LegalSquad para o Claude Code: a skill /legalsquad, ' +
  'os agentes de núcleo (verificador de citações, avaliador de squad, catalog-scout, ' +
  'verificador de persuasão, contraditor) e os gates determinísticos de citação e ' +
  'redação. O motor (CLI legalsquad) continua sendo instalado à parte, pelo GitHub.';

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
        '│ comentário — evento, tipo de hook, forma shell — vale palavra por palavra.',
      ]
    : ['│ Transformação: nenhuma. Cópia literal da fonte, com este aviso.'];

  return [
    '# ┌─ ARQUIVO GERADO — não edite aqui ─────────────────────────────────────────',
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
 * O ÚNICO hook que o plugin liga sozinho, e de propósito o mais estreito possível.
 *
 * A decisão da §4 da spec MIKE-CHEFE foi tirar os gates do hook de máquina e
 * pô-los no frontmatter da skill e dos agentes — que viajam no plugin e valem no
 * escopo certo (a sessão jurídica / o agente rodando). O que sobra aqui é o mesmo
 * BACKSTOP que o `install-global` grava em `~/.claude/settings.json`, com o mesmo
 * escopo e o mesmo rótulo:
 *   • só `verifica-citacoes` (nunca `verifica-redacao`): gate de redação disparando
 *     em pasta que não é trabalho jurídico é exatamente o excesso que essa
 *     estratificação existe para desfazer;
 *   • `PostToolUse`, que pelo contrato da plataforma não bloqueia — reporta. E o
 *     script só age dentro de `squads/<nome>/output/`, então em repositório
 *     nenhum-a-ver ele sai calado.
 *
 * Quem tiver o `install-global` E o plugin verá o backstop rodar duas vezes. É
 * ruído, não erro: os dois são advisory e idempotentes.
 */
export function montarHooks() {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [
            {
              type: 'command',
              command: `node "${PARA}verifica-citacoes.mjs"`,
              statusMessage: 'LegalSquad · backstop de citações (advisory)',
            },
          ],
        },
      ],
    },
  };
}

/** README do plugin — curto de propósito: a documentação de verdade é a do repo. */
function montarReadme(versao) {
  return `<!-- ARQUIVO GERADO por scripts/build-plugin.mjs — não edite aqui. -->

# LegalSquad — plugin do Claude Code

Versão ${versao}. Gerado a partir de \`templates/ide-templates/claude-code/.claude/\`
no repositório [legalsquad-nucleo](${REPO_URL}).

## Instalar

\`\`\`bash
claude plugin marketplace add bbpropulse/legalsquad-nucleo
claude plugin install ${NOME_PLUGIN}@bbpropulse
\`\`\`

## O que vem aqui

- \`skills/legalsquad/\` — a skill \`/legalsquad:legalsquad\`, com os gates de citação
  e redação no frontmatter;
- \`agents/\` — os cinco agentes de núcleo (\`verificador-citacoes\`, \`avaliador-squad\`,
  \`catalog-scout\`, \`verificador-persuasao\`, \`contraditor\`);
- \`scripts/\` — os hooks determinísticos, byte a byte iguais aos do motor;
- \`hooks/hooks.json\` — o backstop advisory de citações.

## O que NÃO vem aqui

O **motor** (CLI \`legalsquad\`: \`init\`, \`update\`, \`acervo sync\`, empacotador) e o
bloco global de \`CLAUDE.md\` — plugin não injeta \`CLAUDE.md\`. Instale o motor com
\`npm install -g github:bbpropulse/legalsquad-nucleo\`.

Também não viaja aqui **nenhuma matéria jurídica de área** (skills de matéria,
squads, best-practices, acervo, agentes especialistas): áreas do Direito chegam
como pacotes assinados por \`legalsquad acervo sync\`. Nem memória, nem
\`squads/*/output/\`, nem \`skills/_evals/results/\`.
`;
}

/** Monta, em memória, a árvore inteira do plugin: caminho relativo → conteúdo. */
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

  return arvore;
}

/** Lista recursivamente os arquivos do plugin em disco (caminhos relativos, POSIX). */
async function listarEmDisco(dir, base = dir) {
  let entradas;
  try {
    entradas = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const achados = [];
  for (const entrada of entradas) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...(await listarEmDisco(caminho, base)));
    else achados.push(relative(base, caminho).split(sep).join(posix.sep));
  }
  return achados;
}

/**
 * Gera o plugin. Com `{ check: true }` nada é gravado — devolve o que estaria
 * fora de sincronia (é assim que `tests/plugin.test.js` prende a paridade, no
 * mesmo molde do `buildIdeTemplates`).
 *
 * Arquivo que existe em disco e não está na árvore entra como divergência
 * `sobrando:` — é o que impede alguém de acrescentar matéria jurídica ao plugin
 * na mão e ninguém perceber.
 */
export async function buildPlugin({ check = false } = {}) {
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
    if (atual === conteudo) continue;
    divergentes.push(rel);
    if (!check) {
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, conteudo, 'utf-8');
    }
  }

  for (const rel of await listarEmDisco(PLUGIN)) {
    if (arvore.has(rel)) continue;
    divergentes.push(`sobrando: ${rel}`);
    if (!check) await rm(join(PLUGIN, ...rel.split(posix.sep)), { force: true });
  }

  return divergentes;
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
}
