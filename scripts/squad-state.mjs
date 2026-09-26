#!/usr/bin/env node
// Escritor DETERMINÍSTICO do state.json de um squad — substitui a escrita à mão
// do JSON pelo Pipeline Runner. Garante timestamps reais, transições atômicas
// (write tmp + rename) e saída sempre válida contra o contrato.
// Contrato: _legalsquad/core/state.schema.json | Tipos: dashboard/src/types/state.ts
//
//   node scripts/squad-state.mjs init       <squad-dir> --total <N>
//   node scripts/squad-state.mjs ritmo      <squad-dir> [--set rapido|equilibrado|completo] [--ciclos N] [--verificadores N] [--persuasao sim|nao] [--red-team sim|nao]
//   node scripts/squad-state.mjs step       <squad-dir> --current <K> --label "<L>" --working <id> [--working <id> ...] [--from <prevId>] [--message "<m>"] [--activity "<a>"]
//   node scripts/squad-state.mjs checkpoint <squad-dir> --agent <id>
//   node scripts/squad-state.mjs complete   <squad-dir>
//   node scripts/squad-state.mjs fail       <squad-dir>
//
// Loop de revisão (cartório determinístico — grava review-state.json ao lado):
//   node scripts/squad-state.mjs review-open    <squad-dir> --loop <step-revisor> --target <step-on-reject> [--max <N>]
//   node scripts/squad-state.mjs review-verdict <squad-dir> --reviewer <id> --verdict APPROVE|REJECT [--fix "<gravidade>: ..."]... [--ajuste "..."]... [--citacoes <json>] [--expect <N>] [--confirmacoes <N>]
//   node scripts/squad-state.mjs review-status  <squad-dir>
//   node scripts/squad-state.mjs gate-decisao   <squad-dir> --gate <gate> --decisao corrigir|seguir [--por <quem decidiu>]
// `gate-decisao` grava a decisão do profissional num laço escalado: `corrigir` reabre com um
// ciclo só, o da conferência da correção; `seguir` fecha com as pendências como ressalvas.
// Os três imprimem a DECISÃO em JSON no stdout. `review-verdict`/`review-status`
// saem com código 3 quando a decisão é `escalate` — escalação não pode passar
// despercebida por quem só olha o exit code. `review-verdict` sai com código 1 e
// `action: refuse` quando o laço já fechou (aprovado ou escalado) ou quando a
// mesma voz vota duas vezes no ciclo; nada é gravado nesse caso.
//
// Citações verificadas (o mesmo review-state.json, chave `citacoes`): o veredito
// de uma citação vale por citação, não por ciclo. `--citacoes <json>` registra a
// tabela do verificador; `citacoes-pendentes --peca <arquivo>` diz o que ainda
// falta conferir nesta versão da peça e o que já foi conferido neste run:
//   node scripts/squad-state.mjs citacoes-pendentes <squad-dir> --peca <caminho real da minuta> [--confirmacoes N] [--final]
//   node scripts/squad-state.mjs citacoes-status    <squad-dir>
//
// Manifesto da peça final, gerado do cartório (nunca escrito à mão): uma entrada por
// citação da peça com fonte, evidência e verificadores, o SHA-256 da peça e as
// pendências do profissional lidas dos marcadores de dado; valida contra o schema e o
// hook antes de deixar gravado, e recusa citação da peça sem entrada no cartório:
//   node scripts/squad-state.mjs manifesto-final <squad-dir> --peca <peça final> [--pendencias <json>] [--por <id do conferente>]
//
// Carimbo do Gate de Sobrevivência ao Resumo (4.6): o hash da síntese e dos pedidos da versão que
// a persuasão aprovou; o `manifesto-final` avisa quando a final mudou uma das duas depois disso:
//   node scripts/squad-state.mjs persuasao-carimbo <squad-dir> --peca <minuta aprovada>
//
// Verificação da Meta (consenso por critério das N avaliações do avaliador-squad;
// o mínimo de avaliações é o `meta_verifiers` do squad, que o ritmo não rebaixa):
//   node scripts/squad-state.mjs meta-consenso <squad-dir> --avaliacao <arq> [--avaliacao <arq> ...] [--manifesto <final>.citation-gate.json] [--formato-refeito]
//   node scripts/squad-state.mjs steps-posteriores <squad-dir>   (os steps de agente depois da meta, para os avaliadores)
//
// <squad-dir> é a pasta do squad (contém squad.yaml + squad-party.csv); o
// state.json é gravado lá. Rode a partir da raiz do workspace.
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  if (!existsSync(p)) die('state.json não existe: rode `init` primeiro');
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
  // REJECT dirigido: algum fix do revisor cita a skill pelo id. Sem isso, toda
  // rejeição do ciclo era creditada a toda skill do squad, e a skill da própria
  // peça saía da shortlist do Arquiteto com "7 rejeições" que eram da minuta.
  const fixes = Array.isArray(evento.fixes) ? evento.fixes.filter((f) => typeof f === 'string') : [];
  const citaSkill = (id) => {
    const escapado = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapado}([^A-Za-z0-9_-]|$)`, 'i');
    return fixes.some((f) => re.test(f));
  };
  const base = {
    data: evento.data || new Date().toISOString().slice(0, 10),
    squad: String(evento.squad || ''),
    gate: String(evento.gate || 'review'),
    verdict: String(evento.verdict || ''),
    ...(evento.reviewer ? { reviewer: String(evento.reviewer) } : {}),
  };

  let gravados = 0;
  for (const id of skills) {
    const linha = `${JSON.stringify(base.verdict === 'REJECT' ? { ...base, dirigida: citaSkill(id) } : base)}\n`;
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
  // Só a rejeição dirigida (fix que cita a skill) diz algo sobre a skill; a
  // outra é do ciclo. É a dirigida que a Phase D.5 pesa.
  const dirigidas = rejeicoes.filter((e) => e.dirigida === true);
  const squads = new Set(eventos.map((e) => e.squad).filter(Boolean));
  return {
    ciclos: eventos.length,
    aprovacoes: eventos.filter((e) => e.verdict === 'APPROVE').length,
    rejeicoes: rejeicoes.length,
    rejeicoes_dirigidas: dirigidas.length,
    squads_distintos: squads.size,
    ultimo_uso: eventos[eventos.length - 1].data || null,
    ultima_rejeicao: rejeicoes.length ? rejeicoes[rejeicoes.length - 1].data || null : null,
    ultima_rejeicao_dirigida: dirigidas.length ? dirigidas[dirigidas.length - 1].data || null : null,
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
  die(`não consegui um run_id livre a partir de ${base}: 100 colisões seguidas`);
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

// Ritmo do run e perfil do projeto: quanto de verificação por LLM cada run
// paga. Canônico em `src/perfil.js` (bloco `perfil`, sincronizado por
// `sync-blocos`); aqui o `squad-state` só lê, e é ele quem rebaixa `--max`,
// `--expect` e `--confirmacoes` ao teto, com aviso no stderr, para o chefe não
// precisar lembrar de nada.
// >>> perfil:begin
const PERFIL_ARQUIVO = ['_legalsquad', '_memory', 'perfil.json'];
const PERFIL_PADRAO = 'completo';
/** Do mais rigoroso ao mais rápido; combinar dois ritmos é ficar com o de menor posto. */
const RITMOS = ['completo', 'equilibrado', 'rapido'];
/** Nomes que o profissional usa e o código aceita como sinônimos. */
const RITMO_ALIASES = { rigoroso: 'completo', padrao: 'equilibrado', light: 'rapido', leve: 'rapido' };
/**
 * Os ritmos: quanto de verificação por LLM o run paga. `null` num botão é "o que
 * o squad declarar"; número é teto; `persuasao`/`red_team` em false desligam o
 * gate e a oferta. O Citation Gate nunca cai abaixo de 1 verificador: a sanção
 * por citação inventada é real, e os hooks determinísticos não têm ritmo.
 * `citation_verifiers` é o teto de verificadores POR GATE (citações e persuasão).
 * Os avaliadores da Verificação da Meta não têm botão aqui: são sempre os que o
 * squad declara em `meta_verifiers`. Medido em 24/09/2026: o equilibrado rebaixava
 * `meta_verifiers: 3` para 1, e a mesma evidência saiu punida num run e aceita em
 * outro; o `squad-state meta-consenso` recusa consenso com menos avaliações.
 */
const PERFIS = {
  completo: { citation_verifiers: null, max_review_cycles: null, persuasao: true, red_team: true },
  equilibrado: { citation_verifiers: 1, max_review_cycles: 2, persuasao: true, red_team: false },
  rapido: { citation_verifiers: 1, max_review_cycles: 1, persuasao: false, red_team: false },
};

/** O nome canônico de um ritmo ("Rápido", "light", "rigoroso"), ou null. */
function nomeDeRitmo(valor) {
  const n = String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (PERFIS[n]) return n;
  return RITMO_ALIASES[n] || null;
}

/** O perfil do projeto: nome, botões e de onde veio (`arquivo` ou `padrao`). */
function lerPerfil(raiz) {
  const caminho = join(raiz, ...PERFIL_ARQUIVO);
  let dados;
  try {
    dados = JSON.parse(readFileSync(caminho, 'utf-8'));
  } catch {
    return { nome: PERFIL_PADRAO, gates: { ...PERFIS[PERFIL_PADRAO] }, origem: 'padrao', caminho, ritmo: null };
  }
  const nome = (dados && nomeDeRitmo(dados.perfil)) || PERFIL_PADRAO;
  // Os botões do arquivo valem por cima do perfil nomeado, só os conhecidos e só
  // com valor do tipo certo: um número onde se espera booleano é ruído, não regra.
  const gates = { ...PERFIS[nome] };
  const extra = dados && dados.gates && typeof dados.gates === 'object' ? dados.gates : {};
  for (const chave of Object.keys(gates)) {
    if (!(chave in extra)) continue;
    const valor = extra[chave];
    if (typeof gates[chave] === 'boolean') {
      if (typeof valor === 'boolean') gates[chave] = valor;
    } else if (valor === null || (Number.isInteger(valor) && valor >= 1)) {
      gates[chave] = valor;
    }
  }
  return { nome, gates, origem: 'arquivo', caminho, ritmo: null };
}

/** O mais restrito de dois conjuntos de botões: número menor, `null` cede, booleano E. */
function combinarGates(a, b) {
  const gates = { ...a };
  for (const chave of Object.keys(gates)) {
    if (!b || !(chave in b)) continue;
    const va = a[chave];
    const vb = b[chave];
    if (typeof va === 'boolean' || typeof vb === 'boolean') gates[chave] = Boolean(va) && Boolean(vb);
    else if (va === null) gates[chave] = vb;
    else if (vb === null) gates[chave] = va;
    else gates[chave] = Math.min(va, vb);
  }
  return gates;
}

/**
 * Botões que o profissional ajusta por run, por cima do ritmo ("equilibrado, mas
 * com 3 ciclos"): inteiro >= 1 nos numéricos, booleano nos demais; o resto é ruído.
 */
function ajustesValidos(ajustes) {
  const saida = {};
  if (!ajustes || typeof ajustes !== 'object') return saida;
  for (const chave of Object.keys(PERFIS.completo)) {
    if (!(chave in ajustes)) continue;
    const valor = ajustes[chave];
    if (typeof PERFIS.rapido[chave] === 'boolean') {
      if (typeof valor === 'boolean') saida[chave] = valor;
    } else if (Number.isInteger(valor) && valor >= 1) {
      saida[chave] = valor;
    }
  }
  return saida;
}

/**
 * O perfil que vale num run: o do projeto combinado com o ritmo escolhido na
 * parada intake e com os ajustes por botão. O projeto é o teto: um projeto
 * travado em rápido (curso) não sobe por escolha de um run. Sem ritmo nem
 * ajuste, é o perfil do projeto.
 */
function perfilEfetivo(raiz, ritmo, ajustes) {
  const projeto = lerPerfil(raiz);
  const nome = nomeDeRitmo(ritmo);
  const validos = ajustesValidos(ajustes);
  if (!nome && !Object.keys(validos).length) return projeto;
  const preset = { ...(nome ? PERFIS[nome] : projeto.gates), ...validos };
  const efetivo = nome && RITMOS.indexOf(nome) >= RITMOS.indexOf(projeto.nome) ? nome : projeto.nome;
  return { ...projeto, nome: efetivo, gates: combinarGates(projeto.gates, preset), ritmo: nome, ajustes: validos };
}

/**
 * Rebaixa um número pedido ao teto do perfil. Devolve `{ valor, teto, rebaixado }`:
 * `rebaixado` é o aviso que o chamador imprime, para o rebaixamento nunca ser mudo.
 */
function aplicarTeto(perfil, botao, pedido) {
  const teto = perfil && perfil.gates ? perfil.gates[botao] : null;
  if (!Number.isInteger(teto) || !Number.isInteger(pedido) || pedido <= teto) return { valor: pedido, teto, rebaixado: false };
  return { valor: teto, teto, rebaixado: true };
}

/** Uma linha para o chefe dizer o que o run paga, em linguagem de gente. */
function descreverPerfil(perfil) {
  if (!perfil || perfil.nome === PERFIL_PADRAO) return 'ritmo completo: verificadores, persuasão e red-team como cada squad declara';
  const g = perfil.gates;
  const partes = [`${g.citation_verifiers ?? 'N'} verificador(es) por gate`, 'avaliadores da meta como o squad declara', `${g.max_review_cycles ?? 'N'} ciclo(s) de revisão`];
  partes.push(g.persuasao === false ? 'sem gate de persuasão' : 'persuasão em uma passada');
  if (g.red_team === false) partes.push('sem red-team');
  return `ritmo ${perfil.nome}: ${partes.join(', ')}`;
}
// <<< perfil:end

// Consenso da Verificação da Meta: as N avaliações do `avaliador-squad`
// combinadas por critério, em código. Canônico em `src/meta-consenso.js` (bloco
// `meta-consenso`, sincronizado por `sync-blocos`); o comando `meta-consenso`
// abaixo só lê os arquivos. O número de avaliadores vem do squad, nunca do ritmo.
// >>> meta-consenso:begin
/** A escala da rubrica: não muda (repontuar a série antiga seria obrigatório). */
const META_PONTOS = { ATENDE: 2, PARCIAL: 1, NAO: 0 };
const META_NIVEL_POR_PONTOS = ['NAO', 'PARCIAL', 'ATENDE'];
/** De onde vem a perda: da peça, de dado que não está na pasta do caso, ou de algo fora do alcance da meta. */
const META_CLASSES = ['peca', 'dado-ausente', 'fora-do-alcance'];
/** Estado de cada exigência do critério; `posterior` é artefato de step depois da meta, e não pune. */
const META_STATUS = ['atendida', 'falta', 'posterior'];
/** A régua do dono quando o squad não declara `meta_limiar`. */
const META_LIMIAR_PADRAO = 85;
/** As partes da regra de entrega (`meta_limiar` do squad.yaml). */
const META_LIMIAR_CHAVES = ['nao_max', 'parcial_max', 'atende_obrigatorios', 'parcial_permitidos', 'nota_min'];
/** O padrão do motor, como regra: nenhum NAO e nota mínima 85. */
const META_REGRA_PADRAO = { nao_max: 0, parcial_max: null, atende_obrigatorios: [], parcial_permitidos: null, nota_min: META_LIMIAR_PADRAO };
/**
 * Marcador de DADO (o mesmo `DATA_MARKER` de `src/pendencia.js`): o fato que depende
 * do profissional ou do cliente. Só ele sustenta uma exigência `dado-ausente`;
 * marcador de citação nunca.
 */
const META_MARCADOR_DE_DADO = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:\u2013\u2014-]|\])/;
/**
 * Exigência de conteúdo jurídico (lida sem acento e em minúsculas): nunca é dado
 * ausente. A tese, o fundamento e a citação de lei ou precedente são trabalho da
 * peça, não diligência. "Citação do réu" (o ato processual, que depende do endereço)
 * não entra: é o dado que a pasta pode não ter.
 */
const META_EXIGENCIA_JURIDICA = /\b(?:teses?|fundament\w*|citacoes|citacao\b(?! (?:do|da|dos|das|ao|a|aos|as) (?:reu|re|reus|res|parte|partes|requerid\w*|executad\w*|demandad\w*|impetrad\w*|autoridade|devedor\w*)| por edital| postal| pessoal| por oficial)|sumulas?|precedentes?|jurisprudenc\w*|temas?|repetitivos?)\b/;

/**
 * O que NÃO é dado do cliente nem do caso, lido na redação da exigência (sem acento,
 * em minúsculas): dado público, que a peça obtém sozinha, e elemento que a própria
 * peça produz. Nenhum dos dois é `dado-ausente`, nem em `falta`: a exigência em falta
 * com essa classe é reclassificada como `peca` (volta à redação, não vira pendência do
 * profissional), e a `atendida` com essa classe é recusada. `dado-ausente` fica só para
 * o que só o cliente ou o caso têm e a pasta não traz: qualificação da parte (CPF, RG,
 * e-mail, endereço), documento que só o cliente tem, fato da vida dele, decisão dele.
 *
 * Medido na reavaliação de 24/09/2026 (novo2): mandado de segurança C1 (nome do órgão de
 * representação do Município, 3 de 3), reclamação C1 (data da peça em branco, 3 de 3) e
 * despejo C3 (correção pela série do IPCA, 3 de 3) saíram `dado-ausente` e iriam ao
 * profissional, não ao redator.
 *
 * Limite: o código lê a exigência, não o mundo. A exigência escrita como o documento que
 * falta ("holerites de 03/2024 a 01/2025", "extrato do FGTS") continua `dado-ausente`;
 * escrita como a conta que depende dele ("memória das horas extras"), vira `peca`: o
 * cálculo é da peça, que marca a parte que depende do documento. "Conta" sozinha não
 * entra (conta bancária é dado do cliente); "valor" sozinho também não.
 */
const META_NAO_E_DADO_DO_CLIENTE = [
  { tipo: 'indice-oficial', padrao: /\b(?:ipca(?:-e)?|inpc|igp-?m|igp-?di|ipc-?fipe|selic|taxa referencial|indices?|correcao|correcoes|atualizacao monetaria|juros)\b/, motivo: 'índice oficial, correção e juros são dado público: a peça obtém a série e aplica' },
  { tipo: 'orgao-publico', padrao: /\b(?:orgaos? de representacao|representacao judicial|procuradori\w*|advocacia[ -]geral|defensoria publica|agu|pgfn|pge|pgm)\b/, motivo: 'o órgão de representação de ente público é dado público: a peça o nomeia' },
  { tipo: 'norma-ou-tabela', padrao: /\b(?:lei|leis|decreto|decretos|resolucao|portaria|instrucao normativa|tabelas?|salario minimo|teto)\b/, motivo: 'lei, norma e tabela oficial são dado público' },
  { tipo: 'data-ou-assinatura', padrao: /(?:^data$|\bdata da (?:peca|peticao|inicial|contestacao|impetracao|assinatura|distribuicao|protocolo)\b|\blocal e data\b|\bdata e (?:local|assinatura)\b|\bassinaturas?\b|\bfecho\b)/, motivo: 'data, assinatura e fecho são elementos que a própria peça produz' },
  { tipo: 'pedido', padrao: /\bpedidos?\b/, motivo: 'o pedido é elemento que a própria peça produz' },
  { tipo: 'calculo', padrao: /\b(?:calculos?|memoria|memorias|liquidacao|valor da causa)\b/, motivo: 'o cálculo é elemento que a própria peça produz' },
];

/**
 * Por que a exigência NÃO é dado do cliente nem do caso (dado público ou elemento da
 * peça, `META_NAO_E_DADO_DO_CLIENTE`; ou conteúdo jurídico), ou null.
 * Devolve `{ tipo, motivo }`.
 */
function metaNaoEDadoDoCliente(exigencia) {
  const t = metaSemAcento(exigencia).toLowerCase();
  if (META_EXIGENCIA_JURIDICA.test(t)) return { tipo: 'conteudo-juridico', motivo: 'exigência de conteúdo jurídico (tese, fundamento, citação, súmula, precedente, Tema) nunca é dado ausente' };
  const achado = META_NAO_E_DADO_DO_CLIENTE.find((p) => p.padrao.test(t));
  return achado ? { tipo: achado.tipo, motivo: achado.motivo } : null;
}

/** O que o avaliador declara e o código ignora: a nota e o veredito são do código, pela regra do squad. */
const META_CAMPOS_DO_CODIGO = ['limiar', 'limiar_fonte', 'nota', 'verdict'];
/**
 * A própria peça na evidência de uma exigência `posterior`: o arquivo da final ou da
 * minuta. A peça já existe quando a meta roda; o que ela traz se avalia agora.
 */
const META_ARQUIVO_DA_PECA = /[\w.-]*-(?:final|minuta)(?:-v\d+)?\.md\b/i;
/** Palavras que não distinguem uma exigência de outra na semelhança do consenso. */
const META_PALAVRAS_VAZIAS = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'com', 'por', 'pela', 'pelo', 'pelas', 'pelos', 'para', 'um', 'uma', 'que', 'se', 'ou', 'cada', 'todo', 'toda', 'todos', 'todas', 'como', 'ser', 'sua', 'seu']);
/** Fração mínima dos termos da redação menor que está na maior para duas faltas serem a mesma. */
const META_SEMELHANCA_MIN = 0.75;

function metaMarcadorNormalizado(valor) {
  return String(valor ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Os marcadores de dado listados em `pendencias_do_profissional[]` do manifesto da
 * final (`<peça>-final.md.citation-gate.json`), normalizados. Sem manifesto, `null`:
 * aí nenhuma exigência se aceita como dado ausente.
 */
function pendenciasDoManifesto(manifesto, { detalhe = false } = {}) {
  if (!manifesto || typeof manifesto !== 'object') return null;
  const lista = Array.isArray(manifesto.pendencias_do_profissional) ? manifesto.pendencias_do_profissional : [];
  const entradas = lista
    .map((p) => ({ marcador: metaMarcadorNormalizado(p && p.marcador), onde: metaMarcadorNormalizado(p && p.onde) }))
    .filter((p) => META_MARCADOR_DE_DADO.test(p.marcador));
  return detalhe ? entradas : entradas.map((p) => p.marcador);
}

/**
 * Localização lida na própria evidência, quando o avaliador não preencheu `local`: linha
 * ("linha 11", "l. 36", "l.82"), seção ("§ 1", "capítulo VII", "IV.1", "IX:" no começo,
 * "Nota técnica", "tabela"), documento ou folha ("Doc. 04", "fls. 12", "p. 2") ou arquivo
 * ("prazo-fatal.md"), e o arquivo avaliado nomeado ("na peça", "na final"). Devolve o trecho
 * que localiza, ou null. Medido em 24/09/2026 (negativação, 3 de 3 avaliadores, e contestação,
 * rodada 1): nenhum avaliador preencheu `local`, a evidência dizia "linha 11: ..." e o código
 * rebaixava cada ATENDE a PARCIAL; a nota saiu 50 com 18 votos ATENDE.
 */
const META_LOCAL_NA_EVIDENCIA = [
  /\blinhas?\s+\d+/i,
  /(?:^|[^\p{L}])ll?\.\s*\d+/iu,
  /§\s*\d+/,
  /(?:^|[^\p{L}])(?:cap[íi]tulos?|caps?\.|se[çc][ãa]o|se[çc][õo]es|t[íi]tulo|t[óo]pico|par[áa]grafo|itens|item|anexos?|tabela|quadro|nota t[ée]cnica|s[íi]ntese|pre[âa]mbulo|fecho|rodap[ée])(?![\p{L}])(?:\s+(?:[IVXL]+|\d+)(?:\.\d+)*(?![\p{L}\p{N}]))?/iu,
  /\bdocs?\.\s*(?:n[ºo°.]*\s*)?(?:\d|[A-Z]-?\d)/i,
  /(?:^|[^\p{L}])(?:e-)?fls?\.\s*\d+|\bfolhas?\s+\d+|(?:^|[^\p{L}])pp?\.\s*\d+/iu,
  /[\w.-]+\.(?:md|json|jsonl|ya?ml|txt|docx|pdf)\b/i,
  /(?:^|[\s(;,])[IVXL]+\.\d+/,
  /^\s*[IVXL]+(?:\.\d+)*\s*[:,(]/,
  /(?:^|[^\p{L}])na\s+(?:peça|final|versão final|minuta)(?![\p{L}])/iu,
];

function metaLocalDaEvidencia(evidencia) {
  const texto = metaTextoCorrido(evidencia);
  if (!texto) return null;
  // O primeiro lugar que a evidência cita, na ordem do texto (não na da lista de padrões).
  let melhor = null;
  for (const re of META_LOCAL_NA_EVIDENCIA) {
    const m = texto.match(re);
    if (m && (!melhor || m.index < melhor.index)) melhor = m;
  }
  return melhor ? melhor[0].replace(/^[^\p{L}\p{N}§]+/u, '').trim() : null;
}

/** O tipo do marcador de dado ("CONFIRMAR", "PREENCHER", "DILIGENCIA"), sem acento. */
const META_TIPO_DE_MARCADOR = /\[(?:A[ _])?(CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?=[\s:\]\u2013\u2014-])/g;
const metaTipoDeMarcador = (m) => metaSemAcento(String(m).match(/(CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)/)?.[1] || '').toUpperCase();
const META_MARCADOR_SO_TIPO = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)\]$/;

/** Os números de linha que a evidência cita ("linha 11", "l.82, 110, 130 e 184", "l. 177 a 182"). */
function metaLinhasCitadas(texto) {
  const linhas = new Set();
  for (const m of String(texto).matchAll(/(?:\blinhas?|(?:^|[^\p{L}])ll?\.)\s*(\d+(?:\s*(?:,|e|a)\s*\d+)*)/giu)) {
    const partes = m[1].split(/\s*(,|e|a)\s*/);
    let anterior = null;
    let intervalo = false;
    for (const p of partes) {
      if (p === 'a') { intervalo = true; continue; }
      if (p === ',' || p === 'e') continue;
      const n = Number(p);
      if (intervalo && anterior !== null && n > anterior && n - anterior <= 60) for (let i = anterior; i <= n; i += 1) linhas.add(i);
      linhas.add(n);
      anterior = n;
      intervalo = false;
    }
  }
  return linhas;
}

/** As seções em romano que a evidência cita ("capítulo VII", "VII, final", "VIII.3:", "Cap. X"). */
function metaSecoesCitadas(texto) {
  const secoes = new Set();
  const t = String(texto);
  for (const m of t.matchAll(/(?:cap[íi]tulos?|caps?\.|se[çc][ãa]o)\s+([IVXL]+)\b/giu)) secoes.add(m[1].toUpperCase());
  for (const m of t.matchAll(/(?:^|[\s(;,])([IVXL]+)\.\d+/g)) secoes.add(m[1]);
  const inicio = t.match(/^\s*([IVXL]+)(?:\.\d+)*\s*[:,(]/);
  if (inicio) secoes.add(inicio[1]);
  return secoes;
}

/**
 * O marcador de `pendencias_do_profissional[]` que a evidência mostra, quando o avaliador não
 * preencheu `pendencia`: o marcador literal inteiro na evidência; ou o tipo do marcador
 * ("[CONFIRMAR]", "[DILIGÊNCIA: ...]") na evidência e, no manifesto, uma entrada do mesmo tipo
 * no mesmo lugar (a linha que a evidência cita, ou a seção em romano). Entrada só com o tipo
 * ("[CONFIRMAR]" sozinho, nota ao advogado) não conta: não diz qual dado. Entre várias, fica a
 * que divide mais termos com a exigência. Devolve `{ marcador, como }` ou null. Medido em
 * 24/09/2026 (negativação): "linha 11: ... união estável, RG, CPF, e-mail e CEP marcados
 * [CONFIRMAR] e listados em pendencias_do_profissional[]", e as cinco entradas da linha 11
 * estavam no manifesto; sem `pendencia`, o código recusava o dado ausente.
 */
function metaPendenciaDaEvidencia(e, entradas) {
  const lista = (Array.isArray(entradas) ? entradas : [])
    .map((p) => (typeof p === 'string' ? { marcador: p, onde: '' } : p))
    .filter((p) => p && p.marcador && !META_MARCADOR_SO_TIPO.test(p.marcador));
  if (!lista.length) return null;
  const evidencia = metaMarcadorNormalizado(e.evidencia);
  const literal = lista.find((p) => evidencia.includes(p.marcador));
  if (literal) return { marcador: literal.marcador, como: 'marcador literal na evidência' };
  const tipos = new Set([...evidencia.matchAll(META_TIPO_DE_MARCADOR)].map((m) => metaTipoDeMarcador(m[0])));
  if (!tipos.size) return null;
  const linhas = metaLinhasCitadas(evidencia);
  const secoes = metaSecoesCitadas(evidencia);
  const alvo = metaTermos(`${e.exigencia} ${evidencia}`);
  let melhor = null;
  for (const p of lista) {
    if (!tipos.has(metaTipoDeMarcador(p.marcador))) continue;
    const linha = Number(String(p.onde).match(/\blinha\s+(\d+)/i)?.[1]);
    const secao = String(p.onde).match(/^\s*([IVXL]+)\./)?.[1];
    const como = linha && linhas.has(linha) ? `mesmo tipo de marcador na linha ${linha}` : secao && secoes.has(secao) ? `mesmo tipo de marcador na seção ${secao}` : null;
    if (!como) continue;
    let comum = 0;
    for (const t of metaTermos(p.marcador)) if (alvo.has(t)) comum += 1;
    if (!melhor || comum > melhor.comum) melhor = { marcador: p.marcador, como, comum };
  }
  return melhor && { marcador: melhor.marcador, como: melhor.como };
}

/**
 * Os campos que faltam numa exigência de voto ATENDE para ela valer, quando não dá para
 * derivá-los: `status`; na atendida, `evidencia` e `local`; no dado ausente atendido que é dado
 * do cliente, `pendencia`. É falha de FORMATO do avaliador, não da peça: o consenso não a
 * transforma em nota; o comando devolve `refazer-avaliacao`.
 */
function metaCamposFaltantes(e) {
  if (!e.status) return ['status'];
  if (e.status !== 'atendida') return [];
  const campos = [];
  if (!e.evidencia) campos.push('evidencia');
  if (!e.local) campos.push('local');
  if (e.classe === 'dado-ausente' && !e.pendencia && !metaNaoEDadoDoCliente(e.exigencia)) campos.push('pendencia');
  return campos;
}

/**
 * Por que a exigência `atendida` com `classe: dado-ausente` NÃO se aceita, ou null
 * quando se aceita: exigência de conteúdo jurídico, de dado público ou de elemento da
 * própria peça (`metaNaoEDadoDoCliente`), sem o marcador de dado que a peça traz, ou
 * marcador fora de `pendencias_do_profissional[]` (ou sem manifesto).
 */
/**
 * Os marcadores de dado que `pendencia` traz, um ou vários ("[PREENCHER: RG] e [PREENCHER: CPF]"),
 * normalizados. Medido em 26/09/2026 (despejo, motor 0.9.54): a exigência de qualificação do réu
 * pedia RG e CPF, o avaliador escreveu os dois marcadores, e o código lia a frase inteira como um
 * marcador só, que não estava no manifesto; a avaliação virou `apresentar-falhas`.
 */
const META_MARCADORES_NA_PENDENCIA = /\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:\u2013\u2014-][^\]]*)?\]/g;
function metaMarcadoresDaPendencia(valor) {
  const texto = metaMarcadorNormalizado(valor);
  return [...new Set((texto.match(META_MARCADORES_NA_PENDENCIA) || []).map(metaMarcadorNormalizado))];
}

function motivoDadoAusenteRecusado(e, pendencias) {
  const naoEDado = metaNaoEDadoDoCliente(e.exigencia);
  if (naoEDado) return naoEDado.motivo;
  const marcadores = metaMarcadoresDaPendencia(e.pendencia);
  if (!marcadores.length) return 'sem o marcador de dado ([CONFIRMAR], [PREENCHER], [DILIGÊNCIA]) com que a peça marca o dado como ausente';
  if (!Array.isArray(pendencias)) return 'sem o manifesto da final para conferir `pendencias_do_profissional[]`';
  // Vários marcadores numa exigência valem todos juntos: cada um tem de estar na lista.
  const fora = marcadores.filter((m) => !pendencias.includes(m));
  if (fora.length) return `${fora.join(', ')} não ${fora.length > 1 ? 'estão' : 'está'} em \`pendencias_do_profissional[]\` do manifesto: a diligência não foi listada`;
  return null;
}

