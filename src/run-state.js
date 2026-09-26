// Estado DURÁVEL da execução de um squad — o que sobrevive à sessão cair.
//
// O `state.json` não serve para isto por dois motivos: o contrato dele é
// fechado (`additionalProperties: false`, lido pelo dashboard) e ele é APAGADO
// no cleanup pós-conclusão. Mesmo raciocínio que pôs o ledger do loop de
// revisão em `review-state.json`, ao lado — e não dentro — do `state.json`.
//
// O dado crítico é o `run_id`. Hoje ele nasce na inicialização e vive só na
// memória da sessão; se a sessão cai, o runner não sabe mais em que pasta
// estava gravando, cria um run novo e a pasta anterior fica órfã — com os
// artefatos já produzidos, que ninguém mais lê. O próprio runner admitia o
// buraco ao mandar procurar o "run_id mais recente sem state.json, se
// identificável". Com este ledger não há adivinhação: o id está em disco.
//
// Módulo PURO: sem I/O, sem data/hora, sem processo. A persistência é feita por
// `scripts/squad-state.mjs`.
//
// SINCRONIA: o bloco entre os marcadores abaixo é copiado VERBATIM para
// `scripts/squad-state.mjs` e `templates/scripts/squad-state.mjs`. O script
// distribuído ao usuário é auto-contido por contrato — o projeto do usuário não
// tem `src/` —, então a cópia é inevitável; o que não pode é divergir em
// silêncio. `tests/run-state.test.js` falha se as três cópias divergirem.

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

/** Modos de reabertura: ajuste de forma (sem revisor) ou ciclo de revisão (mérito, citação). */
const MODOS_DE_REABERTURA = Object.freeze(['ajustes', 'revisao']);

/**
 * Reabre um run CONCLUÍDO para uma alteração pedida depois da entrega. O run
 * volta a `running`, no step de redação, com os checkpoints preservados: a
 * alteração é uma revisão a mais do mesmo run, pelos mesmos agentes e gates,
 * nunca edição de arquivo. Cada reabertura fica no histórico (`reaberturas`),
 * com o pedido literal do profissional, o modo e a versão entregue antes.
 * Só `completed` reabre: `failed` recomeça, `running` não está fechado.
 */
function reabrirRun(ledger, { modo, pedido, agora, versaoAnterior, stepLabel } = {}) {
  if (!ledger || typeof ledger !== 'object' || !ledger.runId) throw new Error('não há run para reabrir');
  if (ledger.status !== 'completed') {
    throw new Error(`só um run concluído reabre; este está "${ledger.status}"${ledger.status === 'running' ? ' (ainda aberto: use retomar)' : ' (recomece com um run novo)'}`);
  }
  if (!MODOS_DE_REABERTURA.includes(modo)) throw new Error(`modo de reabertura inválido: "${modo}" (use ${MODOS_DE_REABERTURA.join(' ou ')})`);
  if (typeof pedido !== 'string' || !pedido.trim()) throw new Error('o pedido do profissional é obrigatório: é ele que vira os fixes do redator');
  const entrada = {
    numero: (Array.isArray(ledger.reaberturas) ? ledger.reaberturas.length : 0) + 1,
    modo,
    pedido: pedido.trim(),
    ...(typeof agora === 'string' && agora ? { em: agora } : {}),
    ...(ledger.endedAt ? { entregue_em: ledger.endedAt } : {}),
    ...(typeof versaoAnterior === 'string' && versaoAnterior ? { versao_anterior: versaoAnterior } : {}),
  };
  const { endedAt, ...semFim } = ledger;
  void endedAt;
  return {
    ...semFim,
    status: 'running',
    step: { ...(ledger.step || { current: 0, total: 0 }), label: typeof stepLabel === 'string' ? stepLabel : `reaberto (${modo})` },
    reaberturas: [...(Array.isArray(ledger.reaberturas) ? ledger.reaberturas : []), entrada],
  };
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
    return {
      action: 'closed', runId, squad, status, step: step || null,
      ...(ledger.endedAt ? { endedAt: ledger.endedAt } : {}),
      // Run fechado com entrega pode ser REABERTO para alteração (nunca editado):
      // o chefe lê aqui que a rota existe e quantas vezes já foi usada.
      reabriveis: status === 'completed',
      reaberturas: Array.isArray(ledger.reaberturas) ? ledger.reaberturas : [],
    };
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
    // Run reaberto depois da entrega: a retomada sabe que está numa revisão da
    // entrega, qual foi o pedido e em que modo, para reapresentar ao profissional.
    ...(Array.isArray(ledger.reaberturas) && ledger.reaberturas.length
      ? { reaberto: true, reabertura: ledger.reaberturas[ledger.reaberturas.length - 1], reaberturas: ledger.reaberturas }
      : {}),
    // Ritmo escolhido na parada intake e perfil do projeto na abertura: a
    // retomada lê daqui em vez de reperguntar.
    ...(typeof ledger.ritmo === 'string' ? { ritmo: ledger.ritmo } : {}),
    ...(ledger.ritmo_ajustes && typeof ledger.ritmo_ajustes === 'object' && Object.keys(ledger.ritmo_ajustes).length ? { ritmo_ajustes: ledger.ritmo_ajustes } : {}),
    ...(typeof ledger.perfil === 'string' ? { perfil: ledger.perfil } : {}),
  };
}
// <<< run-state:end

export { RUN_STATUSES, MODOS_DE_REABERTURA, abrirRun, avancarRun, registrarCheckpoint, fecharRun, retomarRun, reabrirRun };
