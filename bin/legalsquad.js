#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { init } from '../src/init.js';
import { installGlobal } from '../src/install-global.js';
import { update } from '../src/update.js';
import { skillsCli } from '../src/skills-cli.js';
import { agentsCli } from '../src/agents-cli.js';
import { listRuns, printRuns } from '../src/runs.js';
import {
  auditSkillsProject,
  checkSkillsProject,
  contractSkillsProject,
  indexSkillsProject,
} from '../src/skill-catalog-cli.js';
import { skillRuntimeCli } from '../src/skill-runtime-cli.js';
import { skillSearchCli } from '../src/skill-search.js';
import { skillDetailCli } from '../src/skill-detail.js';
import { acervoSearchCli } from '../src/acervo-search.js';
import { acervoCli } from '../src/acervo-cli.js';
import { ativarCli } from '../src/acervo-ativar.js';
import { capturaCli } from '../src/captura-cli.js';
import { checkSquad } from '../src/squad-check.js';
import { chefeCli } from '../src/chefe-briefing.js';
import { registrarExecucao, ritualCli } from '../src/chefe-ritual.js';
import { memoriaCli } from '../src/chefe-memoria.js';

const HELP = `
  legalsquad — Multi-agent orchestration for Claude Code

  Usage:
    npx legalsquad init                    Initialize LegalSquad (in this folder)
    npx legalsquad init --skip-deps        Initialize without installing dependencies
    npx legalsquad install-global          Install for ALL Claude conversations (~/.claude)
    npx legalsquad update                  Update LegalSquad core
    npx legalsquad install <name>          Install a skill
    npx legalsquad uninstall <name>        Remove a skill
    npx legalsquad update <name>           Update a specific skill
    npx legalsquad skills                  List installed skills
    npx legalsquad agents                  List installed agents
    npx legalsquad agents install <name>   Install a predefined agent
    npx legalsquad agents remove <name>    Remove an agent
    npx legalsquad agents update           Update all agents
    npx legalsquad indexar-skills          Regenerate skills/_index.yaml
    npx legalsquad contract-skills         Apply the v5 operational contract + reindex
    npx legalsquad check-skills            Validate skill catalogue and graph
    npx legalsquad audit-skills            Audit skill contracts and evidence maturity
    npx legalsquad audit-skills --skill <id>   Same audit, ONLY for the given skill(s) (repeatable) —
                                           what the Architect runs for a skill a squad just created
    npx legalsquad search-skills <query>   Return a compact, ranked skill + best-practice shortlist
    npx legalsquad detail-skill <id>       Inspect ONE skill's structure, triggers and legal substance
                                           (--secao "<título>" reads one section; shows local usage stats)
    npx legalsquad search-skills ... --delivery-type <t> --risk <r>   Filter the shortlist by metadata
    npx legalsquad search-acervo <query>   Return a compact, ranked acervo shortlist
    npx legalsquad captura <file|URL>      Watch video + transcribe audio (local by default)
    npx legalsquad captura setup           Install on-use deps (ffmpeg/yt-dlp/faster-whisper)
    npx legalsquad resolve-skills <id...>  Enforce runtime lifecycle/evidence gates
    npx legalsquad check-squad <code>      Validate a squad's structure, rubric and eval harness
    npx legalsquad ativar <licenca>        Activate your license and sync the licensed areas
    npx legalsquad acervo status           Show synced packs and cache freshness
    npx legalsquad acervo sync             Download/update the licensed areas from the server
    npx legalsquad runs [squad-name]       View execution history
    npx legalsquad chefe [--briefing]      Morning briefing from the squad chief: today's
                                           deadlines + recent intimações + portfolio summary
    npx legalsquad chefe --json            Same aggregate as raw JSON (for automation)
    npx legalsquad chefe --agendar         Show what it takes to schedule the ritual: the exact
                                           command, the honest trade-off of each option, and a
                                           ready-to-paste snippet. Writes NOTHING.
                                           (--hora HH:MM changes the time; default 08:00)
    npx legalsquad chefe --agendar --aplicar
                                           Your explicit yes: writes the macOS LaunchAgent and
                                           stops there. Running \`launchctl load\` stays yours.
                                           Idempotent: running it twice never duplicates.
    npx legalsquad chefe --status          Is a ritual scheduled, and when did it last run?
    npx legalsquad memoria                 What the chief remembers about THIS office
                                           (--tipo perfil|preferencia|decisao|licao, --json)
    npx legalsquad memoria add --tipo <t> --titulo "…" --corpo "…"
                                           Record one fact. Client-identifying data is
                                           REFUSED (LGPD) — record the fact, not the datum.

  Learn more: https://github.com/bbpropulse/legalsquad-nucleo
  `;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    'skip-deps': { type: 'boolean' },
    force: { type: 'boolean' },
    yes: { type: 'boolean' },
    lang: { type: 'string' },
    ide: { type: 'string' },
    supervised: { type: 'boolean' },
    selection: { type: 'boolean' },
    'explicit-selection': { type: 'boolean' },
    query: { type: 'string' },
    limit: { type: 'string' },
    'include-preview': { type: 'boolean' },
    secao: { type: 'string' },
    'delivery-type': { type: 'string' },
    risk: { type: 'string' },
    'quality-profile': { type: 'string' },
    'include-quarantined': { type: 'boolean' },
    json: { type: 'boolean' },
    briefing: { type: 'boolean' },
    // Rituais agendados do chefe (MIKE-CHEFE §6). `agendar` PROPÕE e `aplicar`
    // é o "sim" que autoriza a única escrita — agendar rotina é decisão M3.
    agendar: { type: 'boolean' },
    aplicar: { type: 'boolean' },
    status: { type: 'boolean' },
    hora: { type: 'string' },
    tipo: { type: 'string' },
    titulo: { type: 'string' },
    corpo: { type: 'string' },
    origem: { type: 'string' },
    'pilot-opt-in': { type: 'string', multiple: true },
    'pilot-fallback': { type: 'string', multiple: true },
    'squads-dir': { type: 'string' },
    // audit-skills --skill <id> (repetível): audita só essas skills.
    skill: { type: 'string', multiple: true },
  },
});

