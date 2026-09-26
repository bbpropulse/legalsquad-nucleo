import { cp, mkdir, readdir, readFile, writeFile, rm, stat, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { binDoMotor, caminhoLegivel, registrarMotorNaMaquina as registrarNoRegistro } from './motor-link.js';
import { BLOCK_RE, CLAUDE_MD_BEGIN, blocoNpm } from './bloco-roteador.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');

// The npm tarball ships only templates/ (not the repo's own .claude/), so the
// global skill + agents are sourced from the claude-code IDE template.
const CC_TEMPLATE = join(PACKAGE_ROOT, 'templates', 'ide-templates', 'claude-code', '.claude');

// Entrada do motor instalado (o que o `bin` do package.json aponta). Vai escrito
// no bloco global porque o comando `legalsquad` depende de o prefixo global do
// npm estar no PATH do shell que o Claude do aluno abre, e isso falha em campo
// (nvm inicializado só no .zshrc, prefixo trocado para ~/.npm-global, app de
// desktop aberto pelo Dock): o Claude concluía "não está instalado" e
// reinstalava do GitHub a cada chamada, sem nunca chegar ao init. Com o caminho
// no bloco, `node "<caminho>"` substitui `legalsquad` em qualquer shell. O
// caminho e a forma (barras normais) vêm de motor-link.js, a mesma fonte do
// atalho por projeto.
const BIN_PATH = binDoMotor(PACKAGE_ROOT);
const caminhoParaOBloco = caminhoLegivel;

// O bloco e os marcadores moram em bloco-roteador.js: o plugin do Claude Code
// injeta a variante dele pelo SessionStart (src/plugin-sessao.js) e precisa
// reconhecer este bloco para não repetir a instrução.

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

function claudeMdBlock({ binPath = BIN_PATH } = {}) {
  return blocoNpm({ motor: caminhoParaOBloco(binPath) });
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

// Copies the specialist agents into ~/.claude/agents/. A file that is NOT ours
// (a user's own agent under the same name) is never touched. A file that IS
// ours — it carries the LegalSquad signature — is refreshed when it differs:
// otherwise the hook gets updated by `installGlobalHook` below while the agent
// that writes the manifest the hook checks stays on the old contract (measured
// 11/09/2026: global `verificador-citacoes.md` from 21/08 next to a hook that
// requires one manifest entry per citation). Skips the README index. Returns
// { installed, updated, skipped } counts so the caller can report honestly.
// "Ours" = carries a squad signature, OR is an older copy of the same agent: same
// `name:` in the frontmatter and the same opening of the `description:` (the
// copies installed before the signature existed have neither the word LegalSquad
// nor the new contract, and are exactly the ones that need refreshing).
function frontmatterField(text, field) {
  const m = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(text.slice(0, 4096));
  return m ? m[1].trim() : '';
}
function ehNosso(atual, novo) {
  if (/legalsquad|criminalsquad|medsquad/i.test(atual)) return true;
  const nome = frontmatterField(atual, 'name');
  const descricao = frontmatterField(atual, 'description').slice(0, 40);
  return !!nome && nome === frontmatterField(novo, 'name') && !!descricao && frontmatterField(novo, 'description').startsWith(descricao);
}

async function installGlobalAgents(claudeDir) {
  const src = join(CC_TEMPLATE, 'agents');
  const dest = join(claudeDir, 'agents');
  await mkdir(dest, { recursive: true });

  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch {
    return { installed: 0, updated: 0, skipped: 0 };
  }

  let installed = 0;
  let updated = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'README.md') continue; // index, not an agent
    const destPath = join(dest, entry.name);
    const novo = await readFile(join(src, entry.name), 'utf-8');
    let atual = null;
    try {
      atual = await readFile(destPath, 'utf-8');
    } catch {
      // does not exist — copy it
    }
    if (atual === null) {
      await cp(join(src, entry.name), destPath);
      installed++;
    } else if (atual === novo) {
      skipped++; // already current
    } else if (ehNosso(atual, novo)) {
      await writeFile(destPath, novo, 'utf-8');
      updated++; // ours, and stale — refresh
    } else {
      skipped++; // a user's own agent — do not clobber
    }
  }
  return { installed, updated, skipped };
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

  const legado = await removerGateDeRedacaoLegado(settings, claudeDir);

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return already ? (legado ? 'already+legado' : 'already') : (legado ? 'registered+legado' : 'registered');
}

