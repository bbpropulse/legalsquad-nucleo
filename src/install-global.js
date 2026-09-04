import { cp, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');

// The npm tarball ships only templates/ (not the repo's own .claude/), so the
// global skill + agents are sourced from the claude-code IDE template.
const CC_TEMPLATE = join(PACKAGE_ROOT, 'templates', 'ide-templates', 'claude-code', '.claude');

const CLAUDE_MD_BEGIN = '<!-- BEGIN LegalSquad (install-global) -->';
const CLAUDE_MD_END = '<!-- END LegalSquad (install-global) -->';
// Matches a whole LegalSquad block (BEGIN…END). CRLF-tolerant (no ^/$ line
// anchors — those break on Windows line endings). Global so ALL blocks collapse.
const BLOCK_RE =
  /<!-- BEGIN LegalSquad \(install-global\) -->[\s\S]*?<!-- END LegalSquad \(install-global\) -->/g;

// Writes {path}.bak ONLY if it doesn't exist yet, so re-running install-global never
// overwrites the backup of the user's ORIGINAL content with an already-modified copy.
async function backupOnce(path, content) {
  try {
    await stat(path + '.bak');
    return false; // a backup already exists — preserve the original
  } catch {
    await writeFile(path + '.bak', content, 'utf-8');
    return true;
  }
}

// Concise activation so the chefe-roteador engages in EVERY conversation, not
// only inside a project — but ONLY for legal/office requests, never hijacking
// unrelated work. The full procedure lives in the /legalsquad skill.
function claudeMdBlock() {
  return `${CLAUDE_MD_BEGIN}
## LegalSquad — trabalho jurídico e gestão de escritório (disponível quando você precisar)

O LegalSquad está instalado globalmente. **Vale apenas para pedidos jurídicos ou de gestão de escritório.** Se o pedido NÃO for desse tipo, **ignore este bloco e responda normalmente** — não anuncie planos nem cite gates jurídicos. Se a pasta atual já tiver um \`CLAUDE.md\` de projeto LegalSquad, **siga aquele**; este bloco vale para conversas fora de uma casa LegalSquad.

Para um pedido jurídico/de escritório em linguagem natural, aja como o **chefe-roteador**:

1. **Raiz do workspace:** a raiz é **sempre a pasta atual** — cada projeto é autocontido; todos os arquivos (squads, acervo, \`output/\`) ficam nela, **nunca numa casa global**. Se a pasta atual não tiver \`_legalsquad/\`, **inicialize-a aqui automaticamente, sem perguntar**: rode \`legalsquad init --yes --lang "<idioma do usuário>"\` na pasta atual, avise em uma linha, e siga usando a pasta atual como raiz. Se o comando não existir, o motor não está instalado: \`npm install -g github:bbpropulse/legalsquad-nucleo\` (o LegalSquad **não** está no npm — \`npx legalsquad\` falha com 404 no registro).
2. **Decida quem atende** — REUSAR › ADAPTAR › CRIAR: squad em \`{root}/squads/\` · agente em \`~/.claude/agents/\` · tarefa pontual ad-hoc · se recorrente e nada cobrir, **proponha criar** um squad (só com o "sim").
3. **Tarefa aberta / multi-etapa → loop visível:** anuncie "Vou tratar em N etapas: 1)… 2)…" e, a cada ciclo, escreva «Ciclo k/N — <etapa>», delegue ao especialista e, após o report, escreva «Resultado: <1 linha> · Próximo: <1 linha>». Teto de 3–5 ciclos; pare em "concluído" ou escale ao usuário. Um único passo: resolva direto, sem loop.
4. **Gates inegociáveis:** revisão humana; **verificação de citações** — nenhuma súmula/precedente citado de memória, grave peças em \`{root}/squads/<nome>/output/\` e confira as citações antes de entregar (há sanção real por jurisprudência inventada por IA); checkpoint antes de criar squad ou enviar e-mail/protocolo.

Na primeira vez em cada pasta de projeto, o \`/legalsquad\` faz o onboarding do perfil (tipo de instituição + polo). Use \`/legalsquad\` para o menu completo.
${CLAUDE_MD_END}`;
}

// Copies the global /legalsquad skill into ~/.claude/skills/. Cleans the dest
// first so a future multi-file skill never leaves stale files behind (the skill
// is the product, not user content — safe to replace wholesale).
async function installGlobalSkill(claudeDir) {
  const src = join(CC_TEMPLATE, 'skills', 'legalsquad');
  const dest = join(claudeDir, 'skills', 'legalsquad');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

// Copies the specialist agents into ~/.claude/agents/, NEVER overwriting an
// existing file (could be a user's own agent). Skips the README index. Returns
// { installed, skipped } counts so the caller can report honestly.
async function installGlobalAgents(claudeDir) {
  const src = join(CC_TEMPLATE, 'agents');
  const dest = join(claudeDir, 'agents');
  await mkdir(dest, { recursive: true });

  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch {
    return { installed: 0, skipped: 0 };
  }

  let installed = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'README.md') continue; // index, not an agent
    const destPath = join(dest, entry.name);
    try {
      await stat(destPath);
      skipped++; // already exists — do not clobber user content
      continue;
    } catch {
      // does not exist — copy it
    }
    await cp(join(src, entry.name), destPath);
    installed++;
  }
  return { installed, skipped };
}

