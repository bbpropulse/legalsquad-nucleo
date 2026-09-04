// Contabilidade DETERMINÍSTICA do loop de revisão (writer → reviewer).
//
// Antes, tudo isto era prosa em `_legalsquad/core/runner.pipeline.md` que o LLM
// obedecia de cabeça: parsear o veredito, contar o ciclo, comparar os `fixes`
// com os do ciclo anterior, decidir se volta ao writer, se escala ou se segue.
// Contabilidade não é julgamento — é aritmética, e aritmética de cabeça erra em
// silêncio. Aqui ela vira código puro e testado; ao LLM sobra só o mérito do
// texto (APPROVE/REJECT + `fixes`), que é o que só ele faz.
//
// Módulo PURO: sem I/O, sem data/hora, sem processo. A persistência (o ledger em
// `squads/<nome>/review-state.json`, que faz o loop sobreviver a uma sessão
// caída) é feita por `scripts/squad-state.mjs`.
//
// SINCRONIA: o bloco entre os marcadores abaixo é copiado VERBATIM para
// `scripts/squad-state.mjs` e `templates/scripts/squad-state.mjs`. O script
// distribuído ao usuário é auto-contido por contrato — o projeto do usuário não
// tem `src/` —, então a cópia é inevitável; o que não pode é divergir em
// silêncio. `tests/review-loop.test.js` falha se as três cópias divergirem.

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

export {
  REVIEW_ACTIONS,
  DEFAULT_MAX_REVIEW_CYCLES,
  normalizeFix,
  combineVerdicts,
  repeatedFixes,
  decideReview,
  openReview,
  applyVerdict,
  resumeReview,
};
