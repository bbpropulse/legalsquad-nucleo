#!/usr/bin/env node
// Escritor DETERMINÍSTICO do state.json de um squad — substitui a escrita à mão
// do JSON pelo Pipeline Runner. Garante timestamps reais, transições atômicas
// (write tmp + rename) e saída sempre válida contra o contrato.
// Contrato: _legalsquad/core/state.schema.json | Tipos: dashboard/src/types/state.ts
//
//   node scripts/squad-state.mjs init       <squad-dir> --total <N>
//   node scripts/squad-state.mjs step       <squad-dir> --current <K> --label "<L>" --working <id> [--working <id> ...] [--from <prevId>] [--message "<m>"] [--activity "<a>"]
//   node scripts/squad-state.mjs checkpoint <squad-dir> --agent <id>
//   node scripts/squad-state.mjs complete   <squad-dir>
//   node scripts/squad-state.mjs fail       <squad-dir>
//
// Loop de revisão (cartório determinístico — grava review-state.json ao lado):
//   node scripts/squad-state.mjs review-open    <squad-dir> --loop <step-revisor> --target <step-on-reject> [--max <N>]
//   node scripts/squad-state.mjs review-verdict <squad-dir> --reviewer <id> --verdict APPROVE|REJECT [--fix "..."]... [--expect <N>]
//   node scripts/squad-state.mjs review-status  <squad-dir>
// Os três imprimem a DECISÃO em JSON no stdout. `review-verdict`/`review-status`
// saem com código 3 quando a decisão é `escalate` — escalação não pode passar
// despercebida por quem só olha o exit code.
//
// <squad-dir> é a pasta do squad (contém squad.yaml + squad-party.csv); o
// state.json é gravado lá. Rode a partir da raiz do workspace.
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';

const SQUAD_STATUSES = ['idle', 'running', 'completed', 'checkpoint', 'failed'];
const AGENT_STATUSES = ['idle', 'working', 'delivering', 'done', 'checkpoint'];
// Status que indicam que o agente já atuou — ao avançar, viram "done".
const ACTED = ['working', 'delivering', 'checkpoint', 'done'];

function die(msg) {
  console.error(`squad-state: ${msg}`);
  process.exit(1);
}

function now() {
  return new Date().toISOString();
}

// command, dir, depois --flags (algumas repetíveis, ex.: --working).
function parseArgs(argv) {
  const [command, dir, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const val = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    if (key in flags) flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : [flags[key]]), val];
    else flags[key] = val;
  }
  return { command, dir, flags };
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (typeof v === 'string' ? v : '');

// Parser mínimo de linha CSV (lida com "campos, entre aspas").
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readAgents(dir) {
  const csvPath = join(dir, 'squad-party.csv');
  if (!existsSync(csvPath)) die(`squad-party.csv não encontrado em ${dir}`);
  const lines = readFileSync(csvPath, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) die('squad-party.csv vazio');
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const iId = header.indexOf('id');
  const iName = header.indexOf('name');
  const iIcon = header.indexOf('icon');
  if (iId < 0 || iName < 0 || iIcon < 0) die('squad-party.csv precisa das colunas id,name,icon');
  return lines.slice(1).map((line, i) => {
    const cells = parseCsvLine(line);
    return {
      id: (cells[iId] || '').trim(),
      name: (cells[iName] || '').trim(),
      icon: (cells[iIcon] || '').trim(),
      status: 'idle',
      desk: { col: (i % 3) + 1, row: Math.floor(i / 3) + 1 },
    };
  });
}

function readSquadCode(dir) {
  const p = join(dir, 'squad.yaml');
  if (!existsSync(p)) die(`squad.yaml não encontrado em ${dir}`);
  const m = readFileSync(p, 'utf-8').match(/^code:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1].trim() : '';
}

function loadState(dir) {
  const p = join(dir, 'state.json');
  if (!existsSync(p)) die('state.json não existe — rode `init` primeiro');
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return die('state.json existente é JSON inválido');
  }
}

// Rede de segurança: espelha _legalsquad/core/state.schema.json e o isValidState
// do dashboard. Por construção a saída já é válida; isto pega regressões cedo.
function validate(s) {
  const errs = [];
  if (typeof s.squad !== 'string') errs.push('squad deve ser string');
  if (!SQUAD_STATUSES.includes(s.status)) errs.push(`status inválido: ${s.status}`);
  if (!s.step || typeof s.step.current !== 'number' || typeof s.step.total !== 'number' || typeof s.step.label !== 'string')
    errs.push('step inválido (current/total/label)');
  if (!Array.isArray(s.agents)) errs.push('agents deve ser array');
  else s.agents.forEach((a, i) => {
    if (typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.icon !== 'string') errs.push(`agente ${i}: id/name/icon`);
    if (!AGENT_STATUSES.includes(a.status)) errs.push(`agente ${i}: status inválido (${a.status})`);
    if (!a.desk || typeof a.desk.col !== 'number' || typeof a.desk.row !== 'number') errs.push(`agente ${i}: desk inválido`);
  });
  if (s.handoff !== null && (typeof s.handoff !== 'object' || typeof s.handoff.from !== 'string' || typeof s.handoff.to !== 'string'))
    errs.push('handoff inválido');
  if (errs.length) die('estado inválido:\n  - ' + errs.join('\n  - '));
}