// Installs the Citation Gate hook as the machine-wide BACKSTOP — the last line,
// not the gate.
//
// The gate itself now travels with the work: the /legalsquad skill declares the
// citação + redação hooks in its own frontmatter (scope: "the rest of the
// session once the skill is invoked") and the squad agents declare them in
// theirs (scope: "while that subagent is running"), so a legal session carries
// its own deterministic floor without the machine carrying anything. See the
// comment block in templates/.../skills/legalsquad/SKILL.md.
//
// What stays here covers exactly one hole: the session where nobody invoked the
// skill. It is deliberately ADVISORY and deliberately narrower than the skill's:
//   * only verifica-citacoes (never verifica-redacao) — a redação gate firing in
//     a folder that is not legal work is the over-reach this layering exists to
//     undo;
//   * PostToolUse, which by the platform contract "can block? No — shows stderr
//     to Claude; the tool already ran". It reports; it does not prevent.
//
// Mechanics: copies the hook to ~/.claude/hooks/ and idempotently registers a
// PostToolUse (Write|Edit) entry in ~/.claude/settings.json pointing to an
// ABSOLUTE path ($CLAUDE_PROJECT_DIR is empty outside a project). Backs up
// settings.json first and never clobbers an unparseable file. An entry written
// by an OLDER install (same command, no statusMessage) satisfies the idempotence
// check and is left exactly as it is — we never rewrite a user's settings entry.
async function installGlobalHook(claudeDir) {
  const src = join(CC_TEMPLATE, 'hooks', 'verifica-citacoes.mjs');
  const hookDest = join(claudeDir, 'hooks', 'verifica-citacoes.mjs');
  await mkdir(dirname(hookDest), { recursive: true });
  try {
    await cp(src, hookDest);
  } catch {
    return 'missing'; // hook source absent — nothing to register
  }

  const command = `node "${hookDest.replace(/\\/g, '/')}"`;
  const settingsPath = join(claudeDir, 'settings.json');

  let settings = {};
  let existed = false;
  let raw = null;
  try {
    raw = await readFile(settingsPath, 'utf-8');
    existed = true;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
      else return 'manual'; // not an object — don't risk clobbering
    } catch {
      return 'manual'; // invalid JSON — leave the user's file untouched
    }
  } catch {
    // settings.json doesn't exist yet — we'll create a minimal one
  }

  // Back up the user's ORIGINAL bytes (not a reserialized copy) so the .bak is a
  // faithful restore point — matches ensureGlobalClaudeMd's backupOnce(path, existing).
  if (existed) {
    await backupOnce(settingsPath, raw);
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

  // Idempotent: skip if any existing entry already runs our hook.
  const already = settings.hooks.PostToolUse.some(
    (e) =>
      Array.isArray(e?.hooks) &&
      e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('verifica-citacoes'))
  );
  if (!already) {
    settings.hooks.PostToolUse.push({
      matcher: 'Write|Edit',
      hooks: [
        {
          type: 'command',
          command,
          // Names the layer where the user actually sees it run. The spinner is
          // the only place the demotion is visible at runtime; without it a
          // backstop looks exactly like a gate.
          statusMessage: 'LegalSquad · backstop de citações (advisory)',
        },
      ],
    });
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return already ? 'already' : 'registered';
}

// Idempotently inserts/refreshes the LegalSquad block in ~/.claude/CLAUDE.md,
// preserving everything else. Strategy that is safe even on a corrupted file:
//   1. back up the existing file to CLAUDE.md.bak before touching it;
//   2. remove ALL well-formed LegalSquad blocks (collapses duplicates);
//   3. append exactly one fresh block.
// Returns { action: 'created'|'updated'|'appended', backedUp: boolean }.
async function ensureGlobalClaudeMd(claudeDir) {
  const path = join(claudeDir, 'CLAUDE.md');
  let block = claudeMdBlock();

  let existing = null;
  try {
    existing = await readFile(path, 'utf-8');
  } catch {
    // no global CLAUDE.md yet
  }

  if (existing === null) {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path, block + '\n', 'utf-8');
    return { action: 'created', backedUp: false };
  }

  const hadBlock = existing.includes(CLAUDE_MD_BEGIN);
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';

  // Match the file's line endings so we never introduce mixed LF/CRLF (Windows).
  if (eol === '\r\n') block = block.replace(/\n/g, '\r\n');

  // Back up the user's ORIGINAL once — recoverable no matter what (covers the
  // edge case of our markers appearing inside user text). Never overwrite an
  // existing .bak on re-runs (it would replace the original with a modified copy).
  await backupOnce(path, existing);

  // Remove every existing block (collapses duplicates), tidy blank runs, then
  // append exactly one fresh block.
  const base = existing
    .replace(BLOCK_RE, '')
    .replace(/(\r?\n){3,}/g, eol + eol)
    .replace(/\s+$/, '');
  const next = base + eol + eol + block + eol;
  await writeFile(path, next, 'utf-8');

  return { action: hadBlock ? 'updated' : 'appended', backedUp: true };
}

