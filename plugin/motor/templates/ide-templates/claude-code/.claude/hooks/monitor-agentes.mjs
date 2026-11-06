#!/usr/bin/env node
/**
 * Hook do monitor de agentes do LegalSquad (0.9.108): o relógio dos subagentes é do código, não da
 * sessão que espera por eles.
 *
 * Doc oficial conferida em 21/10/2026, Claude Code 2.1.299 (https://code.claude.com/docs/en/hooks e
 * https://code.claude.com/docs/en/sub-agents). O que este arquivo usa, campo a campo:
 * - Entrada comum: `hook_event_name`, `session_id`, `transcript_path` (a transcrição da SESSÃO),
 *   `cwd`; `agent_id` e `agent_type` quando o hook dispara DENTRO de um subagente ("Hooks from
 *   settings files ... apply inside subagents"): com `agent_id`, o PostToolUse e o UserPromptSubmit
 *   são do subagente, e o aviso não vai para ele.
 * - `PreToolUse` com matcher `Agent`: `tool_input.description`, `tool_input.subagent_type` e
 *   `tool_use_id` (o `prompt` e o `model` existem e NÃO são lidos nem gravados).
 * - `SubagentStart`: `agent_id` e `agent_type` (não traz prompt nem descrição). A transcrição do
 *   subagente fica em `<transcript_path sem .jsonl>/subagents/agent-<id>.jsonl` (a doc do
 *   SubagentStop: "stored in a nested subagents/ folder"); sem ela, a busca do `vigiar`. Também
 *   dispara num agente retomado: abre geração nova. Saída do SubagentStart iria para o subagente, por
 *   isso este hook não escreve nada nele.
 * - `PostToolUse` do `Agent`: `tool_response.status` (`async_launched` no segundo plano,
 *   `completed` no primeiro), `tool_response.agentId` e `tool_use_id`, que casam o agente com o
 *   pedido do PreToolUse.
 * - `SubagentStop`: `agent_id`, `agent_type`, `agent_transcript_path` e `last_assistant_message` (a
 *   queda pela API vem como o texto do erro).
 * Não usado por não estar documentado: o `.meta.json` ao lado da transcrição e qualquer forma de o
 * hook interromper um subagente (parar e redespachar continuam com a sessão).
 *
 * - `additionalContext` em `hookSpecificOutput` (com `hookEventName`), até 10.000 caracteres: no
 *   PostToolUse vai ao lado do resultado da ferramenta; no UserPromptSubmit, junto do prompt, e o
 *   UserPromptSubmit também dispara quando um subagente em segundo plano volta à sessão. A doc pede o
 *   texto como fato, não como ordem ao modelo: o aviso descreve a situação e a regra do runner.
 *
 * - `asyncRewake: true` no hook de comando (o despertador, com o argumento `despertar`, no
 *   PostToolUse com matcher `Agent`). O que a doc diz (conferida em 22/10/2026, 2.1.306): "If true,
 *   runs in the background and wakes Claude on exit code 2"; o `timeout` vale para ele; o código 2
 *   acorda o Claude mesmo com a sessão ociosa; no `-p` o hook em segundo plano ainda vivo é morto no
 *   fim da sessão. A doc não diz em que modo ele deixaria de rodar em segundo plano.
 *   O que foi medido (22/10/2026, 2.1.306, Sonnet 5.5, ambiente limpo, subagente em segundo plano de
 *   2 s, tempo do papel 1 min): no `claude -p` com `--output-format json` e o prompt como texto, o
 *   Bash seguinte ao Agent rodou 60 s depois do lançamento: o hook segurou o retorno do Agent pelo
 *   tempo do papel inteiro, e a guarda de 8 s da 0.9.108 (a transcrição da sessão não cresce) não
 *   disparou, porque a transcrição cresce mesmo com a sessão presa. Com `--input-format stream-json`,
 *   o Bash rodou 0,3 s depois. No run de 21/10/2026 foram 7 despachos presos, cerca de 147 de 260 min.
 *   As variáveis de ambiente do hook são as mesmas nos dois modos (`CLAUDE_CODE_ENTRYPOINT`,
 *   `CLAUDE_CODE_SESSION_ATTENDED` e as demais não diferem, e não são documentadas para isso); o que
 *   difere é a linha de comando do processo do Claude Code, que a doc expõe por `CLAUDE_PID` ("Read it
 *   from your own scripts to identify ... the parent Claude Code process"). Como a regra que liga a
 *   linha de comando ao primeiro plano é medida e não documentada, ela não basta para deixar o
 *   despertador ligado por padrão: desde 0.9.111 ele vem DESLIGADO (`monitor.despertar: true` no
 *   perfil liga), e o aviso segue pelo PostToolUse e pelo UserPromptSubmit, que não seguram nada.
 *   Ligado, ele ainda sai na hora quando a linha de comando é `-p` sem `--input-format stream-json` ou
 *   quando não dá para lê-la. Fica no PostToolUse do Agent, e não no SubagentStart, porque o
 *   SubagentStart roda no contexto do subagente (medido em 21/10/2026: o aviso foi parar na
 *   transcrição do subagente e segurou o subagente pelo sono inteiro).
 *
 * O que ele grava: uma linha de metadados por evento no registro do run aberto
 * (`squads/<code>/output/<run>/_tmp/agentes.jsonl`; sem run, `_legalsquad/_tmp/agentes.jsonl`):
 * id, tipo, descrição curta (até 80 caracteres), horários, caminho da transcrição. Nunca o prompt
 * nem conteúdo do caso. O painel é `legalsquad agentes`.
 *
 * Fora de projeto LegalSquad ou com qualquer erro: sai 0 sem saída. Nunca bloqueia nada.
 * Sem dependência e sem import de `src/`: é copiado para o projeto e para o plugin; a lógica vem do
 * bloco monitor-agentes (`npm run sync:blocos`).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

const AQUI = dirname(fileURLToPath(import.meta.url));

function real(caminho) {
  try { return realpathSync(caminho); } catch { return resolve(caminho); }
}

/** Primeira pasta, subindo a partir de cada ponto, que tem `_legalsquad/`. */
function raizDoMonitor(...pontos) {
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
 * settings.json dela)? Então quem roda é a do projeto: as duas gravariam cada evento duas vezes.
 */
