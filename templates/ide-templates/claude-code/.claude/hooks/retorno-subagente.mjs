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
 * Registrado no `.claude/settings.json` do projeto e no `hooks/hooks.json` do plugin (nunca só no
 * frontmatter do agente: agente de plugin ignora hooks), para os quatro nativos que dão veredito
 * (`verificador-citacoes`, `verificador-persuasao`, `avaliador-squad`, `contraditor`) e para o
 * `general-purpose`. O agente do squad vai como `general-purpose`, e o hook só o reconhece pela marca
 * que o código põe no despacho (`[legalsquad:veredito squad=<code> run=<runId> papel=revisao]`, na
 * primeira linha do `despacho_do_revisor` que o `review-open`/`review-status` devolvem e o chefe cola
 * no prompt): `general-purpose` sem a marca, de qualquer projeto, sai 0 sem gravar nada. O que ele faz:
 *
 * 1. Acha a raiz do projeto (subindo do `cwd` do evento até `_legalsquad/`) e o run aberto
 *    (`squads/<code>/run-state.json` com `status: running`; o do nativo é o único run aberto ou o
 *    que o prompt cita).
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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const NATIVOS = new Set(['verificador-citacoes', 'verificador-persuasao', 'avaliador-squad', 'contraditor']);

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
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    let o;
    try { o = JSON.parse(linha); } catch { continue; }
    if (!saida.inicio && typeof o.timestamp === 'string') saida.inicio = o.timestamp;
    const conteudo = o && o.message && o.message.content;
    if (!saida.prompt && o.type === 'user') saida.prompt = typeof conteudo === 'string' ? conteudo : Array.isArray(conteudo) ? conteudo.map((c) => (c && c.text) || '').join('\n') : '';
    if (o.type === 'assistant' && Array.isArray(conteudo)) {
      for (const c of conteudo) if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input && typeof c.input.message === 'string') saida.handback = c.input.message;
    }
  }
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

/** Os squads com run aberto: `{ code, dir, runId, atualizado }`. */
function runsAbertos(raiz) {
  const base = join(raiz, 'squads');
  let nomes;
  try { nomes = readdirSync(base); } catch { return []; }
  const abertos = [];
  for (const code of nomes) {
    try {
      const l = JSON.parse(readFileSync(join(base, code, 'run-state.json'), 'utf8'));
      if (l && l.status === 'running' && typeof l.runId === 'string' && l.runId) abertos.push({ code, dir: join(base, code), runId: l.runId, atualizado: String(l.updatedAt || '') });
    } catch { /* sem run */ }
  }
  return abertos;
}

function squadDoAgente(raiz, prompt) {
  const abertos = runsAbertos(raiz);
  if (abertos.length <= 1) return abertos[0] || null;
  const citados = abertos.filter((a) => prompt.includes(`squads/${a.code}/`));
  const candidatos = citados.length ? citados : abertos;
  return candidatos.sort((a, b) => b.atualizado.localeCompare(a.atualizado))[0];
}

function principal() {
  let entrada;
  try { entrada = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (!entrada || entrada.hook_event_name !== 'SubagentStop') return;
  const tipo = String(entrada.agent_type || '').replace(/^legalsquad:/, '');
  if (!NATIVOS.has(tipo) && tipo !== 'general-purpose') return;
  const raiz = raizDoProjeto(entrada.cwd, process.env.CLAUDE_PROJECT_DIR);
  if (!raiz || copiaDoPluginCedeAVez(raiz)) return;
  const transcricao = lerTranscricao(entrada.agent_transcript_path);
  let squad;
  let papel = null;
  if (tipo === 'general-purpose') {
    // Sem a marca do código, o general-purpose não é do squad (ou é um agente sem veredito): nada.
    const marca = marcaDoVeredito(transcricao.prompt);
    if (!marca) return;
    squad = runsAbertos(raiz).find((a) => a.code === marca.squad && a.runId === marca.run) || null;
    papel = marca.papel;
  } else {
    squad = squadDoAgente(raiz, transcricao.prompt);
  }
  if (!squad) return;
  const retorno = transcricao.handback || (typeof entrada.last_assistant_message === 'string' ? entrada.last_assistant_message : '');
  const id = String(entrada.agent_id || 'sem-id').replace(/[^\w.-]+/g, '-').slice(0, 80);
  const pasta = join(squad.dir, 'output', squad.runId, '_tmp', 'retornos');
  mkdirSync(pasta, { recursive: true });
  const arquivo = join(pasta, `${papel || tipo}-${id}.md`);
  writeFileSync(arquivo, retorno, 'utf8');
  const squadState = join(raiz, 'scripts', 'squad-state.mjs');
  if (!existsSync(squadState)) return;
  const args = [squadState, 'retorno-subagente', squad.dir, '--tipo', tipo, '--arquivo', arquivo, '--agente-id', id];
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