// Escrita atômica (tmp + rename): uma sessão que morre no meio nunca deixa um
// JSON truncado para a próxima ler.
function writeJson(dir, file, data) {
  const tmp = join(dir, `${file}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, join(dir, file)); // atômico no mesmo filesystem
}

function writeState(dir, s) {
  validate(s);
  writeJson(dir, 'state.json', s);
}

// ---------------------------------------------------------------------------
// Loop de revisão — cópia VERBATIM de src/review-loop.js.
// Este script é distribuído ao usuário (templates/scripts/) e roda num projeto
// que NÃO tem src/ — por isso a lógica é embutida em vez de importada. A cópia
// é guardada por tests/review-loop.test.js: se divergir, a suíte quebra.
// ---------------------------------------------------------------------------
// >>> review-loop:begin
/** Ações possíveis de uma decisão do loop de revisão. */
const REVIEW_ACTIONS = Object.freeze({
  ADVANCE: 'advance', // veredito APPROVE → segue para o próximo step
  REVISE: 'revise', // REJECT convergindo → volta ao step do `on_reject`
  ESCALATE: 'escalate', // teto, não-convergência ou veredito ilegível → humano
  AWAIT: 'await', // faltam vereditos deste ciclo (revisores em paralelo)
});

/** Teto default de ciclos, quando o step/pipeline não declara `max_review_cycles`. */
const DEFAULT_MAX_REVIEW_CYCLES = 3;

/**
 * Chave de comparação de um `fix`: o mesmo problema descrito com outra pontuação,
 * caixa ou acento ainda é o MESMO problema. Sem isto, "Falta a citação." e
 * "falta a citacao" pareceriam correções diferentes e a não-convergência passaria
 * batida até o teto.
 */
function normalizeFix(fix) {
  if (typeof fix !== 'string') return '';
  return fix
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Funde os vereditos de UM ciclo (pode haver N revisores em `parallel_group`).
 *
 * Regra conservadora, porque o risco aqui é real (peça vai a protocolo):
 *   - qualquer REJECT derruba os APPROVEs — um revisor que aprova não anula
 *     o problema que o outro achou;
 *   - qualquer veredito ausente/ilegível vira UNREADABLE, mesmo que os demais
 *     aprovem: "não sei ler" não é "aprovado".
 * Os `fixes` dos que rejeitaram são unidos e deduplicados por `normalizeFix`.
 */
function combineVerdicts(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const reviewers = [];
  const unreadable = [];
  const rejecting = [];
  const fixes = [];
  const seen = new Set();

  for (const entry of list) {
    const who =
      entry && typeof entry.reviewer === 'string' && entry.reviewer.trim() ? entry.reviewer.trim() : '(revisor anônimo)';
    reviewers.push(who);
    const verdict = entry && typeof entry.verdict === 'string' ? entry.verdict.trim().toUpperCase() : '';
    if (verdict !== 'APPROVE' && verdict !== 'REJECT') {
      unreadable.push(who);
      continue;
    }
    if (verdict === 'APPROVE') continue;
    rejecting.push(who);
    const raw = entry && Array.isArray(entry.fixes) ? entry.fixes : [];
    for (const fix of raw) {
      if (typeof fix !== 'string') continue;
      const key = normalizeFix(fix);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fixes.push(fix.trim());
    }
  }

  if (!list.length) {
    return { verdict: 'UNREADABLE', fixes, reviewers, unreadable: ['(nenhum veredito recebido)'], rejecting };
  }
  if (unreadable.length) return { verdict: 'UNREADABLE', fixes, reviewers, unreadable, rejecting };
  return { verdict: rejecting.length ? 'REJECT' : 'APPROVE', fixes, reviewers, unreadable, rejecting };
}

/** Quais dos `fixes` deste ciclo já haviam aparecido em algum ciclo anterior. */
function repeatedFixes(fixes, history) {
  const previous = new Set();
  for (const cycle of Array.isArray(history) ? history : []) {
    for (const fix of cycle && Array.isArray(cycle.fixes) ? cycle.fixes : []) {
      const key = normalizeFix(fix);
      if (key) previous.add(key);
    }
  }
  return (Array.isArray(fixes) ? fixes : []).filter((fix) => previous.has(normalizeFix(fix)));
}

/**
 * A decisão do ciclo. Entrada: os vereditos deste ciclo, o histórico dos ciclos
 * já fechados e o teto. Saída: o que o runner deve fazer — sem margem para
 * interpretação.
 *
 * Ordem das saídas de escalação importa: não-convergência vem ANTES do teto,
 * porque gastar os ciclos restantes repetindo o mesmo problema é desperdício
 * (e o `runner.pipeline.md` sempre mandou escalar "imediatamente").
 */
function decideReview(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const maxCycles =
    Number.isInteger(raw.maxCycles) && raw.maxCycles > 0 ? raw.maxCycles : DEFAULT_MAX_REVIEW_CYCLES;
  const history = Array.isArray(raw.history) ? raw.history : [];
  const cycle = history.length + 1;
  const combined = combineVerdicts(raw.verdicts);
  const base = {
    cycle,
    maxCycles,
    verdict: combined.verdict,
    fixes: combined.fixes,
    reviewers: combined.reviewers,
  };

  if (combined.verdict === 'UNREADABLE') {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'veredito-ilegivel',
      detail: `veredito ausente ou ilegível de: ${combined.unreadable.join(', ')} — "não sei ler" não é "aprovado"`,
    };
  }
  if (combined.verdict === 'APPROVE') {
    return { ...base, action: REVIEW_ACTIONS.ADVANCE, reason: 'aprovado', detail: 'todos os revisores aprovaram' };
  }
  if (!combined.fixes.length) {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'reject-sem-fixes',
      detail: `REJECT de ${combined.rejecting.join(', ')} sem nenhuma correção acionável — sem feedback-delta o writer só reescreveria no escuro`,
    };
  }
  const repeated = repeatedFixes(combined.fixes, history);
  if (repeated.length) {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'nao-convergiu',
      repeated,
      detail: `correção repetida do ciclo anterior (${repeated.length}) — o loop não está convergindo`,
    };
  }
  if (cycle >= maxCycles) {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'teto-atingido',
      detail: `${cycle}/${maxCycles} ciclos sem APPROVE`,
    };
  }
  return {
    ...base,
    action: REVIEW_ACTIONS.REVISE,
    reason: 'rejeitado',
    nextCycle: cycle + 1,
    detail: `devolver ao writer apenas os ${combined.fixes.length} fixes (feedback-delta)`,
  };
}

/** Ledger vazio de um loop — o que `review-open` persiste. */
function openReview(options) {
  const raw = options && typeof options === 'object' ? options : {};
  const maxCycles =
    Number.isInteger(raw.maxCycles) && raw.maxCycles > 0 ? raw.maxCycles : DEFAULT_MAX_REVIEW_CYCLES;
  return {
    loop: typeof raw.loop === 'string' ? raw.loop : '',
    target: typeof raw.target === 'string' ? raw.target : '',
    maxCycles,
    status: 'open',
    cycles: [],
    pending: null,
  };
}

/**
 * Registra o veredito de UM revisor no ledger e devolve `{ ledger, result }`.
 *
 * Com `expect > 1` (dois revisores num `parallel_group`, por exemplo), os
 * vereditos se acumulam em `pending` e a decisão só sai quando todos chegam —
 * é o que impede que o APPROVE do revisor A, chegando primeiro, faça o pipeline
 * andar antes do REJECT do revisor B.
 */
function applyVerdict(ledger, entry, options) {
  const base = ledger && typeof ledger === 'object' ? ledger : openReview({});
  const opts = options && typeof options === 'object' ? options : {};
  const expect = Number.isInteger(opts.expect) && opts.expect > 0 ? opts.expect : 1;
  const cycles = Array.isArray(base.cycles) ? base.cycles : [];
  const cycle = cycles.length + 1;
  const pending =
    base.pending && Array.isArray(base.pending.verdicts) && base.pending.cycle === cycle ? base.pending.verdicts : [];
  const verdicts = [...pending, entry];

  if (verdicts.length < expect) {
    return {
      ledger: { ...base, cycles, status: 'open', pending: { cycle, expect, verdicts } },
      result: {
        action: REVIEW_ACTIONS.AWAIT,
        reason: 'aguardando-revisores',
        cycle,
        expect,
        received: verdicts.length,
        loop: base.loop,
        target: base.target,
        detail: `${verdicts.length}/${expect} vereditos deste ciclo`,
      },
    };
  }

  const history = cycles.map((c) => ({
    cycle: c && c.cycle,
    fixes: c && c.decision && Array.isArray(c.decision.fixes) ? c.decision.fixes : [],
  }));
  const decision = decideReview({ verdicts, history, maxCycles: base.maxCycles });
  const status =
    decision.action === REVIEW_ACTIONS.ADVANCE
      ? 'approved'
      : decision.action === REVIEW_ACTIONS.ESCALATE
        ? 'escalated'
        : 'open';
  return {
    ledger: { ...base, cycles: [...cycles, { cycle, verdicts, decision }], pending: null, status },
    result: { ...decision, loop: base.loop, target: base.target },
  };
}

/**
 * Retomada durável: dado o ledger lido do disco, o que o runner deve fazer agora.
 * É o que permite uma sessão nova continuar o loop no ciclo certo em vez de
 * recomeçar do zero (e estourar o teto sem perceber).
 */
function resumeReview(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    return { action: 'none', reason: 'sem-loop', detail: 'nenhum loop de revisão aberto' };
  }
  const loop = typeof ledger.loop === 'string' ? ledger.loop : '';
  const target = typeof ledger.target === 'string' ? ledger.target : '';
  if (ledger.pending && Array.isArray(ledger.pending.verdicts)) {
    return {
      action: REVIEW_ACTIONS.AWAIT,
      reason: 'aguardando-revisores',
      cycle: ledger.pending.cycle,
      expect: ledger.pending.expect,
      received: ledger.pending.verdicts.length,
      loop,
      target,
      detail: 'ciclo incompleto — refaça os vereditos que faltam',
    };
  }
  const cycles = Array.isArray(ledger.cycles) ? ledger.cycles : [];
  const last = cycles[cycles.length - 1];
  if (!last || !last.decision) {
    return { action: 'none', reason: 'sem-ciclos', loop, target, detail: 'loop aberto, nenhum ciclo fechado ainda' };
  }
  return { ...last.decision, loop, target, resumedFrom: last.cycle };
}
// <<< review-loop:end

// >>> skill-uso:begin
const DIR_USO = ['_evals', 'uso'];

/** `skills/` é irmão de `squads/` — mesma convenção do squad-check. */
export function skillsDirDoSquad(squadDir) {
  return join(dirname(resolve(squadDir)), '..', 'skills');
}

/**
 * Ids de skill declarados pelo squad (squad.yaml + frontmatter dos agentes).
 * Parser local mínimo — as duas formas que o motor gera (lista de bloco e
 * inline), mesmas regexes do squad-check.
 */
export function skillsDeclaradasDoSquad(squadDir) {
  const ids = new Set();
  const fontes = [join(squadDir, 'squad.yaml')];
  const agentsDir = join(squadDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith('.md')) fontes.push(join(agentsDir, f));
    }
  }
  for (const arquivo of fontes) {
    if (!existsSync(arquivo)) continue;
    const texto = readFileSync(arquivo, 'utf8');
    const inline = texto.match(/^\s*skills:\s*\[([^\]]*)\]\s*$/m);
    if (inline) {
      for (const s of inline[1].split(',')) {
        const id = s.trim().replace(/^["']|["']$/g, '');
        if (id) ids.add(id);
      }
      continue;
    }
    const bloco = texto.match(/^skills:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (!bloco) continue;
    for (const linha of bloco[1].split('\n')) {
      const id = linha.match(/^\s*-\s+(.+?)\s*$/)?.[1]?.replace(/^["']|["']$/g, '');
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * Grava UM evento de ciclo fechado para cada skill do squad.
 * `evento = { squad, gate, verdict, reviewer?, data? }`.
 * Sem skills declaradas ou sem `skills/` no disco → no-op silencioso: área
 * não instalada é estado normal deste motor.
 */
export function registrarUsoDeSkills(squadDir, evento) {
  const skills = skillsDeclaradasDoSquad(squadDir);
  if (!skills.length) return { gravados: 0 };
  const skillsDir = skillsDirDoSquad(squadDir);
  if (!existsSync(skillsDir)) return { gravados: 0 };

  const usoDir = join(skillsDir, ...DIR_USO);
  mkdirSync(usoDir, { recursive: true });
  const linha = `${JSON.stringify({
    data: evento.data || new Date().toISOString().slice(0, 10),
    squad: String(evento.squad || ''),
    gate: String(evento.gate || 'review'),
    verdict: String(evento.verdict || ''),
    ...(evento.reviewer ? { reviewer: String(evento.reviewer) } : {}),
  })}\n`;

  let gravados = 0;
  for (const id of skills) {
    // Id vindo de YAML do usuário NUNCA vira caminho sem o mesmo gate do
    // detail-skill: barra ou `..` atravessaria para fora de _evals/uso via
    // appendFileSync. Telemetria pula o id torto em silêncio — fail-safe.
    if (/[\\/]|\.\./.test(id)) continue;
    // Um arquivo por skill: a leitura na hora da decisão é O(1) — abre o
    // arquivo da finalista, nunca varre um log global.
    appendFileSync(join(usoDir, `${id}.jsonl`), linha);
    gravados++;
  }
  return { gravados, skills };
}

/**
 * Agregado de uso de UMA skill, para o digest do `detail-skill` e para a
 * Phase D.5 do Design. Ausência de arquivo → `null` ("nunca medida"), que é
 * diferente de zero — a mesma semântica de ausência do resto do motor.
 */
export function lerUsoDeSkill(rootDir, skillId) {
  if (/[\\/]|\.\./.test(String(skillId || ''))) return null;
  const caminho = join(rootDir, 'skills', ...DIR_USO, `${skillId}.jsonl`);
  if (!existsSync(caminho)) return null;

  const eventos = readFileSync(caminho, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
  if (!eventos.length) return null;

  const rejeicoes = eventos.filter((e) => e.verdict === 'REJECT');
  const squads = new Set(eventos.map((e) => e.squad).filter(Boolean));
  return {
    ciclos: eventos.length,
    aprovacoes: eventos.filter((e) => e.verdict === 'APPROVE').length,
    rejeicoes: rejeicoes.length,
    squads_distintos: squads.size,
    ultimo_uso: eventos[eventos.length - 1].data || null,
    ultima_rejeicao: rejeicoes.length ? rejeicoes[rejeicoes.length - 1].data || null : null,
  };
}
// <<< skill-uso:end

// ---------------------------------------------------------------------------
// Estado durável do run — cópia VERBATIM de src/run-state.js.
// Guarda o run_id em disco: sem ele, uma sessão caída faz o runner começar um
// run novo e abandonar a pasta com os artefatos já produzidos.
// A cópia é guardada por tests/run-state.test.js: se divergir, a suíte quebra.
// ---------------------------------------------------------------------------
// >>> run-state:begin
/** Estados de um run. `running` é o único não-terminal. */
const RUN_STATUSES = Object.freeze(['running', 'completed', 'failed']);

/** Abre o ledger de um run. O `run_id` é obrigatório: é a chave de retomada. */
function abrirRun({ runId, squad, total, agora } = {}) {
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new Error('run_id é obrigatório: um run sem id não é retomável depois de a sessão cair');
  }
  const totalNum = Number.isInteger(total) && total >= 0 ? total : 0;
  return {
    runId: runId.trim(),
    squad: typeof squad === 'string' ? squad : '',
    status: 'running',
    step: { current: 0, total: totalNum, label: '' },
    checkpoints: {},
    // Carimbo de abertura — só quando o CHAMADOR fornece (o módulo segue puro,
    // sem data própria). É o que permite ao chefe dizer "estamos nisso há N
    // minutos" e ao relatório fechar a duração real do run.
    ...(typeof agora === 'string' && agora ? { startedAt: agora } : {}),
  };
}

/** Move o ponteiro do step. Preserva o `total` — perdê-lo cega a retomada. */
function avancarRun(ledger, { current, label, stepId, agora } = {}) {
  const base = ledger || {};
  const passo = base.step || {};
  const proximo = {
    ...base,
    step: {
      current: Number.isInteger(current) ? current : passo.current || 0,
      total: passo.total || 0,
      label: typeof label === 'string' ? label : passo.label || '',
    },
  };
  // Histórico por step — só quando o chamador carimba (`agora`). Fecha o step
  // anterior ainda aberto e abre o novo; é a matéria-prima de "a pesquisa
  // levou 4 minutos" na conclusão e do recap honesto na retomada. Ledger
  // antigo sem `steps` continua válido: o campo nasce aqui quando aparece.
  if (typeof agora === 'string' && agora) {
    const historico = Array.isArray(base.steps) ? [...base.steps] : [];
    const aberto = historico.length && !historico[historico.length - 1].endedAt
      ? historico.pop()
      : null;
    if (aberto) historico.push({ ...aberto, endedAt: agora });
    // `stepId` é o ID do step (`step-01`), separado do RÓTULO humano.
    // A espera pelo humano se mede casando o carimbo do checkpoint (que usa o
    // id) com o início do step. Enquanto a única chave era `label`, e o runner
    // manda passar "id OU rótulo", a medição virava sorteio: com "Foco do
    // Caso" o join falhava e a métrica dizia "não medido"; e em
    // `parallel_group` o rótulo NUNCA é um id, então ali era sempre imedível.
    historico.push({ n: proximo.step.current, label: proximo.step.label, ...(typeof stepId === 'string' && stepId.trim() ? { stepId: stepId.trim() } : {}), startedAt: agora });
    proximo.steps = historico;
  }
  return proximo;
}

/**
 * Guarda a resposta do usuário num checkpoint.
 *
 * Sem isto, retomar um run interrompido obriga a reperguntar tudo o que já foi
 * decidido — e uma segunda resposta pode não ser igual à primeira, o que muda o
 * resultado sem ninguém perceber.
 */
function registrarCheckpoint(ledger, { step, resposta, agora } = {}) {
  const base = ledger || {};
  if (typeof step !== 'string' || !step.trim()) return base;
  return {
    ...base,
    // O VALOR continua string — é o shape que a retomada e os testes leem.
    // O carimbo vive num mapa paralelo, aditivo: ledger antigo não o tem e
    // segue válido; com ele, o chefe pode dizer QUANDO cada decisão foi tomada.
    checkpoints: { ...(base.checkpoints || {}), [step.trim()]: typeof resposta === 'string' ? resposta : '' },
    ...(typeof agora === 'string' && agora
      ? { checkpoints_em: { ...(base.checkpoints_em || {}), [step.trim()]: agora } }
      : {}),
  };
}

/** Fecha o run. Só `completed` ou `failed` — fechar em `running` é contradição. */
function fecharRun(ledger, { status, agora } = {}) {
  const terminais = RUN_STATUSES.filter((s) => s !== 'running');
  if (!terminais.includes(status)) {
    throw new Error(`status terminal inválido: "${status}" (use ${terminais.join(' ou ')})`);
  }
  const base = ledger || {};
  const extra = {};
  if (typeof agora === 'string' && agora) {
    extra.endedAt = agora;
    // Fecha também o último step ainda aberto do histórico — sem isto a
    // duração do passo final ficaria eternamente em aberto no relatório.
    if (Array.isArray(base.steps) && base.steps.length && !base.steps[base.steps.length - 1].endedAt) {
      extra.steps = [...base.steps.slice(0, -1), { ...base.steps[base.steps.length - 1], endedAt: agora }];
    }
  }
  return { ...base, status, ...extra };
}

/**
 * O que fazer com o ledger encontrado em disco.
 *
 * Três respostas, e nenhuma delas é um palpite: `none` (não há run), `resume`
 * (interrompido — retome DESTE run_id) e `closed` (terminou). "Não sei" nunca
 * vira "comece um run novo", que é o que produzia pastas órfãs.
 */
function retomarRun(ledger) {
  if (!ledger || typeof ledger !== 'object' || !ledger.runId) return { action: 'none' };
  const { runId, squad, status, step, checkpoints } = ledger;
  if (status !== 'running') {
    return { action: 'closed', runId, squad, status, step: step || null };
  }
  return {
    action: 'resume',
    runId,
    squad,
    status,
    step: step || { current: 0, total: 0, label: '' },
    checkpoints: checkpoints || {},
    // Campos de tempo — aditivos e opcionais: o molde de retomada do runner
    // promete "diga QUANDO cada decisão foi tomada", e prometer campo que o
    // run-status não devolve obrigaria o chefe a inventar. Ledger antigo não
    // os tem e o shape segue válido.
    ...(ledger.startedAt ? { startedAt: ledger.startedAt } : {}),
    ...(Array.isArray(ledger.steps) && ledger.steps.length ? { steps: ledger.steps } : {}),
    ...(ledger.checkpoints_em ? { checkpoints_em: ledger.checkpoints_em } : {}),
  };
}
// <<< run-state:end


// ---------------------------------------------------------------------------
// Abertura do run — o que era prosa executada pelo modelo (PLANO §0, achados
// M1/M2 da auditoria de prompts). Duas coisas saíram do runner e vieram para
// cá porque são determinísticas e o modelo errava em silêncio:
//
//   1. o `run_id` (formato de data + desempate por colisão) — string e
//      comparação, a mesma família de "a conta é do CÓDIGO, não sua";
//   2. a normalização do `memories.md`/`runs.md` do squad — uma migração de
//      formato, executada a cada run por instrução de 30 linhas.
// ---------------------------------------------------------------------------

// >>> abertura-run:begin
/** Nome de exibição do squad (`name:`); cai no `code` quando ausente. */
function readSquadName(dir) {
  const p = join(dir, 'squad.yaml');
  if (!existsSync(p)) return readSquadCode(dir);
  const m = readFileSync(p, 'utf-8').match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1].trim() : readSquadCode(dir);
}

/**
 * `YYYY-MM-DD-HHmmss` no fuso do FORO — não o da máquina. Contêiner, cron e
 * viagem rodam em UTC, e um run aberto às 21h de Recife não deve nascer com a
 * data do dia seguinte. Mesmo racional do `today()` dos scripts orchestra.
 */
const FUSO_DO_FORO = 'America/Sao_Paulo';

function formatarRunId(agora = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_DO_FORO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(agora).reduce((acc, { type, value }) => ({ ...acc, [type]: value }), {});
  const hora = p.hour === '24' ? '00' : p.hour; // en-CA usa 24 para meia-noite
  return `${p.year}-${p.month}-${p.day}-${hora}${p.minute}${p.second}`;
}

/**
 * Um `run_id` livre: o formato acima e, na colisão sub-segundo, `-2`, `-3`…
 * até a pasta do run não existir. `ocupado` é injetável para teste.
 */
function gerarRunId(dir, { agora = new Date(), ocupado } = {}) {
  const existe = ocupado || ((id) => existsSync(join(dir, 'output', id)));
  const base = formatarRunId(agora);
  if (!existe(base)) return base;
  for (let n = 2; n <= 100; n += 1) {
    if (!existe(`${base}-${n}`)) return `${base}-${n}`;
  }
  die(`não consegui um run_id livre a partir de ${base} — 100 colisões seguidas`);
}

/** As cinco seções canônicas do `memories.md`, na ordem. */
const SECOES_DE_MEMORIA = Object.freeze([
  '## Estilo de Escrita',
  '## Design Visual',
  '## Estrutura de Conteúdo',
  '## Proibições Explícitas',
  '## Técnico (específico do squad)',
]);

/**
 * Normaliza `_memory/memories.md` e `_memory/runs.md` do squad.
 *
 * **Idempotente e NÃO destrutiva** — e aqui houve uma correção de premissa:
 * a instrução que este código substitui mandava, em prosa, "reset
 * unconditionally… do NOT attempt to salvage content from the old file".
 * Em código isso viraria apagar em silêncio o que o escritório escreveu, toda
 * vez que faltasse um cabeçalho — a mesma perda silenciosa que a rota de
 * aprendizado técnico sofria ao gravar em pasta de pacote. O que uma migração
 * de FORMATO precisa é garantir que as seções existam: arquivo ausente ou
 * vazio recebe o modelo; arquivo com conteúdo recebe, no fim, apenas as
 * seções que faltavam. Nada do usuário é descartado.
 */
function normalizarMemoriaDoSquad(dir, nomeDeExibicao) {
  const memDir = join(dir, '_memory');
  const resultado = { memories: 'ok', runs: 'ok' };

  const alvoMemories = join(memDir, 'memories.md');
  const atual = existsSync(alvoMemories) ? readFileSync(alvoMemories, 'utf-8') : null;
  if (atual === null || !atual.trim()) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(alvoMemories, `# Squad Memory: ${nomeDeExibicao}\n\n${SECOES_DE_MEMORIA.join('\n\n')}\n`, 'utf-8');
    resultado.memories = atual === null ? 'criado' : 'preenchido';
  } else {
    const faltando = SECOES_DE_MEMORIA.filter((h) => !atual.includes(h));
    if (faltando.length) {
      const corpo = `${atual.replace(/\s*$/, '')}\n\n${faltando.join('\n\n')}\n`;
      mkdirSync(memDir, { recursive: true });
      writeFileSync(alvoMemories, corpo, 'utf-8');
      resultado.memories = `seções acrescentadas: ${faltando.length}`;
    }
  }

  const alvoRuns = join(memDir, 'runs.md');
  const CABECALHO_DE_RUNS = '| Data | Run ID | Tema | Output | Resultado |';
  const runs = existsSync(alvoRuns) ? readFileSync(alvoRuns, 'utf-8') : null;
  if (runs === null || !runs.trim()) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      alvoRuns,
      `# Run History: ${nomeDeExibicao}\n\n${CABECALHO_DE_RUNS}\n|------|--------|------|--------|-----------|\n`,
      'utf-8',
    );
    resultado.runs = runs === null ? 'criado' : 'preenchido';
  }
  return resultado;
}
// <<< abertura-run:end

