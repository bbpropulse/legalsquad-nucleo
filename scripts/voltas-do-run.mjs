#!/usr/bin/env node
/**
 * As voltas de um run: o que disparou cada versão da peça, lido do que o run deixou em disco (sem
 * token, sem rede, só leitura). Feito em 10/11/2026 para o run da resposta a ofício do MP (37
 * versões, 6 finais): antes dele, cada vai e vem era explicado caso a caso.
 *
 * Lê `review-state.json` (laços atuais e histórico), `run-state.json` (as respostas do
 * profissional), as pastas `vN/` e `_tmp/agentes.jsonl` (os despachos), e diz:
 *   - por versão: a hora, o arquivo, o gatilho (a decisão de gate ou a resposta do profissional que
 *     veio logo antes) e se é cópia da versão anterior do mesmo arquivo;
 *   - por final: quantos verificadores o Citation Gate final despachou e quanto tempo o laço levou;
 *   - o placar: rodadas abertas pelo profissional × pelos gates, cópias, verificadores por final.
 *
 * Uso: node scripts/voltas-do-run.mjs <pasta do run> [--json]
 *      (a pasta é squads/<nome>/output/<run_id>)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Onde mora o estado de cada run (cópia VERBATIM de src/squad-contexto.js, `npm run sync:blocos`).
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
// O bloco vem inteiro para não divergir; estas funções dele não são usadas aqui.
void pastaDosLedgers;
void runDoCaminho;
void runsAbertosDoProjeto;
void runMarcadoNoTexto;

const lerJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const hora = (t) => new Date(t).toISOString().slice(11, 19);

/** Os eventos do run em ordem: versões, decisões de gate, aberturas de laço, respostas e despachos. */
/**
 * Onde estão os ledgers: na pasta do run, depois que ele fecha; na do squad, enquanto o run aberto é
 * este (o `run-state.json` do squad tem o mesmo runId). Medido em 10/11/2026: o run em andamento
 * não era lido.
 */
export function ledgersDoRun(runDir) {
  if (existsSync(join(runDir, 'review-state.json'))) return runDir;
  const squad = resolve(runDir, '..', '..');
  // A vaga do run (`runs/<run_id>/`, 0.9.141) ou a raiz do squad, quando o ledger dela é deste run (legado).
  const estado = dirDoEstadoDoRun(squad, basename(resolve(runDir)));
  return estado && existsSync(join(estado, 'review-state.json')) ? estado : null;
}

export function eventosDoRun(runDir) {
  const ev = [];
  const base = ledgersDoRun(runDir) || runDir;
  const rs = lerJson(join(base, 'review-state.json')) || {};
  const lacos = [
    ...Object.entries(rs.loops || {}).map(([g, l]) => [g, l]),
    ...Object.entries(rs.historico || {}).flatMap(([g, ls]) => (Array.isArray(ls) ? ls : [ls]).map((l) => [g, l])),
  ];
  for (const [gate, l] of lacos) {
    if (!l) continue;
    if (l.aberto_em) ev.push({ t: Date.parse(l.aberto_em), tipo: 'abre', gate, laco: l.loop });
    for (const c of l.cycles || []) {
      const d = c.decision || {};
      const vozes = (c.verdicts || []).map((v) => v.reviewer);
      ev.push({ t: Date.parse(c.em), tipo: 'decisao', gate, laco: l.loop, acao: d.action, motivo: d.reason, vozes, fixes: d.fixes || [], ajustes: d.ajustes || [] });
    }
  }
  const run = lerJson(join(base, 'run-state.json')) || {};
  for (const h of run.checkpoints_historico || []) ev.push({ t: Date.parse(h.em), tipo: 'resposta', parada: h.step, resposta: String(h.resposta || '') });
  for (const v of readdirSync(runDir).filter((x) => /^v\d+$/.test(x))) {
    for (const f of readdirSync(join(runDir, v)).filter((x) => /\.md$/.test(x))) {
      const p = join(runDir, v, f);
      ev.push({ t: statSync(p).mtimeMs, tipo: 'versao', versao: v, arquivo: f, sha: createHash('sha256').update(readFileSync(p)).digest('hex') });
    }
  }
  const ag = join(runDir, '_tmp', 'agentes.jsonl');
  if (existsSync(ag)) {
    for (const linha of readFileSync(ag, 'utf-8').split('\n').filter(Boolean)) {
      const a = (() => { try { return JSON.parse(linha); } catch { return null; } })();
      if (a && a.ev === 'pedido') ev.push({ t: Date.parse(a.em), tipo: 'despacho', agente: a.tipo, descricao: a.descricao || '' });
    }
  }
  return ev.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
}

/** O gatilho de uma versão: a última decisão que pede texto novo, ou a resposta do profissional, antes dela. */
function gatilhoAntes(ev, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    const e = ev[k];
    if (e.tipo === 'versao') return null;
    if (e.tipo === 'resposta') return { origem: 'profissional', texto: `${e.parada}: ${e.resposta.slice(0, 140)}` };
    if (e.tipo === 'decisao' && (e.vozes || []).includes('profissional')) return { origem: 'profissional', texto: `${e.gate}: ${(e.fixes[0] || '').slice(0, 140)}` };
    if (e.tipo === 'decisao' && e.acao === 'revise') return { origem: 'gate', texto: `${e.gate} (${e.vozes.join('+')}): ${(e.fixes[0] || '').slice(0, 140)}` };
    if (e.tipo === 'decisao' && e.ajustes && e.ajustes.length) return { origem: 'gate', texto: `${e.gate} (${e.vozes.join('+')}), ${e.ajustes.length} ajuste(s): ${e.ajustes[0].slice(0, 120)}` };
  }
  return null;
}