// O disparador de máquina dos hooks DO PROJETO (medição dos moldes de 24/09/2026,
// defeito 34): com a sessão aberta fora da raiz, `$CLAUDE_PROJECT_DIR` aponta outra
// pasta, o settings.json do projeto nem carrega e o frontmatter da skill e dos
// agentes chama um arquivo que não existe; o gate de redação e a guarda de memória
// não rodaram no run de alimentos. O disparador sobe a partir do arquivo tocado até
// `_legalsquad/` e roda os hooks da própria raiz (nunca uma cópia de máquina do de
// redação): o escopo é o do projeto achado, não a máquina inteira. Registro
// idempotente, uma entrada por evento, com caminho absoluto; o alheio fica.
async function installDisparador(claudeDir) {
  const nome = 'legalsquad-disparador.mjs';
  const destino = join(claudeDir, 'hooks', nome);
  await mkdir(dirname(destino), { recursive: true });
  try {
    await cp(join(CC_TEMPLATE, 'hooks', nome), destino);
  } catch {
    return 'missing';
  }
  const settingsPath = join(claudeDir, 'settings.json');
  let settings = {};
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'manual';
      settings = parsed;
    } catch {
      return 'manual';
    }
    await backupOnce(settingsPath, raw);
  } catch {
    // sem settings.json: nasce com as nossas entradas
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let novo = false;
  for (const [evento, modo] of [['PreToolUse', 'pre'], ['PostToolUse', 'post']]) {
    if (!Array.isArray(settings.hooks[evento])) settings.hooks[evento] = [];
    const ja = settings.hooks[evento].some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(nome)));
    if (ja) continue;
    novo = true;
    settings.hooks[evento].push({
      matcher: 'Write|Edit',
      hooks: [{
        type: 'command',
        command: `node "${destino.replace(/\\/g, '/')}" ${modo}`,
        statusMessage: modo === 'pre' ? 'LegalSquad · guarda de memória do projeto do arquivo' : 'LegalSquad · gates do projeto do arquivo',
      }],
    });
  }
  if (novo) await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return novo ? 'registered' : 'already';
}

// O mesmo disparador para o Codex (fallback). O `.codex/hooks.json` do projeto chama
// `node ".codex/hooks/…"` relativo à pasta da sessão, e o `apply_patch` do Codex não
// traz `file_path`: dentro ou fora da raiz, os hooks do projeto saíam 0 sem olhar
// nada, e a guarda de memória nem é registrada ali. O Codex lê hooks de máquina em
// ~/.codex/hooks.json (mesmo formato de eventos do Claude Code); o disparador lê o
// texto do patch e acha a raiz por arquivo. Só com ~/.codex/ existente: quem não usa
// Codex não ganha pasta nova. O Codex só executa hook de usuário depois de aprovado
// em `/hooks`, e isso não se faz por arquivo: o texto do install diz.
async function installDisparadorCodex(home) {
  const codexDir = join(home, '.codex');
  try {
    if (!(await stat(codexDir)).isDirectory()) return 'sem-codex';
  } catch {
    return 'sem-codex';
  }
  const nome = 'legalsquad-disparador.mjs';
  const destino = join(codexDir, 'hooks', nome);
  await mkdir(dirname(destino), { recursive: true });
  try {
    await cp(join(CC_TEMPLATE, 'hooks', nome), destino);
  } catch {
    return 'missing';
  }
  const hooksPath = join(codexDir, 'hooks.json');
  let config = {};
  try {
    const raw = await readFile(hooksPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'manual';
      config = parsed;
    } catch {
      return 'manual';
    }
    await backupOnce(hooksPath, raw);
  } catch {
    // sem hooks.json: nasce com as nossas entradas
  }
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  let novo = false;
  for (const [evento, modo] of [['PreToolUse', 'pre'], ['PostToolUse', 'post']]) {
    if (!Array.isArray(config.hooks[evento])) config.hooks[evento] = [];
    const ja = config.hooks[evento].some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(nome)));
    if (ja) continue;
    novo = true;
    config.hooks[evento].push({
      matcher: 'apply_patch|Write|Edit',
      hooks: [{ type: 'command', command: `node "${destino.replace(/\\/g, '/')}" ${modo}` }],
    });
  }
  if (novo) await writeFile(hooksPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return novo ? 'registered' : 'already';
}