function cmdInit(dir, flags) {
  const total = Number(flags.total);
  if (!Number.isInteger(total) || total < 0) die('init requer --total <N> (inteiro >= 0)');
  // O `run_id` é do CÓDIGO. `--run` continua aceito (retomada passa o id do run
  // interrompido, e squads antigos seguem valendo); ausente, o init gera,
  // desempata a colisão e cria a pasta do run — era a única aritmética que o
  // runner ainda fazia de cabeça na abertura.
  const runId = typeof flags.run === 'string' && flags.run.trim() ? flags.run.trim() : gerarRunId(dir);
  mkdirSync(join(dir, 'output', runId), { recursive: true });
  writeJson(dir, RUN_LEDGER, { ...abrirRun({ runId, squad: readSquadCode(dir), total, agora: now() }), updatedAt: now() });
  const memoria = normalizarMemoriaDoSquad(dir, readSquadName(dir));
  writeState(dir, {
    squad: readSquadCode(dir),
    status: 'idle',
    step: { current: 0, total, label: '' },
    agents: readAgents(dir),
    handoff: null,
    startedAt: null,
    updatedAt: now(),
  });
  // O runner precisa do `run_id` de volta — é ele que resolve todos os caminhos
  // de output daqui para frente.
  console.log(JSON.stringify({ runId, total, runDir: `output/${runId}`, memoria }, null, 2));
}

