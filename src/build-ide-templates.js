import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS_DIR = join(ROOT, 'templates', 'ide-assets');
const IDE = 'templates/ide-templates';

// Single source of truth: each shared body lives once in templates/ide-assets/.
// The files below carry that body, each wrapped in its own per-IDE frontmatter
// (which is legitimately IDE-specific and stays in the file). Paths are relative
// to the repo root, so this also covers the repo's OWN copies (the LegalSquad
// repo functioning as a project). Editing a body asset + `npm run build:ide`
// propagates the change everywhere — replacing the old hand-maintained mirroring.
export const MANIFEST = {
  'command-body.md': [
    `${IDE}/claude-code/.claude/skills/legalsquad/SKILL.md`,
    `${IDE}/gemini-cli/.gemini/skills/legalsquad/SKILL.md`,
    `${IDE}/qwen-code/.qwen/skills/legalsquad/SKILL.md`,
    `${IDE}/vscode-copilot/.github/prompts/legalsquad.prompt.md`,
    // Cursor tem superfície de comando sob demanda (.cursor/commands/) — o corpo
    // completo entra por ela, como o prompt do Copilot e o workflow do Antigravity.
    // Antes este arquivo era um ponteiro fino para as rules, que carregam só o
    // instructions-body: o usuário de Cursor nunca via Command Routing nem o
    // handoff roteador→chefe (débito D3 do CHEFE-DE-SQUAD.md). As rules (.mdc,
    // alwaysApply) NÃO recebem o command-body: entram em toda conversa, e 40 KB
    // de programa de comando não pertencem a contexto ambiente.
    `${IDE}/cursor/.cursor/commands/legalsquad.md`,
    `${IDE}/opencode/AGENTS.md`,
    '.claude/skills/legalsquad/SKILL.md', // cópia do próprio repo
  ],
  'instructions-body.md': [
    `${IDE}/claude-code/CLAUDE.md`,
    `${IDE}/gemini-cli/GEMINI.md`,
    `${IDE}/qwen-code/QWEN.md`,
    `${IDE}/antigravity/.agents/rules/legalsquad.md`,
    `${IDE}/cursor/.cursor/rules/legalsquad.mdc`,
    // Trae só tem rules sempre-aplicadas — não há convenção de arquivo de
    // comando na IDE. Por isso o instructions-body carrega a linha de handoff
    // roteador→chefe (D3): é o único veículo que alcança este destino.
    `${IDE}/trae/.trae/rules/legalsquad.md`,
    // O CLAUDE.md da raiz NÃO é gerado: é a instrução do projeto LegalSquad
    // (fronteira núcleo × pacote, regras do build-area), não o corpo distribuído
    // às IDEs. Gerá-lo aqui sobrescrevia a documentação do repositório.
  ],
};

// Codex e Antigravity (21/10/2026) leem a mesma pasta de skills (`.agents/skills/`), e o arquivo
// que carregam tem dois corpos: as notas das duas IDEs (o que muda em relação ao Claude Code) e o
// corpo do comando. O AGENTS.md do Codex fica curto: o Codex corta a instrução de projeto em 32 KiB
// (project_doc_max_bytes, https://learn.chatgpt.com/docs/agent-configuration/agents-md), e o
// command-body inteiro passava de 80 KB; ele leva as instruções do projeto (roteador e
// conformidade) e as notas, e o corpo do comando vai para a skill, que não tem teto
// (https://learn.chatgpt.com/docs/build-skills). O Antigravity aposentou os workflows em 19/10/2026
// (https://antigravity.google/docs/migration/workflows-to-skills): o /legalsquad é a skill.
const SKILL_DAS_DUAS = ['agents-ide-notes.md', 'command-body.md'];
export const COMPOSTOS = {
  [`${IDE}/codex/AGENTS.md`]: ['instructions-body.md', 'agents-ide-notes.md'],
  [`${IDE}/codex/.agents/skills/legalsquad/SKILL.md`]: SKILL_DAS_DUAS,
  [`${IDE}/antigravity/.agents/skills/legalsquad/SKILL.md`]: SKILL_DAS_DUAS,
};

