// Monitor de agentes por código (0.9.108).
//
// Medido em dois runs: em 09/10/2026 (reforma tributária, ritmo Rápido) o revisor trabalhou 5 horas
// sem ninguém medir, e a sessão disse "parado" olhando o arquivo errado; em 16/10/2026 (memoriais
// cíveis) foram 30 subagentes, o `vigiar` rodou uma vez e o `aguardar` nenhuma, os leitores de autos
// (51 min) e de prova (31 min) ficaram sem relógio, e o revisor caiu duas vezes por 503 sem que a
// sessão visse. Os dois relógios que existiam dependiam de a sessão lembrar de rodá-los, e é ela
// quem está esperando.
//
// Aqui o relógio é do código: os hooks do Claude Code (`.claude/hooks/monitor-agentes.mjs`) gravam
// um registro de metadados por subagente (id, tipo, descrição curta, papel deduzido, horários,
// caminho da transcrição; nunca o prompt nem conteúdo do caso), e este módulo lê o registro e o fim
// da transcrição de cada agente aberto para dizer a situação de cada um: `trabalhando`, `lento`
// (passou do tempo do papel), `parado` (10 min sem escrever na transcrição), `caiu` (a última
// mensagem é erro da API) ou `terminou`. O painel (`legalsquad agentes`, `squad-state agentes`) e o
// aviso na conversa (o hook, por `additionalContext`, e o despertador `asyncRewake`) usam a mesma
// leitura.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM para `scripts/squad-state.mjs`,
// `templates/scripts/squad-state.mjs`, `.claude/hooks/monitor-agentes.mjs` e
// `templates/ide-templates/claude-code/.claude/hooks/monitor-agentes.mjs` (`npm run sync:blocos`).
// As funções usam os módulos de `node:fs`, `node:path` e `node:os` importados fora do bloco em cada
// arquivo. A busca de transcrição (`transcricaoDoSubagente`) era do `vigiar` (0.9.100) e mora aqui
// agora; o `vigiar` a usa pelo bloco.
import {
  appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// >>> monitor-agentes:begin
/**
 * Minutos que cada papel costuma levar, medidos nos runs de setembro e outubro de 2026 (o plano do
 * monitor, seção 3.2). Passar deles é `lento`: não interrompe nada sozinho. O perfil do projeto
 * ajusta (`monitor.tempos` em `_legalsquad/_memory/perfil.json`).
 */
const MONITOR_TEMPO_POR_PAPEL = Object.freeze({
  descritor: 5, prazo: 10, 'pre-mortem': 10, temas: 10, leitor: 20, pesquisa: 20, verificador: 20, revisor: 30, avaliador: 35, calculista: 55,
});
/** Papel que a descrição e o tipo não dizem. */
const MONITOR_TEMPO_DESCONHECIDO_MIN = 25;
/** Minutos sem escrever na transcrição que contam como `parado`. */
const MONITOR_PARADO_MIN = 10;
/** Minutos sem escrever que ainda contam como `trabalhando` sem ressalva (entre este e o parado, `trabalhando`). */
const MONITOR_TRABALHANDO_MIN = 5;
/** O que o registro guarda da descrição do despacho (a descrição curta do Agent, nunca o prompt). */
const MONITOR_DESCRICAO_MAX = 80;
/** O aviso na conversa: no máximo isto por agente e tantos agentes por aviso. */
const MONITOR_AVISO_MAX_POR_AGENTE = 600;
const MONITOR_AVISO_MAX_AGENTES = 3;
const MONITOR_REGISTRO = 'agentes.jsonl';
/** A linha que o redespacho do agente parado leva a mais (a mesma do `vigiar`). */
const MONITOR_LINHA_DE_REENVIO = 'reenvio: julgue com o que já está nos artefatos, sem abrir fonte';
const MONITOR_SITUACOES_DE_AVISO = Object.freeze(['lento', 'parado', 'caiu']);

const monitorTentar = (fn, padrao) => { try { return fn(); } catch { return padrao; } };
const monitorSemAcento = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const monitorIdDoAgente = (id) => String(id ?? '').trim().replace(/^agent-/, '').replace(/\.jsonl$/, '');

/**
 * O papel lido na descrição do despacho (a mais específica) e, sem acerto, no tipo do agente. A ordem
 * importa: "aplica as correções da revisão" é do redator, não do revisor; "Diagnóstico: temas do
 * acervo" é de temas, não de pesquisa.
 */
const MONITOR_PAPEL_PELA_DESCRICAO = [
  ['calculista', /calcul|contingenc|liquidac/],
  ['avaliador', /avalia|\bmeta\b/],
  ['redator', /redig|redacao|aplica (?:as )?correc|corrige|reclassifica/],
  ['revisor', /revis/],
  ['verificador', /verifica|confer|confirm|citac/],
  ['pre-mortem', /pre[- ]?mortem|contradit|ataques?\b/],
  ['prazo', /\bprazos?\b/],
  ['descritor', /imagen|figura|descritor/],
  ['temas', /\btemas?\b/],
  ['pesquisa', /pesquis|jurisprud|acervo|legislac|doutrin/],
  ['leitor', /leitor|leitura|\bautos\b|\bprova\b|sumario|diagnostic/],
];
const MONITOR_PAPEL_PELO_TIPO = Object.freeze({
  'verificador-citacoes': 'verificador', 'verificador-persuasao': 'verificador', 'avaliador-squad': 'avaliador', 'revisor-squad': 'revisor',
  contraditor: 'pre-mortem', 'lembrete-prazo': 'prazo', 'acervo-busca': 'pesquisa', 'jurisprudencia-stj-stf': 'pesquisa', 'lei-e-sumula': 'pesquisa',
  doutrina: 'pesquisa', 'resumo-processo': 'leitor', 'analise-contradicoes': 'leitor',
});

/**
 * Os nomes de arquivo de agente e de step que o despacho cita (`agents/calculista.agent.md`,
 * `.claude/agents/revisor-squad.md`, `steps/step-10-carga-por-regime.md`): `{ agentes, steps }`, sem
 * extensão. É só o nome do arquivo da estrutura do squad; nada do texto do despacho é guardado.
 */
function pistasDoDespacho(prompt) {
  const t = String(prompt ?? '');
  const agentes = [...t.matchAll(/(?:^|[\s/`'"(])agents\/([a-z0-9][\w.-]*?)(?:\.agent)?\.md\b/gi)].map((m) => m[1].toLowerCase());
  const steps = [...t.matchAll(/\b(step-[\w-]+)/gi)].map((m) => m[1].toLowerCase());
  return { agentes: [...new Set(agentes)], steps: [...new Set(steps)] };
}

const papelPelaFrase = (texto) => {
  const d = monitorSemAcento(texto).replace(/[-_]/g, ' ');
  if (!d) return null;
  for (const [papel, re] of MONITOR_PAPEL_PELA_DESCRICAO) if (re.test(d)) return papel;
  return null;
};

/**
 * O papel do agente, na ordem do mais seguro ao menos: o arquivo do agente que o despacho cita (o
 * `calculista.agent.md` do squad), a descrição do despacho, o nome do step citado e o tipo do agente
 * (`subagent_type`). Sem acerto, `desconhecido`. Medido na releitura do run de 09/10/2026: o
 * calculista foi despachado como general-purpose com o nome do personagem na descrição ("Custódio
 * Carga: carga por regime e ano"), e só o arquivo do agente no despacho dizia o papel.
 */
function papelDoAgente(tipo, descricao, pistas = null) {
  const { agentes = [], steps = [] } = pistas || {};
  const t = String(tipo || '').replace(/^[a-z0-9-]+:/, '');
  for (const nome of agentes) { const p = MONITOR_PAPEL_PELO_TIPO[nome] || papelPelaFrase(nome); if (p) return p; }
  const pelaDescricao = papelPelaFrase(descricao);
  if (pelaDescricao) return pelaDescricao;
  for (const nome of steps) { const p = papelPelaFrase(nome.replace(/^step-\d*-?/, '')); if (p) return p; }
  return MONITOR_PAPEL_PELO_TIPO[t] || papelPelaFrase(t) || 'desconhecido';
}

/**
 * O que o perfil do projeto diz do monitor (`monitor` em `_legalsquad/_memory/perfil.json`):
 * `despertar` (padrão false desde 0.9.111: só `true` liga; medido em 22/10/2026, o despertador segura a
 * sessão no `claude -p` sem entrada em streaming), `tempos` por papel em minutos (aceita fração, para o
 * teste), `parado_min` e `trabalhando_min`. Valor fora do tipo é ruído, não regra.
 */
function configDoMonitor(raiz) {
  const dados = monitorTentar(() => JSON.parse(readFileSync(join(raiz, '_legalsquad', '_memory', 'perfil.json'), 'utf8')), null);
  const m = dados && dados.monitor && typeof dados.monitor === 'object' ? dados.monitor : {};
  const positivo = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const tempos = { ...MONITOR_TEMPO_POR_PAPEL, desconhecido: MONITOR_TEMPO_DESCONHECIDO_MIN, redator: MONITOR_TEMPO_DESCONHECIDO_MIN };
  if (m.tempos && typeof m.tempos === 'object') for (const [papel, v] of Object.entries(m.tempos)) if (positivo(v)) tempos[papel] = v;
  return {
    despertar: m.despertar === true,
    tempos,
    parado_min: positivo(m.parado_min) ? m.parado_min : MONITOR_PARADO_MIN,
    trabalhando_min: positivo(m.trabalhando_min) ? m.trabalhando_min : MONITOR_TRABALHANDO_MIN,
  };
}

/**
 * A mensagem de erro da API que o Claude Code grava como resposta do agente, lida por inteiro (o
 * texto É o erro, ancorado no começo): `{ tipo, status, mensagem, prazo }`, ou null. `servidor`: 5xx,
 * 529, sem conexão, resposta cortada; `limite`: 429, limite da sessão ou da semana; `saldo`: crédito
 * ou cota; `outro`: requisição (400, modelo não habilitado, entrada grande demais). `prazo` é o que a
 * mensagem diz para esperar ("reset after 20m 29s", "resets 3pm").
 */
const MONITOR_ERRO_DA_API = /^(?:API Error\b|You've hit your (?:session|weekly|usage) limit|You're out of (?:usage )?credits|Credit balance is too low|Not logged in|Login expired|Request too large|Prompt is too long|Agent terminated early)/i;
function erroDaApi(texto, marcadoComoErro = false) {
  const msg = String(texto ?? '').trim();
  if (!msg || (!marcadoComoErro && !MONITOR_ERRO_DA_API.test(msg))) return null;
  const status = (msg.match(/\b([45]\d\d)\b/) || [])[1] || null;
  let tipo = 'outro';
  if (/model .{0,80}not enabled|not found in available tools|input exceeds|too large|prompt is too long|not logged in|login expired/i.test(msg)) tipo = 'outro';
  else if (/credit balance|out of (?:usage )?credits|quota|billing|saldo|credito/i.test(msg)) tipo = 'saldo';
  else if (status === '429' || /rate limit|session limit|weekly limit|usage limit|too many requests/i.test(msg)) tipo = 'limite';
  else if ((status && /^5/.test(status)) || /unavailable|overloaded|upstream|can.?t reach|connection lost|server error|went to sleep|econn|enotfound|timed? ?out/i.test(msg)) tipo = 'servidor';
  const prazo = (msg.match(/reset(?:s)? (?:after|in) ((?:\d+\s*[hms]\s*)+)/i) || msg.match(/resets? ((?:at )?[^·().]*?\d(?::\d\d)?\s*(?:am|pm)?(?: \([^)]+\))?)(?:\.|$|\s·)/i) || [])[1] || null;
  const curta = msg.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*(?:This is a server-side issue|If it persists).*$/i, '').replace(/\s*[\u2013\u2014].*$/, '').replace(/\s+/g, ' ').slice(0, 160);
  return { tipo, status, mensagem: curta, prazo: prazo ? prazo.trim() : null };
}

/** O prazo relativo da mensagem ("1h 27s", "20m 29s") em ms; null quando é hora do relógio ou não há. */
function prazoEmMs(prazo) {
  if (!prazo || !/^(?:\d+\s*[hms]\s*)+$/i.test(String(prazo).trim())) return null;
  let ms = 0;
  for (const [, n, u] of String(prazo).matchAll(/(\d+)\s*([hms])/gi)) ms += Number(n) * ({ h: 3600000, m: 60000, s: 1000 })[u.toLowerCase()];
  return ms;
}

/** A pasta do projeto no Claude Code: o caminho absoluto com todo caractere fora de [A-Za-z0-9] trocado por "-". */
function slugDoProjetoClaude(caminho) {
  return String(caminho).replace(/[^A-Za-z0-9]/g, '-');
}

/** `<config do Claude Code>/projects`: o pedido, ou `$CLAUDE_CONFIG_DIR/projects` quando definido, ou `~/.claude/projects`. */
function pastaDeProjetosDoClaude(pedida) {
  if (typeof pedida === 'string' && pedida.trim()) return resolve(pedida);
  const base = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() ? process.env.CLAUDE_CONFIG_DIR.trim() : join(homedir(), '.claude');
  return join(base, 'projects');
}

/**
 * A transcrição do subagente: a de mtime mais recente entre as sessões da pasta do projeto (o slug da
 * raiz e do diretório atual, com e sem o caminho real) e, sem nenhuma lá, entre todas as pastas de
 * projeto. O id do agente é único; a sessão mais recente que o contém é a do run.
 */
function transcricaoDoSubagente(projetos, raiz, agente) {
  const nome = `agent-${monitorIdDoAgente(agente)}.jsonl`;
  const real = (p) => monitorTentar(() => realpathSync(p), p);
  const doProjeto = [...new Set([raiz, real(raiz), process.cwd(), real(process.cwd())].map(slugDoProjetoClaude))].map((s) => join(projetos, s));
  const naPasta = (pastas) => {
    let melhor = null;
    for (const pasta of pastas) {
      let sessoes;
      try { sessoes = readdirSync(pasta, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
      for (const sessao of sessoes) {
        const f = join(pasta, sessao.name, 'subagents', nome);
        const m = monitorTentar(() => statSync(f).mtimeMs, null);
        if (m !== null && (!melhor || m > melhor.m)) melhor = { f, m, sessao: sessao.name };
      }
    }
    return melhor;
  };
  const achado = naPasta(doProjeto) || naPasta(monitorTentar(() => readdirSync(projetos).map((n) => join(projetos, n)), []));
  return achado ? { arquivo: achado.f, sessao: achado.sessao } : null;
}

/**
 * A transcrição do subagente pelo caminho da transcrição da sessão (o `transcript_path` do evento):
 * `<sessão>.jsonl` tem os subagentes em `<sessão>/subagents/agent-<id>.jsonl` (a doc do
 * SubagentStop: "stored in a nested subagents/ folder").
 */
function transcricaoPelaSessao(transcriptPath, agente) {
  const p = String(transcriptPath || '').replace(/^~(?=\/)/, homedir());
  if (!p.endsWith('.jsonl') || !monitorIdDoAgente(agente)) return null;
  return join(p.slice(0, -'.jsonl'.length), 'subagents', `agent-${monitorIdDoAgente(agente)}.jsonl`);
}

/** Os squads com run aberto (`status: running` no `run-state.json`): `{ code, dir, runId, atualizado }`. */
function monitorRunsAbertos(raiz) {
  const base = join(raiz, 'squads');
  const abertos = [];
  for (const code of monitorTentar(() => readdirSync(base), [])) {
    const l = monitorTentar(() => JSON.parse(readFileSync(join(base, code, 'run-state.json'), 'utf8')), null);
    if (l && l.status === 'running' && typeof l.runId === 'string' && l.runId) abertos.push({ code, dir: join(base, code), runId: l.runId, atualizado: String(l.updatedAt || '') });
  }
  return abertos.sort((a, b) => b.atualizado.localeCompare(a.atualizado));
}

const registroDoRun = (run) => join(run.dir, 'output', run.runId, '_tmp', MONITOR_REGISTRO);
const registroSolto = (raiz) => join(raiz, '_legalsquad', '_tmp', MONITOR_REGISTRO);

/** Onde o despacho de agora se registra: o run aberto mais recente, ou `_legalsquad/_tmp/` sem run. */
function registroAtual(raiz) {
  const abertos = monitorRunsAbertos(raiz);
  return abertos.length ? registroDoRun(abertos[0]) : registroSolto(raiz);
}

/** Os registros que o painel lê: o de cada run aberto (ou só o do squad pedido) e o solto. */
function registrosParaLer(raiz, { squad = null } = {}) {
  const lista = monitorRunsAbertos(raiz).filter((r) => !squad || r.code === squad).map((r) => ({ arquivo: registroDoRun(r), squad: r.code, run: r.runId }));
  if (!squad) lista.push({ arquivo: registroSolto(raiz), squad: null, run: null });
  return lista;
}

/** O run do registro ainda está aberto? O registro solto (sem run) não fecha. */
function registroAberto(raiz, arquivo) {
  const m = String(arquivo).replace(/\\/g, '/').match(/\/squads\/([^/]+)\/output\/([^/]+)\/_tmp\/[^/]+$/);
  if (!m) return true;
  const l = monitorTentar(() => JSON.parse(readFileSync(join(raiz, 'squads', m[1], 'run-state.json'), 'utf8')), null);
  return Boolean(l && l.status === 'running' && l.runId === m[2]);
}

/** Acrescenta um evento ao registro (uma linha JSON; só metadados). */
function anotarNoRegistro(arquivo, evento) {
  mkdirSync(dirname(arquivo), { recursive: true });
  appendFileSync(arquivo, `${JSON.stringify(evento)}\n`, 'utf8');
}

/** A descrição curta que o registro guarda: uma linha, até 80 caracteres. */
const descricaoCurta = (d) => String(d ?? '').replace(/\s+/g, ' ').trim().slice(0, MONITOR_DESCRICAO_MAX);
const tipoSemEscopo = (t) => String(t ?? '').replace(/^[a-z0-9-]+:/, '');

/**
 * O registro dobrado: um objeto por agente com tipo, descrição, início, fim e a transcrição. O
 * pedido (PreToolUse do Agent) dá a descrição; o início (SubagentStart) a casa com o pedido mais
 * antigo do mesmo tipo ainda sem dono; o lançamento (PostToolUse do Agent, com `agentId` e o
 * `tool_use_id`) corrige a casa quando chega. O SubagentStart de um agente retomado abre uma
 * geração nova.
 */
function lerRegistro(arquivo) {
  const bruto = monitorTentar(() => readFileSync(arquivo, 'utf8'), '');
  const agentes = new Map();
  const pedidos = [];
  const pedidoPorUso = new Map();
  const livre = (p) => p && !p.dono;
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue;
    const e = monitorTentar(() => JSON.parse(linha), null);
    if (!e || typeof e !== 'object') continue;
    if (e.ev === 'pedido') {
      const p = { uso: e.uso || null, tipo: tipoSemEscopo(e.tipo), descricao: descricaoCurta(e.descricao), papel: typeof e.papel === 'string' ? e.papel : null, em: e.em, dono: null };
      pedidos.push(p);
      if (p.uso) pedidoPorUso.set(p.uso, p);
      continue;
    }
    const id = monitorIdDoAgente(e.agente);
    if (!id) continue;
    let a = agentes.get(id);
    if (!a) { a = { agente: id, tipo: null, descricao: '', papel: null, inicio: null, fim: null, motivo: null, erro: null, transcricao: null, geracao: 0, uso: null, registro: arquivo }; agentes.set(id, a); }
    if (e.ev === 'inicio') {
      a.tipo = tipoSemEscopo(e.tipo) || a.tipo;
      a.geracao += 1;
      a.inicio = e.em;
      a.fim = null;
      a.motivo = null;
      a.erro = null;
      if (e.transcricao) a.transcricao = e.transcricao;
      if (!a.descricao) {
        const p = pedidos.find((x) => livre(x) && (!x.tipo || !a.tipo || x.tipo === a.tipo));
        if (p) { p.dono = id; a.descricao = p.descricao; a.papel = p.papel; a.uso = p.uso; }
      }
    } else if (e.ev === 'lancado') {
      const p = e.uso ? pedidoPorUso.get(e.uso) : null;
      if (p && p.dono !== id) {
        const antigo = a.uso ? pedidoPorUso.get(a.uso) : null;
        if (antigo && antigo.dono === id) antigo.dono = null;
        if (p.dono && agentes.get(p.dono)) { const outro = agentes.get(p.dono); outro.descricao = ''; outro.papel = null; outro.uso = null; }
        p.dono = id;
      }
      a.uso = e.uso || a.uso;
      a.descricao = (p && p.descricao) || descricaoCurta(e.descricao) || a.descricao;
      if (p && p.papel) a.papel = p.papel;
      if (e.tipo && !a.tipo) a.tipo = tipoSemEscopo(e.tipo);
      if (!a.inicio) a.inicio = e.em;
    } else if (e.ev === 'fim') {
      a.fim = e.em;
      a.motivo = e.motivo || 'terminou';
      a.erro = e.erro || null;
      if (e.transcricao) a.transcricao = e.transcricao;
      if (!a.inicio) a.inicio = e.em;
    }
  }
  return { agentes, pedidos };
}

/**
 * O fim da transcrição, lido por partes: só os bytes novos desde a última leitura (`anterior`, o
 * que o cache guardou com o tamanho e o mtime). Conta as chamadas de ferramenta, soma os tokens de
 * saída por mensagem e guarda o primeiro e o último horário e o erro da API da última resposta.
 * A linha incompleta do fim fica para a próxima leitura.
 */
function lerTranscricaoPorPartes(arquivo, anterior = null) {
  let st;
  try { st = statSync(arquivo); } catch { return null; }
  if (anterior && anterior.size === st.size && anterior.mtime === st.mtimeMs) return anterior;
  // A transcrição só cresce; se encolheu, ou o começo mudou (arquivo regravado), a leitura recomeça.
  const cabeca = monitorTentar(() => {
    const b = Buffer.alloc(Math.min(256, st.size));
    const fd = openSync(arquivo, 'r');
    try { readSync(fd, b, 0, b.length, 0); } finally { closeSync(fd); }
    return b.toString('base64');
  }, '');
  const continua = anterior && anterior.offset <= st.size && anterior.size < st.size && anterior.cabeca === cabeca;
  const base = continua
    ? { ...anterior }
    : { offset: 0, chamadas: 0, tokens: 0, msgId: null, msgTokens: 0, primeira: null, ultima: null, erro: null };
  base.cabeca = cabeca;
  base.size = st.size;
  base.mtime = st.mtimeMs;
  const tamanho = st.size - base.offset;
  if (tamanho <= 0) return base;
  const buf = Buffer.alloc(tamanho);
  const fd = openSync(arquivo, 'r');
  try { readSync(fd, buf, 0, tamanho, base.offset); } finally { closeSync(fd); }
  const fimDaUltima = buf.lastIndexOf(10);
  if (fimDaUltima < 0) return base;
  const texto = buf.toString('utf8', 0, fimDaUltima);
  base.offset += fimDaUltima + 1;
  for (const linha of texto.split('\n')) {
    if (!linha) continue;
    const ts = (linha.match(/"timestamp":"([^"]+)"/) || [])[1];
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(t)) { if (base.primeira === null) base.primeira = t; base.ultima = t; }
    if (!linha.includes('"type":"assistant"')) continue;
    let o;
    try { o = JSON.parse(linha); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const conteudo = Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of conteudo) if (c && c.type === 'tool_use') base.chamadas += 1;
    const saida = o.message.usage && Number.isFinite(o.message.usage.output_tokens) ? o.message.usage.output_tokens : 0;
    const id = o.message.id || o.uuid || null;
    if (id !== base.msgId) { base.tokens += base.msgTokens; base.msgId = id; base.msgTokens = saida; } else base.msgTokens = Math.max(base.msgTokens, saida);
    const textoDaResposta = conteudo.map((c) => (c && c.type === 'text' ? c.text : '')).join(' ');
    const erro = erroDaApi(textoDaResposta, o.isApiErrorMessage === true);
    base.erro = erro ? { ...erro, em: Number.isFinite(t) ? t : null } : null;
  }
  return base;
}

const cacheDoMonitor = (raiz) => join(raiz, '_legalsquad', '_tmp', 'monitor-cache.json');

/**
 * A situação de cada agente dos registros: `{ agente, tipo, papel, descricao, inicio, fim, minutos,
 * esperado_min, chamadas, tokens_saida, min_desde_escrita, situacao, erro, queda_n, geracao,
 * registro, transcricao }`. `agora` (ms) e `projetos` são para teste; `cache: false` não lê nem grava
 * o cache das transcrições. Sem agente aberto, não abre transcrição nenhuma.
 */
function estadoDosAgentes(raiz, { agora = Date.now(), squad = null, todos = false, agente = null, cache = true, projetos = null, config = null, registros = null } = {}) {
  const cfg = config || configDoMonitor(raiz);
  const lidos = (registros || registrosParaLer(raiz, { squad })).map((r) => ({ ...r, ...lerRegistro(r.arquivo) }));
  const lista = [];
  for (const r of lidos) for (const a of r.agentes.values()) if (!agente || a.agente === monitorIdDoAgente(agente)) lista.push({ ...a, squad: r.squad, run: r.run });
  const precisaLer = lista.filter((a) => todos || !a.fim || a.motivo === 'caiu');
  if (!precisaLer.length) return [];
  const arquivoDoCache = cacheDoMonitor(raiz);
  const guardado = cache ? monitorTentar(() => JSON.parse(readFileSync(arquivoDoCache, 'utf8')), {}) : {};
  const novo = {};
  const saida = [];
  for (const a of precisaLer) {
    let transcricao = a.transcricao && monitorTentar(() => statSync(a.transcricao).isFile(), false) ? a.transcricao : null;
    if (!transcricao) { const achado = transcricaoDoSubagente(pastaDeProjetosDoClaude(projetos), raiz, a.agente); transcricao = achado ? achado.arquivo : null; }
    const t = transcricao ? lerTranscricaoPorPartes(transcricao, guardado[transcricao] || null) : null;
    if (t && transcricao) novo[transcricao] = t;
    const inicio = Date.parse(a.inicio || '') || (t && t.primeira) || null;
    const fim = a.fim ? Date.parse(a.fim) : null;
    const papel = a.papel && a.papel !== 'desconhecido' ? a.papel : papelDoAgente(a.tipo, a.descricao);
    const esperado = cfg.tempos[papel] || cfg.tempos.desconhecido;
    const ate = fim || agora;
    const minutos = inicio ? Math.max(0, (ate - inicio) / 60000) : null;
    const ultimaEscrita = t ? Math.max(t.mtime || 0, t.ultima || 0) : null;
    const desdeEscrita = !fim && ultimaEscrita ? Math.max(0, (agora - ultimaEscrita) / 60000) : null;
    const erro = a.erro ? { ...a.erro, em: a.erro.em || fim } : (t && t.erro) || null;
    let situacao = 'trabalhando';
    if (fim) situacao = a.motivo === 'caiu' || erro ? 'caiu' : 'terminou';
    else if (erro) situacao = 'caiu';
    else if (desdeEscrita !== null && desdeEscrita >= cfg.parado_min) situacao = 'parado';
    else if (minutos !== null && minutos >= esperado) situacao = 'lento';
    if (!todos && situacao === 'terminou') continue;
    saida.push({
      agente: a.agente, tipo: a.tipo, papel, descricao: a.descricao, squad: a.squad, run: a.run,
      inicio: inicio ? new Date(inicio).toISOString() : null, fim: fim ? new Date(fim).toISOString() : null,
      minutos: minutos === null ? null : Math.round(minutos * 10) / 10, esperado_min: esperado,
      chamadas: t ? t.chamadas : null, tokens_saida: t ? t.tokens + t.msgTokens : null,
      min_desde_escrita: desdeEscrita === null ? null : Math.round(desdeEscrita * 10) / 10,
      situacao, erro, geracao: a.geracao, registro: a.registro, transcricao,
    });
  }
  // A ordem das quedas por papel no mesmo registro: a segunda queda do mesmo papel vai ao profissional.
  const quedas = new Map();
  for (const e of [...saida].sort((x, y) => String(x.inicio).localeCompare(String(y.inicio)))) {
    if (e.situacao !== 'caiu') continue;
    const chave = `${e.registro}|${e.papel}`;
    quedas.set(chave, (quedas.get(chave) || 0) + 1);
    e.queda_n = quedas.get(chave);
  }
  if (cache && Object.keys(novo).length) {
    monitorTentar(() => {
      mkdirSync(dirname(arquivoDoCache), { recursive: true });
      const tmp = `${arquivoDoCache}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...guardado, ...novo }), 'utf8');
      renameSync(tmp, arquivoDoCache);
    }, null);
  }
  return saida.sort((x, y) => String(x.inicio).localeCompare(String(y.inicio)));
}