function copiaDoPluginCedeAVez(raiz) {
  const plugin = process.env.CLAUDE_PLUGIN_ROOT;
  if (!plugin || !real(AQUI).startsWith(real(plugin))) return false;
  const sessao = process.env.CLAUDE_PROJECT_DIR;
  if (!sessao || real(sessao) !== real(raiz)) return false;
  if (!existsSync(join(raiz, '.claude', 'hooks', 'monitor-agentes.mjs'))) return false;
  try { return readFileSync(join(raiz, '.claude', 'settings.json'), 'utf8').includes('monitor-agentes.mjs'); } catch { return false; }
}

/** O registro onde o agente começou (o run aberto dele, ou o solto); null se não está em nenhum. */
function registroDoAgente(raiz, id) {
  for (const r of registrosParaLer(raiz)) if (lerRegistro(r.arquivo).agentes.has(id)) return r.arquivo;
  return null;
}

const agora = () => new Date().toISOString();

/** Registro (PreToolUse, SubagentStart, PostToolUse do Agent, SubagentStop). Não devolve saída. */
function registrar(entrada, raiz) {
  const ev = entrada.hook_event_name;
  if (ev === 'PreToolUse') {
    if (entrada.tool_name !== 'Agent') return;
    const ti = entrada.tool_input && typeof entrada.tool_input === 'object' ? entrada.tool_input : {};
    // Do prompt sai só o papel deduzido dos nomes de arquivo de agente e step que ele cita; o texto não é guardado.
    const tipo = ti.subagent_type || 'general-purpose';
    const papel = papelDoAgente(tipo, ti.description, pistasDoDespacho(ti.prompt));
    anotarNoRegistro(registroAtual(raiz), { ev: 'pedido', em: agora(), uso: entrada.tool_use_id || null, tipo, descricao: descricaoCurta(ti.description), papel });
    return;
  }
  if (ev === 'SubagentStart') {
    const id = monitorIdDoAgente(entrada.agent_id);
    // Sem tipo é agente interno do Claude Code (sugestão de prompt, /btw), não despacho do run.
    if (!id || !entrada.agent_type) return;
    anotarNoRegistro(registroAtual(raiz), { ev: 'inicio', em: agora(), agente: id, tipo: entrada.agent_type, transcricao: transcricaoPelaSessao(entrada.transcript_path, id) });
    return;
  }
  if (ev === 'PostToolUse' && entrada.tool_name === 'Agent') {
    const r = entrada.tool_response && typeof entrada.tool_response === 'object' ? entrada.tool_response : {};
    const id = monitorIdDoAgente(r.agentId);
    if (!id) return;
    const ti = entrada.tool_input && typeof entrada.tool_input === 'object' ? entrada.tool_input : {};
    anotarNoRegistro(registroDoAgente(raiz, id) || registroAtual(raiz), { ev: 'lancado', em: agora(), agente: id, uso: entrada.tool_use_id || null, tipo: ti.subagent_type || null, descricao: descricaoCurta(ti.description || r.description) });
    return;
  }
  if (ev === 'SubagentStop') {
    const id = monitorIdDoAgente(entrada.agent_id);
    const registro = id ? registroDoAgente(raiz, id) : null;
    if (!registro) return;
    const transcricao = typeof entrada.agent_transcript_path === 'string' ? entrada.agent_transcript_path.replace(/^~(?=\/)/, homedir()) : null;
    let erro = erroDaApi(entrada.last_assistant_message);
    if (!erro && transcricao) { const t = lerTranscricaoPorPartes(transcricao); erro = t && t.erro ? t.erro : null; }
    anotarNoRegistro(registro, { ev: 'fim', em: agora(), agente: id, motivo: erro ? 'caiu' : 'terminou', erro: erro || undefined, transcricao: transcricao || undefined });
  }
}