export function voltasDoRun(runDir) {
  const ev = eventosDoRun(runDir);
  const versoes = [];
  const ultimoSha = new Map();
  let gatilho = null;
  ev.forEach((e, i) => {
    if (e.tipo !== 'versao') return;
    // Versão sem gatilho próprio herda o da anterior (o redator grava a minuta e o revisor a revisão).
    gatilho = gatilhoAntes(ev, i) || gatilho;
    const tipoDeArquivo = e.arquivo.replace(/-(minuta|final)\.md$/, '-$1');
    const copia = ultimoSha.get(tipoDeArquivo) === e.sha;
    ultimoSha.set(tipoDeArquivo, e.sha);
    versoes.push({ versao: e.versao, hora: hora(e.t), t: e.t, arquivo: e.arquivo, final: /-final\.md$/.test(e.arquivo), copia, gatilho });
  });
  // Por final: os verificadores despachados depois dela e antes da próxima versão, e o tempo do laço.
  const finais = versoes.filter((v) => v.final).map((v) => {
    const proxima = versoes.find((x) => x.t > v.t);
    const ate = proxima ? proxima.t : Infinity;
    const janela = ev.filter((e) => e.t >= v.t && e.t < ate);
    const verificadores = janela.filter((e) => e.tipo === 'despacho' && e.agente === 'verificador-citacoes').length;
    const decisaoFinal = janela.find((e) => e.tipo === 'decisao' && e.gate === 'citacao');
    const aberturas = janela.filter((e) => e.tipo === 'abre' && e.gate === 'citacao').length;
    const fim = decisaoFinal ? decisaoFinal.t : null;
    return { versao: v.versao, verificadores, aberturas_do_laco: aberturas, fechou: Boolean(decisaoFinal), minutos: fim ? Math.round((fim - v.t) / 6000) / 10 : null, proxima: proxima ? proxima.versao : null };
  });
  const rodadas = { profissional: 0, gate: 0 };
  let anterior = null;
  for (const v of versoes) {
    if (v.gatilho && v.gatilho !== anterior) rodadas[v.gatilho.origem] += 1;
    anterior = v.gatilho;
  }
  return {
    run: runDir,
    versoes: versoes.map((v) => { const c = { ...v }; delete c.t; return c; }),
    finais,
    placar: {
      versoes: versoes.length,
      finais: finais.length,
      copias: versoes.filter((v) => v.copia).length,
      rodadas_do_profissional: rodadas.profissional,
      rodadas_dos_gates: rodadas.gate,
      verificadores_nos_finais: finais.reduce((n, f) => n + f.verificadores, 0),
      finais_sem_fechar: finais.filter((f) => !f.fechou).map((f) => f.versao),
      laco_final_reaberto: finais.filter((f) => f.aberturas_do_laco > 1).map((f) => f.versao),
    },
  };
}

function texto(r) {
  const linhas = [`Voltas do run ${r.run}`, ''];
  for (const v of r.versoes) {
    const g = v.gatilho ? `${v.gatilho.origem === 'profissional' ? 'PROFISSIONAL' : 'gate'}: ${v.gatilho.texto}` : 'primeira redação';
    linhas.push(`${v.versao.padEnd(4)} ${v.hora}  ${v.arquivo.padEnd(34)} ${v.copia ? '[CÓPIA] ' : ''}${g}`);
  }
  linhas.push('', 'Finais:');
  for (const f of r.finais) linhas.push(`  ${f.versao}: ${f.verificadores} verificador(es), laço aberto ${f.aberturas_do_laco}x, ${f.fechou ? `fechou em ${f.minutos} min` : 'NÃO FECHOU'}${f.proxima ? `; depois veio a ${f.proxima}` : ''}`);
  const p = r.placar;
  linhas.push('', `Placar: ${p.versoes} versões, ${p.finais} finais, ${p.copias} cópia(s); rodadas abertas pelo profissional ${p.rodadas_do_profissional}, pelos gates ${p.rodadas_dos_gates}; ${p.verificadores_nos_finais} verificador(es) nos finais${p.finais_sem_fechar.length ? `; finais sem fechar: ${p.finais_sem_fechar.join(', ')}` : ''}${p.laco_final_reaberto.length ? `; laço final reaberto em: ${p.laco_final_reaberto.join(', ')}` : ''}.`);
  return linhas.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir || !ledgersDoRun(dir)) {
    console.error('uso: node scripts/voltas-do-run.mjs <squads/<nome>/output/<run_id>> [--json]  (a pasta do run; o run aberto é lido pelos ledgers do squad)');
    process.exit(1);
  }
  const r = voltasDoRun(resolve(dir));
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : texto(r));
}
