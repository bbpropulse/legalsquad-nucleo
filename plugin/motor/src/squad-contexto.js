// Onde mora cada coisa de um squad e de um run (0.9.141, runs simultâneos).
//
// Até a 0.9.140 o estado do run (state.json, run-state.json, review-state.json, caso.json,
// identificacao.json, autos/) morava solto em `squads/<code>/`, um só para todos os runs: o mesmo
// squad não atendia dois casos ao mesmo tempo, e uma conversa nova do caso 2 retomava o run do caso
// 1. Desde a 0.9.141 cada run nasce numa VAGA, `squads/<code>/runs/<run_id>/`, e a saída continua em
// `squads/<code>/output/<run_id>/`. O run aberto antes disso, com o estado na raiz, segue e fecha na
// raiz (legado), sem migração.
//
// Este módulo é o ponto único da pergunta "dado este caminho, onde está o quê": aceita
// `squads/<code>` e `squads/<code>/runs/<run_id>` e devolve a raiz do projeto, a do squad, o code, a
// pasta do estado e o run. Quem antes derivava `basename(resolve(dir))` como code ou
// `dirname(dirname(dir))` como raiz do projeto recebe isto.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o
// `squad-state`, os hooks que leem estado do run (retorno-subagente, verifica-citacoes,
// verifica-redacao, monitor-agentes) e os scripts que leem os ledgers (run-metricas, auditar-run,
// voltas-do-run, empacotar), em raiz e templates. Cada cópia importa `existsSync`, `readFileSync`,
// `readdirSync` de `node:fs` e `basename`, `dirname`, `join`, `resolve` de `node:path`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// >>> squad-contexto:begin
/** A pasta das vagas dentro do squad: `squads/<code>/runs/<run_id>/`. */
const PASTA_DAS_VAGAS = 'runs';

/** O nome de run que pode virar pasta: sem barra, sem `..`, sem começar por ponto. */
const RUN_ID_VALIDO = /^[\w][\w.-]*$/;

/**
 * O contexto de um caminho de squad: `{ raizDoProjeto, raizDoSquad, code, dirDoEstado, runId,
 * legado }`, todos absolutos. `squads/<code>` é a raiz (o estado legado mora nela: `legado: true`,
 * `runId: null`); `squads/<code>/runs/<run_id>` é a vaga daquele run (`dirDoEstado` é a vaga).
 */
function contextoDoSquad(dir) {
  const abs = resolve(String(dir || '.'));
  const pai = dirname(abs);
  const avo = dirname(pai);
  // Vaga é `runs/<id>` de um squad: o avô tem o squad.yaml, ou está em `squads/` e a pasta já tem o
  // ledger do run. Só o nome `squads` não basta: uma pasta de projetos chamada assim fazia de qualquer
  // `runs/<id>` uma vaga (0.9.142).
  const ehVaga = basename(pai) === PASTA_DAS_VAGAS && RUN_ID_VALIDO.test(basename(abs))
    && (existsSync(join(avo, 'squad.yaml')) || (basename(dirname(avo)) === 'squads' && existsSync(join(abs, 'run-state.json'))));
  const raizDoSquad = ehVaga ? avo : abs;
  return {
    raizDoProjeto: dirname(dirname(raizDoSquad)),
    raizDoSquad,
    code: basename(raizDoSquad),
    dirDoEstado: abs,
    runId: ehVaga ? basename(abs) : null,
    legado: !ehVaga,
  };
}

/** A vaga do run `runId` no squad (o caminho, exista ou não). */
function vagaDoRun(raizDoSquad, runId) {
  return join(resolve(raizDoSquad), PASTA_DAS_VAGAS, String(runId));
}

/** O `run-state.json` de uma pasta de estado, ou null (ausente ou ilegível). */
function ledgerDaPasta(dirDoEstado) {
  try { return JSON.parse(readFileSync(join(dirDoEstado, 'run-state.json'), 'utf8')); } catch { return null; }
}

/**
 * Quando o ledger mudou por último: o `updatedAt`, ou o `endedAt`, ou o `startedAt` (ledger antigo
 * sem `updatedAt` ia para o fim da lista e nunca era o mais recente, 0.9.142).
 */
function quandoDoLedger(l) {
  return String(l.updatedAt || l.endedAt || l.startedAt || '');
}

/**
 * Os runs de um squad que têm ledger: o legado da raiz (quando houver) e cada vaga. Cada um:
 * `{ runId, estado, vaga, status, atualizado, inicio, ledger }`, do mais recente ao mais antigo.
 */

function runsDoSquad(raizDoSquad) {
  const raiz = resolve(raizDoSquad);
  const lista = [];
  const daRaiz = ledgerDaPasta(raiz);
  if (daRaiz && typeof daRaiz.runId === 'string' && daRaiz.runId) {
    lista.push({ runId: daRaiz.runId, estado: raiz, vaga: false, status: String(daRaiz.status || ''), atualizado: quandoDoLedger(daRaiz), inicio: String(daRaiz.startedAt || ''), ledger: daRaiz });
  }
  let nomes;
  try { nomes = readdirSync(join(raiz, PASTA_DAS_VAGAS)); } catch { nomes = []; }
  for (const nome of nomes) {
    if (!RUN_ID_VALIDO.test(nome)) continue;
    const estado = join(raiz, PASTA_DAS_VAGAS, nome);
    const l = ledgerDaPasta(estado);
    if (!l || typeof l.runId !== 'string' || !l.runId) continue;
    lista.push({ runId: l.runId, estado, vaga: true, status: String(l.status || ''), atualizado: quandoDoLedger(l), inicio: String(l.startedAt || ''), ledger: l });
  }
  return lista.sort((a, b) => b.atualizado.localeCompare(a.atualizado));
}