/**
 * O aviso na conversa (PostToolUse de qualquer ferramenta e UserPromptSubmit, que também dispara
 * quando um subagente em segundo plano volta à sessão): os agentes lentos, parados ou caídos ainda não
 * avisados nesta situação, por `additionalContext`. Dentro de um subagente (`agent_id` na entrada), o
 * aviso iria para ele, então não sai nada.
 */
function avisar(entrada, raiz) {
  const ev = entrada.hook_event_name;
  if ((ev !== 'PostToolUse' && ev !== 'UserPromptSubmit') || entrada.agent_id) return null;
  const aviso = avisoDoMonitor(estadoDosAgentes(raiz));
  return aviso ? { hookSpecificOutput: { hookEventName: ev, additionalContext: aviso } } : null;
}

function principal(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  // A ferramenta de dentro de um subagente (a maior parte das chamadas de um run) não registra nem
  // avisa: sai antes de procurar a raiz.
  if (entrada.agent_id && entrada.hook_event_name === 'PostToolUse' && entrada.tool_name !== 'Agent') return null;
  const raiz = raizDoMonitor(entrada.cwd, process.env.CLAUDE_PROJECT_DIR);
  if (!raiz || copiaDoPluginCedeAVez(raiz)) return null;
  registrar(entrada, raiz);
  return avisar(entrada, raiz);
}

const dormir = (ms) => new Promise((ok) => { setTimeout(ok, Math.max(0, ms)); });
/** Teto do sono do despertador: abaixo do `timeout` do hook (3600 s no settings), que a doc diz valer também no asyncRewake. */
const DESPERTADOR_TETO_MS = 55 * 60000;
/** De quanto em quanto tempo o despertador relê o registro: o agente que termina antes do tempo do papel solta o hook. */
const DESPERTADOR_SONDAGEM_MS = 2000;

/**
 * O modo da sessão pela linha de comando do processo do Claude Code (`CLAUDE_PID`, documentado):
 * `segura` quando é `-p`/`--print` sem `--input-format stream-json` (medido em 22/10/2026: ali o
 * asyncRewake roda em primeiro plano e segura o retorno do Agent), `solta` nos outros modos (o
 * `-p` com entrada em streaming, medido; a sessão interativa, como a doc descreve o asyncRewake) e
 * `desconhecido` quando não dá para ler (sem `CLAUDE_PID`, Windows, `ps` falhou). Na dúvida, quem chama trata como `segura`.
 */
function modoDaSessao() {
  const pid = String(process.env.CLAUDE_PID || '').trim();
  if (!/^\d+$/.test(pid) || process.platform === 'win32') return 'desconhecido';
  const args = monitorTentar(() => execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }), '');
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 'desconhecido';
  const imprime = tokens.some((t) => t === '-p' || t === '--print');
  const streaming = tokens.some((t, i) => t === '--input-format=stream-json' || (t === '--input-format' && tokens[i + 1] === 'stream-json'));
  return imprime && !streaming ? 'segura' : 'solta';
}