const monitorBr = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
const monitorHora = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** A regra do runner para a situação, em frase de fato (o hook não dá ordem, informa). */
function regraDoMonitor(e) {
  if (e.situacao === 'caiu') {
    const erro = e.erro || {};
    if (e.queda_n >= 2) return `É a ${e.queda_n}ª queda do papel ${e.papel} neste run: pela regra do runner, a decisão vai ao profissional (esperar o serviço ou pausar o run), sem redespacho automático.`;
    if (erro.tipo === 'saldo') return 'A queda é de saldo ou cota da conta: esperar não resolve, e pela regra do runner a decisão vai ao profissional.';
    if (erro.tipo === 'outro') return 'É erro da requisição, não do servidor: pela regra do runner ("Erro de modelo não é queda"), não se redespacha igual; vale o despacho como general-purpose, sem model.';
    const ms = prazoEmMs(erro.prazo);
    const quando = erro.prazo ? ` (${erro.prazo}${ms && erro.em ? `, até ${monitorHora(erro.em + ms)}` : ''})` : '';
    return `Pela regra do runner, espera-se o prazo da mensagem${quando} e redespacha-se o mesmo agente, com o mesmo despacho e o mesmo modelo, sem trocar de modelo; numa segunda queda, a decisão vai ao profissional.`;
  }
  if (e.situacao === 'parado') return `Pela regra do runner, o agente parado é interrompido e o mesmo despacho é redespachado com a linha a mais: "${MONITOR_LINHA_DE_REENVIO}".`;
  return 'Lento não interrompe nada sozinho: o profissional fica sabendo em uma linha, com estes números, e o agente segue; se parar de escrever, vira parado.';
}