function cmdStep(dir, flags) {
  const current = Number(flags.current);
  if (!Number.isInteger(current)) die('step requer --current <K> (inteiro)');
  const working = asList(flags.working).filter((v) => typeof v === 'string');
  if (!working.length) die('step requer ao menos um --working <id>');
  const workingSet = new Set(working);
  const activity = str(flags.activity);

  const s = loadState(dir);
  s.status = 'running';
  s.step = { current, total: s.step?.total ?? 0, label: str(flags.label) };
  s.agents = s.agents.map((a) => {
    const c = { ...a };
    delete c.activity;
    if (workingSet.has(a.id)) {
      c.status = 'working';
      if (activity) c.activity = activity;
    } else {
      c.status = ACTED.includes(a.status) ? 'done' : 'idle';
    }
    return c;
  });
  s.handoff = flags.from
    ? { from: String(flags.from), to: working[0], message: str(flags.message), completedAt: now() }
    : null;
  if (!s.startedAt) s.startedAt = now();
  s.updatedAt = now();
  writeState(dir, s);
  atualizarRunLedger(dir, (l) => avancarRun(l, { current, label: str(flags.label), stepId: str(flags.step), agora: now() }));
}

function cmdCheckpoint(dir, flags) {
  if (typeof flags.agent !== 'string') die('checkpoint requer --agent <id>');
  const s = loadState(dir);
  s.status = 'checkpoint';
  s.agents = s.agents.map((a) => (a.id === flags.agent ? { ...a, status: 'checkpoint' } : a));
  s.updatedAt = now();
  writeState(dir, s);
  // A resposta do usuário fica no ledger durável: retomar um run interrompido
  // sem ela obriga a reperguntar, e a segunda resposta pode não ser a primeira.
  if (typeof flags.step === 'string') {
    atualizarRunLedger(dir, (l) => registrarCheckpoint(l, { step: flags.step, resposta: str(flags.resposta), agora: now() }));
  }
}

