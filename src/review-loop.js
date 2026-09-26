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
  REFUSE: 'refuse', // veredito fora de laço aberto ou voz repetida no ciclo: nada é gravado
});

/** Teto default de ciclos, quando o step/pipeline não declara `max_review_cycles`. */
const DEFAULT_MAX_REVIEW_CYCLES = 3;

/**
 * Gravidade de um `fix`, lida do PREFIXO que o revisor escreve na própria frase:
 * `critica: …`, `alta: …`, `media: …`, `baixa: …` (com ou sem acento, com ou
 * sem colchetes). Só `critica` e `alta` sustentam um REJECT; `media` e `baixa`
 * são AJUSTES: o redator aplica, ninguém abre rodada nova para conferir.
 *
 * Sem prefixo, a gravidade é `alta`: fail-closed. Um revisor que não classifica
 * continua reprovando como sempre reprovou; o que muda é que quem classifica
 * deixa de gastar 40 minutos de rodada num hífen. Medido num run real de
 * 15/09/2026: três REJECTs seguidos (13, 8 e 6 fixes) com a peça já certa no
 * mérito, porque cada rodada abria frente nova de forma até o teto.
 */
const GRAVIDADES = Object.freeze(['critica', 'alta', 'media', 'baixa']);
const GRAVIDADE_PADRAO = 'alta';
const BLOQUEANTES = new Set(['critica', 'alta']);
const PREFIXO_DE_GRAVIDADE = /^\s*\[?\s*(cr[ií]tica|alta|m[eé]dia|baixa)\s*\]?\s*[:\-–]\s*/i;