/**
 * O despertador (fase 4 do monitor). Desde 0.9.111 vem DESLIGADO: só `monitor.despertar: true` no
 * perfil o liga, e mesmo ligado ele sai na hora no `claude -p` sem entrada em streaming e quando não
 * consegue ler a linha de comando do Claude Code (ver a cabeça deste arquivo). Registrado como hook
 * `asyncRewake` no PostToolUse com matcher `Agent`, que roda na sessão principal depois do lançamento
 * (`tool_response.status: "async_launched"`, com o `agentId`): o código 2 acorda a sessão principal,
 * não o subagente. Ordem, para sair em menos de 1 s quando não vai acordar ninguém: desligado, sai;
 * sessão `segura` ou `desconhecido`, sai; senão espera o registro do agente e relê o registro a cada
 * 2 s até o tempo do papel, saindo assim que o agente termina, é retomado ou o run fecha. Passado o
 * tempo com o agente aberto, sai 2 com o aviso no stderr, marcado no espaço próprio do despertador
 * (`monitor-despertador/`), que nunca impede o aviso do PostToolUse e do UserPromptSubmit. Em
 * qualquer outro caso, sai 0 sem saída. Despacho em primeiro plano (`completed`) já terminou: nada.
 */
async function despertador(entrada) {
  if (!entrada || entrada.hook_event_name !== 'PostToolUse' || entrada.tool_name !== 'Agent' || entrada.agent_id) return null;
  const resposta = entrada.tool_response && typeof entrada.tool_response === 'object' ? entrada.tool_response : {};
  const id = resposta.status === 'async_launched' ? monitorIdDoAgente(resposta.agentId) : '';
  const raiz = id ? raizDoMonitor(entrada.cwd, process.env.CLAUDE_PROJECT_DIR) : null;
  if (!raiz || copiaDoPluginCedeAVez(raiz)) return null;
  const cfg = configDoMonitor(raiz);
  if (!cfg.despertar) return null;
  if (modoDaSessao() !== 'solta') return null;
  let registro = null;
  for (let i = 0; i < 20 && !registro; i += 1) {
    registro = registroDoAgente(raiz, id);
    if (!registro) await dormir(250);
  }
  if (!registro) return null;
  const a = lerRegistro(registro).agentes.get(id);
  if (!a || a.fim) return null;
  const geracao = a.geracao;
  const papel = a.papel && a.papel !== 'desconhecido' ? a.papel : papelDoAgente(a.tipo, a.descricao);
  const esperado = cfg.tempos[papel] || cfg.tempos.desconhecido;
  const acorda = Math.min((Date.parse(a.inicio || '') || Date.now()) + esperado * 60000, Date.now() + DESPERTADOR_TETO_MS);
  for (;;) {
    const falta = acorda - Date.now();
    if (falta > 0) await dormir(Math.min(falta, DESPERTADOR_SONDAGEM_MS));
    if (!registroAberto(raiz, registro)) return null;
    const agora = lerRegistro(registro).agentes.get(id);
    if (!agora || agora.fim || agora.geracao !== geracao) return null;
    if (Date.now() >= acorda) break;
  }
  const estados = estadoDosAgentes(raiz, { agente: id, config: cfg, registros: [{ arquivo: registro, squad: null, run: null }] });
  return avisoDoMonitor(estados, { marcas: MONITOR_MARCAS_DO_DESPERTADOR });
}

let bruto = '';
try { bruto = readFileSync(0, 'utf8'); } catch { /* sem entrada: nada */ }
let entrada = null;
try { entrada = JSON.parse(bruto); } catch { /* entrada inválida: nada */ }

if (process.argv[2] === 'despertar') {
  // O código 2 só sai com o aviso escrito; qualquer erro é 0 sem saída.
  despertador(entrada).then((aviso) => {
    if (aviso) process.stderr.write(`${aviso}\n`, () => { process.exitCode = 2; });
  }).catch(() => { process.exitCode = 0; });
} else {
  // Sem process.exit: no macOS a escrita em pipe é assíncrona, e sair na marra cortaria a saída.
  try {
    const saida = principal(entrada);
    if (saida) process.stdout.write(`${JSON.stringify(saida)}\n`);
  } catch { /* o hook nunca quebra a sessão */ }
  process.exitCode = 0;
}