/** Uma frase por agente, até 600 caracteres: quem, há quanto tempo, quantas chamadas, a última atividade e a regra. */
function linhaDoAvisoDoMonitor(e) {
  const quem = `Subagente ${e.agente} (${e.papel}${e.descricao ? `, "${e.descricao}"` : ''})`;
  const numeros = [
    e.minutos !== null ? `${monitorBr(e.minutos)} min desde o início (tempo do papel: ${monitorBr(e.esperado_min)} min)` : null,
    e.chamadas !== null ? `${e.chamadas} chamadas de ferramenta` : 'transcrição não encontrada',
    e.min_desde_escrita !== null ? `última escrita na transcrição há ${monitorBr(e.min_desde_escrita)} min` : null,
  ].filter(Boolean).join(', ');
  const estado = e.situacao === 'caiu'
    ? `caiu por erro da API${e.erro && e.erro.mensagem ? ` (${e.erro.mensagem})` : ''}`
    : e.situacao === 'parado' ? 'está parado' : 'está lento';
  const texto = `${quem} ${estado}: ${numeros}. ${regraDoMonitor(e)}`;
  return texto.length > MONITOR_AVISO_MAX_POR_AGENTE ? `${texto.slice(0, MONITOR_AVISO_MAX_POR_AGENTE - 1)}…` : texto;
}