// O CriminalSquad (produto encerrado, integrado ao LegalSquad em 15/09/2026)
// instalava um `verifica-redacao.mjs` GLOBAL como PreToolUse: um detector de
// andaime que bloqueia qualquer peça em squads/*/output/ com front-matter,
// "STATUS:" ou "Step NN". O LegalSquad nunca instala gate de redação global (ver
// o bloco acima), e o desenho de hoje exige o contrário: a MINUTA leva
// `citation_gate: rascunho`, status e matriz no frontmatter e no rodapé, e só a
// versão final sai limpa, conferida pelo hook do PROJETO (que sabe distinguir
// minuta de final). Medido no run de prova de 16/09/2026: o hook legado
// bloqueou a gravação da minuta que o step do squad manda escrever. Aqui ele é
// desregistrado, e o arquivo, renomeado (nunca apagado): só o entry PreToolUse
// que aponta para `<claudeDir>/hooks/verifica-redacao.mjs`; o do MedSquad
// (`medsquad-verifica-redacao.mjs`) e qualquer outro ficam como estão.
async function removerGateDeRedacaoLegado(settings, claudeDir) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : null;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return false;
  const ehLegado = (h) => typeof h?.command === 'string' && /[/\\]\.claude[/\\]hooks[/\\]verifica-redacao\.mjs["']?\s*$/.test(h.command.trim());
  let removido = false;
  hooks.PreToolUse = hooks.PreToolUse
    .map((entry) => {
      if (!Array.isArray(entry?.hooks) || !entry.hooks.some(ehLegado)) return entry;
      removido = true;
      const restantes = entry.hooks.filter((h) => !ehLegado(h));
      return restantes.length ? { ...entry, hooks: restantes } : null;
    })
    .filter(Boolean);
  if (!hooks.PreToolUse.length) delete hooks.PreToolUse;
  if (!removido) return false;
  const arquivo = join(claudeDir, 'hooks', 'verifica-redacao.mjs');
  try {
    await rename(arquivo, `${arquivo}.criminalsquad.bak`);
  } catch {
    // já renomeado ou ausente: o entry saiu do settings, e é o que importa
  }
  return true;
}

// O registro da máquina é dividido com o plugin do Claude Code, que também o
// grava (src/plugin-sessao.js). A regra é a mesma nos dois caminhos e mora em
// motor-link.js: vale o motor de versão mais nova; um registro que aponta para
// um motor que sumiu é refeito. Sem essa regra, o `install-global` de um motor
// do npm mais antigo tiraria do registro o motor mais novo do plugin.
async function registrarMotorNaMaquina(home, binPath) {
  const { version } = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
  // Rodar o install-global é escolha explícita de quem opera: no empate de versão, ele vence.
  const r = await registrarNoRegistro(home, { bin: binPath, version, registradoPor: 'install-global', empateVence: true });
  if (r.proprio) {
    console.log(`  ✓ Motor registrado na máquina: ${r.caminho} (${version})`);
  } else {
    console.log(`  ✓ Registro da máquina mantido: ${r.caminho} aponta para um motor mais novo (${r.version} em ${r.bin}); vale o de versão mais nova`);
  }
}