function gravidadeDoFix(fix) {
  if (typeof fix !== 'string') return { gravidade: GRAVIDADE_PADRAO, texto: '', explicita: false };
  const m = fix.match(PREFIXO_DE_GRAVIDADE);
  if (!m) return { gravidade: GRAVIDADE_PADRAO, texto: fix.trim(), explicita: false };
  const gravidade = m[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // A escala é a lista, não o regex: prefixo que não esteja nela cai no padrão (fail-closed).
  return { gravidade: GRAVIDADES.includes(gravidade) ? gravidade : GRAVIDADE_PADRAO, texto: fix.slice(m[0].length).trim(), explicita: true };
}

const ehBloqueante = (fix) => BLOQUEANTES.has(gravidadeDoFix(fix).gravidade);

/**
 * Citação que a própria tabela de um veredito contesta reprova, venha o
 * veredito como vier. Medido no mandado de segurança (24/09/2026, motor
 * 0.9.44): a reabertura foi registrada como APPROVE com 6 citações
 * `fonte_mudou` na tabela que ela mesma levou ao cartório, e o laço fechou
 * aprovado. O cartório recebia a contagem de contestadas e a ignorava.
 *
 * Uma exceção, e só uma: `fonte_mudou` e `acesso_falhou` dizem "o código não
 * conseguiu confirmar", não "a fonte diz outra coisa". O runner manda essas
 * a um votante LLM no mesmo ciclo; se uma voz POSTERIOR do ciclo a registra
 * como verificada, ela deixa de reprovar (é a mesma regra do cartório de
 * citações: a conferência mais recente vale). `divergente` e
 * `nao_encontrada` são contestação de mérito e reprovam sempre: qualquer voz
 * que marque uma derruba o ciclo, como no voting.
 */
const RECONFERIVEIS = new Set(['fonte_mudou', 'acesso_falhou']);

/**
 * A conferência no acervo assinado (`verificada_no_acervo`) reconfere o que o código não abriu
 * (`acesso_falhou`: a página do tribunal fora do ar ou atrás de desafio), porque a captura do
 * curador é oficial. Não reconfere `fonte_mudou`: a fonte na web mudou de texto, e a cópia
 * capturada antes é justamente o que pode ter ficado para trás (G19, medição de 24/09/2026).
 */
const RECONFERIVEIS_NO_ACERVO = new Set(['acesso_falhou']);

const chaveDeCitacao = (titulo) =>
  String(titulo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const statusDeCitacao = (status) =>
  String(status || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');

/** As contestadas de cada voz que continuam de pé ao fechar o ciclo. */
function contestadasVigentes(list) {
  const confirmadaDepois = (i, chave, status) =>
    list.slice(i + 1).some((e) => {
      if (!Array.isArray(e && e.verificadas) || !e.verificadas.some((t) => chaveDeCitacao(t) === chave)) return false;
      const soNoAcervo = Array.isArray(e.verificadas_no_acervo) && e.verificadas_no_acervo.some((t) => chaveDeCitacao(t) === chave);
      return !soNoAcervo || RECONFERIVEIS_NO_ACERVO.has(status);
    });
  const vigentes = [];
  list.forEach((entry, i) => {
    const who = entry && typeof entry.reviewer === 'string' && entry.reviewer.trim() ? entry.reviewer.trim() : '(revisor anônimo)';
    for (const c of Array.isArray(entry && entry.contestadas) ? entry.contestadas : []) {
      const title = c && typeof c.title === 'string' ? c.title.trim() : '';
      if (!title) continue;
      const status = statusDeCitacao(c.status) || 'contestada';
      if (RECONFERIVEIS.has(status) && confirmadaDepois(i, chaveDeCitacao(title), status)) continue;
      vigentes.push({ index: i, title, status, reviewer: who });
    }
  });
  return vigentes;
}

const fixDeContestada = (c) => `critica: citação contestada no cartório (${c.status}): ${c.title}`;

/**
 * Chave de comparação de um `fix`: o mesmo problema descrito com outra pontuação,
 * caixa ou acento ainda é o MESMO problema. Sem isto, "Falta a citação." e
 * "falta a citacao" pareceriam correções diferentes e a não-convergência passaria
 * batida até o teto. O prefixo de gravidade sai da chave: "alta: falta a
 * citação" e "falta a citação" são o mesmo problema.
 */
function normalizeFix(fix) {
  if (typeof fix !== 'string') return '';
  return gravidadeDoFix(fix).texto
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
  const vigentes = contestadasVigentes(list);
  const contestadas = vigentes.map(({ title, status, reviewer }) => ({ title, status, reviewer }));
  const reviewers = [];
  const unreadable = [];
  const rejecting = [];
  const fixes = [];
  const ajustes = [];
  const seen = new Set();
  const seenAjustes = new Set();
  const juntar = (destino, vistos, raw) => {
    for (const fix of Array.isArray(raw) ? raw : []) {
      if (typeof fix !== 'string') continue;
      const key = normalizeFix(fix);
      if (!key || vistos.has(key)) continue;
      vistos.add(key);
      destino.push(fix.trim());
    }
  };

  for (const [i, entry] of list.entries()) {
    const who =
      entry && typeof entry.reviewer === 'string' && entry.reviewer.trim() ? entry.reviewer.trim() : '(revisor anônimo)';
    reviewers.push(who);
    const verdict = entry && typeof entry.verdict === 'string' ? entry.verdict.trim().toUpperCase() : '';
    if (verdict !== 'APPROVE' && verdict !== 'REJECT') {
      unreadable.push(who);
      continue;
    }
    // `ajustes` (forma: hífen, grafia, título) viajam com APPROVE e com REJECT:
    // quem aprova com ressalva de forma não reprova, mas a ressalva não se perde.
    juntar(ajustes, seenAjustes, entry && entry.ajustes);
    // A tabela desta voz ainda contesta alguma citação: APPROVE vira REJECT,
    // e a contestada vira fix crítico (também num REJECT que veio sem --fix).
    const minhas = vigentes.filter((c) => c.index === i).map(fixDeContestada);
    if (verdict === 'APPROVE' && !minhas.length) continue;
    rejecting.push(who);
    juntar(fixes, seen, entry && entry.fixes);
    juntar(fixes, seen, minhas);
  }

  if (!list.length) {
    return { verdict: 'UNREADABLE', fixes, ajustes, reviewers, unreadable: ['(nenhum veredito recebido)'], rejecting, contestadas };
  }
  if (unreadable.length) return { verdict: 'UNREADABLE', fixes, ajustes, reviewers, unreadable, rejecting, contestadas };
  return { verdict: rejecting.length ? 'REJECT' : 'APPROVE', fixes, ajustes, reviewers, unreadable, rejecting, contestadas };
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
  // Só o que é crítico ou alto sustenta um REJECT; o resto é ajuste de forma,
  // que o redator aplica sem rodada nova. Fix sem prefixo conta como alto.
  const bloqueantes = combined.fixes.filter(ehBloqueante);
  const ajustes = [...combined.ajustes, ...combined.fixes.filter((fix) => !ehBloqueante(fix))];
  const base = {
    cycle,
    maxCycles,
    verdict: combined.verdict,
    fixes: combined.fixes,
    bloqueantes,
    ajustes,
    reviewers: combined.reviewers,
    ...(combined.contestadas.length ? { contestadas: combined.contestadas } : {}),
  };

  // O teto vale para qualquer veredito, não só para o REJECT. Medido em 7 dos
  // 8 runs da medição de 24/09/2026 (motor 0.9.44): o gate `citacao` chegou a
  // 4 e 5 ciclos com teto 2, porque o APPROVE avançava antes deste teste.
  if (cycle > maxCycles) {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'acima-do-teto',
      detail: `ciclo ${cycle} de um laço com teto ${maxCycles}: nenhum veredito passa do teto; o laço escala ao profissional`,
    };
  }
  if (combined.verdict === 'UNREADABLE') {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'veredito-ilegivel',
      detail: `veredito ausente ou ilegível de: ${combined.unreadable.join(', ')}; "não sei ler" não é "aprovado"`,
    };
  }
  if (combined.verdict === 'APPROVE') {
    return ajustes.length
      ? {
          ...base,
          action: REVIEW_ACTIONS.ADVANCE,
          reason: 'aprovado-com-ajustes',
          detail: `aprovado; ${ajustes.length} ajuste(s) de forma para o redator aplicar, sem rodada nova`,
        }
      : { ...base, action: REVIEW_ACTIONS.ADVANCE, reason: 'aprovado', detail: 'todos os revisores aprovaram' };
  }
  if (!combined.fixes.length) {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'reject-sem-fixes',
      detail: `REJECT de ${combined.rejecting.join(', ')} sem nenhuma correção acionável; sem feedback-delta o writer só reescreveria no escuro`,
    };
  }
  if (!bloqueantes.length) {
    // REJECT só de média/baixa: a peça está certa no mérito. O ledger rebaixa
    // para aprovação com ajustes em vez de gastar uma rodada inteira de
    // revisão e verificação num hífen, e diz que rebaixou.
    return {
      ...base,
      verdict: 'APPROVE',
      action: REVIEW_ACTIONS.ADVANCE,
      reason: 'rebaixado-para-ajustes',
      detail: `REJECT de ${combined.rejecting.join(', ')} só com correções de forma (${ajustes.length}); nenhuma crítica ou alta; vira aprovação com ajustes, sem rodada nova`,
    };
  }
  const repeated = repeatedFixes(bloqueantes, history);
  if (repeated.length) {
    return {
      ...base,
      action: REVIEW_ACTIONS.ESCALATE,
      reason: 'nao-convergiu',
      repeated,
      detail: `correção repetida do ciclo anterior (${repeated.length}): o loop não está convergindo`,
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
    detail: `devolver ao writer apenas os ${combined.fixes.length} fixes (feedback-delta): ${bloqueantes.length} bloqueante(s)${ajustes.length ? ` e ${ajustes.length} ajuste(s) de forma` : ''}`,
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

const nomeDaVoz = (entry) => (entry && typeof entry.reviewer === 'string' ? entry.reviewer.trim().toLowerCase() : '');

/** Os vereditos já recebidos no ciclo em aberto (vazio se não há ciclo pendente). */
function pendentesDoCiclo(base) {
  const cycles = Array.isArray(base.cycles) ? base.cycles : [];
  return base.pending && Array.isArray(base.pending.verdicts) && base.pending.cycle === cycles.length + 1
    ? base.pending.verdicts
    : [];
}

/**
 * Por que este veredito não pode entrar no ledger, ou `null` se pode. As
 * recusas vêm dos ledgers da medição de 24/09/2026 (motor 0.9.44):
 *   - laço aprovado: um veredito depois do `approved` abria ciclo novo no mesmo
 *     laço, acima do teto (o incremental e o final dividiam o laço `citacao`);
 *   - laço escalado: um APPROVE depois da escalada por teto fechou o laço como
 *     aprovado e apagou a escalada ao humano (alimentos);
 *   - voz repetida: a mesma voz duas vezes no ciclo contaria como dois votantes.
 */
function recusaDeVeredito(ledger, entry) {
  const base = ledger && typeof ledger === 'object' ? ledger : openReview({});
  const cycles = Array.isArray(base.cycles) ? base.cycles : [];
  const loop = typeof base.loop === 'string' && base.loop ? base.loop : '(sem nome)';
  if (base.status === 'approved') {
    return {
      reason: 'laco-aprovado',
      detail: `o laço ${loop} já fechou aprovado no ciclo ${cycles.length}; uma versão nova da peça abre laço novo com gate-open (o anterior vai para o histórico)`,
    };
  }
  if (base.status === 'escalated') {
    const ultima = cycles.length ? cycles[cycles.length - 1].decision : null;
    return {
      reason: 'laco-escalado',
      detail: `o laço ${loop} escalou ao profissional no ciclo ${cycles.length}${ultima && ultima.reason ? ` (${ultima.reason})` : ''}; só a decisão dele continua o trabalho, e um veredito aqui apagaria a escalada`,
    };
  }
  if (base.status !== 'open') {
    return { reason: 'laco-fechado', detail: `o laço ${loop} não está aberto (status ${JSON.stringify(base.status)}); abra um laço com gate-open` };
  }
  const voz = nomeDaVoz(entry);
  if (pendentesDoCiclo(base).some((v) => nomeDaVoz(v) === voz)) {
    return {
      reason: 'voz-repetida',
      detail: `${voz || '(revisor anônimo)'} já votou no ciclo ${cycles.length + 1} do laço ${loop}; cada voz vota uma vez por ciclo`,
    };
  }
  return null;
}

/**
 * Registra o veredito de UM revisor no ledger e devolve `{ ledger, result }`.
 *
 * Com `expect > 1` (dois revisores num `parallel_group`, por exemplo), os
 * vereditos se acumulam em `pending` e a decisão só sai quando todos chegam —
 * é o que impede que o APPROVE do revisor A, chegando primeiro, faça o pipeline
 * andar antes do REJECT do revisor B.
 *
 * O `expect` de um ciclo só sobe: vale o maior que qualquer voz do ciclo
 * declarou. A reabertura por código vota antes de o runner saber quantos
 * votantes LLM vão conferir o resto, e uma voz que declara menos não fecha o
 * ciclo por cima de quem declarou mais.
 *
 * `faltamConfirmacoes` (lista que o cartório calcula depois de registrar a tabela
 * desta voz: citações do ciclo abaixo das N confirmações exigidas) impede o ciclo
 * de fechar aprovado: ele fica aberto, espera mais uma voz e aceita o voto que
 * falta. Medido na contestação de 24/09/2026 (motor 0.9.49): no gate final, a
 * reabertura contestou a OJ 233 (`fonte_mudou`, o que zera as confirmações), o
 * votante a reconfirmou, as duas vozes do `--expect 2` fecharam o laço aprovado
 * com a OJ 233 em uma confirmação, `citacoes-pendentes` respondeu
 * `faltam-confirmacoes` e o voto do segundo votante foi recusado (`laco-aprovado`);
 * o chefe abriu outro laço e refez a reabertura inteira.
 */
function applyVerdict(ledger, entry, options) {
  const base = ledger && typeof ledger === 'object' ? ledger : openReview({});
  const opts = options && typeof options === 'object' ? options : {};
  const cycles = Array.isArray(base.cycles) ? base.cycles : [];
  const cycle = cycles.length + 1;
  const recusa = recusaDeVeredito(base, entry);
  if (recusa) {
    return {
      ledger: base,
      result: { action: REVIEW_ACTIONS.REFUSE, ...recusa, cycle, loop: base.loop, target: base.target, status: base.status },
    };
  }
  const pending = pendentesDoCiclo(base);
  const pedido = Number.isInteger(opts.expect) && opts.expect > 0 ? opts.expect : 1;
  const declarado = pending.length && base.pending && Number.isInteger(base.pending.expect) ? base.pending.expect : 1;
  const expect = Math.max(pedido, declarado);
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
    // Só os bloqueantes contam para a não-convergência: um ajuste de forma que
    // o redator ainda não aplicou não é motivo para escalar ao humano.
    fixes: c && c.decision && Array.isArray(c.decision.bloqueantes)
      ? c.decision.bloqueantes
      : c && c.decision && Array.isArray(c.decision.fixes) ? c.decision.fixes : [],
  }));
  const decision = decideReview({ verdicts, history, maxCycles: base.maxCycles });
  const faltam = Array.isArray(opts.faltamConfirmacoes) ? opts.faltamConfirmacoes : [];
  if (decision.action === REVIEW_ACTIONS.ADVANCE && faltam.length) {
    const proximo = verdicts.length + 1;
    return {
      ledger: { ...base, cycles, status: 'open', pending: { cycle, expect: proximo, verdicts } },
      result: {
        action: REVIEW_ACTIONS.AWAIT,
        reason: 'faltam-confirmacoes',
        cycle,
        expect: proximo,
        received: verdicts.length,
        faltam_confirmacoes: faltam,
        loop: base.loop,
        target: base.target,
        detail: `${faltam.length} citação(ões) do ciclo abaixo das confirmações exigidas (${faltam.map((f) => f.title).join('; ')}): o ciclo segue aberto e espera mais um votante, com essa lista, no mesmo laço`,
      },
    };
  }
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

/** O que o profissional pode decidir num laço escalado. */
const DECISOES_DE_ESCALADA = Object.freeze(['corrigir', 'seguir']);

/**
 * Registra a decisão do profissional num laço ESCALADO e devolve `{ ledger, result }`.
 *
 * Medido em 24/09/2026 (apelação criminal, defeito 25): a persuasão escalou no teto de 2
 * rodadas, o profissional mandou corrigir, e a correção entrou na peça sem conferência
 * nenhuma; o laço ficou `escalated` e a conclusão foi palavra do agente. A decisão agora é
 * gravada no ledger, e o laço só fecha por veredito:
 *   - `corrigir`: o laço reabre com UM ciclo a mais, o da conferência da correção. APPROVE
 *     fecha aprovado; REJECT escala de novo (o teto é o ciclo da conferência) e nunca abre
 *     rodada extra. O redator aplica os bloqueantes da escalada, e uma voz confere.
 *   - `seguir`: a versão atual segue com os bloqueantes como ressalvas anotadas; o laço fecha
 *     `aceito-com-ressalvas`, com as ressalvas no ledger para o relatório.
 * Fora de laço escalado, recusa: decisão de profissional não aprova laço aberto.
 */
function resolveEscalation(ledger, decisao, options) {
  const base = ledger && typeof ledger === 'object' ? ledger : openReview({});
  const opts = options && typeof options === 'object' ? options : {};
  const cycles = Array.isArray(base.cycles) ? base.cycles : [];
  const loop = typeof base.loop === 'string' && base.loop ? base.loop : '(sem nome)';
  const recusa = (reason, detail) => ({
    ledger: base,
    result: { action: REVIEW_ACTIONS.REFUSE, reason, detail, loop: base.loop, target: base.target, status: base.status },
  });
  if (base.status !== 'escalated') {
    return recusa('laco-nao-escalado', `o laço ${loop} está ${JSON.stringify(base.status)}; a decisão do profissional só se registra em laço escalado`);
  }
  if (!DECISOES_DE_ESCALADA.includes(decisao)) {
    return recusa('decisao-invalida', `decisão ${JSON.stringify(decisao)} desconhecida: use ${DECISOES_DE_ESCALADA.join(' ou ')}`);
  }
  const ultima = cycles.length ? cycles[cycles.length - 1].decision || {} : {};
  const pendentes = Array.isArray(ultima.bloqueantes) && ultima.bloqueantes.length
    ? ultima.bloqueantes
    : Array.isArray(ultima.fixes) ? ultima.fixes : [];
  const resolucao = {
    decisao,
    por: typeof opts.por === 'string' && opts.por.trim() ? opts.por.trim() : 'profissional',
    ciclo_escalado: cycles.length,
    motivo_da_escalada: ultima.reason || null,
    pendentes,
  };
  if (decisao === 'seguir') {
    return {
      ledger: { ...base, status: 'aceito-com-ressalvas', resolucao },
      result: {
        action: REVIEW_ACTIONS.ADVANCE,
        reason: 'aceito-com-ressalvas',
        detail: `o profissional decidiu seguir com a versão atual; ${pendentes.length} pendência(s) viram ressalva anotada no relatório`,
        ressalvas: pendentes,
        loop: base.loop,
        target: base.target,
      },
    };
  }
  const maxCycles = cycles.length + 1;
  return {
    ledger: { ...base, status: 'open', maxCycles, pending: null, resolucao },
    result: {
      action: REVIEW_ACTIONS.REVISE,
      reason: 'conferir-correcao',
      nextCycle: maxCycles,
      maxCycles,
      fixes: pendentes,
      detail: `o profissional mandou corrigir: o redator aplica os ${pendentes.length} bloqueante(s), e a correção só entra com o veredito da conferência no ciclo ${maxCycles} (REJECT ali escala de novo)`,
      loop: base.loop,
      target: base.target,
    },
  };
}

/**
 * Laço que ainda impede a entrega: escalado sem decisão registrada, ou reaberto pela decisão
 * `corrigir` e ainda sem o veredito da conferência. `null` quando o laço não impede.
 */
function lacoPendenteDeConclusao(ledger) {
  if (!ledger || typeof ledger !== 'object') return null;
  const loop = typeof ledger.loop === 'string' && ledger.loop ? ledger.loop : '(sem nome)';
  if (ledger.status === 'escalated') {
    return { reason: 'laco-escalado-sem-decisao', detail: `o laço ${loop} escalou ao profissional e a decisão dele não está no ledger (gate-decisao --decisao corrigir|seguir)` };
  }
  if (ledger.status === 'open' && ledger.resolucao && ledger.resolucao.decisao === 'corrigir') {
    return { reason: 'correcao-sem-conferencia', detail: `o profissional mandou corrigir no laço ${loop}, e a correção ainda não tem o veredito da conferência (gate-verdict no ciclo ${ledger.maxCycles})` };
  }
  return null;
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
      detail: 'ciclo incompleto: refaça os vereditos que faltam',
    };
  }
  const cycles = Array.isArray(ledger.cycles) ? ledger.cycles : [];
  const last = cycles[cycles.length - 1];
  // Depois da decisão do profissional, a última decisão do ciclo é a escalada que ele já
  // resolveu: a retomada responde pela resolução, não pela escalada.
  const resolucao = ledger.resolucao && typeof ledger.resolucao === 'object' ? ledger.resolucao : null;
  if (resolucao && ledger.status === 'aceito-com-ressalvas') {
    return { action: REVIEW_ACTIONS.ADVANCE, reason: 'aceito-com-ressalvas', ressalvas: resolucao.pendentes || [], loop, target, detail: 'o profissional decidiu seguir com ressalvas anotadas' };
  }
  if (resolucao && resolucao.decisao === 'corrigir' && ledger.status === 'open' && cycles.length === resolucao.ciclo_escalado) {
    return { action: REVIEW_ACTIONS.REVISE, reason: 'conferir-correcao', nextCycle: ledger.maxCycles, fixes: resolucao.pendentes || [], loop, target, detail: 'correção mandada pelo profissional, à espera do veredito da conferência' };
  }
  if (!last || !last.decision) {
    return { action: 'none', reason: 'sem-ciclos', loop, target, detail: 'loop aberto, nenhum ciclo fechado ainda' };
  }
  return { ...last.decision, loop, target, resumedFrom: last.cycle };
}
// <<< review-loop:end

export {
  REVIEW_ACTIONS,
  recusaDeVeredito,
  DEFAULT_MAX_REVIEW_CYCLES,
  GRAVIDADES,
  GRAVIDADE_PADRAO,
  gravidadeDoFix,
  ehBloqueante,
  normalizeFix,
  combineVerdicts,
  repeatedFixes,
  decideReview,
  openReview,
  applyVerdict,
  resumeReview,
  DECISOES_DE_ESCALADA,
  resolveEscalation,
  lacoPendenteDeConclusao,
};
