#!/usr/bin/env node
/**
 * Hook SubagentStop do LegalSquad: o retorno de quem dá veredito, gravado e conferido por código.
 *
 * Doc oficial (https://code.claude.com/docs/en/hooks, "SubagentStop"): o evento traz `agent_type`
 * (o mesmo valor do matcher), `agent_id`, `agent_transcript_path` e `last_assistant_message`, o
 * texto da resposta final do subagente; `decision: "block"` com `reason` mantém o subagente
 * trabalhando e entrega o `reason` a ele como próxima instrução. No modo auto, o relatório pode vir
 * pela ferramenta `SubagentHandback` (v2.1.271+), e aí o `last_assistant_message` não é ele: o
 * relatório é o `input.message` da última chamada dessa ferramenta, lido da transcrição.
 *
 * No Codex, o mesmo arquivo é registrado no `.codex/hooks.json` do projeto: o SubagentStop de lá traz
 * os mesmos campos (`agent_type`, `agent_id`, `agent_transcript_path`, `last_assistant_message`, `cwd`)
 * e aceita o mesmo `decision: "block"` (https://learn.chatgpt.com/docs/hooks, conferido em 21/10/2026).
 *
 * Registrado no `.claude/settings.json` do projeto e no `hooks/hooks.json` do plugin (nunca só no
 * frontmatter do agente: agente de plugin ignora hooks), para os quatro nativos que dão veredito
 * (`verificador-citacoes`, `verificador-persuasao`, `avaliador-squad`, `contraditor`) e para o
 * `general-purpose` e o `revisor-squad` (0.9.102). O agente do squad vai como `general-purpose` (o revisor,
 * como `revisor-squad`, onde a IDE tem o agente), e o hook só o reconhece pela marca
 * que o código põe no despacho (`[legalsquad:veredito squad=<code> run=<runId> papel=revisao]`, na
 * primeira linha do `despacho_do_revisor` que o `review-open`/`review-status` devolvem e o chefe cola
 * no prompt): `general-purpose` sem a marca, de qualquer projeto, sai 0 sem gravar nada. O que ele faz:
 *
 * 1. Acha a raiz do projeto (subindo do `cwd` do evento até `_legalsquad/`) e o run aberto
 *    (`squads/<code>/runs/<run_id>/run-state.json`, a vaga do run desde a 0.9.141, ou
 *    `squads/<code>/run-state.json` do run legado, com `status: running`). O do agente do squad é o
 *    da marca; o do nativo é o único run aberto ou o que o prompt aponta (`run=<id>`,
 *    `squads/<code>/output/<id>/` ou `squads/<code>/runs/<id>`). Com dois runs abertos do mesmo squad
 *    e nada que os distinga, não atribui: sai sem gravar.
 * 2. Grava o retorno bruto em `squads/<code>/output/<run>/_tmp/retornos/<tipo>-<agent_id>.md`, para
 *    o chefe não transcrever: `meta-voto --retorno` e `gate-verdict --citacoes` leem esse arquivo
 *    (ou o JSON que o código grava ao lado).
 * 3. Pede ao `scripts/squad-state.mjs retorno-subagente` do projeto que confira o formato com os
 *    leitores do cartório. Fora do formato, devolve `decision: "block"` com o que falta, até duas
 *    vezes por subagente; na terceira, deixa terminar, e o comando registra no ledger.
 *
 * Fora de projeto LegalSquad, fora de run aberto, tipo sem veredito, squad-state antigo (sem o
 * comando) ou qualquer erro: sai 0 sem bloquear. Sem rede; o retorno só é gravado dentro do run.
 *
 * Sem dependência e sem import de `src/`: é copiado para o projeto e para o plugin.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const NATIVOS = new Set(['verificador-citacoes', 'verificador-persuasao', 'avaliador-squad', 'contraditor']);
/**
 * Os tipos do agente do squad: o hook só os reconhece pela marca que o código põe no despacho.
 * `default` e `worker` são os agentes embutidos do Codex, que faz as vezes do `general-purpose`.
 */
const DO_SQUAD = new Set(['general-purpose', 'revisor-squad', 'executor-squad', 'default', 'worker']);

function real(caminho) {
  try { return realpathSync(caminho); } catch { return resolve(caminho); }
}