function clearActivity(agents, status) {
  return agents.map((a) => {
    const c = { ...a };
    delete c.activity;
    if (status) c.status = status;
    return c;
  });
}

function cmdComplete(dir) {
  const s = loadState(dir);
  s.status = 'completed';
  s.agents = clearActivity(s.agents, 'done');
  s.completedAt = now();
  s.updatedAt = now();
  writeState(dir, s);
  atualizarRunLedger(dir, (l) => fecharRun(l, { status: 'completed', agora: now() }));
}

function cmdFail(dir) {
  const s = loadState(dir);
  s.status = 'failed';
  s.agents = clearActivity(s.agents, null);
  s.failedAt = now();
  s.updatedAt = now();
  writeState(dir, s);
  atualizarRunLedger(dir, (l) => fecharRun(l, { status: 'failed', agora: now() }));
}

// --- Loop de revisão: o ledger durável (review-state.json) --------------------
// Fica FORA do state.json de propósito: o contrato do state.json é fechado
// (`additionalProperties: false` em state.schema.json, lido pelo dashboard) e
// o state.json é APAGADO no cleanup pós-conclusão. O ledger precisa sobreviver
// a uma sessão caída — por isso mora no seu próprio arquivo.
const LEDGER = 'review-state.json';

/**
 * O ledger guarda UM laço por gate. O runner tem cinco laços com teto além da
 * revisão — veto, Citation Gate, Redação Gate e os dois retries — e num step de
 * redação mais de um está aberto ao mesmo tempo. Com um laço só, abrir o da
 * citação apagava o da revisão e a contagem recomeçava do zero em silêncio.
 */