// Os agentes do motor no Antigravity são gerados dos do Claude Code (a fonte), com as ferramentas
// traduzidas para os nomes do Antigravity (https://antigravity.google/docs/hooks lista os nomes e os
// argumentos; https://antigravity.google/docs/subagents, os campos). A doc avisa que nome de
// ferramenta errado em `tools` pode travar o subagente: ferramenta sem tradução aqui para o build.
// `find_by_name`, `grep_search` e `list_dir` saíram do conjunto padrão (CLI v1.2.7), então o
// agente de leitura as lista. Agente sem ferramenta de escrita é somente leitura de verdade.
const FONTE_DOS_AGENTES = `${IDE}/claude-code/.claude/agents`;
const DESTINO_ANTIGRAVITY = `${IDE}/antigravity/.agents/agents`;
const FERRAMENTA_ANTIGRAVITY = {
  Read: ['view_file'],
  Grep: ['grep_search'],
  Glob: ['find_by_name', 'list_dir'],
  WebFetch: ['read_url_content'],
  WebSearch: ['search_web'],
  Write: ['write_to_file'],
  Edit: ['replace_file_content', 'multi_replace_file_content'],
  Bash: ['run_command'],
};

/** O agente do Claude Code (`.md` com frontmatter) no formato de subagente do Antigravity. */
export function agenteParaAntigravity(texto, origem = 'agente') {
  const m = texto.match(FRONTMATTER_RE);
  if (!m) throw new Error(`${origem}: sem frontmatter`);
  const campo = (nome) => m[1].match(new RegExp(`^${nome}:.*$`, 'm'))?.[0];
  const nome = campo('name');
  const descricao = campo('description');
  const tools = campo('tools');
  if (!nome || !descricao || !tools) throw new Error(`${origem}: falta name, description ou tools`);
  const ferramentas = [];
  for (const t of tools.replace(/^tools:\s*/, '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const traducao = FERRAMENTA_ANTIGRAVITY[t];
    if (!traducao) throw new Error(`${origem}: ferramenta "${t}" sem tradução para o Antigravity`);
    for (const f of traducao) if (!ferramentas.includes(f)) ferramentas.push(f);
  }
  const corpo = texto.slice(m[0].length).replace(/^\s*\n/, '');
  return [
    '---',
    nome,
    descricao,
    'tools:',
    ...ferramentas.map((f) => `  - ${f}`),
    'subagent: true',
    'mainAgent: false',
    'model: inherit',
    '# Gerado de .claude/agents/ por `npm run build:ide` (src/build-ide-templates.js): edite a fonte.',
    '---',
    '',
    corpo,
  ].join('\n');
}

// CRLF-tolerant: a target edited on Windows (or git autocrlf) must not silently
// lose its IDE-specific frontmatter when the generator runs.
const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---)\r?\n/;

// Reassembles a target file: preserve its existing frontmatter (if any) and use
// the shared body. Frontmatter + blank line + body, or just the body.
function render(currentContent, body) {
  const match = currentContent.match(FRONTMATTER_RE);
  return match ? `${match[1]}\n\n${body}` : body;
}

// Regenerates the IDE template bodies from templates/ide-assets/. With
// { check: true } nothing is written — it returns the files that are out of sync
// (used by tests/CI). Returns the list of changed (or would-be-changed) files.
export async function buildIdeTemplates({ check = false } = {}) {
  const changed = [];
  for (const [asset, files] of Object.entries(MANIFEST)) {
    const body = await readFile(join(ASSETS_DIR, asset), 'utf-8');
    for (const rel of files) {
      const path = join(ROOT, rel);
      const current = await readFile(path, 'utf-8');
      const next = render(current, body);
      if (next !== current) {
        changed.push(rel);
        if (!check) await writeFile(path, next, 'utf-8');
      }
    }
  }
  for (const [rel, assets] of Object.entries(COMPOSTOS)) {
    const body = (await Promise.all(assets.map((a) => readFile(join(ASSETS_DIR, a), 'utf-8')))).join('\n');
    const path = join(ROOT, rel);
    let current = '';
    try { current = await readFile(path, 'utf-8'); } catch { /* novo */ }
    const next = render(current, body);
    if (next !== current) {
      changed.push(rel);
      if (!check) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, next, 'utf-8');
      }
    }
  }
  for (const nome of (await readdir(join(ROOT, FONTE_DOS_AGENTES))).filter((n) => n.endsWith('.md')).sort()) {
    const next = agenteParaAntigravity(await readFile(join(ROOT, FONTE_DOS_AGENTES, nome), 'utf-8'), nome);
    const rel = `${DESTINO_ANTIGRAVITY}/${nome}`;
    const path = join(ROOT, rel);
    let current = null;
    try { current = await readFile(path, 'utf-8'); } catch { /* novo */ }
    if (next !== current) {
      changed.push(rel);
      if (!check) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, next, 'utf-8');
      }
    }
  }
  return changed;
}

// Run directly: `node src/build-ide-templates.js`
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const changed = await buildIdeTemplates();
  console.log(
    changed.length
      ? `IDE templates atualizados (${changed.length}):\n  ${changed.join('\n  ')}`
      : 'IDE templates já estão em sincronia com templates/ide-assets/.'
  );
}