/**
 * Os steps posteriores à meta, pelo `pipeline.yaml`: os que vêm depois do step que
 * declara `meta_verifiers` (sem ele, depois do step que grava a `*-final.md`), na
 * ordem do pipeline. `null` quando o pipeline não tem `steps:` legível (aí a
 * exigência `posterior` só se aceita citando algum step); `[]` quando não há step
 * depois da meta (aí nenhuma se aceita). Com `detalhe`, cada step vem como
 * `{ id, tipo, checkpoint, saidas }`: o `type` do step, se é parada humana (`type:
 * checkpoint` ou listado em `checkpoints:` do pipeline) e os arquivos que ele grava.
 */
function stepsPosterioresDoPipeline(pipelineYaml, { detalhe = false } = {}) {
  const linhas = String(pipelineYaml ?? '').split(/\r?\n/);
  const inicio = linhas.findIndex((l) => /^steps:[ \t]*$/.test(l));
  if (inicio < 0) return null;
  const steps = [];
  let fim = linhas.length;
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (/^\S/.test(linha) && !/^-/.test(linha)) { fim = i; break; }
    const id = linha.match(/^[ \t]*-[ \t]+id:[ \t]*["']?([\w.-]+)/);
    if (id) { steps.push({ id: id[1], tipo: null, meta: false, final: false, saidas: [] }); continue; }
    const atual = steps[steps.length - 1];
    if (!atual) continue;
    if (/^[ \t]+meta_verifiers:/.test(linha)) atual.meta = true;
    if (/-final\.md\b/.test(linha)) atual.final = true;
    const tipo = linha.match(/^[ \t]+type:[ \t]*["']?([\w-]+)/);
    if (tipo && !atual.tipo) atual.tipo = tipo[1];
    const saida = linha.match(/^[ \t]+-[ \t]+["']?([^\s"']+\.[a-z0-9]+)["']?[ \t]*$/i);
    if (saida && saida[1].includes('/')) atual.saidas.push(saida[1]);
  }
  if (!steps.length) return null;
  // As paradas humanas declaradas no nível de cima (`checkpoints:`, uma por linha).
  const paradas = new Set();
  const bloco = linhas.findIndex((l, i) => i >= fim && /^checkpoints:[ \t]*$/.test(l));
  if (bloco >= 0) {
    for (const linha of linhas.slice(bloco + 1)) {
      const item = linha.match(/^[ \t]+-[ \t]+["']?([\w.-]+)/);
      if (item) paradas.add(item[1]);
      else if (/^\S/.test(linha)) break;
    }
  }
  let ancora = -1;
  steps.forEach((st, i) => { if (st.meta) ancora = i; });
  if (ancora < 0) steps.forEach((st, i) => { if (st.final) ancora = i; });
  const depois = ancora < 0 ? [] : steps.slice(ancora + 1);
  if (!detalhe) return depois.map((st) => st.id);
  return depois.map((st) => ({ id: st.id, tipo: st.tipo, checkpoint: st.tipo === 'checkpoint' || paradas.has(st.id), saidas: st.saidas }));
}

/**
 * O que a conferência (o step da meta) produz, lido na exigência sem acento: o
 * relatório de entrega, a nota ou o termo de conferência e o manifesto do Citation
 * Gate. Não é artefato de step posterior: o que eles registram se confere agora, pelo
 * manifesto da final e pela peça. Medido na reavaliação de 24/09/2026 (novo2): "não
 * verificado nomeado no relatório de entrega" saiu `posterior` do step-12-aprovacao em
 * alimentos C5 (a2, a3) e reclamação C5 (a1, a2).
 */
const META_ARTEFATO_DA_CONFERENCIA = /\b(relatorio|nota de conferencia|termo de conferencia|manifesto|citation[ -]gate)\b/;

/** O step posterior como objeto: da lista de ids (sem tipo nem saídas) ou do `detalhe` do pipeline. */
function metaStepPosterior(st) {
  return typeof st === 'string' ? { id: st, tipo: null, checkpoint: null, saidas: null } : { id: String(st && st.id), tipo: st.tipo ?? null, checkpoint: st.checkpoint ?? null, saidas: Array.isArray(st.saidas) ? st.saidas : null };
}

function metaTextoCorrido(valor) {
  return String(valor ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Por que a exigência `posterior` NÃO se aceita, ou null quando se aceita. Posterior
 * é artefato de step depois da meta (checklist, pacote), nunca a própria peça: a
 * evidência ou o local que aponta o arquivo da final, ou que é um trecho literal
 * dela (`peca.texto`), recusa; e a evidência tem de citar um dos `stepsPosteriores`
 * (pelo id ou pelo número, "step-13"). Sem a lista (`null`), basta citar um step.
 * O step citado tem de ser de agente e gerar o artefato: com o `detalhe` do pipeline
 * (`stepsPosterioresDoPipeline(..., { detalhe: true })`), parada humana (checkpoint,
 * como o step de aprovação) não cumpre exigência nenhuma; e exigência do que a
 * conferência produz (`META_ARTEFATO_DA_CONFERENCIA`: relatório de entrega, nota de
 * conferência, manifesto) só se aceita citando step de agente que grava arquivo com
 * esse nome (sem as saídas do step, nunca). A recusa pelo artefato da conferência leva
 * `classe: fora-do-alcance` quando o avaliador não deu classe: o relatório não é da
 * peça, e o redator não o conserta. Devolve o motivo (texto) ou null.
 */
function motivoPosteriorRecusado(e, { stepsPosteriores = null, peca = null } = {}) {
  const texto = `${e.evidencia} ${e.local}`;
  const nomeDaPeca = peca && peca.nome ? String(peca.nome) : '';
  if (META_ARQUIVO_DA_PECA.test(texto) || (nomeDaPeca && texto.includes(nomeDaPeca))) {
    return 'posterior aponta a própria peça, que já existe e se avalia agora: posterior é só artefato de step depois da meta';
  }
  const trecho = metaTextoCorrido(e.evidencia);
  if (peca && peca.texto && trecho.length >= 12 && metaTextoCorrido(peca.texto).includes(trecho)) {
    return 'posterior com evidência que é trecho da própria peça: o que a peça traz se avalia agora';
  }
  const citados = [...texto.matchAll(/\bstep-0*(\d+)/gi)].map((m) => Number(m[1]));
  const artefato = metaSemAcento(e.exigencia).toLowerCase().match(META_ARTEFATO_DA_CONFERENCIA);
  const rotulo = artefato && ({ relatorio: 'o relatório', 'nota de conferencia': 'a nota de conferência', 'termo de conferencia': 'o termo de conferência', manifesto: 'o manifesto' }[artefato[1]] || 'o manifesto do Citation Gate');
  const doArtefato = artefato ? `posterior para ${rotulo}, que a conferência (o step da meta) produz: o que ali se registra se confere agora, pelo manifesto da final e pela peça` : null;
  if (!Array.isArray(stepsPosteriores)) {
    if (!citados.length) return 'posterior sem citar o step posterior à meta que cumpre a exigência';
    return doArtefato ? `${doArtefato}; sem o pipeline, não há step de agente que o grave` : null;
  }
  if (!stepsPosteriores.length) return 'posterior num squad sem step depois da meta';
  const steps = stepsPosteriores.map(metaStepPosterior);
  const numero = (id) => { const m = String(id).match(/^step-0*(\d+)/i); return m ? Number(m[1]) : null; };
  const citadosSteps = steps.filter((st) => texto.includes(st.id) || (numero(st.id) !== null && citados.includes(numero(st.id))));
  if (!citadosSteps.length) return `posterior sem citar um step posterior à meta (${steps.map((st) => st.id).join(', ')})`;
  const deAgente = citadosSteps.filter((st) => st.checkpoint !== true);
  if (!deAgente.length) return `posterior citando parada humana (${citadosSteps.map((st) => st.id).join(', ')}, checkpoint): aprovação não gera artefato que cumpra a exigência; só vale step de agente posterior que o gere${doArtefato ? `; e ${doArtefato.replace(/^posterior para /, '')}` : ''}`;
  if (doArtefato) {
    const palavra = artefato[1].split(/[ -]/)[0];
    const gera = deAgente.some((st) => Array.isArray(st.saidas) && st.saidas.some((s) => metaSemAcento(s.split('/').pop()).toLowerCase().includes(palavra)));
    if (!gera) return `${doArtefato}; ${deAgente.map((st) => st.id).join(', ')} não grava esse arquivo`;
  }
  return null;
}

function metaSemAcento(valor) {
  return String(valor ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** ATENDE, PARCIAL ou NAO a partir do que o avaliador escreveu ("NÃO ATENDE", "nao"...), ou null. */
function metaVeredito(valor) {
  const v = metaSemAcento(valor).toUpperCase().replace(/[\s_-]+/g, ' ');
  if (v === 'ATENDE') return 'ATENDE';
  if (v === 'PARCIAL') return 'PARCIAL';
  if (v === 'NAO' || v === 'NAO ATENDE') return 'NAO';
  return null;
}

function metaClasse(valor) {
  const v = metaSemAcento(valor).toLowerCase().replace(/[\s_]+/g, '-');
  if (META_CLASSES.includes(v)) return v;
  if (v === 'dado-ausente-na-pasta') return 'dado-ausente';
  if (v === 'fora-do-alcance-da-meta') return 'fora-do-alcance';
  return null;
}

/**
 * O objeto `avaliacao_meta` de um retorno do avaliador: o arquivo inteiro como
 * JSON, ou o primeiro bloco ```json que o traga. Nunca a prosa. null se não há.
 */
function extrairAvaliacaoMeta(texto) {
  const bruto = String(texto ?? '').trim();
  const candidatos = [bruto];
  for (const m of bruto.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)) candidatos.push(m[1]);
  for (const candidato of candidatos) {
    let obj;
    try { obj = JSON.parse(candidato); } catch { continue; }
    const av = obj && typeof obj === 'object' ? (obj.avaliacao_meta || obj) : null;
    if (av && Array.isArray(av.criterios)) return av;
  }
  return null;
}

/** Os `success_criteria` do squad.yaml, na ordem (lista em bloco, aspas retiradas). */
function criteriosDoSquadYaml(yaml) {
  const bloco = String(yaml ?? '').match(/^success_criteria:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m);
  if (!bloco) return [];
  return [...bloco[1].matchAll(/^[ \t]+- (.+?)[ \t]*$/gm)].map((m) => {
    const v = m[1].trim();
    const a = v[0];
    return (a === '"' || a === "'") && v.endsWith(a) ? v.slice(1, -1) : v;
  }).filter(Boolean);
}

/**
 * Quantos avaliadores a meta exige: o maior `meta_verifiers` do squad.yaml ou de
 * um step do pipeline; sem declaração, 1. O ritmo do run não entra nesta conta.
 */
function avaliadoresDaMeta(squadYaml, pipelineYaml) {
  const valores = [String(squadYaml ?? ''), String(pipelineYaml ?? '')]
    .flatMap((t) => [...t.matchAll(/^[ \t]*meta_verifiers:[ \t]*["']?(\d+)/gm)].map((m) => Number(m[1])))
    .filter((n) => Number.isInteger(n) && n >= 1);
  return valores.length ? Math.max(...valores) : 1;
}

/** A rubrica em texto fala de limiar? Só para avisar que o código não leu; nunca para extrair número. */
function rubricaDeclaraLimiarEmTexto(texto) {
  return /\blimiar\b/i.test(String(texto ?? ''));
}

/**
 * Normaliza a regra de entrega (`meta_limiar`) a partir de um objeto já lido
 * (valores em número ou em texto, como o parser YAML do motor os devolve), contra
 * `nCriterios` (0 = não conferir índices). Devolve `{ regra, erros }`. Chave
 * desconhecida é erro: uma regra lida pela metade aprovaria o que o squad barra.
 * `nao_max` ausente é 0 (NAO reprova); as demais ausentes não restringem.
 */
function normalizarRegraMeta(bruto, nCriterios = 0) {
  const erros = [];
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { regra: null, erros: ['meta_limiar tem de ser um mapa (ex.: { nao_max: 0, atende_obrigatorios: [1, 4, 6] })'] };
  const vazio = (v) => v === null || v === undefined || (typeof v === 'string' && /^(?:|null|~)$/i.test(v.trim()));
  const inteiro = (v, chave) => {
    if (vazio(v)) return null;
    const n = Number(typeof v === 'string' ? v.trim() : v);
    if (!Number.isInteger(n) || n < 0) { erros.push(`meta_limiar.${chave}: "${v}" não é inteiro >= 0`); return null; }
    return n;
  };
  const indices = (v, chave) => {
    if (vazio(v)) return null;
    const lista = Array.isArray(v) ? v : String(v).replace(/^\[|\]$/g, '').split(',').filter((x) => x.trim());
    const saida = [];
    for (const item of lista) {
      const n = Number(typeof item === 'string' ? item.trim() : item);
      if (!Number.isInteger(n) || n < 1 || (nCriterios && n > nCriterios)) erros.push(`meta_limiar.${chave}: "${String(item).trim()}" não é critério de 1 a ${nCriterios || 'N'}`);
      else if (!saida.includes(n)) saida.push(n);
    }
    return saida.sort((a, b) => a - b);
  };
  for (const chave of Object.keys(bruto)) if (!META_LIMIAR_CHAVES.includes(chave)) erros.push(`meta_limiar.${chave}: chave desconhecida (use ${META_LIMIAR_CHAVES.join(', ')})`);
  const regra = {
    nao_max: inteiro(bruto.nao_max, 'nao_max') ?? 0,
    parcial_max: inteiro(bruto.parcial_max, 'parcial_max'),
    atende_obrigatorios: indices(bruto.atende_obrigatorios, 'atende_obrigatorios') ?? [],
    parcial_permitidos: indices(bruto.parcial_permitidos, 'parcial_permitidos'),
    nota_min: inteiro(bruto.nota_min, 'nota_min'),
  };
  // Lista vazia de onde PARCIAL cabe é "em nenhum": a mesma regra que parcial_max 0.
  if (regra.parcial_permitidos && !regra.parcial_permitidos.length) {
    regra.parcial_permitidos = null;
    regra.parcial_max = 0;
  }
  if (regra.nota_min !== null && regra.nota_min > 100) erros.push(`meta_limiar.nota_min: ${regra.nota_min} acima de 100`);
  if (regra.parcial_permitidos) {
    const conflito = regra.parcial_permitidos.filter((n) => regra.atende_obrigatorios.includes(n));
    if (conflito.length) erros.push(`meta_limiar: critério ${conflito.join(', ')} está em atende_obrigatorios e em parcial_permitidos`);
  }
  return { regra: erros.length ? null : regra, erros };
}

/**
 * Lê `meta_limiar` do texto do squad.yaml, nas duas formas que o motor escreve e
 * aceita: bloco indentado (o que o compilador emite) ou mapa inline
 * (`meta_limiar: { nao_max: 0, atende_obrigatorios: [1, 4, 6] }`). Devolve
 * `{ presente, regra, erros }`; ausente é `{ presente: false }`.
 */
function metaLimiarDoSquadYaml(yaml, nCriterios = 0) {
  const texto = String(yaml ?? '');
  const m = texto.match(/^meta_limiar:[ \t]*(.*)$/m);
  if (!m) return { presente: false, regra: null, erros: [] };
  const semComentario = (v) => v.replace(/[ \t]+#.*$/, '').trim();
  const resto = semComentario(m[1]);
  const bruto = {};
  const erros = [];
  if (resto.startsWith('{')) {
    if (!resto.endsWith('}')) return { presente: true, regra: null, erros: ['meta_limiar: mapa inline sem "}" na mesma linha'] };
    const partes = [];
    let atual = '';
    let colchete = 0;
    for (const c of resto.slice(1, -1)) {
      if (c === '[') colchete += 1;
      if (c === ']') colchete -= 1;
      if (c === ',' && colchete === 0) { partes.push(atual); atual = ''; } else atual += c;
    }
    if (atual.trim()) partes.push(atual);
    for (const parte of partes) {
      const kv = parte.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
      if (!kv) { erros.push(`meta_limiar: "${parte.trim()}" não é chave: valor`); continue; }
      bruto[kv[1]] = kv[2];
    }
  } else if (resto) {
    return { presente: true, regra: null, erros: [`meta_limiar: "${resto}" não é mapa`] };
  } else {
    const depois = texto.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
    let chave = null;
    for (const linha of depois) {
      if (!linha.trim() || /^\s*#/.test(linha)) continue;
      if (!/^[ \t]/.test(linha)) break;
      const item = linha.match(/^[ \t]+-[ \t]+(.+)$/);
      if (item && chave) { bruto[chave] = [...(Array.isArray(bruto[chave]) ? bruto[chave] : []), semComentario(item[1])]; continue; }
      const kv = linha.match(/^[ \t]+([a-z_]+):[ \t]*(.*)$/i);
      if (!kv) { erros.push(`meta_limiar: linha "${linha.trim()}" ilegível`); continue; }
      chave = kv[1];
      const valor = semComentario(kv[2]);
      bruto[chave] = valor === '' ? [] : valor;
    }
    for (const [k, v] of Object.entries(bruto)) if (Array.isArray(v) && !v.length) bruto[k] = null;
  }
  const r = normalizarRegraMeta(bruto, nCriterios);
  return { presente: true, regra: r.regra, erros: [...erros, ...r.erros] };
}

/**
 * Normaliza UMA avaliação contra os N critérios do squad. Devolve `{ erros, criterios,
 * sugestoes, sugestoes_fora_da_rubrica }`; com `erros`, a avaliação não entra no consenso.
 * ATENDE sem a lista de exigências, ou com exigência em falta, sem estado, ou atendida
 * sem trecho e local, é rebaixado a PARCIAL (`rebaixado_por_codigo` diz por quê).
 * `pendencias` são os marcadores de `pendencias_do_profissional[]` do manifesto da
 * final (`pendenciasDoManifesto`): exigência `atendida` com `classe: dado-ausente` só
 * fica atendida se o `pendencia` dela está nessa lista (e não é conteúdo jurídico);
 * senão volta a `falta`, com `recusada_por_codigo`.
 * `stepsPosteriores` (`stepsPosterioresDoPipeline`) e `peca` (`{ nome, texto }` da
 * final) conferem cada exigência `posterior` (`motivoPosteriorRecusado`): a que aponta
 * a peça ou não cita um step posterior volta a `falta`, com `recusada_por_codigo`.
 * ATENDE fica ATENDE só com toda exigência `atendida` com trecho e local (ou dado
 * ausente aceito, ou posterior aceito) e pelo menos uma `atendida`.
 * `rubrica` (`{ criterios, qualityCriteria }`: os `success_criteria` e o texto do
 * `quality-criteria.md`) confere as sugestões: a que repete uma exigência de critério
 * ATENDE (`sugestaoRepeteExigencia`) sai da lista e entra como `falta` daquele
 * critério, com `recusada_por_codigo: "sugestao-repete-exigencia"`, `local` com o nome
 * da lista e `repete` com a fonte; o critério cai para PARCIAL. Sem `rubrica`, nada disso.
 * `limiar`, `limiar_fonte`, `nota` e `verdict` do avaliador não entram em conta
 * nenhuma; `campos_ignorados` diz quais vieram.
 */
function normalizarAvaliacaoMeta(av, nCriterios, { pendencias = null, pendenciasOnde = null, stepsPosteriores = null, peca = null, rubrica = null } = {}) {
  const erros = [];
  if (!av || !Array.isArray(av.criterios)) return { erros: ['sem a lista `criterios`'], criterios: [], fora_do_formato: [] };
  const camposIgnorados = META_CAMPOS_DO_CODIGO.filter((k) => av[k] !== undefined && av[k] !== null);
  const foraDoFormato = [];
  const porN = new Map();
  av.criterios.forEach((c, i) => {
    const n = Number(c && c.n !== undefined ? c.n : i + 1);
    if (!Number.isInteger(n) || n < 1 || n > nCriterios) { erros.push(`critério com n inválido (${c && c.n})`); return; }
    if (porN.has(n)) { erros.push(`critério ${n} repetido`); return; }
    const declarado = metaVeredito(c.veredito);
    // Sem o campo, a mensagem diz o que falta: medido em 26/09/2026 (mandado de segurança, motor
    // 0.9.54), três avaliadores leram "não declare limiar, nota final nem veredito final" como
    // proibição do voto por critério, e o erro era `veredito "undefined"`.
    if (!declarado) {
      erros.push(c.veredito === undefined || c.veredito === null || c.veredito === ''
        ? `critério ${n}: sem \`veredito\` (ATENDE, PARCIAL ou NAO): o veredito de cada critério é o voto do avaliador e é obrigatório; o que ele não declara é o limiar, a nota geral e o veredito final da entrega`
        : `critério ${n}: veredito "${c.veredito}" não é ATENDE, PARCIAL nem NAO`);
      return;
    }
    const exigencias = (Array.isArray(c.exigencias) ? c.exigencias : []).map((e) => {
      const status = metaSemAcento(e && e.status).toLowerCase();
      return {
        exigencia: String((e && e.exigencia) ?? '').trim(),
        status: META_STATUS.includes(status) ? status : null,
        evidencia: String((e && e.evidencia) ?? '').trim(),
        local: String((e && e.local) ?? '').trim(),
        classe: metaClasse(e && e.classe),
        pendencia: metaMarcadorNormalizado(e && e.pendencia),
      };
    }).map((e) => {
      // Derivação honesta do que o avaliador deixou de preencher: o local e o marcador que a
      // própria evidência mostra. O que não se deriva é falha de formato (`fora_do_formato`).
      if (e.status !== 'atendida') return e;
      let saida = e;
      if (!saida.local) {
        const local = metaLocalDaEvidencia(saida.evidencia);
        if (local) saida = { ...saida, local, local_derivado_por_codigo: `da evidência: "${local}"` };
      }
      if (saida.classe === 'dado-ausente' && !saida.pendencia) {
        const achada = metaPendenciaDaEvidencia(saida, pendenciasOnde || pendencias);
        if (achada) saida = { ...saida, pendencia: achada.marcador, pendencia_derivada_por_codigo: `da evidência: ${achada.como}` };
      }
      return saida;
    }).map((e) => {
      if (e.status === 'posterior') {
        const motivo = motivoPosteriorRecusado(e, { stepsPosteriores, peca });
        if (!motivo) return e;
        // O relatório de entrega, a nota de conferência e o manifesto não são da peça: o redator não os conserta.
        const daConferencia = META_ARTEFATO_DA_CONFERENCIA.test(metaSemAcento(e.exigencia).toLowerCase());
        return { ...e, status: 'falta', classe: e.classe || (daConferencia ? 'fora-do-alcance' : 'peca'), recusada_por_codigo: motivo, recusada_como: 'posterior' };
      }
      if (e.classe !== 'dado-ausente') return e;
      if (e.status === 'falta') {
        // Falta de dado público ou de elemento da peça volta à redação, não vira pendência do profissional.
        const naoEDado = metaNaoEDadoDoCliente(e.exigencia);
        return naoEDado ? { ...e, classe: 'peca', reclassificada_por_codigo: `dado-ausente para peca: ${naoEDado.motivo}; dado-ausente é só o dado do cliente ou do caso fora da pasta` } : e;
      }
      if (e.status !== 'atendida') return e;
      const motivo = motivoDadoAusenteRecusado(e, pendencias);
      if (!motivo) return e;
      // Recusada por não ser dado do cliente (conteúdo jurídico, dado público, elemento da peça): a falta é da peça.
      return metaNaoEDadoDoCliente(e.exigencia) ? { ...e, status: 'falta', classe: 'peca', recusada_por_codigo: motivo, reclassificada_por_codigo: `dado-ausente para peca: ${motivo}` } : { ...e, status: 'falta', recusada_por_codigo: motivo };
    });
    let veredito = declarado;
    let rebaixado = null;
    // Só no voto ATENDE o formato decide o voto: abaixo dele, o campo que falta não muda nota.
    if (declarado === 'ATENDE') {
      // O dado ausente recusado só por não trazer `pendencia` é formato; recusado por marcador
      // fora do manifesto, por não ser dado do cliente, ou o posterior recusado, é a peça.
      const soFormato = (e) => e.recusada_por_codigo && !e.recusada_como && !e.pendencia && !e.reclassificada_por_codigo;
      const pelaPeca = exigencias.some((e) => (e.status === 'falta' && !e.recusada_por_codigo) || (e.recusada_por_codigo && !soFormato(e)));
      const faltantes = !exigencias.length
        ? [{ n, exigencia: null, campos: ['exigencias'] }]
        : exigencias.map((e) => ({ n, exigencia: e.exigencia || null, campos: metaCamposFaltantes(soFormato(e) ? { ...e, status: 'atendida' } : e) })).filter((f) => f.campos.length);
      // Critério que cai pela peça cai de qualquer jeito: refazer o formato dele não muda o voto.
      if (!pelaPeca) foraDoFormato.push(...faltantes);
    }
    if (declarado === 'ATENDE') {
      const recusada = exigencias.find((e) => e.recusada_por_codigo);
      const semProva = exigencias.find((e) => e.status !== 'atendida' && e.status !== 'posterior')
        || exigencias.find((e) => e.status === 'atendida' && (!e.evidencia || !e.local));
      if (!exigencias.length) rebaixado = 'ATENDE sem as exigências do critério listadas uma a uma';
      else if (recusada) rebaixado = `ATENDE com ${recusada.recusada_como === 'posterior' ? 'posterior' : 'dado ausente'} não aceito (${recusada.recusada_por_codigo}): ${recusada.exigencia || '(exigência sem texto)'}`;
      else if (semProva) rebaixado = `ATENDE com exigência sem evidência (trecho e local): ${semProva.exigencia || '(exigência sem texto)'}`;
      else if (!exigencias.some((e) => e.status === 'atendida')) rebaixado = 'ATENDE sem nenhuma exigência atendida agora (todas posteriores à meta)';
      if (rebaixado) veredito = 'PARCIAL';
    }
    const perdida = exigencias.find((e) => e.status === 'falta' && e.classe);
    let classe = veredito === 'ATENDE' ? null : (metaClasse(c.classe_da_perda) || (perdida && perdida.classe) || 'peca');
    // O voto que chamou de dado ausente o que é da peça: a classe do critério segue a falta reclassificada.
    const reclassificada = exigencias.find((e) => e.reclassificada_por_codigo);
    let classeReclassificada = null;
    if (classe === 'dado-ausente' && reclassificada) {
      classe = 'peca';
      classeReclassificada = `dado-ausente para peca: ${reclassificada.exigencia || '(exigência sem texto)'} não é dado do cliente nem do caso`;
    }
    porN.set(n, { n, veredito, veredito_declarado: declarado, rebaixado_por_codigo: rebaixado, exigencias, classe_da_perda: classe, ...(classeReclassificada ? { classe_reclassificada_por_codigo: classeReclassificada } : {}) });
  });
  for (let n = 1; n <= nCriterios; n += 1) if (!porN.has(n) && !erros.some((e) => e.startsWith(`critério ${n}:`))) erros.push(`falta o critério ${n}`);
  const lista = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  const sugestoes = { sugestoes: lista(av.sugestoes), sugestoes_fora_da_rubrica: lista(av.sugestoes_fora_da_rubrica) };
  // Sugestão que repete uma exigência de critério ATENDE é a falta escrita no lugar
  // errado: vira `falta` daquele critério e o ATENDE cai (sai da lista de sugestões).
  if (rubrica && Array.isArray(rubrica.criterios) && rubrica.criterios.length === nCriterios && !erros.length) {
    const exigencias = metaExigenciasDaRubrica(rubrica.criterios, rubrica.qualityCriteria || '');
    for (const campo of ['sugestoes', 'sugestoes_fora_da_rubrica']) {
      sugestoes[campo] = sugestoes[campo].filter((s) => {
        const atende = [...porN.values()].filter((c) => c.veredito === 'ATENDE').map((c) => c.n);
        const abaixo = [...porN.values()].filter((c) => c.veredito !== 'ATENDE').map((c) => c.n);
        // Em `sugestoes_fora_da_rubrica` o avaliador afirma que a rubrica não pede o item;
        // o código só o desmente quando o item descreve a falta que uma cláusula PARCIAL ou
        // NÃO nomeia. Medido: "data de recebimento da notificação por extenso no preâmbulo"
        // (contestação a3) casa com o texto do C6, que se cumpre na ficha de prazos.
        const fontes = campo === 'sugestoes_fora_da_rubrica' ? ['quality-criteria'] : null;
        // Nota de alcance ("não está na lista fechada e não foi aberto"), que o agente manda
        // escrever aqui, não é falta: medido (novo2), o HC C2 caía por ela em dois votos.
        if (META_NOTA_DE_ALCANCE.test(metaSemAcento(s).toLowerCase())) return true;
        // Primeiro os critérios ATENDE (a falta derruba o voto); sem casamento, os que já
        // estão abaixo, só pelas regras próprias (`regra`): a falta entra na lista (volta à
        // redação) e o veredito não muda. Medido (novo2): reclamação a2 pôs a Súmula 389, II
        // sem o pedido em `sugestoes_fora_da_rubrica` com o C5 já em NAO, e o defeito sumia
        // da lista. Semelhança de termos contra critério já abaixo não entra: nos votos
        // reais, casava melhoria ("juntar captura do sítio da empresa daria âncora ao local
        // de trabalho") com exigência já cumprida.
        const achada = (atende.length ? sugestaoRepeteExigencia(s, exigencias, atende, { fontes }) : null)
          || (abaixo.length ? sugestaoRepeteExigencia(s, exigencias, abaixo, { fontes, soRegra: true }) : null);
        if (!achada) return true;
        const c = porN.get(achada.n);
        c.exigencias.push({
          exigencia: achada.exigencia,
          status: 'falta',
          evidencia: s,
          local: campo,
          classe: 'peca',
          pendencia: '',
          recusada_por_codigo: 'sugestao-repete-exigencia',
          recusada_como: 'sugestao',
          repete: { fonte: achada.fonte, cobertura: achada.cobertura, ...(achada.regra ? { regra: achada.regra } : {}) },
        });
        if (c.veredito !== 'ATENDE') return false;
        c.veredito = 'PARCIAL';
        c.rebaixado_por_codigo = `ATENDE com sugestão que repete exigência do critério (${achada.fonte === 'criterio' ? 'texto do critério' : 'cláusula PARCIAL ou NÃO do quality-criteria.md'}: "${achada.exigencia}"): ${s}`;
        c.classe_da_perda = metaClasse(c.classe_da_perda) || 'peca';
        return false;
      });
    }
  }
  return {
    erros,
    criterios: [...porN.values()].sort((a, b) => a.n - b.n),
    sugestoes: sugestoes.sugestoes,
    sugestoes_fora_da_rubrica: sugestoes.sugestoes_fora_da_rubrica,
    campos_ignorados: camposIgnorados,
    // O critério que a sugestão derrubou caiu pela peça: o formato dele não muda o voto.
    fora_do_formato: foraDoFormato.filter((f) => !/^ATENDE com sugestão/.test((porN.get(f.n) || {}).rebaixado_por_codigo || '')),
  };
}

function metaChave(texto) {
  return metaSemAcento(texto).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Terminações retiradas antes de comparar termos (a mais longa primeiro), para a
 * mesma palavra flexionada contar como uma só: "atribuída" e "atribuindo",
 * "classificação" e "classificada". Depois, as vogais finais saem ("preclui",
 * "precluiu" e "preclusão" dão "precl"; "autoria" e "autor" dão "autor"). Só em
 * termo de 5 letras ou mais, e o radical fica com pelo menos 4.
 */
const META_TERMINACOES = ['amentos', 'imentos', 'amento', 'imento', 'mente', 'idades', 'idade', 'acoe', 'icoe', 'acao', 'icao', 'coe', 'cao', 'soe', 'sao', 'ncia', 'indo', 'ando', 'endo', 'ida', 'ido', 'ada', 'ado', 'avel', 'ivel'];

function metaRadical(termo) {
  if (/^\d+$/.test(termo) || termo.length < 5) return termo;
  let r = termo;
  const fim = META_TERMINACOES.find((s) => r.endsWith(s) && r.length - s.length >= 4);
  if (fim) r = r.slice(0, -fim.length);
  r = r.replace(/[aeiou]+$/, '');
  return r.length >= 4 ? r : termo;
}

/** Um termo normalizado (plural simples e terminação retirados), ou null quando não distingue nada. */
function metaTermo(t) {
  if (!t || META_PALAVRAS_VAZIAS.has(t)) return null;
  if (!/^\d+$/.test(t) && t.length < 2) return null;
  return metaRadical(t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
}

/** Os termos que distinguem uma exigência: sem acento, sem palavra vazia, plural e terminação retirados. */
function metaTermos(texto) {
  const termos = new Set();
  for (const t of metaChave(texto).split(' ')) {
    const n = metaTermo(t);
    if (n) termos.add(n);
  }
  return termos;
}

/**
 * Quanto `a` e `b` se sobrepõem: termos em comum e a fração dos termos da redação
 * menor que está na maior; `bloqueio` diz por que não podem ser a mesma exigência
 * (números diferentes, redação curta demais), e aí `mesma` é false.
 */
function metaSemelhanca(a, b) {
  if (metaChave(a) && metaChave(a) === metaChave(b)) return { mesma: true, comum: metaTermos(a).size, cobertura: 1, bloqueio: null };
  const ta = metaTermos(a);
  const tb = metaTermos(b);
  const numeros = (t) => [...t].filter((x) => /^\d+$/.test(x)).sort().join(' ');
  let comum = 0;
  for (const t of ta) if (tb.has(t)) comum += 1;
  const menor = Math.min(ta.size, tb.size);
  const cobertura = menor ? comum / menor : 0;
  let bloqueio = null;
  if (numeros(ta) && numeros(tb) && numeros(ta) !== numeros(tb)) bloqueio = 'numeros';
  else if (menor < 2) bloqueio = 'curta';
  return { mesma: !bloqueio && comum >= 2 && cobertura >= META_SEMELHANCA_MIN, comum, cobertura, bloqueio };
}

/**
 * Semelhança simples entre duas redações da mesma exigência (o consenso junta as
 * faltas que três avaliadores escreveram de jeitos diferentes): mesma chave
 * normalizada, ou pelo menos dois termos em comum cobrindo 75% dos termos da redação
 * menor, com os mesmos números quando as duas citam número ("pedido 1" e "pedido 4"
 * são faltas diferentes). Medido na reavaliação: despejo C1 com 5 faltas para 2 defeitos.
 */
function metaMesmaExigencia(a, b) {
  return metaSemelhanca(a, b).mesma;
}

/**
 * Os núcleos de uma falta: o dado ou o elemento de que ela fala, lido na exigência
 * sem acento. Duas faltas com núcleos e nenhum em comum são defeitos diferentes, por
 * mais termos que dividam ("Endereço eletrônico das partes na qualificação (CPC 319,
 * II)" e "CPF das partes na qualificação (CPC 319, II)" dividem 5 de 6 termos); com um
 * núcleo em comum, basta metade dos termos da redação menor (e dois em comum) para
 * serem a mesma ("Correção apurada por competência no cálculo" e "Correção discriminada
 * por competência (valor na memória)"). "Pedido 4" é núcleo próprio, pelo número.
 * A lista é fechada, de propósito: são os dados de qualificação e os elementos que se
 * repetem nas faltas da meta (medido na reavaliação de 24/09/2026, novo2).
 */
const META_NUCLEOS = [
  ['cpf', /\bcpf\b/], ['cnpj', /\bcnpj\b/], ['rg', /\b(?:rg|carteira de identidade)\b/], ['pis', /\b(?:pis|pasep|nit)\b/],
  ['oab', /\boab\b/], ['cep', /\bcep\b/], ['email', /\b(?:e ?mail|endereco eletronico|correio eletronico)\b/],
  ['endereco', /\b(?:endereco(?! eletronico)|domicilio|residencia)\b/], ['estado-civil', /\b(?:estado civil|uniao estavel)\b/],
  ['profissao', /\bprofissao\b/], ['data', /\bdata\b/], ['assinatura', /\bassinaturas?\b/],
  ['correcao', /\b(?:correcao|ipca|inpc|igp ?m|indices?|atualizacao monetaria)\b/], ['juros', /\bjuros\b/],
  ['reflexos', /\breflexos?\b/], ['deducao', /\b(?:deducao|abatimento)\b/], ['audiencia', /\b(?:audiencia|conciliacao|mediacao)\b/],
  ['manifesto', /\b(?:manifesto|citation gate)\b/], ['relatorio', /\brelatorio\b/],
];

function metaNucleos(texto) {
  const t = metaChave(texto);
  const nucleos = new Set(META_NUCLEOS.filter(([, re]) => re.test(t)).map(([nome]) => nome));
  for (const m of t.matchAll(/\bpedidos? (\d+)\b/g)) nucleos.add(`pedido-${m[1]}`);
  return nucleos;
}

/** Fração mínima dos termos da redação menor quando as duas faltas dividem um núcleo. */
const META_SEMELHANCA_COM_NUCLEO = 0.5;

/**
 * Duas faltas (ou dois posteriores) do consenso são o mesmo item? Nunca com classes
 * diferentes (o destino muda: `peca` volta à redação, `dado-ausente` vira pendência),
 * nunca com núcleos disjuntos (e-mail e CPF) nem números diferentes ("pedido 1" e
 * "pedido 4"); sim pela semelhança de sempre (`metaSemelhanca`) ou, com um núcleo em
 * comum, com metade dos termos da redação menor e dois em comum.
 */
function metaMesmaFalta(a, b) {
  if (metaFaltasIncompativeis(a, b)) return false;
  if (metaMesmaExigencia(a.exigencia, b.exigencia)) return true;
  const na = metaNucleos(a.exigencia);
  if (![...metaNucleos(b.exigencia)].some((x) => na.has(x))) return false;
  const s = metaSemelhanca(a.exigencia, b.exigencia);
  return s.comum >= 2 && s.cobertura >= META_SEMELHANCA_COM_NUCLEO;
}

/**
 * Duas faltas que nunca são o mesmo item, por mais parecidas: classes diferentes,
 * núcleos disjuntos (as duas com núcleo) ou números diferentes (as duas com número).
 * O consenso não põe no mesmo grupo uma falta incompatível com QUALQUER membro dele:
 * uma redação larga ("qualificação das partes: CPF/CNPJ, e-mail") não emenda dois
 * defeitos (CPF da autora, CNPJ do réu) num item só.
 */
function metaFaltasIncompativeis(a, b) {
  if (a.classe && b.classe && a.classe !== b.classe) return true;
  const na = metaNucleos(a.exigencia);
  const nb = metaNucleos(b.exigencia);
  if (na.size && nb.size && ![...na].some((x) => nb.has(x))) return true;
  return metaSemelhanca(a.exigencia, b.exigencia).bloqueio === 'numeros';
}

/**
 * As cláusulas de nível do `quality-criteria.md` por critério: o texto de cada
 * "PARCIAL" e de cada "NÃO" (o que o critério NÃO aceita; o contrário é exigência).
 * Lê as três formas que os squads usam: tabela com colunas PARCIAL e NÃO (primeira
 * coluna numerada, "1.", "| 1 |" ou "Título (1)"; sem número, pela posição só quando
 * há uma linha por critério), seção "### Critério N" ou "**N. título**" com itens "- PARCIAL:" e
 * "- NÃO:" (também "PARCIAL quando…"). Devolve uma lista por critério, na ordem.
 * Linha de tabela sem número numa tabela com mais linhas que critérios não se liga
 * a critério nenhum (o código não adivinha qual é).
 */
function clausulasDoQualityCriteria(md, nCriterios) {
  const linhas = String(md ?? '').split(/\r?\n/);
  const porCriterio = Array.from({ length: nCriterios }, () => []);
  const celulas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const numero = (cs) => {
    const c = String(cs[0] ?? '').replace(/\*/g, '').trim();
    const m = c.match(/^(?:crit[eé]rio\s+)?(\d+)(?:[.):]|\s|$)/i) || c.match(/\((\d+)\)$/);
    return m ? Number(m[1]) : null;
  };
  for (let i = 0; i < linhas.length; i += 1) {
    if (!/^\s*\|/.test(linhas[i])) continue;
    const cab = celulas(linhas[i]).map((c) => metaSemAcento(c.replace(/\*/g, '')).toUpperCase());
    const colunas = [cab.indexOf('PARCIAL'), cab.findIndex((c) => c === 'NAO' || c === 'NAO ATENDE')].filter((k) => k >= 0);
    if (!colunas.length) continue;
    const dados = [];
    let j = i + 1;
    for (; j < linhas.length && /^\s*\|/.test(linhas[j]); j += 1) {
      if (/^\s*\|[\s:|-]*$/.test(linhas[j])) continue;
      dados.push(celulas(linhas[j]));
    }
    const numeradas = dados.some((cs) => numero(cs) !== null);
    dados.forEach((cs, k) => {
      const n = numeradas ? numero(cs) : (dados.length === nCriterios ? k + 1 : null);
      if (!n || n > nCriterios) return;
      for (const col of colunas) if (cs[col]) porCriterio[n - 1].push(cs[col]);
    });
    i = j - 1;
  }
  let atual = null;
  for (const linha of linhas) {
    const cab = linha.match(/^\s*(?:#{2,6}\s*|\*\*\s*)(?:crit[eé]rio\s+)?(\d+)\s*[.:)\u2013-]/i);
    if (cab) { const n = Number(cab[1]); atual = n >= 1 && n <= nCriterios ? n : null; continue; }
    if (/^\s*#{1,6}\s/.test(linha) || /^\s*\*\*[^*]+\*\*\s*$/.test(linha)) { atual = null; continue; }
    if (!atual) continue;
    const item = linha.match(/^\s*(?:[-*]\s*)?\**\s*(PARCIAL|N[ÃA]O)(?![\wÀ-ÿ])\s*(?:quando\b)?\s*\**\s*[.:]?\s*\**\s*(.+)$/);
    if (item && item[2].trim()) porCriterio[atual - 1].push(item[2].trim());
  }
  return porCriterio;
}

/** Remissão legal e numeral romano: localizam, não dizem o que se exige. */
const META_TERMO_DE_REMISSAO = /^(?:art|arts|artigo|artigos|cpc|cpp|clt|cf|cc|cdc|lei|leis|inciso|incisos|alinea|alineas|paragrafo|paragrafos|unico|caput|[ivxl]+)$/;

/** Os termos de conteúdo de um texto: sem número e sem remissão legal (quantos dizem o que se exige). */
function metaTermosDeConteudo(texto) {
  const termos = new Set();
  for (const t of metaChave(texto).split(' ')) {
    if (/^\d+$/.test(t) || META_TERMO_DE_REMISSAO.test(t)) continue;
    const n = metaTermo(t);
    if (n) termos.add(n);
  }
  return termos;
}

/**
 * As exigências de um texto da rubrica, uma por trecho: o texto se parte em ";",
 * ":", fim de frase, vírgula (fora de número), "ou", "mas" e "nem", e o que está
 * entre parênteses vira trecho próprio. Numa cláusula de falta (PARCIAL ou NÃO,
 * `daFalta`), o trecho "X sem Y" ou "falta Y" fica só com o Y: é o que falta, e o
 * contrário da falta é a exigência. Trecho com menos de dois termos de conteúdo (só
 * remissão, número ou uma palavra) não é exigência que se compare.
 */
function metaExigenciasDoTexto(texto, { daFalta = false } = {}) {
  const limpo = String(texto ?? '').replace(/[`*]/g, ' ');
  const parenteses = [...limpo.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const pedacos = [limpo.replace(/\([^()]*\)/g, ' '), ...parenteses]
    .flatMap((p) => p.split(/[;:]|\.\s+(?=[A-ZÀ-Ý"“])|,(?!\d)|\s(?:e|ou|mas|nem)\s/));
  const saida = [];
  for (const pedaco of pedacos) {
    let p = pedaco;
    if (daFalta) {
      const m = p.match(/(?:^|\s)(?:sem|falta|faltam|faltando)\s+(.+)$/i);
      if (m) p = m[1];
    }
    p = p.replace(/\s+/g, ' ').replace(/^[\s.,"'“”]+|[\s.,"'“”]+$/g, '');
    if (metaTermosDeConteudo(p).size >= 2 && !saida.includes(p)) saida.push(p);
  }
  return saida;
}

/**
 * As exigências de cada critério para conferir as sugestões do avaliador: as do
 * texto literal do critério (`success_criteria`) e as das cláusulas PARCIAL e NÃO
 * do `quality-criteria.md` daquele critério. Uma lista por critério, cada item
 * `{ texto, fonte }` (`criterio` ou `quality-criteria`).
 */
function metaExigenciasDaRubrica(criterios, qualityCriteria = '') {
  const lista = Array.isArray(criterios) ? criterios : [];
  const clausulas = clausulasDoQualityCriteria(qualityCriteria, lista.length);
  return lista.map((texto, i) => {
    const itens = metaExigenciasDoTexto(texto).map((t) => ({ texto: t, fonte: 'criterio' }));
    for (const clausula of clausulas[i]) {
      for (const t of metaExigenciasDoTexto(clausula, { daFalta: true })) {
        if (!itens.some((x) => metaChave(x.texto) === metaChave(t))) itens.push({ texto: t, fonte: 'quality-criteria' });
      }
      // A cláusula de citação sem o pedido que ela sustenta se confere por regra própria
      // (`META_SUGESTAO_CITACAO_SEM_PEDIDO`), com o texto inteiro da cláusula.
      if (META_CLAUSULA_CITACAO_SEM_PEDIDO.test(metaSemAcento(clausula).toLowerCase())) {
        itens.push({ texto: clausula.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim(), fonte: 'quality-criteria', regra: 'citacao-sem-pedido' });
      }
    }
    return itens;
  });
}

/**
 * Cláusula PARCIAL ou NÃO sobre citação que não sustenta pedido da peça ("Citação
 * verificada, mas fora do pedido que sustenta", "citação sem o pedido"), lida sem acento.
 */
const META_CLAUSULA_CITACAO_SEM_PEDIDO = /\bcitac(?:ao|oes)\b[^|]*\b(?:fora d[oa]s?|sem (?:o |os )?|desligad\w* d[oa]s?|alhei\w* a[os]?)\s*pedidos?\b/;
/**
 * A sugestão que descreve essa falta: nomeia uma citação (súmula, OJ, Tema, artigo,
 * lei, precedente, com número) E diz que a peça não formula o pedido. A mesma falta
 * dita com outras palavras que a cláusula, por isso regra própria e não semelhança de
 * termos. Medido na reavaliação de 24/09/2026 (novo2): reclamação a2 ("(Súmula 389, II);
 * a peça pede só a obrigação de fazer, sem o pedido alternativo liquidado. Nenhum
 * critério cobra essa correspondência") e a3 ("cita a Súmula 389, II, mas não formula o
 * pedido sucessivo"), contra a cláusula PARCIAL do C5.
 */
/**
 * Nota de alcance: o avaliador diz que o arquivo está fora da lista fechada, ou que não o
 * abriu. O agente manda escrevê-la em `sugestoes_fora_da_rubrica`; ela não descreve falta
 * da peça, e o código não a compara com a rubrica.
 */
const META_NOTA_DE_ALCANCE = /\b(?:lista fechada|fora da lista|nao (?:esta|estava|estavam|estao) na lista)\b|\bnao (?:foi|foram) abert[oa]s?\b|\bnao abert[oa]s?\b|\bnao (?:o |a )?abri\b/;
const META_SUGESTAO_CITACAO = /\b(?:sumulas?|oj|orientac\w* jurisprudencia\w*|temas?|arts?\.?|artigos?|leis?|precedentes?|resp|re|hc)\s*(?:n[.o]*\s*)?\d+/;
const META_SUGESTAO_SEM_PEDIDO = /\b(?:sem (?:o |os |a |as )?pedidos?|nao (?:formula|faz|traz|deduz)\w* (?:o |os |a |as )?pedidos?|pede (?:so|apenas|somente)|falta (?:o |a )?pedidos?)\b/;

/**
 * Os critérios que a sugestão cita ("Critério 3", "(critério 1)", "critérios 2 e 3")
 * e o texto dela sem a citação, que é endereço e não conteúdo.
 */
function metaSugestaoSemCitacao(sugestao) {
  const citados = [];
  const texto = String(sugestao ?? '').replace(/\(?\bcrit[eé]rios?\s+(\d+(?:\s*(?:,|e)\s*\d+)*)\)?/gi, (_, lista) => {
    for (const n of lista.split(/\s*(?:,|e)\s*/)) if (/^\d+$/.test(n)) citados.push(Number(n));
    return ' ';
  });
  return { citados: [...new Set(citados)], texto };
}

/**
 * A exigência da rubrica que a sugestão repete, ou null. A sugestão que cita
 * critério se compara só com as exigências dele; a que não cita, com as de todos os
 * critérios em `candidatos`, e fica com o maior casamento. Casar é a mesma regra da
 * deduplicação de faltas (`metaSemelhanca`: mesma normalização, 75% dos termos da
 * redação menor, pelo menos dois em comum, números iguais quando os dois citam).
 * A exigência com `regra` (hoje só `citacao-sem-pedido`) não se compara por termos: casa
 * quando a sugestão nomeia uma citação e diz que o pedido não está na peça. `soRegra`
 * deixa só essas. Devolve `{ n, exigencia, fonte, cobertura, regra? }`.
 */
function sugestaoRepeteExigencia(sugestao, exigenciasPorCriterio, candidatos, { fontes = null, soRegra = false } = {}) {
  const { citados, texto } = metaSugestaoSemCitacao(sugestao);
  const alvo = citados.length ? candidatos.filter((n) => citados.includes(n)) : candidatos;
  let melhor = null;
  const semAcento = metaSemAcento(texto).toLowerCase();
  const citacaoSemPedido = META_SUGESTAO_CITACAO.test(semAcento) && META_SUGESTAO_SEM_PEDIDO.test(semAcento);
  for (const n of alvo) {
    for (const ex of exigenciasPorCriterio[n - 1] || []) {
      if (fontes && !fontes.includes(ex.fonte)) continue;
      if (ex.regra === 'citacao-sem-pedido') {
        if (citacaoSemPedido && !melhor) melhor = { n, exigencia: ex.texto, fonte: ex.fonte, cobertura: 1, comum: 0, regra: ex.regra };
        continue;
      }
      if (soRegra) continue;
      const s = metaSemelhanca(ex.texto, texto);
      if (s.mesma && (!melhor || s.cobertura > melhor.cobertura || (s.cobertura === melhor.cobertura && s.comum > melhor.comum))) {
        melhor = { n, exigencia: ex.texto, fonte: ex.fonte, cobertura: s.cobertura, comum: s.comum, regra: null };
      }
    }
  }
  return melhor && { n: melhor.n, exigencia: melhor.exigencia, fonte: melhor.fonte, cobertura: Math.round(melhor.cobertura * 100) / 100, ...(melhor.regra ? { regra: melhor.regra } : {}) };
}

/**
 * A classe por maioria entre os votos contados; no empate no topo, `peca`, de
 * propósito (a peça volta à redação, o lado seguro), e nunca a ordem da lista.
 * Devolve `{ classe, empate, votos }`; sem voto, `classe: null`.
 */
function metaClassePorMaioria(classes) {
  const votos = {};
  for (const c of classes) if (c) votos[c] = (votos[c] || 0) + 1;
  const maximo = Math.max(0, ...Object.values(votos));
  if (!maximo) return { classe: null, empate: false, votos };
  const topo = Object.keys(votos).filter((c) => votos[c] === maximo);
  return topo.length === 1 ? { classe: topo[0], empate: false, votos } : { classe: 'peca', empate: true, votos };
}

function metaUniao(listas) {
  const vistos = new Set();
  const saida = [];
  for (const item of listas.flat()) {
    const chave = metaChave(item);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(item);
  }
  return saida;
}

/**
 * O consenso por critério. `avaliacoes` já normalizadas (sem erros), uma por
 * avaliador; `criterios` é a lista do squad.yaml; `regra` a de entrega do squad
 * (`meta_limiar` normalizado; ausente, o padrão do motor). O critério fica no
 * nível mais alto que mais da metade dos votos alcança; a nota sai da escala
 * 2/1/0 e o veredito da regra, com cada parte que reprovou nomeada.
 */
/**
 * O trecho da exigência que nomeia o artefato onde ela se registraria ("nomeado no
 * relatório de entrega", "registrado na nota de conferência"): quem não leu escreve a
 * exigência pelo artefato que não abriu; quem leu, pelo que conferiu.
 */
const META_TRECHO_DO_ARTEFATO = /\s*,?\s*(?:\b(?:nomead|registrad|listad|indicad|declarad)\w*\s+)?\b(?:no|na|nos|nas)\s+(?:relatorio|nota|termo|manifesto|checklist)\b.*$/;

/**
 * A falta `fora-do-alcance` de um voto e a exigência que outro avaliador deu por
 * `atendida` com trecho e local são a mesma exigência? A falta sem o trecho do artefato
 * (`META_TRECHO_DO_ARTEFATO`) contra a atendida inteira ou contra cada parte dela
 * separada por ";", pela semelhança de sempre (`metaSemelhanca`: 75% dos termos da
 * redação menor, dois em comum, números iguais). Medido (novo2, alimentos C5): "O não
 * verificado sai da final nomeado no relatório de entrega" (a2) e "Nenhum marcador [NÃO
 * VERIFICADO] na versão final; o não verificado saiu da final" (a1).
 */
function metaMesmaExigenciaConferida(falta, atendida) {
  const nucleo = metaChave(falta).replace(META_TRECHO_DO_ARTEFATO, '').trim();
  if (!nucleo) return false;
  return [atendida, ...String(atendida).split(';')].some((parte) => metaSemelhanca(nucleo, parte).mesma);
}

/**
 * Quem não leu não contradiz quem leu. No consenso, a falta `fora-do-alcance` de um voto
 * (o avaliador não conferiu: arquivo fora do alcance, posterior recusado para o
 * relatório) cuja exigência OUTRO avaliador deu por `atendida` com trecho e local conta
 * como atendida naquele voto, com `superada_por_evidencia: [avaliadores]`. Sem falta
 * restante, o voto volta a ATENDE (`elevado_por_evidencia`). Falta `peca` ou
 * `dado-ausente` nunca é superada: é discordância de mérito, e decide a maioria.
 * Medido (novo2, alimentos C5): a1 conferiu que o não verificado saiu da final, pelo
 * manifesto e pela peça; a2 e a3 marcaram "nomeado no relatório de entrega" como
 * posterior da aprovação, recusado como `fora-do-alcance`, e derrubavam o critério.
 * Devolve as avaliações ajustadas (as originais ficam intactas).
 */
function metaSuperarPorEvidencia(avaliacoes, nCriterios) {
  const ajustadas = avaliacoes.map((a) => ({ ...a, criterios: a.criterios.map((c) => ({ ...c, exigencias: c.exigencias.map((e) => ({ ...e })) })) }));
  for (let i = 0; i < nCriterios; i += 1) {
    const conferidas = [];
    avaliacoes.forEach((a, k) => {
      for (const e of a.criterios[i].exigencias) {
        if (e.status === 'atendida' && e.evidencia && e.local && !e.recusada_por_codigo) conferidas.push({ k: k + 1, exigencia: e.exigencia });
      }
    });
    if (!conferidas.length) continue;
    ajustadas.forEach((a, k) => {
      const c = a.criterios[i];
      let superou = false;
      for (const e of c.exigencias) {
        if (e.status !== 'falta' || e.classe !== 'fora-do-alcance') continue;
        // Quem tem a mesma falta fora do alcance também não leu: não conta como quem conferiu.
        const tambemNaoLeu = new Set(avaliacoes.map((o, j) => (o.criterios[i].exigencias.some((x) => x.status === 'falta' && x.classe === 'fora-do-alcance' && metaMesmaExigenciaConferida(x.exigencia, metaChave(e.exigencia).replace(META_TRECHO_DO_ARTEFATO, ''))) ? j + 1 : null)).filter(Boolean));
        const por = [...new Set(conferidas.filter((x) => x.k !== k + 1 && !tambemNaoLeu.has(x.k) && metaMesmaExigenciaConferida(e.exigencia, x.exigencia)).map((x) => x.k))].sort((x, y) => x - y);
        if (!por.length) continue;
        e.status = 'atendida';
        e.status_do_voto = 'falta';
        e.superada_por_evidencia = por;
        superou = true;
      }
      if (!superou || c.veredito === 'ATENDE') return;
      const resta = c.exigencias.some((e) => e.status === 'falta')
        || c.exigencias.some((e) => e.status === 'atendida' && !e.superada_por_evidencia && (!e.evidencia || !e.local))
        || !c.exigencias.some((e) => e.status === 'atendida');
      if (resta) return;
      c.elevado_por_evidencia = `${c.veredito} para ATENDE: a única falta era fora-do-alcance e outro avaliador a conferiu com evidência`;
      c.veredito = 'ATENDE';
      c.classe_da_perda = null;
    });
  }
  return ajustadas;
}

function combinarMeta(avaliacoesDosVotos, { criterios, regra = null, exigidos = 1 } = {}) {
  // Quem não leu não contradiz quem leu: falta fora-do-alcance superada pela evidência de outro voto.
  const avaliacoes = metaSuperarPorEvidencia(avaliacoesDosVotos, criterios.length);
  const n = avaliacoes.length;
  const aplicada = regra || META_REGRA_PADRAO;
  const porCriterio = criterios.map((texto, i) => {
    const votos = avaliacoes.map((a) => a.criterios[i]);
    const pontos = votos.map((v) => META_PONTOS[v.veredito]).sort((a, b) => b - a);
    const veredito = META_NIVEL_POR_PONTOS[pontos[Math.floor(n / 2)]];
    // A classe da perda: maioria dos votos que perderam; empate, `peca` (metaClassePorMaioria).
    const porClasse = metaClassePorMaioria(votos.filter((v) => v.veredito !== 'ATENDE').map((v) => v.classe_da_perda));
    const classe = veredito === 'ATENDE' ? null : (porClasse.classe || 'peca');
    // Redações diferentes do mesmo defeito viram um item só (metaMesmaFalta), com as
    // outras redações em `redacoes`. A falta entra no grupo se for a mesma que algum
    // membro e não for incompatível com nenhum (`metaFaltasIncompativeis`): uma redação
    // larga ("qualificação das partes: CPF/CNPJ, e-mail") não emenda dois defeitos (CPF
    // da autora, CNPJ do réu) num item só. Medido na
    // reavaliação de 24/09/2026 (novo2): o despejo C1 juntava e-mail (`peca`) e CPF
    // (`dado-ausente`) pela semelhança que a remissão "CPC 319, II" inflava.
    const exigenciasCom = (aceita) => {
      const grupos = [];
      votos.forEach((v, k) => {
        for (const e of v.exigencias) {
          if (!aceita(e) || !metaChave(e.exigencia)) continue;
          let grupo = grupos.find((g) => g.membros.some((m) => metaMesmaFalta(m, e)) && !g.membros.some((m) => metaFaltasIncompativeis(m, e)));
          if (!grupo) { grupo = { membros: [], avaliadores: [] }; grupos.push(grupo); }
          grupo.membros.push(e);
          if (!grupo.avaliadores.includes(k + 1)) grupo.avaliadores.push(k + 1);
        }
      });
      return grupos.map(({ membros, avaliadores }) => {
        const [primeira] = membros;
        const item = { exigencia: primeira.exigencia, evidencia: primeira.evidencia, local: primeira.local, classe: primeira.classe, avaliadores: avaliadores.sort((a, b) => a - b) };
        const classes = membros.map((m) => m.classe).filter(Boolean);
        if (new Set(classes).size > 1) item.classe = metaClassePorMaioria(classes).classe;
        const outras = metaUniao(membros.slice(1).map((m) => m.exigencia)).filter((r) => metaChave(r) !== metaChave(primeira.exigencia));
        if (outras.length) item.redacoes = outras;
        const pendencia = membros.find((m) => m.pendencia);
        if (pendencia) item.pendencia = pendencia.pendencia;
        const recusada = membros.find((m) => m.recusada_por_codigo);
        if (recusada) item.recusada_por_codigo = recusada.recusada_por_codigo;
        const reclassificada = membros.find((m) => m.reclassificada_por_codigo);
        if (reclassificada) item.reclassificada_por_codigo = reclassificada.reclassificada_por_codigo;
        return item;
      });
    };
    return {
      n: i + 1,
      criterio: texto,
      veredito,
      pontos: META_PONTOS[veredito],
      votos: votos.map((v) => v.veredito),
      unanime: votos.every((v) => v.veredito === votos[0].veredito),
      classe_da_perda: classe,
      classe_da_perda_votos: veredito === 'ATENDE' ? null : porClasse.votos,
      classe_por_empate: veredito !== 'ATENDE' && porClasse.empate,
      faltas: exigenciasCom((e) => e.status === 'falta'),
      // Faltas fora-do-alcance que outro avaliador conferiu com evidência: contam como atendidas.
      superadas_por_evidencia: votos.flatMap((v, k) => v.exigencias.filter((e) => e.superada_por_evidencia).map((e) => ({ avaliador: k + 1, exigencia: e.exigencia, superada_por_evidencia: e.superada_por_evidencia }))),
      posteriores: exigenciasCom((e) => e.status === 'posterior'),
      // Atendidas por dado ausente, com a diligência listada no manifesto: não pesam na
      // nota e são o que o profissional resolve antes do protocolo.
      dados_ausentes: exigenciasCom((e) => e.status === 'atendida' && e.classe === 'dado-ausente' && !e.superada_por_evidencia),
      // O que o código leu na evidência porque o avaliador não preencheu: quantos `local` e
      // quais `pendencia` (o marcador e como foi achado), para o humano conferir a derivação.
      derivados_por_codigo: {
        local: votos.reduce((t, v) => t + v.exigencias.filter((e) => e.local_derivado_por_codigo).length, 0),
        pendencia: votos.flatMap((v, k) => v.exigencias.filter((e) => e.pendencia_derivada_por_codigo).map((e) => ({ avaliador: k + 1, exigencia: e.exigencia, pendencia: e.pendencia, como: e.pendencia_derivada_por_codigo }))),
      },
      rebaixados_por_codigo: votos.map((v, k) => (v.rebaixado_por_codigo ? `avaliador ${k + 1}: ${v.rebaixado_por_codigo}` : null)).filter(Boolean),
      // Votos cuja classe `dado-ausente` virou `peca` porque a falta era de dado público ou de elemento da peça.
      elevados_por_evidencia: votos.map((v, k) => (v.elevado_por_evidencia ? `avaliador ${k + 1}: ${v.elevado_por_evidencia}` : null)).filter(Boolean),
      reclassificados_por_codigo: votos.map((v, k) => (v.classe_reclassificada_por_codigo ? `avaliador ${k + 1}: ${v.classe_reclassificada_por_codigo}` : null)).filter(Boolean),
    };
  });
  const soma = porCriterio.reduce((t, c) => t + c.pontos, 0);
  const nota = criterios.length ? Math.round((100 * soma) / (2 * criterios.length)) : 0;
  const cs = (lista) => lista.map((k) => `C${k}`).join(', ');
  const emNao = porCriterio.filter((c) => c.veredito === 'NAO').map((c) => c.n);
  const emParcial = porCriterio.filter((c) => c.veredito === 'PARCIAL').map((c) => c.n);
  const falhas = [];
  if (emNao.length > aplicada.nao_max) falhas.push({ parte: 'nao_max', detalhe: `${emNao.length} critério(s) em NAO (${cs(emNao)}); a regra admite ${aplicada.nao_max}` });
  if (aplicada.parcial_max !== null && emParcial.length > aplicada.parcial_max) falhas.push({ parte: 'parcial_max', detalhe: `${emParcial.length} critério(s) em PARCIAL (${cs(emParcial)}); a regra admite ${aplicada.parcial_max}` });
  const semAtende = aplicada.atende_obrigatorios.filter((k) => k <= porCriterio.length && porCriterio[k - 1].veredito !== 'ATENDE');
  if (semAtende.length) falhas.push({ parte: 'atende_obrigatorios', detalhe: `${cs(semAtende)} sem ATENDE; a regra exige ATENDE em ${cs(aplicada.atende_obrigatorios)}` });
  if (aplicada.parcial_permitidos) {
    const fora = emParcial.filter((k) => !aplicada.parcial_permitidos.includes(k));
    if (fora.length) falhas.push({ parte: 'parcial_permitidos', detalhe: `PARCIAL em ${cs(fora)}; a regra só admite PARCIAL em ${cs(aplicada.parcial_permitidos) || 'nenhum critério'}` });
  }
  if (aplicada.nota_min !== null && nota < aplicada.nota_min) falhas.push({ parte: 'nota_min', detalhe: `nota ${nota} abaixo da mínima ${aplicada.nota_min}` });
  const aprovado = falhas.length === 0;
  return {
    avaliadores: n,
    exigidos,
    regra: aplicada,
    limiar: aplicada.nota_min,
    nota,
    verdict: aprovado ? 'APROVADO' : 'REPROVADO',
    falhas_da_regra: falhas,
    motivo: aprovado ? `nota ${nota}; a regra de entrega foi cumprida em todas as partes` : falhas.map((f) => `${f.parte}: ${f.detalhe}`).join('; '),
    atendidos: porCriterio.filter((c) => c.veredito === 'ATENDE').length,
    total: porCriterio.length,
    divergentes: porCriterio.filter((c) => !c.unanime).map((c) => c.n),
    // A nota de cada voto, recalculada dos vereditos já normalizados (nunca a que o avaliador escreveu).
    notas_por_avaliador: avaliacoes.map((a) => (criterios.length ? Math.round((100 * a.criterios.reduce((t, c) => t + META_PONTOS[c.veredito], 0)) / (2 * criterios.length)) : 0)),
    campos_ignorados: metaUniao(avaliacoes.map((a) => a.campos_ignorados || [])),
    criterios: porCriterio,
    sugestoes: metaUniao(avaliacoes.map((a) => a.sugestoes || [])),
    sugestoes_fora_da_rubrica: metaUniao(avaliacoes.map((a) => a.sugestoes_fora_da_rubrica || [])),
  };
}
// <<< meta-consenso:end

/** A raiz do projeto é duas pastas acima de `squads/<nome>`; é dela que o perfil vem. */
function perfilDoProjeto(dir) {
  return lerPerfil(resolve(dir, '..', '..'));
}

/** O ritmo gravado no ledger do run atual (`ritmo --set`), ou null. */
function ritmoDoRun(dir) {
  let ledger;
  try { ledger = loadRunLedger(dir); } catch { ledger = null; }
  return ledger && typeof ledger.ritmo === 'string' ? ledger.ritmo : null;
}

/** Os ajustes por botão gravados no ledger do run (`ritmo --ciclos`, `--verificadores`...), ou {}. */
function ajustesDoRun(dir) {
  let ledger;
  try { ledger = loadRunLedger(dir); } catch { ledger = null; }
  return ledger && ledger.ritmo_ajustes && typeof ledger.ritmo_ajustes === 'object' ? ledger.ritmo_ajustes : {};
}

/** Perfil do projeto combinado com o ritmo e os ajustes do run: o que vale nos tetos deste run. */
function perfilDoRun(dir) {
  return perfilEfetivo(resolve(dir, '..', '..'), ritmoDoRun(dir), ajustesDoRun(dir));
}

/**
 * Rebaixa ao teto do ritmo e avisa: rebaixamento mudo é o que este mecanismo existe para evitar.
 * Com `silencioso`, não avisa e devolve `{ valor, rebaixado, ritmo }`: quem chama compõe um aviso
 * só, quando há outra regra na mesma conta (o piso do gate final de citações).
 */
function tetoDoPerfil(dir, botao, pedido, rotulo, { silencioso = false } = {}) {
  const perfil = perfilDoRun(dir);
  const r = aplicarTeto(perfil, botao, pedido);
  if (silencioso) return { valor: r.valor, rebaixado: !!r.rebaixado, ritmo: perfil.nome };
  if (r.rebaixado) console.error(`ritmo ${perfil.nome}: ${rotulo} rebaixado de ${pedido} para ${r.valor} (teto do ritmo deste run ou do perfil do projeto em _legalsquad/_memory/perfil.json)`);
  return r.valor;
}

/**
 * `ritmo --set rapido|equilibrado|completo` grava no ledger do run o ritmo que o
 * profissional escolheu na parada intake; sem `--set`, mostra o que vale. O
 * `run-status` devolve o mesmo campo, então a retomada não repergunta.
 */
function cmdRitmo(dir, flags) {
  // Ajuste fino por botão, por cima do ritmo: "equilibrado, mas com 3 ciclos".
  const inteiro = (valor, nome) => {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1) die(`--${nome} requer um inteiro maior ou igual a 1`);
    return n;
  };
  const simNao = (valor, nome) => {
    const v = String(valor).trim().toLowerCase();
    if (['sim', 'on', 'true', '1'].includes(v)) return true;
    if (['nao', 'não', 'off', 'false', '0'].includes(v)) return false;
    return die(`--${nome} aceita sim ou nao`);
  };
  const ajustes = {};
  if (flags.ciclos !== undefined) ajustes.max_review_cycles = inteiro(flags.ciclos, 'ciclos');
  // Verificadores por gate (citações e persuasão). Os avaliadores da meta não
  // têm ajuste por run: são os `meta_verifiers` do squad (ver `meta-consenso`).
  if (flags.verificadores !== undefined) ajustes.citation_verifiers = inteiro(flags.verificadores, 'verificadores');
  if (flags.persuasao !== undefined) ajustes.persuasao = simNao(flags.persuasao, 'persuasao');
  if (flags['red-team'] !== undefined) ajustes.red_team = simNao(flags['red-team'], 'red-team');
  const nome = flags.set !== undefined ? nomeDeRitmo(flags.set) : null;
  if (flags.set !== undefined && !nome) die(`ritmo desconhecido: "${flags.set}" (use ${RITMOS.join(', ')})`);
  if (nome || Object.keys(ajustes).length) {
    let ledger;
    try { ledger = loadRunLedger(dir); } catch { ledger = null; }
    if (!ledger || !ledger.runId) die('ritmo requer um run aberto (rode `squad-state init` antes)');
    atualizarRunLedger(dir, (l) => ({ ...l, ...(nome ? { ritmo: nome } : {}), ritmo_ajustes: { ...(l.ritmo_ajustes || {}), ...ajustes } }));
  }
  const perfil = perfilDoRun(dir);
  console.log(JSON.stringify({ ritmo: perfil.ritmo, ajustes: perfil.ajustes || {}, perfil: perfil.nome, gates: perfil.gates, descricao: descreverPerfil(perfil) }, null, 2));
  // Como o run-status: a saída é o JSON, sem a linha "state.json atualizado" atrás.
  return null;
}

/**
 * `meta-consenso <squad-dir> --avaliacao <arq> [--avaliacao <arq> ...]` combina as
 * avaliações do `avaliador-squad` na Verificação da Meta, critério a critério.
 * Cada arquivo é o retorno de UM avaliador (o JSON `avaliacao_meta`, puro ou num
 * bloco ```json). A rubrica é a do squad.yaml; a regra de entrega, o `meta_limiar`
 * do squad.yaml (sem ele, o padrão do motor: nenhum NAO e nota 85, com aviso se o
 * `quality-criteria.md` fala de limiar em texto, que o código não lê); o número
 * mínimo de avaliações, o `meta_verifiers` do squad, que o ritmo do run não
 * rebaixa. Não há flag para mudar nenhum dos três. Imprime a decisão em JSON: `acao: concluir` (exit 0),
 * `apresentar-falhas` (REPROVADO, exit 3, para não passar despercebido),
 * `redespachar` (avaliação faltando ou ilegível, exit 1, nada combinado) ou
 * `refazer-avaliacao` (exit 1, nada combinado): voto ATENDE com campo obrigatório ausente
 * (`local`, `evidencia`, `pendencia`) que a evidência não mostra. Formato não vira nota
 * (medido em 24/09/2026: a negativação saiu 50 com 18 votos ATENDE, porque ninguém preencheu
 * `local`); o runner redespacha aquele avaliador uma vez e roda de novo com `--formato-refeito`,
 * e aí a que continua fora do formato é ilegível (`redespachar`, em contexto fresco).
 * `--manifesto` é o `<peça>-final.md.citation-gate.json`; sem a flag, o do `output`
 * que as avaliações declaram. É dele que sai a lista `pendencias_do_profissional[]`
 * contra a qual o consenso confere cada exigência dada por dado ausente; sem
 * manifesto, nenhuma se aceita (e o comando avisa). Os steps posteriores à meta saem
 * do `pipeline.yaml` (`steps_posteriores` na saída): exigência `posterior` que não
 * cita um deles, que aponta a própria peça, que cita só parada humana (checkpoint)
 * ou que é do que a conferência produz (relatório de entrega, nota de conferência,
 * manifesto) sem step de agente que grave o arquivo, volta a falta. A falta
 * `dado-ausente` de dado público ou de elemento da peça é reclassificada como `peca`. `limiar`, `nota` e
 * `verdict` que o avaliador escreva são ignorados (`campos_ignorados`). A sugestão
 * (em `sugestoes` ou `sugestoes_fora_da_rubrica`) que repete uma exigência de um
 * critério ATENDE, pelo texto do critério ou pelas cláusulas PARCIAL e NÃO do
 * `pipeline/data/quality-criteria.md`, vira falta daquele critério
 * (`recusada_por_codigo: "sugestao-repete-exigencia"`) e o voto cai para PARCIAL.
 */
function manifestoDaMeta(dir, flags, brutas) {
  const raizDoProjeto = resolve(dir, '..', '..');
  const achar = (caminho) => [caminho, isAbsolute(caminho) ? null : join(raizDoProjeto, caminho)].filter(Boolean).find((c) => existsSync(c)) || null;
  let caminho = null;
  if (typeof flags.manifesto === 'string' && flags.manifesto.trim()) {
    caminho = achar(flags.manifesto.trim());
    if (!caminho) die(`--manifesto ${flags.manifesto}: arquivo não existe; nada foi combinado`);
  } else {
    for (const av of brutas) {
      const saida = av && typeof av.output === 'string' ? av.output.trim() : '';
      if (!saida || /[{}]/.test(saida)) continue;
      caminho = achar(`${saida}.citation-gate.json`);
      if (caminho) break;
    }
  }
  if (!caminho) return { caminho: null, pendencias: null, pendenciasOnde: null, raiz: raizDoProjeto };
  let manifesto;
  try { manifesto = JSON.parse(readFileSync(caminho, 'utf-8')); } catch (e) { die(`manifesto ${caminho} ilegível (${e.message}); nada foi combinado`); }
  // Com o `onde` de cada entrada: é por ele que o código acha o marcador que a evidência mostra
  // quando o avaliador não preencheu `pendencia` (mesma linha ou mesma seção).
  return { caminho, pendencias: pendenciasDoManifesto(manifesto), pendenciasOnde: pendenciasDoManifesto(manifesto, { detalhe: true }), raiz: raizDoProjeto };
}

/**
 * A peça avaliada (`{ nome, texto }`), para o consenso recusar `posterior` que aponta
 * a própria peça: o `output` que as avaliações declaram ou, sem ele, o manifesto sem
 * o `.citation-gate.json`. Sem arquivo legível, só o nome (ou null).
 */
function pecaDaMeta(manifesto, brutas) {
  const candidatos = [];
  for (const av of brutas) {
    const saida = av && typeof av.output === 'string' ? av.output.trim() : '';
    if (saida && !/[{}]/.test(saida)) candidatos.push(saida);
  }
  if (manifesto.caminho && manifesto.caminho.endsWith('.citation-gate.json')) candidatos.push(manifesto.caminho.slice(0, -'.citation-gate.json'.length));
  for (const c of candidatos) {
    const caminho = [c, isAbsolute(c) ? null : join(manifesto.raiz, c)].filter(Boolean).find((x) => existsSync(x));
    if (!caminho) continue;
    try { return { nome: basename(caminho), texto: readFileSync(caminho, 'utf-8') }; } catch { /* segue */ }
  }
  return candidatos.length ? { nome: basename(candidatos[0]), texto: null } : null;
}

// Medido em 26/09/2026 (mandado de segurança, motor 0.9.54): as três avaliações da primeira rodada
// vieram sem `veredito` por critério. O agente carregado na sessão era o de antes da 0.9.46 (bloco YAML
// `avaliacao`), porque a sessão fora aberta antes do update, e o despacho dizia "não declare limiar, nota
// final nem veredito final"; o avaliador conciliou os dois tirando o voto. Com o esqueleto no despacho,
// a rodada seguinte veio no formato.
const DICA_DO_FORMATO_DA_META = 'Avaliação sem `veredito` por critério ou no formato YAML antigo: o agente carregado na sessão pode ser anterior ao update (a sessão guarda a definição do agente até ser reaberta), ou o despacho foi lido como proibição do voto. Redespache com o esqueleto do formato no próprio despacho ({"avaliacao_meta":{"criterios":[{"n":1,"criterio":"...","veredito":"ATENDE|PARCIAL|NAO","exigencias":[{"exigencia":"...","status":"atendida|falta|posterior","evidencia":"...","local":"...","classe":null,"pendencia":"..."}],"classe_da_perda":null}]}}), dizendo que o veredito de cada critério é obrigatório e que o que o avaliador não declara é o limiar, a nota geral e o veredito final; depois do run, reabra a sessão';
function formatoAntigoDoAvaliador(invalida) {
  const erros = invalida && Array.isArray(invalida.erros) ? invalida.erros : [];
  return erros.some((e) => /formato antigo do avaliador|sem `veredito`/.test(e));
}

function cmdMetaConsenso(dir, flags) {
  const squadPath = join(dir, 'squad.yaml');
  if (!existsSync(squadPath)) die(`squad.yaml não encontrado em ${dir}`);
  const squadYaml = readFileSync(squadPath, 'utf-8');
  const pipelinePath = join(dir, 'pipeline', 'pipeline.yaml');
  const pipelineYaml = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '';
  const criterios = criteriosDoSquadYaml(squadYaml);
  if (!criterios.length) die('squad.yaml sem success_criteria legíveis: não há rubrica a combinar');
  const exigidos = avaliadoresDaMeta(squadYaml, pipelineYaml);
  const declarada = metaLimiarDoSquadYaml(squadYaml, criterios.length);
  if (declarada.presente && declarada.erros.length) die(`meta_limiar do squad.yaml ilegível, nada foi combinado: ${declarada.erros.join('; ')}`);
  const rubricaPath = join(dir, 'pipeline', 'data', 'quality-criteria.md');
  const qualityCriteria = existsSync(rubricaPath) ? readFileSync(rubricaPath, 'utf-8') : '';
  const avisos = [];
  if (!declarada.presente && qualityCriteria && rubricaDeclaraLimiarEmTexto(qualityCriteria)) {
    avisos.push('o pipeline/data/quality-criteria.md declara o limiar em texto, que o código não lê: usado o padrão do motor (nenhum NAO e nota 85). Declare a regra em `meta_limiar` no squad.yaml para o veredito seguir a rubrica do squad');
  }
  const limiarFonte = declarada.presente ? 'squad.yaml:meta_limiar' : 'padrao-do-motor';

  const arquivos = asList(flags.avaliacao).filter((v) => typeof v === 'string' && v.trim());
  const validas = [];
  const invalidas = [];
  const lidas = [];
  for (const arquivo of arquivos) {
    if (!existsSync(arquivo)) { invalidas.push({ arquivo, erros: ['arquivo não existe'] }); continue; }
    const bruto = readFileSync(arquivo, 'utf-8');
    const av = extrairAvaliacaoMeta(bruto);
    if (!av) {
      // O formato antigo do agente (bloco YAML `avaliacao:` com nota e veredito) ainda aparece quando
      // a sessão foi aberta antes do update: a definição do agente fica carregada até a sessão reabrir.
      const antigo = /^\s*avaliacao:\s*$/m.test(bruto);
      invalidas.push({ arquivo, erros: [antigo ? 'bloco YAML `avaliacao` do formato antigo do avaliador, não o JSON `avaliacao_meta`' : 'sem o JSON `avaliacao_meta` (arquivo JSON ou bloco ```json)'] });
      continue;
    }
    lidas.push({ arquivo, av });
  }
  const manifesto = manifestoDaMeta(dir, flags, lidas.map((l) => l.av));
  const alegaDadoAusente = lidas.some(({ av }) => (av.criterios || []).some((c) => (Array.isArray(c && c.exigencias) ? c.exigencias : [])
    .some((e) => e && metaClasse(e.classe) === 'dado-ausente' && metaSemAcento(e.status).toLowerCase() === 'atendida')));
  if (!manifesto.caminho && alegaDadoAusente) {
    avisos.push('sem o manifesto da final (`--manifesto` ou `<output>.citation-gate.json`): nenhuma exigência foi aceita como dado ausente, porque `pendencias_do_profissional[]` não pôde ser conferida');
  }
  // `posterior` só vale para step depois da meta, pelo pipeline (não pelo que o avaliador declara),
  // e nunca para a própria peça.
  // Com o detalhe (tipo, parada humana, arquivos gravados): parada humana não cumpre exigência.
  const stepsPosteriores = stepsPosterioresDoPipeline(pipelineYaml, { detalhe: true });
  const peca = pecaDaMeta(manifesto, lidas.map((l) => l.av));
  const formatoRefeito = flags['formato-refeito'] === true;
  const refazer = [];
  for (const [i, { arquivo, av }] of lidas.entries()) {
    // A rubrica (critérios e cláusulas PARCIAL e NÃO) confere as sugestões: a que repete
    // uma exigência de critério ATENDE vira falta daquele critério.
    const normalizada = normalizarAvaliacaoMeta(av, criterios.length, { pendencias: manifesto.pendencias, pendenciasOnde: manifesto.pendenciasOnde, stepsPosteriores, peca, rubrica: { criterios, qualityCriteria } });
    if (normalizada.erros.length) { invalidas.push({ arquivo, erros: normalizada.erros }); continue; }
    // Formato não vira nota: campo obrigatório que o código não deriva da evidência devolve a
    // avaliação ao avaliador (uma vez). Depois de refeita, a que segue fora do formato sai do
    // consenso como ilegível e vai a um avaliador em contexto fresco.
    const fora = normalizada.fora_do_formato || [];
    if (fora.length) {
      const item = { arquivo, avaliador: Number.isInteger(av.avaliador) ? av.avaliador : i + 1, faltam: fora };
      if (formatoRefeito) invalidas.push({ arquivo, erros: fora.map((f) => `fora do formato depois de refeita: C${f.n}${f.exigencia ? ` "${f.exigencia}"` : ''} sem ${f.campos.join(', ')}`) });
      else refazer.push(item);
      continue;
    }
    validas.push({ arquivo, ...normalizada });
  }
  if (!invalidas.length && refazer.length) {
    console.log(JSON.stringify({
      acao: 'refazer-avaliacao',
      exigidos,
      recebidas: arquivos.length,
      validas: validas.length,
      refazer,
      detalhe: `${refazer.length} avaliação(ões) fora do formato: campo obrigatório ausente que a evidência não mostra. Não é falha da peça e não vira nota; nada foi combinado. Redespache UMA vez cada avaliador listado, em contexto fresco, com a mesma lista fechada e a lista \`faltam\` (em cada exigência atendida: \`evidencia\` com trecho e \`local\`; no dado ausente: \`pendencia\` com o marcador literal de \`pendencias_do_profissional[]\`), grave no mesmo arquivo e rode de novo com --formato-refeito`,
    }, null, 2));
    process.exitCode = 1;
    return null;
  }
  if (invalidas.length || validas.length < exigidos) {
    const faltam = Math.max(0, exigidos - validas.length);
    console.log(JSON.stringify({
      acao: 'redespachar',
      exigidos,
      recebidas: arquivos.length,
      validas: validas.length,
      invalidas,
      ...(refazer.length ? { refazer } : {}),
      detalhe: invalidas.length
        ? `${invalidas.length} avaliação(ões) ilegível(is): redespache o avaliador em contexto fresco para cada uma; nada foi combinado${invalidas.some(formatoAntigoDoAvaliador) ? `. ${DICA_DO_FORMATO_DA_META}` : ''}`
        : `o squad declara meta_verifiers: ${exigidos} e chegaram ${validas.length}: despache mais ${faltam} avaliador(es) em contexto fresco (o ritmo do run não rebaixa os avaliadores da meta)`,
    }, null, 2));
    process.exitCode = 1;
    return null;
  }
  const consenso = combinarMeta(validas, { criterios, regra: declarada.regra, exigidos });
  console.log(JSON.stringify({
    acao: consenso.verdict === 'APROVADO' ? 'concluir' : 'apresentar-falhas',
    limiar_fonte: limiarFonte,
    avisos,
    arquivos: validas.map((v) => v.arquivo),
    manifesto: manifesto.caminho,
    // Só step de agente: a parada humana (checkpoint) não cumpre exigência nenhuma, e listá-la
    // aqui a oferecia como `posterior` válido (H7, medido em 25/09/2026 na reclamação).
    steps_posteriores: Array.isArray(stepsPosteriores) ? stepsDeAgentePosteriores(stepsPosteriores).map((st) => st.id) : stepsPosteriores,
    ...consenso,
  }, null, 2));
  if (consenso.verdict !== 'APROVADO') process.exitCode = 3;
  return null;
}

/** Os steps posteriores à meta que são de agente (não parada humana): os únicos que cumprem `posterior`. */
function stepsDeAgentePosteriores(detalhados) {
  return detalhados.filter((st) => st.checkpoint !== true);
}

/**
 * `steps-posteriores`: a lista que o runner entrega aos avaliadores da meta, pelo código. Só os
 * steps de agente depois da meta, com os arquivos que gravam; as paradas humanas vão à parte,
 * em `paradas_excluidas`, para ninguém as oferecer como `posterior`. Medido em 25/09/2026
 * (reclamação, motor 0.9.53): a lista montada de cabeça trazia o step-12-aprovacao, dois
 * avaliadores deram C5 `posterior` para ele, e o `meta-consenso` recusou e derrubou o critério.
 */
function cmdStepsPosteriores(dir) {
  const pipelinePath = join(dir, 'pipeline', 'pipeline.yaml');
  const detalhados = existsSync(pipelinePath) ? stepsPosterioresDoPipeline(readFileSync(pipelinePath, 'utf-8'), { detalhe: true }) : null;
  if (!Array.isArray(detalhados)) die(`sem pipeline/pipeline.yaml com \`steps:\` legível em ${dir}: não há como listar os steps posteriores à meta`);
  const deAgente = stepsDeAgentePosteriores(detalhados);
  console.log(JSON.stringify({
    steps_posteriores: deAgente.map((st) => ({ id: st.id, saidas: st.saidas })),
    paradas_excluidas: detalhados.filter((st) => st.checkpoint === true).map((st) => st.id),
    detail: deAgente.length
      ? `${deAgente.length} step(s) de agente depois da meta: só eles cumprem exigência \`posterior\`; parada humana não entra na lista dos avaliadores`
      : 'nenhum step de agente depois da meta: nenhuma exigência se aceita como `posterior`',
  }, null, 2));
  return null;
}

function cmdInit(dir, flags) {
  const total = Number(flags.total);
  if (!Number.isInteger(total) || total < 0) die('init requer --total <N> (inteiro >= 0)');
  // O `run_id` é do CÓDIGO. `--run` continua aceito (retomada passa o id do run
  // interrompido, e squads antigos seguem valendo); ausente, o init gera,
  // desempata a colisão e cria a pasta do run — era a única aritmética que o
  // runner ainda fazia de cabeça na abertura.
  const runId = typeof flags.run === 'string' && flags.run.trim() ? flags.run.trim() : gerarRunId(dir);
  mkdirSync(join(dir, 'output', runId), { recursive: true });
  const perfil = perfilDoProjeto(dir);
  // Retomada (`--run` de um run ainda aberto): o ledger existente é dado do run
  // (checkpoints, ritmo, tempos). Reabri-lo do zero apagava a resposta que o
  // runner promete não reperguntar; o que muda é só o `total` e o carimbo.
  let existente;
  try { existente = typeof flags.run === 'string' && flags.run.trim() ? loadRunLedger(dir) : null; } catch { existente = null; }
  const retomado = existente && existente.runId === runId && existente.status === 'running' ? existente : null;
  writeJson(dir, RUN_LEDGER, retomado
    ? { ...retomado, step: { ...(retomado.step || { current: 0, label: '' }), total }, updatedAt: now() }
    : { ...abrirRun({ runId, squad: readSquadCode(dir), total, agora: now() }), perfil: perfil.nome, updatedAt: now() });
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
  // O perfil vai na resposta para o chefe dizer na abertura o que este run paga
  // de verificação, sem abrir arquivo nenhum; o ritmo vem quando é retomada.
  const ritmo = retomado && typeof retomado.ritmo === 'string' ? retomado.ritmo : null;
  const efetivo = retomado ? perfilEfetivo(resolve(dir, '..', '..'), ritmo, retomado.ritmo_ajustes) : perfil;
  console.log(JSON.stringify({ runId, total, runDir: `output/${runId}`, memoria, retomado: !!retomado, ritmo, perfil: { nome: efetivo.nome, gates: efetivo.gates, descricao: descreverPerfil(efetivo) } }, null, 2));
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
    return die(`${LEDGER} existente é JSON inválido: resolva à mão antes de continuar`);
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
    die(`gate "${gate}" não tem laço aberto: rode \`gate-open --gate ${gate}\` antes de registrar vereditos`);
  }
  return laco || null;
}

function saveLedger(dir, gate, laco) {
  const bruto = lerLedgerBruto(dir) || {};
  // `...bruto` preserva as outras chaves do cartório (as citações verificadas):
  // gravar só `loops` apagava a tabela registrada segundos antes pelo mesmo comando.
  writeJson(dir, LEDGER, { ...bruto, loops: { ...(bruto.loops || {}), [gate]: laco }, updatedAt: now() });
}

/**
 * Um gate pode abrir mais de um laço por run: o Citation Gate roda no step de
 * redação e de novo na conferência final. Medido no run de 15/09/2026: o segundo
 * `gate-open` gravava por cima do primeiro, e o termo e as métricas mostravam
 * só a última rodada — as três rodadas intermediárias sumiam do relatório. O laço
 * que sai de cena vai para `historico[gate]`, fechado com a hora, e nada se perde.
 * Devolve o que foi arquivado (o runner narra; um laço ainda aberto com ciclos
 * merece aviso, porque reabrir zera a contagem do teto).
 */
function arquivarLaco(dir, gate) {
  const bruto = lerLedgerBruto(dir) || {};
  const atual = bruto.loops ? bruto.loops[gate] : null;
  if (!atual) return null;
  const historico = bruto.historico && typeof bruto.historico === 'object' ? bruto.historico : {};
  const anteriores = Array.isArray(historico[gate]) ? historico[gate] : [];
  const arquivado = { ...atual, arquivadoEm: now() };
  writeJson(dir, LEDGER, { ...bruto, historico: { ...historico, [gate]: [...anteriores, arquivado] }, updatedAt: now() });
  return { loop: atual.loop, target: atual.target, status: atual.status, ciclos: Array.isArray(atual.cycles) ? atual.cycles.length : 0 };
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
  const maxPedido = flags.max === undefined ? undefined : Number(flags.max);
  if (maxPedido !== undefined && (!Number.isInteger(maxPedido) || maxPedido < 1)) die('--max precisa ser inteiro >= 1');
  // O teto de ciclos é do ritmo quando ele é menor que o pedido (ou que o
  // default do laço): ritmo rápido fecha em 1 ciclo, e é o código que garante.
  const max = tetoDoPerfil(dir, 'max_review_cycles', maxPedido === undefined ? DEFAULT_MAX_REVIEW_CYCLES : maxPedido, `teto de ciclos do gate "${gate}"`);
  const anterior = arquivarLaco(dir, gate);
  if (anterior && anterior.status === 'open' && anterior.ciclos > 0) {
    console.error(`aviso: o gate "${gate}" tinha um laço aberto (${anterior.loop} → ${anterior.target}, ${anterior.ciclos} ciclo(s)); foi arquivado e a contagem do teto recomeça neste laço novo`);
  }
  // `aberto_em` é o marco do gate final de citações: `citacoes-pendentes` no laço
  // citation-gate-final só conta como nova a confirmação registrada depois dele.
  const laco = { ...openReview({ loop: flags.loop, target: flags.target, maxCycles: max }), aberto_em: now() };
  saveLedger(dir, gate, laco);
  return emitDecision({ action: 'open', gate, loop: laco.loop, target: laco.target, maxCycles: laco.maxCycles, ...(anterior ? { laco_anterior: anterior } : {}) });
}

function cmdReviewVerdict(dir, flags) {
  const gate = nomeDoGate(flags);
  if (typeof flags.verdict !== 'string') die('gate-verdict requer --verdict APPROVE|REJECT');
  const expect = flags.expect === undefined ? 1 : Number(flags.expect);
  if (!Number.isInteger(expect) || expect < 1) die('--expect precisa ser inteiro >= 1');
  // O ritmo limita quantos votantes o runner despacha e quantos ciclos o laço
  // tem; nunca quantas vozes o ciclo espera. Medido em 23 e 24/09/2026 (motor
  // 0.9.44, ritmo equilibrado): o `--expect 2` rebaixado para 1 deixou o REJECT
  // do revisor fechar o ciclo sozinho, e o APPROVE do verificador de citações
  // virou um ciclo 2 "aprovado" sem redação nova (negativação, reclamação,
  // mandado de segurança). Um ciclo só fecha quando todas as vozes votam.
  const entry = {
    reviewer: str(flags.reviewer),
    verdict: flags.verdict,
    fixes: asList(flags.fix).filter((v) => typeof v === 'string'),
    ajustes: asList(flags.ajuste).filter((v) => typeof v === 'string'),
  };
  const laco = loadLedger(dir, gate, { required: true });
  // Veredito em laço aprovado ou escalado, ou de uma voz que já votou neste
  // ciclo, é recusado ANTES de tocar o cartório: nem o ciclo nem a tabela de
  // citações daquela voz entram. Sai com código 1 (erro de uso), não 3.
  const recusa = recusaDeVeredito(laco, entry);
  if (recusa) {
    console.error(`squad-state: veredito recusado no gate "${gate}": ${recusa.detail}`);
    console.log(JSON.stringify({ action: REVIEW_ACTIONS.REFUSE, ...recusa, gate, loop: laco.loop, target: laco.target, status: laco.status }, null, 2));
    process.exitCode = 1;
    return null;
  }
  // A tabela do verificador entra no cartório ANTES da decisão: o veredito de
  // cada citação sobrevive ao ciclo, e é o que a próxima rodada reaproveita.
  const citacoes = typeof flags.citacoes === 'string' ? registrarCitacoes(dir, flags.citacoes, { gate, reviewer: entry.reviewer }) : null;
  if (citacoes) {
    // O que esta voz contestou e confirmou vai com o veredito: APPROVE que
    // ainda traz contestada vira REJECT (medido no mandado de segurança, 24/09/2026:
    // reabertura APPROVE com 6 `fonte_mudou` fechou o laço aprovado).
    entry.contestadas = citacoes.contestadas_itens;
    entry.verificadas = citacoes.verificadas_itens;
    entry.verificadas_no_acervo = citacoes.verificadas_no_acervo_itens;
  }
  // Gate final de citações: o laço só fecha aprovado quando cada citação que as vozes do ciclo
  // conferiram ou contestaram soma as confirmações exigidas no cartório (o piso do gate final, ou
  // --confirmacoes, se maior). Faltando, o ciclo espera mais uma voz em vez de fechar.
  const faltamConfirmacoes = gate === 'citacao' && laco.loop === LACO_FINAL_DE_CITACOES ? confirmacoesQueFaltam(dir, [...pendentesDoCiclo(laco), entry], flags) : [];
  const { ledger, result } = applyVerdict(laco, entry, { expect, faltamConfirmacoes });
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
        // Os fixes do veredito: é neles que o registro descobre se a rejeição
        // cita a skill (dirigida) ou é do ciclo.
        fixes: entry.fixes,
      });
    } catch (erro) {
      console.error(`aviso: registro de uso de skills falhou (${erro.message}); veredito não afetado`);
    }
  }
  if (!citacoes) return emitDecision({ ...result, gate });
  // A lista das verificadas serve à decisão; na saída, basta a contagem.
  const resumoCitacoes = { ...citacoes };
  delete resumoCitacoes.verificadas_itens;
  delete resumoCitacoes.verificadas_no_acervo_itens;
  return emitDecision({ ...result, gate, citacoes: resumoCitacoes });
}

/**
 * As citações que as vozes do ciclo tocaram (conferiram ou contestaram) e que o cartório ainda
 * não tem com as confirmações exigidas: `{ title, confirmacoes, faltam }`. Exigidas: o piso do
 * gate final, ou `--confirmacoes N`, se maior; o ritmo não rebaixa (como em `citacoes-pendentes`).
 */
function confirmacoesQueFaltam(dir, vozes, flags) {
  const pedido = flags.confirmacoes === undefined ? 0 : Number(str(flags.confirmacoes));
  if (flags.confirmacoes !== undefined && (!Number.isInteger(pedido) || pedido < 1)) die('--confirmacoes requer um inteiro maior ou igual a 1');
  const exigidas = Math.max(PISO_DE_CONFIRMACOES_FINAL, pedido);
  const ledger = lerCitacoesDoLedger(dir);
  const tocadas = new Map();
  for (const voz of vozes) {
    for (const t of Array.isArray(voz && voz.verificadas) ? voz.verificadas : []) tocadas.set(chaveDeTitulo(t), t);
    for (const c of Array.isArray(voz && voz.contestadas) ? voz.contestadas : []) if (c && c.title) tocadas.set(chaveDeTitulo(c.title), c.title);
  }
  const faltam = [];
  for (const [chave, title] of tocadas) {
    const v = ledger.verificadas[chave];
    if (!v) continue; // contestada que ninguém reconfirmou: o próprio ciclo já reprova
    const confirmacoes = contarConfirmacoes(v);
    if (confirmacoes < exigidas) faltam.push({ title, confirmacoes, faltam: exigidas - confirmacoes });
  }
  return faltam;
}

function cmdReviewStatus(dir, flags) {
  const gate = nomeDoGate(flags);
  return emitDecision({ ...resumeReview(loadLedger(dir, gate)), gate });
}

// A decisão do profissional num laço escalado entra no ledger (defeito 25, 24/09/2026): com
// `corrigir`, o laço reabre com um ciclo só, o da conferência da correção; com `seguir`, fecha
// com as pendências como ressalvas. Sem isso, a correção pós-teto entrava sem conferência.
function cmdGateDecisao(dir, flags) {
  const gate = nomeDoGate(flags);
  if (typeof flags.decisao !== 'string') die(`gate-decisao requer --decisao ${DECISOES_DE_ESCALADA.join('|')}`);
  const laco = loadLedger(dir, gate, { required: true });
  const { ledger, result } = resolveEscalation(laco, flags.decisao.trim(), { por: str(flags.por) });
  if (result.action === REVIEW_ACTIONS.REFUSE) {
    console.error(`squad-state: decisão recusada no gate "${gate}": ${result.detail}`);
    console.log(JSON.stringify({ ...result, gate }, null, 2));
    process.exitCode = 1;
    return null;
  }
  saveLedger(dir, gate, ledger);
  return emitDecision({ ...result, gate });
}

/** Laços de qualidade que ainda impedem a entrega (escalados sem decisão ou correção sem conferência). */
function lacosPendentesDeConclusao(dir) {
  const bruto = lerLedgerBruto(dir);
  const loops = bruto && bruto.loops && typeof bruto.loops === 'object' ? bruto.loops : {};
  return ['revisao', 'citacao', 'redacao', 'persuasao', 'conferencia']
    .map((gate) => ({ gate, pendencia: lacoPendenteDeConclusao(loops[gate]) }))
    .filter((l) => l.pendencia)
    .map((l) => ({ gate: l.gate, ...l.pendencia }));
}

// Marcadores de pendência (cópia do bloco canônico de src/pendencia.js): o `manifesto-final`
// lê os marcadores de dado da peça com a mesma regex do hook, para a lista de
// `pendencias_do_profissional[]` sair igual à que o hook confere.
// >>> pendencia:begin
/**
 * Regras da gramática: a palavra-chave em CAIXA ALTA (é assim que o runner, as
 * skills e o ensaio a escrevem), com carga opcional depois de dois-pontos,
 * travessão, hífen ou espaço (`[CONFERIR: a vara]`, `[CONFIRMAR COM A AUTORA]`).
 * Caixa alta é o que separa o marcador de um link Markdown (`[Conferir o
 * inteiro teor](url)`) e de um termo técnico entre colchetes (`[hipótese de
 * incidência]`): com a flag `i`, os dois bloqueavam a gravação da final.
 * Colchete seguido de `(` é link, nunca marcador.
 */
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O|PREENCHER|A[ _]PREENCHER|DILIG[ÊE]NCIA)(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
/**
 * Marcador de DADO (o fato que depende do profissional ou do cliente), separado do
 * de citação na medição dos moldes de 24/09/2026 (G11). O de citação trava a final
 * sempre; o de dado passa se o manifesto o lista em `pendencias_do_profissional[]`,
 * e a parada aprovação o mostra. Testado sobre um marcador já casado por PENDING_MARKER.
 */
const DATA_MARKER = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:—–-]|\])/;
/** Tema sem âncora apontado pelo verificador de persuasão: contado à parte (não trava hoje). */
const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
// <<< pendencia:end
// O bloco vem inteiro para não divergir; aqui o marcador de tema não é usado.
void TEMA_MARKER;

// --- Citações verificadas: o veredito vale por citação, não por ciclo ---------
// Medido num run real (15/09/2026): cada rodada de revisão reverificava as 24
// citações do zero, com a web no meio, e custava 40 minutos para corrigir seis
// linhas. Aqui o cartório guarda, por citação, o que já foi conferido neste run
// (título, fonte, hora, quem conferiu); `citacoes-pendentes` compara a versão
// atual da peça com o que está guardado e diz ao verificador o que ainda falta.
// Uma citação que um verificador contestou (DIVERGENTE, NÃO ENCONTRADA,
// acesso_falhou, fonte_mudou) sai das verificadas na hora: contestação recente
// vence confirmação antiga, e leva junto as confirmações acumuladas.
//
// Cada entrada verificada acumula `confirmacoes[]` (quem conferiu, em que gate,
// quando, com que hash): é o consenso do gate final, contado por código em vez
// de reabrir tudo três vezes. Uma confirmação é distinta por verificador e
// consulted_at, e a evidência de acesso (`evidence`: hash do texto ou dos
// bytes, trecho, cópia local, registro do STJ) fica guardada para a reabertura
// por código (`scripts/fonte-oficial.mjs --reabrir`) comparar sem LLM.
const STATUS_VERIFICADA = 'verificada';
// A conferência na cópia do acervo assinado (a captura oficial do curador), declarada como tal.
// Conta como confirmação e tira a contestação de acesso (acesso_falhou), mas a origem fica no
// cartório, no manifesto e no que o avaliador lê: nunca se apresenta como a página do tribunal
// aberta no run. Medido na medição de 24/09/2026 (G19, defeito 14): na contestação trabalhista,
// dez verbetes e Temas do TST foram conferidos só no acervo e registrados como `verificada`, e a
// meta os leu como verificação em fonte oficial que não houve (critério 4 em PARCIAL).
const STATUS_NO_ACERVO = 'verificada_no_acervo';
const ehCopiaDoAcervo = (caminho) => typeof caminho === 'string' && /(^|[\\/])acervo[\\/]/.test(caminho);
const STATUS_CONTESTADA = new Set(['divergente', 'nao_encontrada', 'nao-encontrada', 'acesso_falhou', 'acesso-falhou', 'fonte_mudou', 'fonte-mudou']);
// A reabertura por código que não teve o que comparar (sem hash nem trecho, sem fonte, trecho
// não localizado). Não é contestação: não apaga confirmações; só não conta como confirmação nova,
// e o gate final manda a citação a um votante (G3 da medição de 24/09/2026).
const STATUS_SEM_EVIDENCIA = new Set(['sem_evidencia', 'sem-evidencia', 'sem_hash', 'sem-hash']);
// Piso de confirmações do gate final: o ritmo rebaixa --confirmacoes nos gates intermediários,
// nunca abaixo disto no final (G3: rebaixado para 1, o final respondia nada-a-verificar sem voto).
const PISO_DE_CONFIRMACOES_FINAL = 2;
const LACO_FINAL_DE_CITACOES = 'citation-gate-final';
const CAMPOS_DE_EVIDENCIA = ['sha256_texto', 'sha256_bytes', 'trecho', 'fonte_local', 'registro', 'dt_publicacao'];
const RE_SHA256 = /^[a-f0-9]{64}$/i;

/** Evidência de acesso: aceita no topo da entrada ou em `evidence`; hash malformado é descartado (vira aviso, não recusa). */
function evidenciaDe(entrada, avisos, title) {
  const ev = entrada && entrada.evidence && typeof entrada.evidence === 'object' ? entrada.evidence : {};
  const saida = {};
  for (const campo of CAMPOS_DE_EVIDENCIA) {
    const bruto = typeof entrada[campo] === 'string' ? entrada[campo] : typeof ev[campo] === 'string' ? ev[campo] : '';
    const valor = bruto.trim();
    if (!valor) continue;
    if (campo.startsWith('sha256_') && !RE_SHA256.test(valor)) {
      avisos.push(`"${title}": ${campo} malformado, ignorado`);
      continue;
    }
    saida[campo] = campo.startsWith('sha256_') ? valor.toLowerCase() : valor;
  }
  return saida;
}

/** Evidência que a reabertura consegue comparar: hash do texto ou dos bytes, ou trecho literal. */
function temEvidencia(ev) {
  return !!(ev && (ev.sha256_texto || ev.sha256_bytes || ev.trecho));
}

function contarConfirmacoes(entrada) {
  // Entrada gravada antes do consenso por código (sem `confirmacoes[]`) foi conferida por um verificador: conta uma.
  return Array.isArray(entrada && entrada.confirmacoes) ? entrada.confirmacoes.length : 1;
}

function chaveDeTitulo(titulo) {
  return String(titulo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function statusNormalizado(status) {
  return String(status || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
}

function lerCitacoesDoLedger(dir) {
  const bruto = lerLedgerBruto(dir) || {};
  const c = bruto.citacoes && typeof bruto.citacoes === 'object' ? bruto.citacoes : {};
  return { verificadas: { ...(c.verificadas || {}) }, contestadas: { ...(c.contestadas || {}) } };
}

function gravarCitacoesNoLedger(dir, citacoes) {
  const bruto = lerLedgerBruto(dir) || {};
  writeJson(dir, LEDGER, { ...bruto, loops: bruto.loops || {}, citacoes, updatedAt: now() });
}

/**
 * O que `fonte-oficial.mjs` baixou neste run (`output/<run>/fontes/INDEX.jsonl`, só `ok`): por
 * URL (a pedida e a final), os hashes da cópia; e por hash, as URLs. Sem run ou sem índice, null.
 */
function indiceDeFontesDoRun(dir) {
  // Lido à parte, sem `loadRunLedger`: ledger ilegível aqui só desliga a conferência, não o veredito.
  let run;
  try { run = JSON.parse(readFileSync(join(dir, RUN_LEDGER), 'utf-8')); } catch { run = null; }
  if (!run || typeof run.runId !== 'string' || !run.runId) return null;
  const caminho = join(dir, 'output', run.runId, 'fontes', 'INDEX.jsonl');
  if (!existsSync(caminho)) return null;
  const porUrl = new Map();
  const porHash = new Map();
  for (const linha of readFileSync(caminho, 'utf-8').split('\n')) {
    let e;
    try { e = JSON.parse(linha); } catch { continue; }
    if (!e || e.status !== 'ok') continue;
    const hashes = [e.sha256_texto, e.sha256_bytes].filter((h) => typeof h === 'string' && RE_SHA256.test(h)).map((h) => h.toLowerCase());
    for (const url of new Set([e.url, e.url_final].filter((u) => typeof u === 'string' && u))) {
      porUrl.set(url, new Set([...(porUrl.get(url) || []), ...hashes]));
      for (const h of hashes) porHash.set(h, new Set([...(porHash.get(h) || []), url]));
    }
  }
  return { caminho, porUrl, porHash };
}

/**
 * A tabela que junta a URL de uma página ao hash de outra: o hash é o de uma cópia que o índice
 * do run registra sob OUTRA URL, e nenhuma cópia da URL declarada tem esse hash. Medido na
 * contestação de 24/09/2026 (motor 0.9.49): a OJ 233 entrou com a URL do livro de súmulas e OJs
 * e o hash (e o trecho) da página de precedentes vinculantes; a reabertura baixou o livro, o
 * hash não bateu e acusou `fonte_mudou`, e o gate final teve de ser refeito. O erro foi da tabela
 * do verificador, não do código: o cartório recusa a entrada, com as duas URLs. Devolve o motivo,
 * ou null.
 */
function hashDeOutraPagina(indice, url, evidencia) {
  if (!indice) return null;
  for (const h of [evidencia.sha256_texto, evidencia.sha256_bytes].filter(Boolean)) {
    const donas = indice.porHash.get(h);
    if (!donas || donas.has(url)) continue;
    if ((indice.porUrl.get(url) || new Set()).has(h)) continue;
    return `o hash ${h.slice(0, 12)}… é da cópia de ${[...donas].join(', ')} no fontes/INDEX.jsonl do run, não de ${url}: a tabela juntou a URL de uma página ao hash de outra. Registre a URL da página que foi lida (ou o hash da cópia desta URL)`;
  }
  return null;
}

/**
 * O início do run corrente (`startedAt` do `run-state.json`), em ms, ou null sem run legível.
 * Lido à parte, como o índice de fontes: ledger ilegível só desliga a conferência.
 */
function inicioDoRunCorrente(dir) {
  let run;
  try { run = JSON.parse(readFileSync(join(dir, RUN_LEDGER), 'utf-8')); } catch { return null; }
  const t = run && typeof run.startedAt === 'string' ? Date.parse(run.startedAt) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * `consulted_at` anterior ao início do run não é leitura deste run. Medido em 25/09/2026
 * (alimentos, motor 0.9.53): o cartório aceitou "CPC, art. 53, II" com `consulted_at`
 * 2026-09-24T21:34:27-03:00, o `baixado_em` de uma cópia que o `fonte-oficial` serviu do
 * cache de um run da véspera, num run aberto em 25/09 às 19h46. Data sem hora vale pelo dia:
 * recusa só o dia anterior ao do início (pelo relógio UTC e pelo local, o que for mais cedo).
 * Devolve o motivo, ou null.
 */
function consultaAnteriorAoRun(consultada, inicio) {
  if (inicio === null) return null;
  const quando = new Date(inicio);
  const pad = (n) => String(n).padStart(2, '0');
  const diaLocal = `${quando.getFullYear()}-${pad(quando.getMonth() + 1)}-${pad(quando.getDate())}`;
  const dia = [quando.toISOString().slice(0, 10), diaLocal].sort()[0];
  const anterior = /^\d{4}-\d{2}-\d{2}$/.test(consultada) ? consultada < dia : Date.parse(consultada) < inicio;
  if (!anterior) return null;
  return `consulted_at ${consultada} é anterior ao início do run (${quando.toISOString()}): é a data de uma leitura de outro run (o \`baixado_em\` de uma cópia servida do cache aparece no fontes/INDEX.jsonl com a data do download antigo), não uma conferência deste. Reabra a fonte neste run (\`fonte-oficial.mjs --forcar\`, ou o verificador na página) e registre a hora da leitura, com o fuso certo`;
}

/**
 * `consulted_at` à frente da hora do registro não é leitura: a leitura vem antes do registro.
 * Folga de 2 minutos para arredondamento de relógio. Medido em 26/09/2026 (despejo, motor
 * 0.9.54): o cartório aceitou `consulted_at` 04:10Z numa tabela registrada às 04:06Z, hora
 * estimada pelo verificador. Data sem hora vale pelo dia: recusa só o dia depois de hoje (pelo
 * relógio UTC e pelo local, o que for mais tarde). Devolve o motivo, ou null.
 */
const FOLGA_DO_RELOGIO_MS = 2 * 60 * 1000;
function consultaNoFuturo(consultada, quando) {
  const agora = Date.parse(quando);
  if (Number.isNaN(agora)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(consultada)) {
    const d = new Date(agora);
    const pad = (n) => String(n).padStart(2, '0');
    const hoje = [d.toISOString().slice(0, 10), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`].sort()[1];
    return consultada > hoje ? `consulted_at ${consultada} é depois de hoje (${hoje}): leitura no futuro não é leitura; registre a data em que a fonte foi lida` : null;
  }
  const adiante = Date.parse(consultada) - agora;
  if (adiante <= FOLGA_DO_RELOGIO_MS) return null;
  return `consulted_at ${consultada} está ${Math.ceil(adiante / 60000)} min à frente da hora do registro (${quando}): a leitura vem antes do registro, e hora no futuro é hora estimada ou fuso trocado ("-03:00" escrito como "Z"). Registre a hora em que a fonte foi lida, com o fuso certo`;
}

/**
 * Registra a tabela de um verificador (JSON com `citations[]` no formato do
 * manifesto, ou um array). `verificada` exige `source_url` HTTPS e
 * `consulted_at`: sem os dois não é verificação, é afirmação, e o cartório a
 * recusa por item (fail-closed, sem derrubar o comando).
 */
function registrarCitacoes(dir, arquivo, { gate, reviewer }) {
  const caminho = isAbsolute(arquivo) ? arquivo : resolve(arquivo);
  let dados;
  try {
    dados = JSON.parse(readFileSync(caminho, 'utf-8'));
  } catch (erro) {
    return die(`--citacoes: JSON ilegível em ${caminho} (${erro.message})`);
  }
  const entradas = Array.isArray(dados) ? dados : Array.isArray(dados && dados.citations) ? dados.citations : null;
  if (!entradas) die('--citacoes: esperado um array ou um objeto com `citations[]`');
  const ledger = lerCitacoesDoLedger(dir);
  const indiceDeFontes = indiceDeFontesDoRun(dir);
  const inicioDoRun = inicioDoRunCorrente(dir);
  const resumo = { verificadas: 0, verificadas_no_acervo: 0, contestadas: 0, sem_evidencia: 0, reabertas_sem_evidencia: 0, recusadas: [], avisos: [], contestadas_itens: [], verificadas_itens: [], verificadas_no_acervo_itens: [] };
  const quando = now();
  for (const [i, entrada] of entradas.entries()) {
    const title = entrada && typeof entrada.title === 'string' ? entrada.title.trim() : '';
    if (!title) {
      resumo.recusadas.push(`citations[${i}]: sem title`);
      continue;
    }
    const chave = chaveDeTitulo(title);
    const status = statusNormalizado(entrada.status);
    if (status === STATUS_VERIFICADA || status === STATUS_NO_ACERVO) {
      const url = typeof entrada.source_url === 'string' ? entrada.source_url.trim() : '';
      const consultada = typeof entrada.consulted_at === 'string' ? entrada.consulted_at.trim() : '';
      if (!/^https:\/\//i.test(url) || !consultada || Number.isNaN(Date.parse(consultada))) {
        resumo.recusadas.push(`"${title}": verificada sem source_url HTTPS ou sem consulted_at ISO`);
        continue;
      }
      const foraDoTempo = consultaAnteriorAoRun(consultada, inicioDoRun) || consultaNoFuturo(consultada, quando);
      if (foraDoTempo) {
        resumo.recusadas.push(`"${title}": ${foraDoTempo}`);
        continue;
      }
      const noAcervo = status === STATUS_NO_ACERVO;
      const desta = evidenciaDe(entrada, resumo.avisos, title);
      if (noAcervo && !ehCopiaDoAcervo(desta.fonte_local)) {
        resumo.recusadas.push(`"${title}": verificada_no_acervo sem evidence.fonte_local dentro de acervo/ (a cópia do acervo assinado que foi lida)`);
        continue;
      }
      const deOutra = hashDeOutraPagina(indiceDeFontes, url, desta);
      if (deOutra) {
        resumo.recusadas.push(`"${title}": ${deOutra}`);
        continue;
      }
      delete ledger.contestadas[chave];
      const anterior = ledger.verificadas[chave];
      // A evidência da fonte oficial não é trocada pela do acervo: é ela que a reabertura compara na web.
      const evidenciaAnterior = (anterior && anterior.evidence) || {};
      const anteriorNaFonte = anterior && anterior.status !== STATUS_NO_ACERVO && temEvidencia(evidenciaAnterior);
      const evidencia = noAcervo && anteriorNaFonte ? { ...desta, ...evidenciaAnterior } : { ...evidenciaAnterior, ...desta };
      const confirmacoes = anterior && Array.isArray(anterior.confirmacoes) ? [...anterior.confirmacoes] : anterior ? [{ verificador: anterior.verificador || '', gate: anterior.gate, consulted_at: anterior.consulted_at, hash: null, registrada_em: anterior.registrada_em }] : [];
      // `evidencia` diz se ESTA confirmação trouxe hash ou trecho: no gate final, só a que
      // trouxe conta como confirmação nova. Sem evidence a verificada entra (o verificador
      // abriu a fonte), mas marcada `sem_evidencia`: não há o que a reabertura compare, e o
      // gate final a devolve a um votante em vez de deixá-la passar calada (G3, 24/09/2026:
      // o cartório da reclamação tinha 61 verificadas, todas com `evidence: {}`).
      const nova = { verificador: reviewer || '', gate, consulted_at: consultada, hash: desta.sha256_texto || desta.sha256_bytes || null, evidencia: temEvidencia(desta), origem: noAcervo ? 'acervo' : 'fonte_oficial', registrada_em: quando };
      if (!confirmacoes.some((c) => c.verificador === nova.verificador && c.consulted_at === nova.consulted_at)) confirmacoes.push(nova);
      // A entrada é `verificada` se alguma confirmação abriu a fonte oficial; só com confirmações no
      // acervo, é `verificada_no_acervo`. Confirmação gravada antes do campo `origem` conta como fonte oficial.
      const naFonte = confirmacoes.some((c) => (c.origem || 'fonte_oficial') === 'fonte_oficial');
      ledger.verificadas[chave] = { title, status: naFonte ? STATUS_VERIFICADA : STATUS_NO_ACERVO, origem: naFonte ? 'fonte_oficial' : 'acervo', source_url: url, consulted_at: consultada, evidence: evidencia, sem_evidencia: !temEvidencia(evidencia), verificador: reviewer || '', gate, registrada_em: quando, confirmacoes };
      if (!temEvidencia(desta)) resumo.sem_evidencia += 1;
      resumo.verificadas += 1;
      if (noAcervo) { resumo.verificadas_no_acervo += 1; resumo.verificadas_no_acervo_itens.push(title); }
      resumo.verificadas_itens.push(title);
      continue;
    }
    if (STATUS_CONTESTADA.has(status)) {
      delete ledger.verificadas[chave];
      ledger.contestadas[chave] = { title, status, observacao: typeof entrada.observacao === 'string' ? entrada.observacao : typeof entrada.motivo === 'string' ? entrada.motivo : '', verificador: reviewer || '', gate, registrada_em: quando };
      resumo.contestadas += 1;
      resumo.contestadas_itens.push({ title, status });
      continue;
    }
    if (STATUS_SEM_EVIDENCIA.has(status)) {
      const motivo = typeof entrada.motivo === 'string' ? entrada.motivo : 'sem-evidencia';
      if (ledger.verificadas[chave]) {
        ledger.verificadas[chave] = { ...ledger.verificadas[chave], reabertura_sem_evidencia: { motivo, verificador: reviewer || '', gate, registrada_em: quando } };
        resumo.reabertas_sem_evidencia += 1;
      } else {
        resumo.avisos.push(`"${title}": ${status} de quem não está entre as verificadas deste run; nada a marcar`);
      }
      continue;
    }
    resumo.recusadas.push(`"${title}": status "${entrada.status}" desconhecido (aceitos: verificada, verificada_no_acervo, divergente, nao_encontrada, acesso_falhou, fonte_mudou, sem_evidencia)`);
  }
  gravarCitacoesNoLedger(dir, ledger);
  return { ...resumo, total_verificadas: Object.keys(ledger.verificadas).length, total_contestadas: Object.keys(ledger.contestadas).length };
}

/** O hook de citações do projeto: é dele a extração de citações materiais, para o cartório não ter uma segunda. */
function hookDeCitacoes(dir) {
  const raiz = resolve(dir, '..', '..');
  const candidatos = [
    join(raiz, '.claude', 'hooks', 'verifica-citacoes.mjs'),
    join(raiz, '.codex', 'hooks', 'verifica-citacoes.mjs'),
    join(raiz, '.Codex', 'hooks', 'verifica-citacoes.mjs'), // projeto anterior à 0.9.49 ainda não atualizado
  ];
  const achado = candidatos.find((p) => existsSync(p));
  if (!achado) die(`hook verifica-citacoes.mjs não encontrado (procurado em ${candidatos.join(' e ')}): sem ele não há como listar as citações da peça; verifique tudo`);
  return achado;
}

/**
 * O marco do gate final: a hora em que o laço citation-gate-final abriu, ou, sem ele, a do
 * manifesto da peça. Confirmação registrada antes dele é da rodada de redação, não do final.
 */
function marcoDoGateFinal(dir, peca) {
  const bruto = lerLedgerBruto(dir) || {};
  const laco = bruto.loops && bruto.loops.citacao;
  if (laco && laco.loop === LACO_FINAL_DE_CITACOES && typeof laco.aberto_em === 'string') return { marco: laco.aberto_em, origem: 'laco' };
  const manifesto = `${peca}.citation-gate.json`;
  if (existsSync(manifesto)) return { marco: statSync(manifesto).mtime.toISOString(), origem: 'manifesto' };
  return die(`--final: sem o laço ${LACO_FINAL_DE_CITACOES} aberto (gate-open --gate citacao --loop ${LACO_FINAL_DE_CITACOES}) nem o manifesto ${manifesto}, não há como saber o que é confirmação nova`);
}

/** O gate final está em curso quando o laço citation-gate-final está aberto. */
function gateFinalAberto(dir) {
  const bruto = lerLedgerBruto(dir) || {};
  const laco = bruto.loops && bruto.loops.citacao;
  return !!(laco && laco.loop === LACO_FINAL_DE_CITACOES && laco.status === 'open');
}

/**
 * O que a versão atual da peça cita e ainda não tem veredito neste run. Saída:
 * `reaproveitadas` (entradas do cartório que cobrem citações do texto, prontas
 * para o manifesto), `pendentes` (citações do texto sem entrada verificada: são
 * as únicas que o verificador precisa abrir), `contestadas` (as que um
 * verificador derrubou e seguem no texto) e, com `--confirmacoes N`,
 * `pendentes_de_consenso` (verificadas que ainda não somam N confirmações
 * distintas: é o que o gate final manda a um verificador a mais, em vez de
 * reabrir tudo de novo).
 *
 * No gate final (`--final`, ou o laço citation-gate-final aberto), cada citação
 * precisa de uma confirmação NOVA, registrada depois do marco (idêntica por
 * código na reabertura, ou de um votante), com evidência (hash ou trecho), e de
 * pelo menos PISO_DE_CONFIRMACOES_FINAL no total, piso que o ritmo não rebaixa.
 * Medido em 24/09/2026 (G3, defeitos 4, 20, 29, 48): sem isso o final respondia
 * `nada-a-verificar` com a confirmação da rodada de redação, e em três runs
 * nenhum verificador foi despachado.
 */
function cmdCitacoesPendentes(dir, flags) {
  if (typeof flags.peca !== 'string') die('citacoes-pendentes requer --peca <caminho real da minuta>');
  const peca = isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca);
  if (!existsSync(peca)) die(`peça não encontrada: ${peca}`);
  const exigidasPedidas = flags.confirmacoes === undefined ? 1 : Number(str(flags.confirmacoes));
  if (!Number.isInteger(exigidasPedidas) || exigidasPedidas < 1) die('--confirmacoes requer um inteiro maior ou igual a 1');
  const final = flags.final === true || gateFinalAberto(dir);
  const { marco } = final ? marcoDoGateFinal(dir, peca) : { marco: null };
  // Um aviso, numa linha, com a conta inteira. Medido em 25/09/2026, alimentos/reclamação: o
  // gate final dizia "rebaixado de 3 para 1" e, na linha seguinte, "sobem de 1 para 2", duas
  // mensagens que se contradiziam para quem lia o log.
  const teto = tetoDoPerfil(dir, 'citation_verifiers', exigidasPedidas, 'confirmações exigidas por citação', { silencioso: true });
  const doRitmo = teto.valor;
  const exigidas = final ? Math.max(doRitmo, PISO_DE_CONFIRMACOES_FINAL) : doRitmo;
  if (exigidas !== exigidasPedidas) {
    const partes = [];
    if (teto.rebaixado) partes.push(`o teto do ritmo ${teto.ritmo} é ${doRitmo}`);
    if (exigidas > doRitmo) partes.push(`o piso do gate final é ${PISO_DE_CONFIRMACOES_FINAL}, que o ritmo não rebaixa`);
    console.error(`${final ? 'gate final' : `ritmo ${teto.ritmo}`}: confirmações exigidas por citação: ${exigidas} (pedidas ${exigidasPedidas}; ${partes.join('; ')})`);
  }
  const ledger = lerCitacoesDoLedger(dir);
  const verificadas = Object.values(ledger.verificadas);
  const tmp = mkdtempSync(join(tmpdir(), 'legalsquad-citacoes-'));
  const manifesto = join(tmp, 'verificadas.json');
  let saida;
  try {
    writeFileSync(manifesto, JSON.stringify({ citations: verificadas.map((v) => ({ title: v.title })) }), 'utf-8');
    const r = spawnSync(process.execPath, [hookDeCitacoes(dir), '--citacoes', peca, '--manifesto', manifesto], { encoding: 'utf-8' });
    if (r.status !== 0) die(`hook de citações falhou: ${(r.stderr || r.stdout || '').trim()}`);
    saida = JSON.parse(r.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const reaproveitadas = [...new Set(saida.cobertas.map((c) => c.titulo))].map((i) => verificadas[i]);
  const contestadas = Object.values(ledger.contestadas);
  // A remissão sem diploma no contexto ("(art. 22, VIII)" num parágrafo que não nomeia a lei) vai como
  // pendente com `sem_diploma`: é o redator que nomeia o diploma; a que herdou o diploma leva
  // `diploma_de`, para o verificador conferir se a remissão é mesmo a ele. Medido em 26/09/2026 (despejo).
  const pendentes = saida.descobertas.map((c) => ({ bruto: c.bruto, linha: c.linha, classe: c.classe, numero: c.numero, artigo: c.artigo, sufixo: c.sufixo, dispositivo: c.dispositivo, diploma: c.diploma, numeroLei: c.numeroLei, orgao: c.orgao, ...(c.recurso ? { recurso: c.recurso } : {}), ...(c.sem_diploma ? { sem_diploma: true } : {}), ...(c.diploma_de ? { diploma_de: c.diploma_de } : {}) }));
  const semDiploma = pendentes.filter((p) => p.sem_diploma);
  // Confirmação nova: registrada depois do marco e com evidência. Registro anterior ao campo
  // `evidencia` vale pelo hash que guardou.
  const depoisDoMarco = (v) => (Array.isArray(v.confirmacoes) ? v.confirmacoes : []).filter((c) => marco && typeof c.registrada_em === 'string' && c.registrada_em >= marco);
  const comEvidencia = (c) => (typeof c.evidencia === 'boolean' ? c.evidencia : !!c.hash);
  const avaliar = (v) => {
    const total = contarConfirmacoes(v);
    if (!final) return total < exigidas ? { total, novas: null, faltam: exigidas - total, motivo: 'faltam-confirmacoes' } : null;
    const recentes = depoisDoMarco(v);
    const novas = recentes.filter(comEvidencia).length;
    const faltam = Math.max(exigidas - total, novas ? 0 : 1);
    if (!faltam) return null;
    const motivo = novas ? 'faltam-confirmacoes'
      : recentes.length ? 'nova-sem-evidencia'
        : v.reabertura_sem_evidencia && v.reabertura_sem_evidencia.registrada_em >= marco ? 'reabertura-sem-evidencia'
          : 'sem-confirmacao-nova';
    return { total, novas, faltam, motivo };
  };
  const pendentesDeConsenso = reaproveitadas
    .map((v) => ({ v, falta: avaliar(v) }))
    .filter(({ falta }) => falta)
    .map(({ v, falta }) => ({
      title: v.title,
      source_url: v.source_url,
      confirmacoes: falta.total,
      ...(final ? { novas: falta.novas } : {}),
      faltam: falta.faltam,
      motivo: falta.motivo,
      verificadores: (v.confirmacoes || [{ verificador: v.verificador }]).map((c) => c.verificador),
    }));
  const acao = pendentes.length ? 'verificar-pendentes' : pendentesDeConsenso.length ? 'confirmar-consenso' : 'nada-a-verificar';
  // Duas contas, cada uma com o seu nome. `dispositivos` é o que o extrator acha no texto, cada
  // artigo, parágrafo e inciso à parte ("arts. 1.694 e 1.695" são dois); `total` é a conta do
  // manifesto: uma citação por entrada do cartório que cobre o texto, mais as pendentes, uma por
  // trecho (estimativa até serem conferidas). Medido em 25/09/2026, alimentos: o cartório dizia
  // "todas as 44 citações" e o manifesto da mesma peça gravou 36; eram 44 dispositivos em 36 citações.
  const total = reaproveitadas.length + new Set(pendentes.map((p) => p.bruto)).size;
  const contas = `${total} citação(ões) do texto, ${saida.total} dispositivo(s)`;
  const resultado = {
    peca,
    total,
    dispositivos: saida.total,
    final,
    ...(final ? { marco } : {}),
    confirmacoes_exigidas: exigidas,
    reaproveitadas,
    pendentes,
    pendentes_de_consenso: pendentesDeConsenso,
    contestadas,
    acao,
    ...(semDiploma.length ? { sem_diploma: semDiploma.length } : {}),
    detail: acao === 'verificar-pendentes'
      ? `${pendentes.length} dispositivo(s) citado(s) sem veredito nesta versão; ${reaproveitadas.length} citação(ões) já conferida(s) neste run${pendentesDeConsenso.length ? `; ${pendentesDeConsenso.length} ainda sem ${exigidas} confirmações` : ''} (${contas}: artigo, parágrafo e inciso contam à parte)${semDiploma.length ? `; ${semDiploma.length} remissão(ões) sem diploma no contexto (\`sem_diploma\`): vão ao redator, que nomeia o diploma no texto (${[...new Set(semDiploma.map((p) => `"${p.bruto}", linha ${p.linha}`))].slice(0, 5).join('; ')})` : ''}`
      : acao === 'confirmar-consenso'
        ? final
          ? `gate final: ${pendentesDeConsenso.length} de ${total} citação(ões) sem confirmação nova com evidência (idêntica por código ou de um votante) ou abaixo de ${exigidas} confirmações; despache ao menos um votante com a lista (${contas})`
          : `todas as ${total} citações do texto já foram conferidas neste run; ${pendentesDeConsenso.length} ainda não soma(m) ${exigidas} confirmações distintas (${contas})`
        : `todas as ${total} citações do texto (${saida.total} dispositivos: artigo, parágrafo e inciso contam à parte) já foram conferidas neste run${exigidas > 1 ? `, cada uma com ${exigidas} ou mais confirmações` : ''}${final ? ' e uma confirmação nova com evidência no gate final' : ''}; nenhum verificador a despachar`,
  };
  console.log(JSON.stringify(resultado, null, 2));
  return null;
}

function cmdCitacoesStatus(dir) {
  const ledger = lerCitacoesDoLedger(dir);
  const verificadas = Object.values(ledger.verificadas);
  const porConfirmacoes = {};
  for (const v of verificadas) {
    const n = contarConfirmacoes(v);
    porConfirmacoes[n] = (porConfirmacoes[n] || 0) + 1;
  }
  console.log(JSON.stringify({
    resumo: { verificadas: verificadas.length, no_acervo: verificadas.filter((v) => v.status === STATUS_NO_ACERVO).length, contestadas: Object.keys(ledger.contestadas).length, por_confirmacoes: porConfirmacoes, com_hash: verificadas.filter((v) => v.evidence && (v.evidence.sha256_texto || v.evidence.sha256_bytes)).length },
    verificadas,
    contestadas: Object.values(ledger.contestadas),
  }, null, 2));
  return null;
}

// --- Manifesto da final gerado pelo cartório (`manifesto-final`) ------------
// Medido nos 8 runs dos moldes de 24/09/2026 (G20, defeitos 23 e 31): o
// `<peça>.citation-gate.json` da final era escrito à mão pelo conferente, e cada run o
// montou de um jeito. O step não nomeava os campos que o schema exige (`artifact_sha256`,
// `verified_at`, `kind`, `schema_version`, `gate_status`, `verification_type`), o schema
// recusava a barra em `artifact`, e o agente tentava até o hook deixar passar;
// `evidence` chegou ao manifesto em 4 dos 8, `verified_by` virou prosa de três linhas. Aqui
// o manifesto sai do cartório do run, por código: uma entrada por citação da peça com a
// fonte, a evidência e quem conferiu; `pendencias_do_profissional[]` lida dos marcadores de
// dado do texto; o SHA-256 da peça; validação contra o schema distribuído e o hook do
// projeto antes de deixar o arquivo gravado. Citação da peça sem entrada verificada no
// cartório recusa o manifesto inteiro, com a lista: o que falta vai ao verificador, não ao
// manifesto.
const SUFIXO_DO_MANIFESTO = '.citation-gate.json';
// A mesma forma de data que o hook aceita (ISO 8601 com fuso).
const RE_DATA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** O schema distribuído: ao lado do script no projeto; no repositório do motor, em templates/scripts/. */
function schemaDoManifesto(dir) {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const candidatos = [
    join(aqui, 'citation-gate-manifest.schema.json'),
    join(resolve(dir, '..', '..'), 'scripts', 'citation-gate-manifest.schema.json'),
    join(aqui, '..', 'templates', 'scripts', 'citation-gate-manifest.schema.json'),
  ];
  const achado = candidatos.find((p) => existsSync(p));
  if (!achado) die(`schema do manifesto não encontrado (procurado em ${candidatos.join(', ')}): sem ele não há como validar o que se grava`);
  try {
    return JSON.parse(readFileSync(achado, 'utf-8'));
  } catch (erro) {
    return die(`schema do manifesto ilegível em ${achado} (${erro.message})`);
  }
}

/**
 * Validador do subconjunto de JSON Schema que o schema do manifesto usa (type, const, enum,
 * required, properties, additionalProperties, items, minItems, minLength, pattern, format
 * date-time e uri). O script roda no projeto do usuário, sem node_modules: um validador
 * completo seria dependência para dez palavras-chave.
 */
function validarContraSchema(valor, s, onde = 'manifesto', erros = []) {
  if (!s || typeof s !== 'object') return erros;
  const tipo = Array.isArray(valor) ? 'array' : valor === null ? 'null' : typeof valor;
  if ('const' in s && valor !== s.const) erros.push(`${onde} deve ser ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(valor)) erros.push(`${onde} deve ser um de: ${s.enum.join(', ')}`);
  if (s.type && s.type !== tipo) {
    erros.push(`${onde} deve ser ${s.type}`);
    return erros;
  }
  if (tipo === 'string') {
    if (typeof s.minLength === 'number' && valor.length < s.minLength) erros.push(`${onde} tem menos de ${s.minLength} caractere(s)`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(valor)) erros.push(`${onde} não casa com ${s.pattern}`);
    if (s.format === 'date-time' && (!RE_DATA_ISO.test(valor) || Number.isNaN(Date.parse(valor)))) erros.push(`${onde} deve ser data/hora ISO 8601 com fuso`);
    if (s.format === 'uri') {
      try { new URL(valor); } catch { erros.push(`${onde} deve ser URI`); }
    }
  }
  if (tipo === 'array') {
    if (typeof s.minItems === 'number' && valor.length < s.minItems) erros.push(`${onde} deve ter ao menos ${s.minItems} item(ns)`);
    if (s.items) valor.forEach((item, i) => validarContraSchema(item, s.items, `${onde}[${i}]`, erros));
  }
  if (tipo === 'object') {
    for (const campo of s.required || []) if (!(campo in valor)) erros.push(`${onde}.${campo} é obrigatório`);
    const props = s.properties || {};
    for (const [campo, v] of Object.entries(valor)) {
      if (props[campo]) validarContraSchema(v, props[campo], `${onde}.${campo}`, erros);
      else if (s.additionalProperties === false) erros.push(`${onde}.${campo} não é campo do schema`);
    }
  }
  return erros;
}

/** O que o hook do projeto extrai da peça e o que cada título cobre (a extração é dele, só dele). */
function coberturaPeloHook(dir, peca, titulos) {
  const tmp = mkdtempSync(join(tmpdir(), 'legalsquad-manifesto-'));
  try {
    const lista = join(tmp, 'titulos.json');
    writeFileSync(lista, JSON.stringify({ citations: titulos.map((title) => ({ title })) }), 'utf-8');
    const r = spawnSync(process.execPath, [hookDeCitacoes(dir), '--citacoes', peca, '--manifesto', lista], { encoding: 'utf-8' });
    if (r.status !== 0) die(`hook de citações falhou: ${(r.stderr || r.stdout || '').trim()}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function marcadorNormalizado(m) {
  return String(m || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

const semMarkdown = (t) => String(t || '').replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();

/** Onde está a ocorrência: o título de seção acima e a abertura em negrito do parágrafo, com a linha. */
function localNaPeca(linhas, indice) {
  let secao = '';
  for (let i = indice; i >= 0; i -= 1) {
    const h = linhas[i].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) { secao = semMarkdown(h[1]); break; }
  }
  const abertura = linhas[indice].match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?\*\*([^*]{2,90}?)\*\*/);
  const paragrafo = abertura ? semMarkdown(abertura[1]).replace(/[.:]$/, '') : '';
  const partes = [secao, paragrafo && `parágrafo "${paragrafo}"`].filter(Boolean);
  return `${partes.length ? partes.join(', ') : 'corpo da peça'}, linha ${indice + 1}`;
}

/** Lê `--pendencias <json>`: array, ou objeto com `pendencias_do_profissional[]`. */
function lerPendenciasInformadas(arquivo) {
  const caminho = isAbsolute(arquivo) ? arquivo : resolve(arquivo);
  let dados;
  try {
    dados = JSON.parse(readFileSync(caminho, 'utf-8'));
  } catch (erro) {
    return die(`--pendencias: JSON ilegível em ${caminho} (${erro.message})`);
  }
  const lista = Array.isArray(dados) ? dados : Array.isArray(dados && dados.pendencias_do_profissional) ? dados.pendencias_do_profissional : null;
  if (!lista) die('--pendencias: esperado um array ou um objeto com `pendencias_do_profissional[]`');
  const porMarcador = new Map();
  lista.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof p.marcador !== 'string' || !p.marcador.trim()) die(`--pendencias[${i}]: sem \`marcador\``);
    const m = marcadorNormalizado(p.marcador);
    porMarcador.set(m, [...(porMarcador.get(m) || []), p]);
  });
  return porMarcador;
}

const textoDe = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Uma entrada por OCORRÊNCIA de marcador de dado (a mesma contagem do hook). `marcador` e
 * `onde` saem do texto; `procurado_em` e `diligencia` são juízo de quem procurou e vêm de
 * `--pendencias`, nunca inventados: sem eles, a ocorrência volta em `faltam`. A mesma
 * pendência repetida (`[CONFIRMAR o índice]` duas vezes) usa a última entrada informada.
 */
function pendenciasDoTexto(texto, informadas) {
  const linhas = texto.split('\n');
  const inicios = [0];
  for (let i = 0; i < texto.length; i += 1) if (texto.charCodeAt(i) === 10) inicios.push(i + 1);
  const linhaDe = (pos) => {
    let lo = 0;
    let hi = inicios.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (inicios[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const re = new RegExp(PENDING_MARKER.source, PENDING_MARKER.flags);
  const usadas = new Map();
  const pendencias = [];
  const faltam = [];
  const deCitacao = [];
  for (const achado of texto.matchAll(re)) {
    const literal = marcadorNormalizado(achado[0]);
    const linha = linhaDe(achado.index);
    if (!DATA_MARKER.test(achado[0])) { deCitacao.push({ marcador: literal, linha: linha + 1 }); continue; }
    const k = usadas.get(literal) || 0;
    usadas.set(literal, k + 1);
    const doProfissional = informadas.get(literal) || [];
    const entrada = doProfissional[Math.min(k, doProfissional.length - 1)] || {};
    const onde = textoDe(doProfissional[k] && doProfissional[k].onde) || localNaPeca(linhas, linha);
    const item = { marcador: literal, onde, procurado_em: textoDe(entrada.procurado_em), diligencia: textoDe(entrada.diligencia) };
    if (!item.procurado_em || !item.diligencia) faltam.push(item);
    pendencias.push(item);
  }
  const sobrando = [...informadas.keys()].filter((m) => !usadas.has(m));
  return { pendencias, faltam, deCitacao, sobrando };
}

function consultadoEm(valor, avisos, title) {
  const v = textoDe(valor);
  if (RE_DATA_ISO.test(v) && !Number.isNaN(Date.parse(v))) return v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  avisos.push(`"${title}": consulted_at "${v}" normalizado para ISO 8601 com fuso`);
  return new Date(t).toISOString();
}

/** A entrada do manifesto a partir da entrada do cartório: fonte, hora, evidência de acesso e quem conferiu. */
function citacaoDoCartorio(v, avisos) {
  const evidence = {};
  const ev = v.evidence && typeof v.evidence === 'object' ? v.evidence : {};
  for (const campo of CAMPOS_DE_EVIDENCIA) {
    const valor = textoDe(ev[campo]);
    if (!valor) continue;
    if (campo.startsWith('sha256_') && !RE_SHA256.test(valor)) { avisos.push(`"${v.title}": ${campo} malformado no cartório, fora do manifesto`); continue; }
    if (campo === 'trecho' && valor.length < 8) { avisos.push(`"${v.title}": trecho curto demais para provar acesso, fora do manifesto`); continue; }
    evidence[campo] = campo.startsWith('sha256_') ? valor.toLowerCase() : valor;
  }
  const confirmacoes = Array.isArray(v.confirmacoes) && v.confirmacoes.length ? v.confirmacoes : [{ verificador: v.verificador }];
  const verificadores = [...new Set(confirmacoes.map((c) => textoDe(c && c.verificador)).filter(Boolean))];
  const consulted = consultadoEm(v.consulted_at, avisos, v.title);
  // A origem da conferência vai ao manifesto como está no cartório: citação conferida só na cópia
  // do acervo assinado sai `verificada_no_acervo`, com a cópia e o hash. Medido na contestação de
  // 24/09/2026 (motor 0.9.49): o cartório tinha 25 entradas `verificada_no_acervo` e o manifesto
  // gravou as 23 citadas como `verificada`, a fonte oficial aberta que não houve (G19 da 0.9.47).
  return {
    title: v.title,
    status: v.status === STATUS_NO_ACERVO ? STATUS_NO_ACERVO : STATUS_VERIFICADA,
    source_url: v.source_url,
    consulted_at: consulted,
    ...(Object.keys(evidence).length ? { evidence } : {}),
    ...(verificadores.length ? { verificadores } : {}),
  };
}

function recusarManifesto(resultado, mensagem) {
  console.log(JSON.stringify({ acao: 'recusado', ...resultado }, null, 2));
  console.error(`squad-state: manifesto-final recusado: ${mensagem}`);
  process.exit(1);
}

/**
 * `manifesto-final <squad-dir> --peca <final> [--pendencias <json>] [--por <id>]`: gera
 * `<final>.citation-gate.json` a partir do cartório do run. Recusa (saída 1, nada gravado)
 * quando a peça cita o que o cartório não tem verificado (lista `sem_entrada`, com a
 * contestação quando houve), quando resta marcador de citação no texto, quando falta
 * `procurado_em`/`diligencia` de um marcador de dado (devolve o `modelo` para preencher e
 * passar em `--pendencias`), quando o manifesto não passa no schema e quando o hook do
 * projeto o recusa (aí o manifesto anterior volta ao lugar).
 */
// --- Carimbo da persuasão (Passo 4.6) ----------------------------------------
// Medido em 25/09/2026 (apelação e HC, motor 0.9.50): o gate 4.6 aprovou uma versão e os fixes da
// revisão mudaram depois a síntese (e, na apelação, os pedidos); a final saiu com síntese que
// nenhum verificador de persuasão leu. O carimbo guarda o hash das duas seções na aprovação, e o
// `manifesto-final` compara com a final: diferente, avisa que a reconferência é obrigatória.
const RE_TITULO_DE_SECAO = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const semAcentoSecao = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const SECOES_DA_FRENTE = {
  sintese: /^(?:[ivxlc]+[.)-]?\s+|\d+[.)-]?\s+)?(?:da\s+)?sintese\b/,
  pedidos: /^(?:[ivxlc]+[.)-]?\s+|\d+[.)-]?\s+)?(?:d[oa]s?\s+)?(?:pedidos?|requerimentos?)\s*$/,
};

/** O texto de uma seção (do título até o próximo título do mesmo nível ou acima), ou null. */
function textoDaSecao(texto, re) {
  const saida = [];
  let nivel = 0;
  for (const linha of String(texto).replace(/\r\n?/g, '\n').split('\n')) {
    const t = linha.match(RE_TITULO_DE_SECAO);
    if (t && nivel && t[1].length <= nivel) break;
    if (t && !nivel && re.test(semAcentoSecao(t[2]).replace(/[*_`]/g, '').trim())) { nivel = t[1].length; continue; }
    if (nivel) saida.push(linha);
  }
  return nivel ? saida.join('\n').replace(/\s+/g, ' ').trim() : null;
}

function hashesDaFrente(texto) {
  const h = (t) => (t === null ? null : createHash('sha256').update(t).digest('hex'));
  return Object.fromEntries(Object.entries(SECOES_DA_FRENTE).map(([nome, re]) => [nome, h(textoDaSecao(texto, re))]));
}

function cmdPersuasaoCarimbo(dir, flags) {
  if (typeof flags.peca !== 'string') die('persuasao-carimbo requer --peca <minuta que o gate 4.6 aprovou>');
  const peca = isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca);
  if (!existsSync(peca)) die(`peça não encontrada: ${peca}`);
  const hashes = hashesDaFrente(readFileSync(peca, 'utf-8').normalize('NFC'));
  const carimbo = { peca: basename(peca), sintese_sha256: hashes.sintese, pedidos_sha256: hashes.pedidos, registrado_em: now() };
  const bruto = lerLedgerBruto(dir) || {};
  writeJson(dir, LEDGER, { ...bruto, persuasao_carimbo: carimbo, updatedAt: now() });
  const faltam = Object.entries(hashes).filter(([, v]) => v === null).map(([k]) => k);
  console.log(JSON.stringify({ acao: 'carimbado', ...carimbo, ...(faltam.length ? { aviso: `seção sem título reconhecível na peça: ${faltam.join(', ')}; o que não tem título não entra na comparação` } : {}) }, null, 2));
  return null;
}

/** Compara a frente da final com o carimbo da persuasão; devolve o aviso, ou null. */
function avisoDaPersuasao(dir, texto) {
  const bruto = lerLedgerBruto(dir) || {};
  const carimbo = bruto.persuasao_carimbo;
  const houveGate = !!((bruto.loops && bruto.loops.persuasao) || (bruto.historico && bruto.historico.persuasao));
  if (!carimbo) {
    return houveGate ? { persuasao: { carimbo: null }, aviso: 'o gate de persuasão (4.6) rodou neste run, mas a versão que ele aprovou não foi carimbada (`persuasao-carimbo`): não há como saber se a síntese e os pedidos da final são os que ele leu; confira antes da parada aprovação' } : null;
  }
  const agora = hashesDaFrente(texto);
  const mudou = ['sintese', 'pedidos'].filter((k) => (carimbo[`${k}_sha256`] ?? null) !== agora[k]);
  if (!mudou.length) return { persuasao: { carimbo: carimbo.peca, confere: true } };
  const nomes = mudou.map((k) => (k === 'sintese' ? 'a síntese' : 'os pedidos')).join(' e ');
  return {
    persuasao: { carimbo: carimbo.peca, confere: false, mudou },
    aviso: `persuasão desatualizada: o gate 4.6 aprovou ${carimbo.peca} em ${carimbo.registrado_em}, e ${nomes} da final ${mudou.length > 1 ? 'mudaram' : 'mudou'} depois disso; a reconferência de persuasão (um verificador-persuasao, modo reconferência) é obrigatória antes da parada aprovação`,
  };
}

function cmdManifestoFinal(dir, flags) {
  if (typeof flags.peca !== 'string') die('manifesto-final requer --peca <caminho real da peça final>');
  const peca = isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca);
  if (!existsSync(peca)) die(`peça não encontrada: ${peca}`);
  const bytes = readFileSync(peca);
  const texto = bytes.toString('utf-8').normalize('NFC');
  const informadas = typeof flags.pendencias === 'string' ? lerPendenciasInformadas(flags.pendencias) : new Map();
  const avisos = [];

  // 0. Laço escalado sem decisão, ou correção pós-teto sem conferência, não vira peça final:
  // a conclusão de um laço no teto é do ledger, não da palavra do agente (defeito 25).
  const lacosPendentes = lacosPendentesDeConclusao(dir);
  if (lacosPendentes.length) {
    recusarManifesto({ motivo: 'laco-sem-conclusao', peca, lacos: lacosPendentes },
      lacosPendentes.map((l) => `gate "${l.gate}": ${l.detail}`).join('; '));
  }

  // 1. Citações: cada uma da peça precisa de uma entrada verificada no cartório.
  const ledger = lerCitacoesDoLedger(dir);
  const verificadas = Object.values(ledger.verificadas);
  const contestadas = Object.values(ledger.contestadas);
  const cobertura = coberturaPeloHook(dir, peca, [...verificadas, ...contestadas].map((c) => c.title));
  const semEntrada = [
    ...cobertura.descobertas.map((c) => ({ bruto: c.bruto, linha: c.linha, contestada: null })),
    ...cobertura.cobertas.filter((c) => c.titulo >= verificadas.length).map((c) => {
      const k = contestadas[c.titulo - verificadas.length];
      return { bruto: c.bruto, linha: c.linha, contestada: { title: k.title, status: k.status } };
    }),
  ].sort((a, b) => a.linha - b.linha);
  const indices = [...new Set(cobertura.cobertas.filter((c) => c.titulo < verificadas.length).map((c) => c.titulo))];
  const { pendencias, faltam, deCitacao, sobrando } = pendenciasDoTexto(texto, informadas);
  if (semEntrada.length) {
    recusarManifesto({ motivo: 'citacao-sem-entrada-no-cartorio', peca, total: cobertura.total, sem_entrada: semEntrada, detail: `${semEntrada.length} citação(ões) da peça sem entrada verificada no cartório do run: vão ao verificador (Citation Gate incremental) antes do manifesto` },
      `${semEntrada.length} citação(ões) da peça sem entrada verificada no cartório: ${semEntrada.slice(0, 8).map((c) => `"${c.bruto}" (linha ${c.linha}${c.contestada ? `, ${c.contestada.status}` : ''})`).join('; ')}${semEntrada.length > 8 ? '; …' : ''}`);
  }
  if (deCitacao.length) {
    recusarManifesto({ motivo: 'marcador-de-citacao', peca, marcadores: deCitacao },
      `marcador de citação na peça (${[...new Set(deCitacao.map((m) => m.marcador))].join(', ')}): a citação se verifica ou sai, pelo redator`);
  }
  if (faltam.length) {
    recusarManifesto({ motivo: 'pendencia-sem-diligencia', peca, faltam, modelo: pendencias, detail: 'preencha procurado_em e diligencia de cada marcador de dado no modelo e passe o arquivo em --pendencias' },
      `${faltam.length} marcador(es) de dado sem procurado_em ou diligencia: ${[...new Set(faltam.map((f) => f.marcador))].join(', ')}`);
  }
  for (const m of sobrando) avisos.push(`--pendencias lista ${m}, que não está no texto da peça; ignorado`);

  const citations = indices.map((i) => citacaoDoCartorio(verificadas[i], avisos));
  const semData = citations.filter((c) => !c.consulted_at).map((c) => c.title);
  if (semData.length) die(`entrada(s) do cartório sem consulted_at legível: ${semData.join('; ')}`);
  if (!citations.length) avisos.push('o extrator do hook não achou citação material na peça: o manifesto atesta ausência; confirme na leitura');

  // 2. O manifesto, com os nomes que o schema exige.
  const run = loadRunLedger(dir);
  const verificadores = [...new Set(citations.flatMap((c) => c.verificadores || []))];
  const por = textoDe(str(flags.por));
  const origem = `cartório do run${run && run.runId ? ` ${run.runId}` : ''}`;
  const manifesto = {
    schema_version: '1',
    kind: 'legalsquad.citation-gate-attestation',
    artifact: basename(peca),
    artifact_sha256: createHash('sha256').update(bytes).digest('hex'),
    gate_status: 'aprovado',
    verification_type: 'material',
    scope: citations.length ? 'citacoes_materiais' : 'sem_citacoes_materiais',
    verified_by: `${por ? `${por}, a partir do ` : ''}${origem}${verificadores.length ? ` (verificadores: ${verificadores.join(', ')})` : ''}`,
    verified_at: now(),
    ...(pendencias.length ? { pendencias_do_profissional: pendencias } : {}),
    citations,
  };
  const errosDoSchema = validarContraSchema(manifesto, schemaDoManifesto(dir));
  if (errosDoSchema.length) recusarManifesto({ motivo: 'schema', peca, erros: errosDoSchema }, `o manifesto não passa no schema: ${errosDoSchema.join('; ')}`);

  // 3. Grava (tmp + rename) e passa pelo hook do projeto; recusado, o anterior volta.
  const destino = `${peca}${SUFIXO_DO_MANIFESTO}`;
  const anterior = existsSync(destino) ? readFileSync(destino) : null;
  const tmp = `${destino}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifesto, null, 2)}\n`, 'utf-8');
  renameSync(tmp, destino);
  const check = spawnSync(process.execPath, [hookDeCitacoes(dir), '--check', peca], { encoding: 'utf-8' });
  if (check.status !== 0) {
    if (anterior) writeFileSync(destino, anterior); else rmSync(destino, { force: true });
    recusarManifesto({ motivo: 'hook', peca, hook: (check.stderr || check.stdout || '').trim() }, `o hook de citações recusou o manifesto gerado (o anterior ${anterior ? 'voltou ao lugar' : 'não existia; nada ficou gravado'}): ${(check.stderr || '').split('\n')[0]}`);
  }
  const semEvidencia = citations.filter((c) => !c.evidence || !(c.evidence.sha256_texto || c.evidence.sha256_bytes || c.evidence.trecho)).map((c) => c.title);
  const daPersuasao = avisoDaPersuasao(dir, texto);
  if (daPersuasao && daPersuasao.aviso) {
    avisos.push(daPersuasao.aviso);
    console.error(`AVISO: ${daPersuasao.aviso}`);
  }
  console.log(JSON.stringify({
    acao: 'gravado',
    manifesto: destino,
    artifact: manifesto.artifact,
    artifact_sha256: manifesto.artifact_sha256,
    scope: manifesto.scope,
    citacoes: citations.length,
    com_evidencia: citations.length - semEvidencia.length,
    sem_evidencia: semEvidencia,
    pendencias_do_profissional: pendencias.length,
    verificadores,
    ...(daPersuasao ? { persuasao: daPersuasao.persuasao } : {}),
    avisos,
    detail: `manifesto gerado do cartório: ${citations.length} citação(ões), ${citations.length - semEvidencia.length} com hash ou trecho; ${pendencias.length} pendência(s) do profissional${semEvidencia.length ? `; ${semEvidencia.length} sem evidência (a reabertura do gate final não tem o que comparar nelas e as devolve a um votante)` : ''}`,
  }, null, 2));
  return null;
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
    return die(`${RUN_LEDGER} existente é JSON inválido: resolva à mão antes de continuar`);
  }
}

/** Atualiza o ledger SE ele existir. Sem ledger, o comando segue normal. */
function atualizarRunLedger(dir, transformar) {
  const atual = loadRunLedger(dir);
  if (!atual) return;
  writeJson(dir, RUN_LEDGER, { ...transformar(atual), updatedAt: now() });
}

// ---------------------------------------------------------------------------
// Alteração depois da entrega: reabrir um run concluído.
//
// Decisão do dono (19/09/2026): o que o profissional pede sobre a peça já
// entregue é uma revisão a mais do MESMO run, pelos mesmos agentes e gates,
// nunca edição de arquivo. Três regras, todas por código: só reabre a pedido
// (este comando; nenhum gate nem rotina o chama); só reabre run `completed`;
// e só reabre enquanto os autos não mudaram: documento em `autos/_index.yaml`
// mais novo que o começo do run é caso novo, e caso novo é run novo.
// ---------------------------------------------------------------------------
// Onde estão os autos (cópia do bloco canônico de src/autos-path.js): a guarda "fato novo é
// run novo" da reabertura lia só `squads/<nome>/autos/` e ficava muda com `caso.json`.
// >>> autos-path:begin
/**
 * Pasta de autos de um squad: `squads/<nome>/autos/` (copiados para o squad) ou,
 * por referência, a pasta do caso que `squads/<nome>/caso.json` aponta
 * (`{"autos": "Processos/<caso>/autos"}` ou `{"pasta": "Processos/<caso>"}`,
 * relativo à raiz do projeto, a pasta acima de `squads/`). A cópia local com
 * `_index.yaml` vence a referência; sem `caso.json`, fica a do squad.
 */
function pastaDeAutos(squadDir) {
  const noSquad = join(squadDir, 'autos');
  if (existsSync(join(noSquad, '_index.yaml'))) return noSquad;
  try {
    const caso = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8'));
    const raiz = dirname(dirname(squadDir));
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (autos) return resolve(raiz, autos);
  } catch { /* sem caso.json, ou ilegível: fica o do squad */ }
  return noSquad;
}

/**
 * Aceita `squads/<nome>` (com `autos/` dentro ou `caso.json` apontando o caso), a
 * pasta do caso (com `autos/` dentro) ou o caminho direto de `autos/`.
 * Devolve `{ dir, erro }`; `dir` é absoluto.
 */
function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const dir = pastaDeAutos(abs);
  if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, erro: null };
  if (existsSync(join(abs, 'caso.json'))) return { dir: null, erro: `${entrada}/caso.json aponta ${dir}, que não existe: confira o caminho (relativo à raiz do projeto, a pasta acima de squads/)` };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/; crie ${entrada}/autos/ e coloque nela os PDFs e documentos do caso, ou grave ${entrada}/caso.json apontando a pasta do caso` };
}
// <<< autos-path:end
// O bloco vem inteiro para não divergir; aqui só `pastaDeAutos` é usada.
void resolverAutos;

function mtimesDoIndiceDosAutos(dir) {
  const caminho = join(pastaDeAutos(dir), '_index.yaml');
  if (!existsSync(caminho)) return null;
  const texto = readFileSync(caminho, 'utf8');
  const mtimes = [...texto.matchAll(/^\s+mtime:\s*"?([^"\n]+)"?\s*$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const gerado = texto.match(/^gerado_em:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || null;
  return { gerado, mtimes };
}

function versaoEntregue(dir, runId) {
  const pasta = join(dir, 'output', runId);
  if (!existsSync(pasta)) return null;
  const versoes = readdirSync(pasta, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => Number(e.name.slice(1)));
  return versoes.length ? `v${Math.max(...versoes)}` : null;
}

function cmdReabrir(dir, flags) {
  if (typeof flags.modo !== 'string') die('reabrir requer --modo ajustes|revisao');
  if (typeof flags.pedido !== 'string' || !flags.pedido.trim()) die('reabrir requer --pedido "<o que o profissional pediu, literal>"');
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('não há run neste squad para reabrir');
  if (typeof flags.run === 'string' && flags.run.trim() && flags.run.trim() !== ledger.runId) {
    die(`o run mais recente deste squad é ${ledger.runId}, não ${flags.run.trim()}: só o último run reabre (os anteriores ficam como estão em output/)`);
  }
  if (ledger.status !== 'completed') die(`só um run concluído reabre; este está "${ledger.status}"${ledger.status === 'running' ? ': está aberto, retome com run-status/init --run' : ''}`);
  // "Fato novo é run novo": a única guarda por código da reabertura. Sem índice (autos
  // nunca indexados) ela não tem como decidir, e a saída diz isso em vez de silenciar.
  const autos = mtimesDoIndiceDosAutos(dir);
  if (autos && ledger.startedAt) {
    const novos = autos.mtimes.filter((m) => m > ledger.startedAt);
    if (novos.length) die(`os autos mudaram depois do run (${novos.length} documento(s) com mtime posterior a ${ledger.startedAt}): alteração de fato novo não é ajuste da peça. Abra um run novo`);
  }
  const guardaDosAutos = autos ? (ledger.startedAt ? 'conferidos' : 'sem startedAt no ledger') : `sem índice em ${pastaDeAutos(dir)}: não dá para saber se os autos mudaram`;
  const versao = versaoEntregue(dir, ledger.runId);
  let novo;
  try {
    novo = reabrirRun(ledger, { modo: flags.modo, pedido: flags.pedido, agora: now(), versaoAnterior: versao });
  } catch (erro) {
    die(erro.message);
  }
  // O cleanup pós-conclusão APAGA o state.json (ele é arquivado na pasta do run):
  // num run concluído, o normal é não haver state.json. Reconstruir aqui, como o
  // init faz, em vez de morrer com o ledger já reescrito: a primeira versão desta
  // rotina gravava o ledger, chamava loadState, morria, e deixava o run "running"
  // sem state.json (achado no ensaio de 19/09/2026). Estado primeiro, ledger por último.
  let s;
  if (existsSync(join(dir, 'state.json'))) {
    s = loadState(dir);
  } else {
    s = { squad: readSquadCode(dir), status: 'idle', step: { current: ledger.step?.current ?? 0, total: ledger.step?.total ?? 0, label: ledger.step?.label ?? '' }, agents: readAgents(dir), handoff: null, startedAt: ledger.startedAt || null, updatedAt: now() };
  }
  s.status = 'running';
  s.updatedAt = now();
  writeState(dir, s);
  writeJson(dir, RUN_LEDGER, { ...novo, updatedAt: now() });
  const r = novo.reaberturas[novo.reaberturas.length - 1];
  console.log(JSON.stringify({ runId: novo.runId, reabertura: r.numero, modo: r.modo, pedido: r.pedido, versao_anterior: versao, proxima_versao: versao ? `v${Number(versao.slice(1)) + 1}` : 'v1', checkpoints: Object.keys(novo.checkpoints || {}), ritmo: novo.ritmo || null, autos: guardaDosAutos }, null, 2));
  return null;
}

function cmdRunStatus(dir) {
  console.log(JSON.stringify(retomarRun(loadRunLedger(dir)), null, 2));
  return null;
}

const { command, dir, flags } = parseArgs(process.argv.slice(2));
if (!command || !dir)
  die('uso: squad-state <init|ritmo|step|checkpoint|complete|fail|reabrir|review-open|review-verdict|review-status|citacoes-pendentes|citacoes-status|manifesto-final|persuasao-carimbo|run-status|meta-consenso|steps-posteriores> <squad-dir> [opções]');
if (!existsSync(dir)) die(`pasta do squad não existe: ${dir}`);

const commands = {
  init: cmdInit,
  ritmo: cmdRitmo,
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
  'gate-decisao': cmdGateDecisao,
  'citacoes-pendentes': cmdCitacoesPendentes,
  'citacoes-status': cmdCitacoesStatus,
  'manifesto-final': cmdManifestoFinal,
  'persuasao-carimbo': cmdPersuasaoCarimbo,
  'run-status': cmdRunStatus,
  'meta-consenso': cmdMetaConsenso,
  'steps-posteriores': cmdStepsPosteriores,
  reabrir: cmdReabrir,
};
if (!commands[command]) die(`comando desconhecido: ${command}`);
// Comandos de revisão já imprimiram o JSON da decisão; os de estado confirmam
// a escrita em uma linha (como sempre fizeram).
if (commands[command](dir, flags) !== null) console.log(`state.json atualizado (${command}) em ${dir}`);