// Idempotently inserts/refreshes the LegalSquad block in ~/.claude/CLAUDE.md,
// preserving everything else. Strategy that is safe even on a corrupted file:
//   1. back up the existing file to CLAUDE.md.bak before touching it;
//   2. remove ALL well-formed LegalSquad blocks (collapses duplicates);
//   3. append exactly one fresh block.
// Returns { action: 'created'|'updated'|'appended', backedUp: boolean }.
async function ensureGlobalClaudeMd(claudeDir, { binPath } = {}) {
  const path = join(claudeDir, 'CLAUDE.md');
  let block = claudeMdBlock({ binPath });

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
// stays per-folder. Options: { homeDir, binPath } — exist mainly for tests
// (binPath: entry of the engine to write in the global block; default is this
// package's own bin/legalsquad.js).
export async function installGlobal(options = {}) {
  const home = options.homeDir || homedir();
  const binPath = options.binPath || BIN_PATH;
  const claudeDir = join(home, '.claude');

  console.log('\n  🟢 LegalSquad: instalação global (só o comando; os dados ficam por projeto)\n');

  // Global install ships ONLY the command surface (skill + agents + hook + CLAUDE.md).
  // It NEVER creates a global data home — each project is self-contained, and the
  // /legalsquad skill auto-initializes the current folder on first use.

  // 1) Global skill + 2) global agents → ~/.claude/
  await installGlobalSkill(claudeDir);
  console.log('  ✓ Skill /legalsquad instalada em ~/.claude/skills/');

  const { installed, updated, skipped } = await installGlobalAgents(claudeDir);
  console.log(
    `  ✓ Agentes especialistas: ${installed} instalado(s)` +
      (updated ? `, ${updated} atualizado(s)` : '') +
      (skipped ? `, ${skipped} preservado(s) (já existiam)` : '') +
      ' em ~/.claude/agents/'
  );
  // A sessão aberta segue com a definição do agente que carregou ao abrir (medido em 26/09/2026,
  // mandado de segurança: o avaliador da meta seguia o formato antigo com o arquivo já novo).
  if (installed || updated) console.log('  🔄 Feche e abra de novo a sessão do Claude Code: a sessão aberta guarda a definição antiga dos agentes até ser reaberta.');

  // 4) Citation Gate hook — BACKSTOP advisory de máquina. O gate de verdade vai
  //    no frontmatter da skill e dos agentes (instalados acima), com escopo de
  //    sessão jurídica; este aqui só cobre a sessão em que ninguém invocou nada.
  const hook = await installGlobalHook(claudeDir);
  if (hook.startsWith('registered') || hook.startsWith('already')) {
    console.log('  ✓ Backstop de citações (hook advisory) em ~/.claude/hooks/ + settings.json');
    if (hook.endsWith('+legado')) console.log('  ✓ Gate de redação global do CriminalSquad (PreToolUse) desregistrado: bloqueava a minuta que o squad manda escrever; o arquivo ficou como verifica-redacao.mjs.criminalsquad.bak');
  } else if (hook === 'manual') {
    console.log('  ⚠️  ~/.claude/settings.json não pôde ser lido; hook copiado, mas registre o PostToolUse à mão (veja INSTALL.md)');
  }

  // 4b) Disparador dos hooks do PROJETO para a sessão aberta fora da raiz.
  const disparador = await installDisparador(claudeDir);
  if (disparador === 'registered' || disparador === 'already') {
    console.log('  ✓ Disparador dos hooks do projeto em ~/.claude/hooks/ + settings.json: com a sessão fora da raiz, a raiz é achada pelo arquivo tocado');
  } else if (disparador === 'manual') {
    console.log('  ⚠️  ~/.claude/settings.json não pôde ser lido: registre à mão o legalsquad-disparador.mjs (pre e post) para os hooks do projeto rodarem fora da raiz');
  }
  const disparadorCodex = await installDisparadorCodex(home);
  if (disparadorCodex === 'registered' || disparadorCodex === 'already') {
    console.log('  ✓ Codex: disparador dos hooks do projeto em ~/.codex/hooks/ + hooks.json. O Codex só o executa depois de aprovado: abra o Codex e aprove em /hooks.');
  } else if (disparadorCodex === 'manual') {
    console.log('  ⚠️  ~/.codex/hooks.json não pôde ser lido: registre à mão o legalsquad-disparador.mjs (pre e post, matcher apply_patch) para os gates rodarem no Codex');
  }

  // 5) Activate the chefe-roteador in every conversation via global CLAUDE.md.
  const { action, backedUp } = await ensureGlobalClaudeMd(claudeDir, { binPath });
  console.log(`  ✓ Caminho do motor gravado no bloco global: node "${caminhoParaOBloco(binPath)}"`);

  // 6) Registro do motor na máquina: ~/.legalsquad/motor.json. É o que os
  //    atalhos `npx legalsquad` de TODOS os projetos leem antes dos prefixos
  //    conhecidos, então trocar de motor (outro Node, outro prefixo) e rodar
  //    `install-global` atualiza todos os projetos de uma vez, sem `update`
  //    em cada um. O motor.json por projeto continua valendo (e vence, se for
  //    mais novo): o registro da máquina é a rede abaixo dele.
  await registrarMotorNaMaquina(home, binPath);
  const label =
    action === 'created'
      ? 'criado'
      : action === 'updated'
        ? 'bloco atualizado'
        : 'bloco adicionado ao seu CLAUDE.md (conteúdo preservado)';
  console.log(
    `  ✓ Chefe-roteador ativado em todas as conversas (~/.claude/CLAUDE.md, ${label})` +
      (backedUp ? ' · backup: ~/.claude/CLAUDE.md.bak' : '')
  );

  console.log('\n  ✅ Pronto! O LegalSquad agora funciona em qualquer conversa do Claude.');
  console.log('     • Digite /legalsquad para o menu completo.');
  console.log('     • Ou só descreva o que precisa: o chefe-roteador assume.');
  console.log('     • Cada pasta vira um projeto próprio: os dados (squads, acervo, output) ficam nela.');
  console.log('     • Numa pasta nova, o assistente pergunta antes de prepará-la (onboarding do perfil na 1ª vez).\n');
  console.log('  ℹ️  Onde cada gate mora, sem promessa a mais:');
  console.log('     • /legalsquad (skill) carrega citação + redação pelo frontmatter, da');
  console.log('       invocação em diante, na sessão inteira. É a camada que vale.');
  console.log('     • Os agentes do squad carregam os dois no frontmatter deles, que valem');
  console.log('       enquanto rodam, inclusive em fork/worktree.');
  if (hook.startsWith('registered') || hook.startsWith('already')) {
    console.log('     • ~/.claude/settings.json é só o BACKSTOP: última linha, advisory, só');
    console.log('       citações, para a sessão em que ninguém invocou a skill. É PostToolUse:');
    console.log('       reporta a peça já gravada em squads/*/output/, não impede a escrita.');
  } else {
    console.log('     • O backstop de máquina NÃO foi registrado: fora de uma sessão com a');
    console.log('       skill ou os agentes, não há gate nenhum.');
  }
  if (disparador === 'registered' || disparador === 'already') {
    console.log('     • O disparador de máquina roda os hooks DO PROJETO do arquivo gravado');
    console.log('       (raiz achada subindo até _legalsquad/), para a sessão aberta em outra pasta.');
  }
  if (disparadorCodex === 'registered' || disparadorCodex === 'already') {
    console.log('     • No Codex, os gates do projeto só rodam por esse disparador (o apply_patch não');
    console.log('       informa o arquivo aos hooks do projeto), e só depois da aprovação em /hooks.');
  }
  console.log('     A conferência final de toda súmula/precedente é sempre humana.');
  console.log('  ℹ️  Para o Sherlock (navegador), dentro de um projeto rode:');
  console.log('     npm install && npx playwright install chromium\n');

  return {
    claudeDir,
    agentsInstalled: installed,
    agentsUpdated: updated,
    agentsSkipped: skipped,
    citationHook: hook,
    hooksDisparador: disparador,
    hooksDisparadorCodex: disparadorCodex,
    claudeMd: action,
    claudeMdBackedUp: backedUp,
  };
}