/** Primeira pasta, subindo a partir de cada ponto, que tem `_legalsquad/`. */
function raizDoProjeto(...pontos) {
  for (const ponto of pontos) {
    if (!ponto) continue;
    let dir = resolve(ponto);
    for (;;) {
      try { if (statSync(join(dir, '_legalsquad')).isDirectory()) return dir; } catch { /* sobe */ }
      const acima = dirname(dir);
      if (acima === dir) break;
      dir = acima;
    }
  }
  return null;
}

/**
 * Esta é a cópia do plugin e o projeto já registra a própria (a sessão aberta na raiz, com o hook no
 * settings.json dela)? Então quem roda é a do projeto: as duas contariam o mesmo bloqueio duas vezes.
 */
function copiaDoPluginCedeAVez(raiz) {
  const plugin = process.env.CLAUDE_PLUGIN_ROOT;
  if (!plugin || !real(AQUI).startsWith(real(plugin))) return false;
  const sessao = process.env.CLAUDE_PROJECT_DIR;
  if (!sessao || real(sessao) !== real(raiz)) return false;
  if (!existsSync(join(raiz, '.claude', 'hooks', 'retorno-subagente.mjs'))) return false;
  try { return readFileSync(join(raiz, '.claude', 'settings.json'), 'utf8').includes('retorno-subagente.mjs'); } catch { return false; }
}

/** A transcrição do subagente: o prompt do despacho, a hora em que começou e o relatório do SubagentHandback. */
function lerTranscricao(caminho) {
  const saida = { prompt: '', inicio: null, handback: null };
  if (!caminho) return saida;
  let texto;
  try { texto = readFileSync(caminho.replace(/^~(?=\/)/, process.env.HOME || '~'), 'utf8'); } catch { return saida; }
  let ultimoDoUsuarioNoCodex = '';
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    let o;
    try { o = JSON.parse(linha); } catch { continue; }
    if (!saida.inicio && typeof o.timestamp === 'string') saida.inicio = o.timestamp;
    const p = o && o.type === 'response_item' && o.payload;
    if (p && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) ultimoDoUsuarioNoCodex = p.content.map((c) => (c && c.text) || '').join('\n');
    const conteudo = o && o.message && o.message.content;
    if (!saida.prompt && o.type === 'user') saida.prompt = typeof conteudo === 'string' ? conteudo : Array.isArray(conteudo) ? conteudo.map((c) => (c && c.text) || '').join('\n') : '';
    if (o.type === 'assistant' && Array.isArray(conteudo)) {
      for (const c of conteudo) if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input && typeof c.input.message === 'string') saida.handback = c.input.message;
    }
  }
  // Transcrição que não é do Claude Code. Codex (21/10/2026): o `agent_transcript_path` vem no
  // SubagentStop (https://learn.chatgpt.com/docs/hooks), mas o formato das linhas não é documentado;
  // observado no disco: `{timestamp, type: "response_item", payload: {type: "message", role, content:
  // [{type: "input_text", text}]}}`. Vale a ÚLTIMA mensagem do usuário: num fork com o histórico do
  // pai, as primeiras são do pai. Sem nenhuma reconhecida, o texto cru serve à marca e ao squad citado.
  if (!saida.prompt) saida.prompt = ultimoDoUsuarioNoCodex || texto.slice(0, 2 * 1024 * 1024);
  return saida;
}

/**
 * A marca do despacho do agente do squad que dá veredito, lida no prompt: `{ squad, run, papel }`, ou
 * null. Só o código a escreve (`despacho_do_revisor`); o nome do squad e o run vêm nela.
 */
const MARCA_DO_VEREDITO = /\[legalsquad:veredito squad=([a-z0-9][a-z0-9-]*) run=([\w.-]+) papel=(revisao|conferencia)\]/;
function marcaDoVeredito(prompt) {
  const m = String(prompt || '').match(MARCA_DO_VEREDITO);
  return m ? { squad: m[1], run: m[2], papel: m[3] } : null;
}

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

/** Os runs abertos do projeto, na raiz dos squads (legado) e nas vagas: `{ code, dir, estado, runId, atualizado }`. */
function runsAbertos(raiz) {
  return runsAbertosDoProjeto(raiz);
}

/**
 * O run do agente nativo: o que o prompt aponta sem ambiguidade (marca `run=`, caminho de output ou da
 * vaga). Sem isso, o legado: entre os squads citados (ou todos), o mais recente, desde que não haja
 * dois runs abertos do mesmo squad entre os candidatos (aí, na dúvida, nenhum).
 */