const GATE_PADRAO = 'revisao';

function lerLedgerBruto(dir) {
  const p = join(dir, LEDGER);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    // Ledger ilegível ≠ ledger ausente: seguir como se não houvesse laço
    // reiniciaria a contagem de ciclos em silêncio. Fail-closed.
    return die(`${LEDGER} existente é JSON inválido — resolva à mão antes de continuar`);
  }
}

/** Nome do gate desta chamada. Sem --gate, é a revisão (uso legado). */
function nomeDoGate(flags) {
  return typeof flags.gate === 'string' && flags.gate.trim() ? flags.gate.trim() : GATE_PADRAO;
}

function loadLedger(dir, gate, { required } = {}) {
  const bruto = lerLedgerBruto(dir);
  const laco = bruto && bruto.loops ? bruto.loops[gate] : null;
  if (!laco && required) {
    // Abrir sozinho zeraria a contagem: cada REJECT viraria "ciclo 1" e o teto
    // nunca chegaria — o laço giraria para sempre.
    die(`gate "${gate}" não tem laço aberto — rode \`gate-open --gate ${gate}\` antes de registrar vereditos`);
  }
  return laco || null;
}

function saveLedger(dir, gate, laco) {
  const bruto = lerLedgerBruto(dir) || {};
  writeJson(dir, LEDGER, { loops: { ...(bruto.loops || {}), [gate]: laco }, updatedAt: now() });
}