/** As marcas do aviso na conversa (PostToolUse e UserPromptSubmit) e as do despertador, em pastas separadas. */
const MONITOR_MARCAS_DO_AVISO = 'monitor-avisos';
const MONITOR_MARCAS_DO_DESPERTADOR = 'monitor-despertador';

/**
 * Marca a situação do agente como avisada no espaço `marcas`; true só para quem criou a marca (o
 * `wx` do sistema de arquivos é a trava: dois hooks ao mesmo tempo não avisam duas vezes). O
 * despertador marca no espaço dele: o que ele avisou (ou o que caiu no lugar errado) nunca impede o
 * aviso na conversa da sessão principal.
 */
function marcarAviso(e, marcas = MONITOR_MARCAS_DO_AVISO) {
  const pasta = join(dirname(e.registro), marcas);
  try {
    mkdirSync(pasta, { recursive: true });
    closeSync(openSync(join(pasta, `${e.agente}-${e.geracao}-${e.situacao}`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/**
 * O aviso para a conversa: os agentes `lento`, `parado` ou `caiu` ainda não avisados nesta situação,
 * até três, cada um marcado ao entrar. Devolve o texto, ou null quando não há o que avisar.
 * `marcar: false` só monta (o painel e o teste); `marcas` é o espaço das marcas (o do despertador é outro).
 */
function avisoDoMonitor(estados, { marcar = true, marcas = MONITOR_MARCAS_DO_AVISO } = {}) {
  const linhas = [];
  for (const e of estados) {
    if (linhas.length >= MONITOR_AVISO_MAX_AGENTES) break;
    if (!MONITOR_SITUACOES_DE_AVISO.includes(e.situacao)) continue;
    if (marcar && !marcarAviso(e, marcas)) continue;
    linhas.push(linhaDoAvisoDoMonitor(e));
  }
  if (!linhas.length) return null;
  return `Monitor de agentes do LegalSquad (medição por código): ${linhas.join(' ')} O painel completo sai em \`legalsquad agentes\`.`;
}
// <<< monitor-agentes:end

/**
 * A linha do tempo de uma transcrição já gravada, para reler runs passados (só leitura): quando o
 * monitor teria marcado `lento`, `parado` e `caiu`. Usa os horários das linhas, não o mtime (que um
 * arquivo antigo perdeu). `{ inicio, fim, minutos, papel, esperado_min, chamadas, lento_em, parados,
 * caiu_em, erro }`, com `parados` = `[{ em, sem_escrever_min }]` (cada pausa que passou do limite).
 */
export function linhaDoTempo(arquivo, { tipo = null, descricao = '', config = null } = {}) {
  const cfg = config || { tempos: { ...MONITOR_TEMPO_POR_PAPEL, desconhecido: MONITOR_TEMPO_DESCONHECIDO_MIN, redator: MONITOR_TEMPO_DESCONHECIDO_MIN }, parado_min: MONITOR_PARADO_MIN };
  const bruto = readFileSync(arquivo, 'utf8');
  const horas = [];
  let chamadas = 0;
  let erro = null;
  let pistas = null;
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue;
    const o = monitorTentar(() => JSON.parse(linha), null);
    if (!o) continue;
    // O despacho é a primeira mensagem do usuário: dele só saem os nomes de arquivo de agente e step.
    if (!pistas && o.type === 'user' && o.message) {
      const c = o.message.content;
      pistas = pistasDoDespacho(typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '');
    }
    const t = Date.parse(o.timestamp || '');
    if (Number.isFinite(t)) horas.push(t);
    if (o.type !== 'assistant' || !o.message) continue;
    const conteudo = Array.isArray(o.message.content) ? o.message.content : [];
    chamadas += conteudo.filter((c) => c && c.type === 'tool_use').length;
    const e = erroDaApi(conteudo.map((c) => (c && c.type === 'text' ? c.text : '')).join(' '), o.isApiErrorMessage === true);
    erro = e ? { ...e, em: Number.isFinite(t) ? t : null } : null;
  }
  horas.sort((a, b) => a - b);
  const inicio = horas[0] ?? null;
  const fim = horas[horas.length - 1] ?? null;
  const papel = papelDoAgente(tipo, descricao, pistas);
  const esperado = cfg.tempos[papel] || cfg.tempos.desconhecido;
  const parados = [];
  for (let i = 1; i < horas.length; i += 1) {
    const pausa = (horas[i] - horas[i - 1]) / 60000;
    if (pausa >= cfg.parado_min) parados.push({ em: new Date(horas[i - 1] + cfg.parado_min * 60000).toISOString(), sem_escrever_min: Math.round(pausa * 10) / 10 });
  }
  const lento = inicio !== null && fim - inicio >= esperado * 60000 ? new Date(inicio + esperado * 60000).toISOString() : null;
  return {
    inicio: inicio === null ? null : new Date(inicio).toISOString(), fim: fim === null ? null : new Date(fim).toISOString(),
    minutos: inicio === null ? null : Math.round(((fim - inicio) / 60000) * 10) / 10, papel, esperado_min: esperado, chamadas,
    lento_em: lento, parados, caiu_em: erro && erro.em ? new Date(erro.em).toISOString() : null, erro,
  };
}

/** Uma linha do painel, para gente. */
function linhaDoPainel(e) {
  const br = (n) => (n === null || n === undefined ? '-' : String(Math.round(n * 10) / 10).replace('.', ','));
  const tempo = `${br(e.minutos)}/${br(e.esperado_min)} min`;
  const escrita = e.min_desde_escrita === null ? (e.fim ? 'terminou' : '-') : `há ${br(e.min_desde_escrita)} min`;
  const erro = e.situacao === 'caiu' && e.erro ? ` · ${e.erro.mensagem}` : '';
  return `  ${e.agente.slice(0, 17).padEnd(17)}  ${e.papel.padEnd(11)}  ${e.situacao.padEnd(11)}  ${tempo.padEnd(14)}  ${String(e.chamadas ?? '-').padStart(5)}  ${escrita.padEnd(14)}  ${e.descricao || e.tipo || ''}${erro}`;
}

/** `legalsquad agentes [--squad <code>] [--json] [--todos]`: o painel dos agentes do run aberto. */
export function agentesCli(raiz, { squad = null, json = false, todos = false } = {}) {
  const estados = estadoDosAgentes(raiz, { squad: typeof squad === 'string' && squad ? squad : null, todos: todos === true });
  if (json) {
    console.log(JSON.stringify({ agentes: estados }, null, 2));
    return { success: true, agentes: estados };
  }
  if (!estados.length) {
    console.log(todos ? '\n  Nenhum agente registrado nos runs abertos.\n' : '\n  Nenhum agente aberto nos runs abertos (--todos mostra os que terminaram).\n');
    return { success: true, agentes: estados };
  }
  console.log('');
  console.log(`  ${'agente'.padEnd(17)}  ${'papel'.padEnd(11)}  ${'situação'.padEnd(11)}  ${'tempo/papel'.padEnd(14)}  ${'chamadas'.padStart(5)}  ${'última escrita'.padEnd(14)}  descrição`);
  for (const e of estados) console.log(linhaDoPainel(e));
  const alerta = estados.filter((e) => MONITOR_SITUACOES_DE_AVISO.includes(e.situacao));
  if (alerta.length) {
    console.log('');
    for (const e of alerta) console.log(`  ${e.agente}: ${regraDoMonitor(e)}`);
  }
  console.log('');
  return { success: true, agentes: estados };
}

export {
  MONITOR_TEMPO_POR_PAPEL, MONITOR_TEMPO_DESCONHECIDO_MIN, MONITOR_PARADO_MIN, MONITOR_DESCRICAO_MAX, MONITOR_AVISO_MAX_POR_AGENTE, MONITOR_AVISO_MAX_AGENTES,
  MONITOR_REGISTRO, MONITOR_LINHA_DE_REENVIO, MONITOR_MARCAS_DO_AVISO, MONITOR_MARCAS_DO_DESPERTADOR, pistasDoDespacho, papelDoAgente, configDoMonitor, erroDaApi, prazoEmMs, slugDoProjetoClaude, pastaDeProjetosDoClaude,
  transcricaoDoSubagente, transcricaoPelaSessao, monitorRunsAbertos, registroAtual, registrosParaLer, registroAberto, anotarNoRegistro, descricaoCurta,
  lerRegistro, lerTranscricaoPorPartes, estadoDosAgentes, regraDoMonitor, linhaDoAvisoDoMonitor, avisoDoMonitor, marcarAviso,
};