function squadDoAgente(raiz, prompt) {
  const abertos = runsAbertos(raiz);
  const marcado = runMarcadoNoTexto(abertos, prompt);
  if (marcado || abertos.length <= 1) return marcado || abertos[0] || null;
  const citados = abertos.filter((a) => String(prompt || '').includes(`squads/${a.code}/`));
  const candidatos = citados.length ? citados : abertos;
  const codes = candidatos.map((a) => a.code);
  if (new Set(codes).size !== codes.length) return null;
  return candidatos.sort((a, b) => b.atualizado.localeCompare(a.atualizado))[0];
}

function principal() {
  let entrada;
  try { entrada = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (!entrada || entrada.hook_event_name !== 'SubagentStop') return;
  const tipo = String(entrada.agent_type || '').replace(/^legalsquad:/, '');
  if (!NATIVOS.has(tipo) && !DO_SQUAD.has(tipo)) return;
  const raiz = raizDoProjeto(entrada.cwd, process.env.CLAUDE_PROJECT_DIR);
  if (!raiz || copiaDoPluginCedeAVez(raiz)) return;
  const transcricao = lerTranscricao(entrada.agent_transcript_path);
  let squad;
  let papel = null;
  if (DO_SQUAD.has(tipo)) {
    // Sem a marca do código, o general-purpose (ou o revisor-squad) não é do squad (ou é um agente sem veredito): nada.
    const marca = marcaDoVeredito(transcricao.prompt);
    if (!marca) return;
    squad = runsAbertos(raiz).find((a) => a.code === marca.squad && a.runId === marca.run) || null;
    papel = marca.papel;
  } else {
    squad = squadDoAgente(raiz, transcricao.prompt);
  }
  if (!squad) {
    // Na dúvida o retorno não vai a run nenhum, mas fica registrado: com dois runs abertos, o painel e a
    // auditoria mostram o agente que ninguém recebeu, em vez de ele sumir (0.9.142).
    if (!DO_SQUAD.has(tipo) && runsAbertos(raiz).length > 1) {
      try {
        const pasta = join(raiz, '_legalsquad', '_tmp');
        mkdirSync(pasta, { recursive: true });
        appendFileSync(join(pasta, 'retornos-sem-run.jsonl'), `${JSON.stringify({ em: new Date().toISOString(), tipo, agente_id: String(entrada.agent_id || ''), motivo: 'mais de um run aberto e o prompt sem a marca run=<id> nem o caminho do run' })}\n`);
      } catch { /* registro de diagnóstico: falhar aqui não muda nada no run */ }
    }
    return;
  }
  const retorno = transcricao.handback || (typeof entrada.last_assistant_message === 'string' ? entrada.last_assistant_message : '');
  const id = String(entrada.agent_id || 'sem-id').replace(/[^\w.-]+/g, '-').slice(0, 80);
  const pasta = join(squad.dir, 'output', squad.runId, '_tmp', 'retornos');
  mkdirSync(pasta, { recursive: true });
  const arquivo = join(pasta, `${papel || tipo}-${id}.md`);
  writeFileSync(arquivo, retorno, 'utf8');
  const squadState = join(raiz, 'scripts', 'squad-state.mjs');
  if (!existsSync(squadState)) return;
  // Para o cartório, o agente embutido do Codex é o `general-purpose` do Claude Code.
  const tipoNoCartorio = tipo === 'default' || tipo === 'worker' ? 'general-purpose' : tipo;
  // O squad-state recebe o caminho do estado do run (a vaga, ou a raiz do squad no run legado).
  const args = [squadState, 'retorno-subagente', squad.estado || squad.dir, '--tipo', tipoNoCartorio, '--arquivo', arquivo, '--agente-id', id];
  // No run legado (estado na raiz do squad), o `--run` diz qual run: pela raiz, sem ele, o squad-state
  // recusa quando outro caso tem run aberto numa vaga, e o retorno se perdia (0.9.142).
  if (!squad.estado || resolve(squad.estado) === resolve(squad.dir)) args.push('--run', squad.runId);
  if (papel) args.push('--papel', papel);
  if (transcricao.inicio) args.push('--desde', transcricao.inicio);
  const r = spawnSync(process.execPath, args, { cwd: raiz, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 || !r.stdout) return;
  let res;
  try { res = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)); } catch { return; }
  if (res && res.acao === 'bloquear' && typeof res.motivo === 'string') {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: res.motivo })}\n`);
  }
}

// Sem process.exit: no macOS a escrita em pipe é assíncrona, e sair na marra cortaria o JSON.
try { principal(); } catch { /* o hook nunca derruba o subagente */ }
process.exitCode = 0;