// A saída dos comandos de revisão é JSON no stdout (o runner parseia) e o
// exit code 3 marca escalação para quem só olha o código de saída.
function emitDecision(result) {
  console.log(JSON.stringify(result, null, 2));
  if (result && result.action === REVIEW_ACTIONS.ESCALATE) process.exitCode = 3;
  return null;
}

function cmdReviewOpen(dir, flags) {
  const gate = nomeDoGate(flags);
  if (typeof flags.loop !== 'string') die('gate-open requer --loop <step-id do avaliador>');
  if (typeof flags.target !== 'string') die('gate-open requer --target <step-id a refazer>');
  const max = flags.max === undefined ? undefined : Number(flags.max);
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) die('--max precisa ser inteiro >= 1');
  const laco = openReview({ loop: flags.loop, target: flags.target, maxCycles: max });
  saveLedger(dir, gate, laco);
  return emitDecision({ action: 'open', gate, loop: laco.loop, target: laco.target, maxCycles: laco.maxCycles });
}

function cmdReviewVerdict(dir, flags) {
  const gate = nomeDoGate(flags);
  if (typeof flags.verdict !== 'string') die('gate-verdict requer --verdict APPROVE|REJECT');
  const expect = flags.expect === undefined ? 1 : Number(flags.expect);
  if (!Number.isInteger(expect) || expect < 1) die('--expect precisa ser inteiro >= 1');
  const entry = {
    reviewer: str(flags.reviewer),
    verdict: flags.verdict,
    fixes: asList(flags.fix).filter((v) => typeof v === 'string'),
  };
  const { ledger, result } = applyVerdict(loadLedger(dir, gate, { required: true }), entry, { expect });
  saveLedger(dir, gate, ledger);
  // Ciclo FECHADO vira evento de uso das skills do squad — o elo execução →
  // seleção que faltava (o Arquiteto lê isto via detail-skill na Phase D.5).
  // Só gates de QUALIDADE (review/redacao/citacao/persuasao/contrato): retry e veto medem
  // infraestrutura e vontade do usuário, não desempenho de skill. Telemetria
  // é fail-safe: um defeito aqui não pode custar a peça — engole e avisa.
  if (result.action !== 'await' && ['revisao', 'redacao', 'citacao', 'persuasao', 'contrato'].includes(gate)) {
    try {
      registrarUsoDeSkills(dir, {
        squad: readSquadCode(dir) || basename(resolve(dir)),
        gate,
        verdict: result.action === 'advance' ? 'APPROVE' : 'REJECT',
        reviewer: entry.reviewer,
      });
    } catch (erro) {
      console.error(`aviso: registro de uso de skills falhou (${erro.message}) — veredito não afetado`);
    }
  }
  return emitDecision({ ...result, gate });
}