const command = positionals[0];
const cwd = process.cwd();

// Command table: each entry returns a result; `checkSuccess` entries set a
// non-zero exit code when the handler reports { success: false }.
const commands = {
  init: {
    run: () => init(cwd, {
      skipDeps: values['skip-deps'] === true,
      // Non-interactive (`--yes`) lets the /legalsquad skill auto-initialize the
      // current project folder without prompting — keeping every project's data local.
      ...(values.yes
        ? {
          _skipPrompts: true,
          _language: values.lang || 'Português (Brasil)',
          _ides: values.ide
            ? String(values.ide).split(',').map((s) => s.trim()).filter(Boolean)
            : ['claude-code'],
        }
        : {}),
    }),
  },
  'install-global': { run: () => installGlobal() },
  install: { run: () => skillsCli('install', positionals.slice(1), cwd), checkSuccess: true },
  uninstall: { run: () => skillsCli('remove', positionals.slice(1), cwd), checkSuccess: true },
  update: {
    run: () => {
      const target = positionals[1];
      // `update <name>` updates a single skill; bare `update` updates the core.
      return target ? skillsCli('update-one', [target], cwd) : update(cwd);
    },
    checkSuccess: true,
  },
  skills: { run: () => skillsCli(positionals[1], positionals.slice(2), cwd), checkSuccess: true },
  agents: { run: () => agentsCli(positionals[1], positionals.slice(2), cwd), checkSuccess: true },
  'indexar-skills': { run: () => indexSkillsProject(cwd), checkSuccess: true },
  'contract-skills': {
    run: () => contractSkillsProject(cwd, { force: values.force === true }),
    checkSuccess: true,
  },
  'check-skills': { run: () => checkSkillsProject(cwd), checkSuccess: true },
  // Gate mecânico de squad: o que o build.prompt.md descreve como
  // "Filesystem Validation" verificado por código, com exit code utilizável.
  'check-squad': {
    run: () => {
      const alvo = positionals[1];
      if (!alvo) {
        console.error('Uso: npx legalsquad check-squad <code> [--squads-dir <dir>]');
        return { success: false };
      }
      const squadsDir = values['squads-dir'] || join(cwd, 'squads');
      const r = checkSquad(alvo, { squadsDir });

      const erros = r.issues.filter((i) => i.severity === 'error');
      const avisos = r.issues.filter((i) => i.severity === 'warn');

      console.log(`Squad: ${r.squad}`);
      for (const i of erros) console.log(`  ✖ [${i.code}] ${i.detail}`);
      for (const i of avisos) console.log(`  ⚠ [${i.code}] ${i.detail}`);
      console.log(
        r.ok
          ? `  ✓ estrutura íntegra${avisos.length ? ` (${avisos.length} aviso(s))` : ''}`
          : `  ${erros.length} erro(s) — corrija antes de rodar o squad`
      );

      return { success: r.ok };
    },
    checkSuccess: true,
  },
  'audit-skills': { run: () => auditSkillsProject(cwd, { skills: values.skill || [] }), checkSuccess: true },
  'search-skills': {
    run: () => skillSearchCli(values.query || positionals.slice(1).join(' '), cwd, values),
    checkSuccess: true,
  },
  'detail-skill': {
    run: () => skillDetailCli(positionals[1] || '', cwd, values),
    checkSuccess: true,
  },
  'search-acervo': {
    run: () => acervoSearchCli(values.query || positionals.slice(1).join(' '), cwd, values),
    checkSuccess: true,
  },
  // Forward the raw argv tail (not parseArgs output) so engine flags like
  // --sigiloso / --start / --transcribe survive intact.
  captura: {
    run: () => capturaCli(process.argv.slice(3)),
    checkSuccess: true,
  },
  'resolve-skills': {
    run: () => skillRuntimeCli(positionals.slice(1), cwd, values),
    checkSuccess: true,
  },
  acervo: {
    run: () => acervoCli(positionals[1] || 'status', cwd, values),
    checkSuccess: true,
  },
  ativar: {
    run: () => ativarCli(positionals[1] || '', cwd, values),
    checkSuccess: true,
  },
  runs: {
    run: async () => {
      const runs = await listRuns(positionals[1] || null, cwd);
      printRuns(runs);
    },
  },
  // Ritual matinal do chefe (persona default do runner: Mike, 🎩): encadeia os
  // scripts orchestra DO PROJETO e reapresenta o agregado na voz do chefe.
  // `--briefing` é o único modo hoje, logo é o default quando nada é passado;
  // `--json` emite o agregado cru para a rotina agendada do usuário consumir
  // (o agendamento em si é decisão do usuário, nunca registrado por nós).
  chefe: {
    // `--briefing` segue aceito no parse e no usage (compat de CLI), mas não é
    // encaminhado: é o único modo e o chefeCli não o lê — hoje é redundante.
    run: async () => {
      // Rituais agendados (MIKE-CHEFE §6). `--agendar` e `--status` saem antes
      // do briefing: são o metanível (quando o ritual roda), não o ritual.
      if (values.agendar === true || values.aplicar === true || values.status === true) {
        return ritualCli(cwd, {
          agendar: values.agendar === true,
          aplicar: values.aplicar === true,
          status: values.status === true,
          hora: values.hora || undefined,
        });
      }
      const resultado = await chefeCli(cwd, { json: values.json === true });
      // O marcador é gravado AQUI, e não dentro do chefeCli, para o
      // `chefe-briefing.js` seguir puro em relação ao ritual: ele produz o
      // briefing, e quem contabiliza a execução é o comando. Só timestamp e
      // status entram (nunca conteúdo — ver `registrarExecucao`), e a falha ao
      // gravar nunca derruba um briefing que deu certo.
      registrarExecucao(cwd, {
        sucesso: resultado?.success === true,
        modo: values.json === true ? 'json' : 'briefing',
      });
      return resultado;
    },
    checkSuccess: true,
  },
  // Memória do chefe (MIKE-CHEFE §6). Porta ESTRUTURADA para o que o chefe
  // aprendeu sobre o escritório — sem ela, ele grava Markdown à mão e o índice
  // apodrece. `add` passa por `escrever()`, que RECUSA dado identificável de
  // cliente (LGPD); a mesma régua do hook `.claude/hooks/guarda-memoria.mjs`,
  // agora também no caminho de código.
  memoria: {
    run: () => memoriaCli(cwd, positionals[1], {
      tipo: values.tipo,
      titulo: values.titulo,
      corpo: values.corpo,
      origem: values.origem,
      json: values.json === true,
    }),
    checkSuccess: true,
  },
};

const entry = commands[command];

if (entry) {
  const result = await entry.run();
  if (entry.checkSuccess && result && !result.success) process.exitCode = 1;
} else {
  console.log(HELP);
  if (command) process.exitCode = 1;
}