/** Os runs abertos (`status: running`) de um squad, do mais recente ao mais antigo. */
function runsAbertosDoSquad(raizDoSquad) {
  return runsDoSquad(raizDoSquad).filter((r) => r.status === 'running');
}

/**
 * A pasta do estado do run `runId`: a vaga, se ela tem o ledger; a raiz, se o ledger da raiz é
 * dele (legado); senão null.
 */
function dirDoEstadoDoRun(raizDoSquad, runId) {
  if (!runId || !RUN_ID_VALIDO.test(String(runId))) return null;
  const vaga = vagaDoRun(raizDoSquad, runId);
  if (existsSync(join(vaga, 'run-state.json'))) return vaga;
  const daRaiz = ledgerDaPasta(resolve(raizDoSquad));
  return daRaiz && daRaiz.runId === runId ? resolve(raizDoSquad) : null;
}

/**
 * Onde estão os ledgers de um run do squad: `{ raizDoSquad, runId, pasta }`. O run é o `runId` dado,
 * ou o da vaga (quando `dir` é a vaga), ou o mais recente do squad. `pasta` é a vaga, a raiz (o run
 * legado cujo ledger é o da raiz) ou `output/<run_id>/` (a cópia arquivada); null sem run nenhum.
 */
function pastaDosLedgers(dir, runId = null) {
  const ctx = contextoDoSquad(dir);
  const raiz = ctx.raizDoSquad;
  const id = runId || ctx.runId || (runsDoSquad(raiz)[0] || {}).runId || null;
  if (!id) return { raizDoSquad: raiz, runId: null, pasta: null };
  return { raizDoSquad: raiz, runId: id, pasta: dirDoEstadoDoRun(raiz, id) || join(raiz, 'output', String(id)) };
}

/**
 * Do caminho de um arquivo do run (`.../squads/<code>/output/<run_id>/...` ou
 * `.../squads/<code>/runs/<run_id>/...`): `{ raizDoProjeto, raizDoSquad, code, runId, dirDoEstado }`,
 * com `dirDoEstado` na vaga quando ela existe e na raiz do squad (legado) quando não. null fora de
 * um run.
 */
function runDoCaminho(caminho) {
  const p = resolve(String(caminho || '')).replace(/\\/g, '/');
  const m = p.match(/^(.*)\/squads\/([^/]+)\/(output|runs)\/([^/]+)(?:\/|$)/);
  if (!m || !RUN_ID_VALIDO.test(m[4]) || m[4] === 'pacote') return null;
  const raizDoProjeto = m[1] || '/';
  const raizDoSquad = join(raizDoProjeto, 'squads', m[2]);
  const vaga = vagaDoRun(raizDoSquad, m[4]);
  return { raizDoProjeto, raizDoSquad, code: m[2], runId: m[4], dirDoEstado: existsSync(vaga) ? vaga : raizDoSquad };
}

/** Os runs abertos de todos os squads do projeto: `{ code, dir, estado, runId, atualizado }` (dir é a raiz do squad). */
function runsAbertosDoProjeto(raizDoProjeto) {
  const base = join(resolve(raizDoProjeto), 'squads');
  let nomes;
  try { nomes = readdirSync(base); } catch { nomes = []; }
  const abertos = [];
  for (const code of nomes) {
    for (const r of runsAbertosDoSquad(join(base, code))) abertos.push({ code, dir: join(base, code), estado: r.estado, runId: r.runId, atualizado: r.atualizado });
  }
  return abertos.sort((a, b) => b.atualizado.localeCompare(a.atualizado));
}

/**
 * O run aberto que um texto (o prompt de um despacho) aponta, entre `abertos` (de
 * `runsAbertosDoProjeto`): pela marca `run=<id>` do código ou pelo caminho
 * `squads/<code>/output/<id>/` ou `squads/<code>/runs/<id>`. Com um aberto só, é ele; com mais de
 * um, só o que o texto aponta sem ambiguidade; senão null (na dúvida, não atribui).
 */
function runMarcadoNoTexto(abertos, texto) {
  if (!Array.isArray(abertos) || !abertos.length) return null;
  if (abertos.length === 1) return abertos[0];
  const t = String(texto || '').replace(/\\/g, '/');
  // O id inteiro, nunca o prefixo: `run=2026-11-23-1200` não marca o run `2026-11-23-1200-2`.
  const tem = (prefixo) => new RegExp(`${prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(t);
  const citados = abertos.filter((a) => tem(`run=${a.runId}`) || tem(`squads/${a.code}/output/${a.runId}`) || tem(`squads/${a.code}/runs/${a.runId}`));
  return citados.length === 1 ? citados[0] : null;
}
// <<< squad-contexto:end

export {
  PASTA_DAS_VAGAS, RUN_ID_VALIDO, contextoDoSquad, vagaDoRun, ledgerDaPasta, runsDoSquad, runsAbertosDoSquad,
  dirDoEstadoDoRun, pastaDosLedgers, runDoCaminho, runsAbertosDoProjeto, runMarcadoNoTexto,
};