function cmdReviewStatus(dir, flags) {
  const gate = nomeDoGate(flags);
  return emitDecision({ ...resumeReview(loadLedger(dir, gate)), gate });
}

// --- Estado durável do run (run-state.json) ---------------------------------
// Mesma razão do review-state.json para ficar FORA do state.json: contrato
// fechado lá, e o state.json é apagado no cleanup. Aqui mora o run_id.
const RUN_LEDGER = 'run-state.json';

function loadRunLedger(dir) {
  const p = join(dir, RUN_LEDGER);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    // Ilegível ≠ ausente: seguir em frente criaria um run novo e abandonaria a
    // pasta com os artefatos já produzidos. Fail-closed.
    return die(`${RUN_LEDGER} existente é JSON inválido — resolva à mão antes de continuar`);
  }
}

/** Atualiza o ledger SE ele existir. Sem ledger, o comando segue normal. */
function atualizarRunLedger(dir, transformar) {
  const atual = loadRunLedger(dir);
  if (!atual) return;
  writeJson(dir, RUN_LEDGER, { ...transformar(atual), updatedAt: now() });
}

function cmdRunStatus(dir) {
  console.log(JSON.stringify(retomarRun(loadRunLedger(dir)), null, 2));
  return null;
}

const { command, dir, flags } = parseArgs(process.argv.slice(2));
if (!command || !dir)
  die('uso: squad-state <init|step|checkpoint|complete|fail|review-open|review-verdict|review-status|run-status> <squad-dir> [opções]');
if (!existsSync(dir)) die(`pasta do squad não existe: ${dir}`);

const commands = {
  init: cmdInit,
  step: cmdStep,
  checkpoint: cmdCheckpoint,
  complete: cmdComplete,
  fail: cmdFail,
  'review-open': cmdReviewOpen,
  'review-verdict': cmdReviewVerdict,
  'review-status': cmdReviewStatus,
  // Nomes honestos para os laços que não são de revisão (citação, redação,
  // veto, retry). Mesmos handlers — o que muda é só o --gate.
  'gate-open': cmdReviewOpen,
  'gate-verdict': cmdReviewVerdict,
  'gate-status': cmdReviewStatus,
  'run-status': cmdRunStatus,
};
if (!commands[command]) die(`comando desconhecido: ${command}`);
// Comandos de revisão já imprimiram o JSON da decisão; os de estado confirmam
// a escrita em uma linha (como sempre fizeram).
if (commands[command](dir, flags) !== null) console.log(`state.json atualizado (${command}) em ${dir}`);