// Installs LegalSquad globally so /legalsquad and the chefe-roteador work
// in every Claude conversation — installs the COMMAND surface only; project data
// stays per-folder. Options: { homeDir } — exists mainly for tests.
export async function installGlobal(options = {}) {
  const home = options.homeDir || homedir();
  const claudeDir = join(home, '.claude');

  console.log('\n  🟢 LegalSquad — Instalação global (só o comando; os dados ficam por projeto)\n');

  // Global install ships ONLY the command surface (skill + agents + hook + CLAUDE.md).
  // It NEVER creates a global data home — each project is self-contained, and the
  // /legalsquad skill auto-initializes the current folder on first use.

  // 1) Global skill + 2) global agents → ~/.claude/
  await installGlobalSkill(claudeDir);
  console.log('  ✓ Skill /legalsquad instalada em ~/.claude/skills/');

  const { installed, skipped } = await installGlobalAgents(claudeDir);
  console.log(
    `  ✓ Agentes especialistas: ${installed} instalado(s)` +
      (skipped ? `, ${skipped} preservado(s) (já existiam)` : '') +
      ' em ~/.claude/agents/'
  );

  // 4) Citation Gate hook — BACKSTOP advisory de máquina. O gate de verdade vai
  //    no frontmatter da skill e dos agentes (instalados acima), com escopo de
  //    sessão jurídica; este aqui só cobre a sessão em que ninguém invocou nada.
  const hook = await installGlobalHook(claudeDir);
  if (hook === 'registered' || hook === 'already') {
    console.log('  ✓ Backstop de citações (hook advisory) em ~/.claude/hooks/ + settings.json');
  } else if (hook === 'manual') {
    console.log('  ⚠️  ~/.claude/settings.json não pôde ser lido — hook copiado, mas registre o PostToolUse à mão (veja INSTALL.md)');
  }

  // 5) Activate the chefe-roteador in every conversation via global CLAUDE.md.
  const { action, backedUp } = await ensureGlobalClaudeMd(claudeDir);
  const label =
    action === 'created'
      ? 'criado'
      : action === 'updated'
        ? 'bloco atualizado'
        : 'bloco adicionado ao seu CLAUDE.md (conteúdo preservado)';
  console.log(
    `  ✓ Chefe-roteador ativado em todas as conversas (~/.claude/CLAUDE.md — ${label})` +
      (backedUp ? ' · backup: ~/.claude/CLAUDE.md.bak' : '')
  );

  console.log('\n  ✅ Pronto! O LegalSquad agora funciona em qualquer conversa do Claude.');
  console.log('     • Digite /legalsquad para o menu completo.');
  console.log('     • Ou só descreva o que precisa — o chefe-roteador assume.');
  console.log('     • Cada pasta vira um projeto próprio: os dados (squads, acervo, output) ficam nela.');
  console.log('     • Rode /legalsquad numa pasta e ela se inicializa sozinha (onboarding na 1ª vez).\n');
  console.log('  ℹ️  Onde cada gate mora, sem promessa a mais:');
  console.log('     • /legalsquad (skill) carrega citação + redação pelo frontmatter — da');
  console.log('       invocação em diante, na sessão inteira. É a camada que vale.');
  console.log('     • Os agentes do squad carregam os dois no frontmatter deles — valem');
  console.log('       enquanto rodam, inclusive em fork/worktree.');
  if (hook === 'registered' || hook === 'already') {
    console.log('     • ~/.claude/settings.json é só o BACKSTOP: última linha, advisory, só');
    console.log('       citações, para a sessão em que ninguém invocou a skill. É PostToolUse —');
    console.log('       reporta a peça já gravada em squads/*/output/, não impede a escrita.');
  } else {
    console.log('     • O backstop de máquina NÃO foi registrado — fora de uma sessão com a');
    console.log('       skill ou os agentes, não há gate nenhum.');
  }
  console.log('     A conferência final de toda súmula/precedente é sempre humana.');
  console.log('  ℹ️  Para o Sherlock (navegador), dentro de um projeto rode:');
  console.log('     npm install && npx playwright install chromium\n');

  return {
    claudeDir,
    agentsInstalled: installed,
    agentsSkipped: skipped,
    citationHook: hook,
    claudeMd: action,
    claudeMdBackedUp: backedUp,
  };
}
