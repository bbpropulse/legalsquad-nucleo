#!/usr/bin/env node
// Escritor DETERMINÍSTICO do state.json de um squad — substitui a escrita à mão
// do JSON pelo Pipeline Runner. Garante timestamps reais, transições atômicas
// (write tmp + rename) e saída sempre válida contra o contrato.
// Contrato: _legalsquad/core/state.schema.json | Tipos: dashboard/src/types/state.ts
//
//   node scripts/squad-state.mjs init       <squad-dir> --total <N>
//   node scripts/squad-state.mjs ritmo      <squad-dir> [--set rapido|equilibrado|completo] [--ciclos N] [--verificadores N] [--persuasao sim|nao] [--red-team sim|nao]
//   node scripts/squad-state.mjs step       <squad-dir> --current <K> [--step <id>] --label "<L>" [--working <id> ...] [--from <prevId>] [--message "<m>"] [--activity "<a>"]
//   node scripts/squad-state.mjs checkpoint <squad-dir> [--agent <id>] [--step <id> --resposta "<r>"]
//   node scripts/squad-state.mjs fora-do-fluxo <squad-dir> --tipo pergunta|correcao|pedido-novo --resumo "<meia linha, sem dado do caso>" [--fix "<correção antes da redação>"]
//   node scripts/squad-state.mjs red-team   <squad-dir> --retorno <tabela do contraditor> | --decisao corrigir|seguir|ajustar|parar --resposta "<literal>"
//   node scripts/squad-state.mjs dupla-contagem <squad-dir> [--arquivo <contingência, cálculo ou peça> ...]
//   node scripts/squad-state.mjs anular-fora-do-fluxo <squad-dir> --indice N --motivo "<meia linha>"
//   node scripts/squad-state.mjs pedidos-novos <squad-dir> [--oferecidos --resposta "<resposta literal>"]
//   node scripts/squad-state.mjs aprovar-design <squad-dir> --resposta "<a resposta do profissional ao desenho, literal>"
//   npx legalsquad resolve-skills <ids...> --json | node scripts/squad-state.mjs skills-resolvidas <squad-dir>   (ou --arquivo <json>)
//   node scripts/squad-state.mjs complete   <squad-dir>
//   node scripts/squad-state.mjs fail       <squad-dir>
//
// Retorno de subagente que dá veredito (quem chama é o hook SubagentStop, com o retorno já gravado em
// output/<run>/_tmp/retornos/): confere o formato; fora dele, devolve `bloquear` com o que falta (até 2
// vezes por subagente); da tabela do verificador de citações, grava o JSON que vai em --citacoes:
//   node scripts/squad-state.mjs retorno-subagente <squad-dir> --tipo <agent_type> --arquivo <retorno.md> [--agente-id <id>] [--desde <ISO>]
//
// Loop de revisão (cartório determinístico — grava review-state.json ao lado):
//   node scripts/squad-state.mjs review-open    <squad-dir> --loop <step-revisor> --target <step-on-reject> [--max <N>]
//   node scripts/squad-state.mjs review-verdict <squad-dir> --reviewer <id> --verdict APPROVE|REJECT [--fix "<gravidade>: ..."]... [--ajuste "..."]... [--citacoes <json>] [--expect <N>] [--confirmacoes <N>]
//   node scripts/squad-state.mjs review-verdict <squad-dir> --reviewer <id> --retorno <arquivo do revisor> [...]   (verdict, fixes e ajustes lidos do bloco YAML que abre o arquivo)
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
//   node scripts/squad-state.mjs manifesto-final <squad-dir> [--de <minuta aprovada>] --peca <peça final> [--pendencias <json>] [--por <id do conferente>]
//
// Carimbo do Gate de Sobrevivência ao Resumo (4.6): o hash da síntese e dos pedidos da versão que
// a persuasão aprovou; o `manifesto-final` avisa quando a final mudou uma das duas depois disso:
//   node scripts/squad-state.mjs persuasao-carimbo <squad-dir> --peca <minuta aprovada>
//
// Verificação da Meta (consenso por critério das N avaliações do avaliador-squad;
// o mínimo de avaliações é o `meta_verifiers` do squad sob o teto do ritmo: rápido 1, equilibrado 2, rigoroso até 3):
//   node scripts/squad-state.mjs meta-consenso <squad-dir> --avaliacao <arq> [--avaliacao <arq> ...] [--manifesto <final>.citation-gate.json] [--formato-refeito] [--anterior <meta-consenso da entrega anterior>.json] [--sem-gravar]
//   node scripts/squad-state.mjs steps-posteriores <squad-dir>   (os steps de agente depois da meta, para os avaliadores)
//
// Despacho com prazo: depois de despachar em segundo plano, o relógio do run mede o subagente
// (`pronto` quando o artefato aparece, `caido` passado o prazo, `esperando` no fim da janela):
//   node scripts/squad-state.mjs aguardar <squad-dir> --despacho <nome> [--despacho <outro> ...] [--saida <artefato> ...] [--limite 25] [--janela 5, ou 0 para só marcar] [--fim]
//
// <squad-dir> é a pasta do squad (contém squad.yaml + squad-party.csv); o
// state.json é gravado lá. Rode a partir da raiz do workspace.
import { readFileSync, readSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, basename, isAbsolute, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Uso de cada subcomando: as flags que ele lê e as que ele exige (sem elas, o comando morre).
// É a verdade contra a qual `tests/runner-x-scripts.test.js` confere todo comando que o runner,
// o /legalsquad, os agentes e os steps compilados mandam rodar: nas medições de 26 e 27/09/2026
// todo run achou um desvio (flag que não existe, obrigatória que o texto não dizia). O parser
// daqui aceita qualquer `--x` em silêncio, então a tabela é o contrato; o mesmo teste confere
// que ela bate com o que cada handler lê. `node scripts/squad-state.mjs --uso` a imprime.
export const USO_SQUAD_STATE = {
  init: { flags: ['total', 'run', 'confirmacao'], obrigatorias: ['total'] },
  ritmo: { flags: ['set', 'ciclos', 'verificadores', 'persuasao', 'red-team'], obrigatorias: [] },
  step: { flags: ['current', 'step', 'label', 'working', 'from', 'message', 'activity', 'fase'], obrigatorias: ['current'] },
  checkpoint: { flags: ['agent', 'step', 'resposta'], obrigatorias: [] },
  complete: { flags: [], obrigatorias: [] },
  fail: { flags: [], obrigatorias: [] },
  'review-open': { flags: ['gate', 'loop', 'target', 'max'], obrigatorias: ['loop', 'target'] },
  'review-verdict': { flags: ['gate', 'reviewer', 'verdict', 'fix', 'ajuste', 'citacoes', 'expect', 'confirmacoes', 'retorno'], obrigatorias: [] },
  'review-status': { flags: ['gate'], obrigatorias: [] },
  'gate-open': { flags: ['gate', 'loop', 'target', 'max'], obrigatorias: ['loop', 'target'] },
  'gate-verdict': { flags: ['gate', 'reviewer', 'verdict', 'fix', 'ajuste', 'citacoes', 'expect', 'confirmacoes', 'retorno'], obrigatorias: [] },
  'gate-status': { flags: ['gate'], obrigatorias: [] },
  'gate-decisao': { flags: ['gate', 'decisao', 'por'], obrigatorias: ['decisao'] },
  'citacoes-pendentes': { flags: ['peca', 'confirmacoes', 'final', 'previa', 'pesquisa'], obrigatorias: ['peca'] },
  'citacoes-status': { flags: [], obrigatorias: [] },
  'manifesto-final': { flags: ['peca', 'de', 'pendencias', 'por', 'anexo'], obrigatorias: ['peca'] },
  'persuasao-carimbo': { flags: ['peca'], obrigatorias: ['peca'] },
  'run-status': { flags: [], obrigatorias: [] },
  'meta-consenso': { flags: ['avaliacao', 'manifesto', 'formato-refeito', 'anterior', 'rodada', 'sem-gravar'], obrigatorias: [] },
  'meta-despacho': { flags: ['peca', 'anterior', 'rodada', 'redespachar', 'desempate'], obrigatorias: [] },
  'meta-voto': { flags: ['rodada', 'voz', 'retorno'], obrigatorias: ['voz', 'retorno'] },
  'steps-posteriores': { flags: [], obrigatorias: [] },
  reabrir: { flags: ['modo', 'pedido', 'run', 'documento-dos-autos'], obrigatorias: ['modo', 'pedido'] },
  'fora-do-fluxo': { flags: ['tipo', 'resumo', 'fix'], obrigatorias: ['tipo', 'resumo'] },
  'anular-fora-do-fluxo': { flags: ['indice', 'motivo'], obrigatorias: ['indice', 'motivo'] },
  'red-team': { flags: ['retorno', 'decisao', 'resposta'], obrigatorias: [] },
  'dupla-contagem': { flags: ['arquivo'], obrigatorias: [] },
  'pedidos-novos': { flags: ['oferecidos', 'resposta'], obrigatorias: [] },
  'aprovar-design': { flags: ['resposta'], obrigatorias: ['resposta'] },
  'skills-resolvidas': { flags: ['arquivo'], obrigatorias: [] },
  'fase-zero-reaproveitar': { flags: ['step', 'modo'], obrigatorias: ['step'] },
  aguardar: { flags: ['despacho', 'saida', 'limite', 'papel', 'janela', 'fim', 'tokens', 'duracao', 'volta', 'tardio', 'fase', 'erro', 'recuo'], obrigatorias: ['despacho'] },
  fase: { flags: ['nome', 'inicio', 'fim', 'tokens'], obrigatorias: ['nome'] },
  'contrato-redacao': { flags: ['step'], obrigatorias: [] },
  'retorno-subagente': { flags: ['tipo', 'arquivo', 'agente-id', 'desde', 'papel'], obrigatorias: ['tipo', 'arquivo'] },
  vigiar: { flags: ['agente', 'espera', 'teto-min', 'sem-atividade-min', 'intervalo-s', 'projetos-dir'], obrigatorias: ['agente', 'espera'] },
};

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
 * citações: a conferência mais recente vale). `divergente`,
 * `nao_encontrada` e `cancelada` (súmula cancelada, revogada ou superada) são
 * contestação de mérito e reprovam sempre: qualquer voz que marque uma derruba
 * o ciclo, como no voting.
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

// A súmula cancelada (revogada ou superada, que o cartório grava como `cancelada`) diz no fix o que
// fazer com ela, não só que foi contestada: a citação sai, porque nenhuma conferência a salva.
const fixDeContestada = (c) => (c.status === 'cancelada'
  ? `critica: citação contestada no cartório (cancelada): súmula cancelada: não fundamente nela: ${c.title}`
  : `critica: citação contestada no cartório (${c.status}): ${c.title}`);

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
  // O fix de origem humana (a correção fora do fluxo, o pedido de mérito da reabertura) não gasta
  // ciclo do teto do revisor: o ciclo só com a voz do profissional entra com `origem: 'humana'` e o
  // teto do laço sobe um. Medido no run de 01/10/2026 (ritmo equilibrado, teto 2): a correção e o
  // pedido da reabertura viraram o ciclo 1, e a revisora teve uma rodada só antes de escalar.
  const humano = verdicts.every((v) => v && (v.origem === 'humana' || nomeDaVoz(v) === 'profissional'));
  const teto = Number.isInteger(base.maxCycles) && base.maxCycles > 0 ? base.maxCycles : DEFAULT_MAX_REVIEW_CYCLES;
  const maxCycles = humano ? teto + 1 : teto;
  const decision = decideReview({ verdicts, history, maxCycles });
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
    // `em`: a hora em que o ciclo fechou, quando quem chama a fornece (o módulo segue sem relógio).
    // É o fim do ciclo na métrica de tempo por gate (Etapa 0 do plano motor leve, outubro de 2026).
    ledger: { ...base, ...(humano ? { maxCycles, teto_do_revisor: base.teto_do_revisor || teto } : {}), cycles: [...cycles, { cycle, verdicts, decision, ...(humano ? { origem: 'humana' } : {}), ...(typeof opts.agora === 'string' && opts.agora ? { em: opts.agora } : {}) }], pending: null, status },
    result: { ...decision, loop: base.loop, target: base.target, ...(humano ? { origem: 'humana', detail: `${decision.detail}; fix de origem humana, fora do teto do revisor (o laço passa a ${maxCycles} ciclos)` } : {}) },
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
    ...(typeof opts.agora === 'string' && opts.agora ? { em: opts.agora } : {}),
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
function avancarRun(ledger, { current, label, stepId, agora, agentes, skills, fase } = {}) {
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
    // Quem executou o step e as skills que ele levou, resolvidas antes (premissa C1): `agentes` são
    // os `--working`; `skills` é o que o chamador derivou do agente e do manifesto do resolvedor.
    const quem = Array.isArray(agentes) && agentes.length ? { agentes: [...agentes] } : {};
    const comSkills = skills && typeof skills === 'object' ? { skills } : {};
    // A fase nomeada (lista fechada de src/fases-do-run.js, decidida por quem chama) e, no run
    // reaberto, o número da reabertura: é o que o run-metricas soma por fase e separa do run de base.
    const comFase = typeof fase === 'string' && fase.trim() ? { fase: fase.trim() } : {};
    const reaberturas = Array.isArray(base.reaberturas) ? base.reaberturas.length : 0;
    historico.push({ n: proximo.step.current, label: proximo.step.label, ...(typeof stepId === 'string' && stepId.trim() ? { stepId: stepId.trim() } : {}), ...comFase, ...(reaberturas ? { reabertura: reaberturas } : {}), ...quem, ...comSkills, startedAt: agora });
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
  // A escalada que se repete (a meta reprovada duas vezes) grava a mesma chave: o mapa guarda só a
  // última resposta. O histórico, aditivo, guarda cada uma (L11, locação de 27/09/2026, motor
  // 0.9.60: duas escaladas da meta e a do teto da revisão, e o run-metricas contou duas).
  const escalada = /(?:^|[-_.])escala/i.test(step);
  const historico = escalada
    ? { escaladas_historico: [...(Array.isArray(base.escaladas_historico) ? base.escaladas_historico : []), { step: step.trim(), resposta: typeof resposta === 'string' ? resposta : '', ...(typeof agora === 'string' && agora ? { em: agora } : {}) }] }
    : {};
  // Toda resposta, por ocorrência: o run reaberto passa de novo pela aprovação, e o mapa guarda só a
  // última. A reabertura vai no campo próprio, nunca anotada no texto da resposta (achado D2 do run
  // de 01/10/2026: "Aprovar e seguir (reabertura 2)" deixou de ser a fala literal do profissional).
  const reabertura = Array.isArray(base.reaberturas) && base.reaberturas.length ? base.reaberturas.length : null;
  const ocorrencia = { step: step.trim(), resposta: typeof resposta === 'string' ? resposta : '', ...(typeof agora === 'string' && agora ? { em: agora } : {}), ...(reabertura ? { reabertura } : {}) };
  return {
    ...base,
    ...historico,
    checkpoints_historico: [...(Array.isArray(base.checkpoints_historico) ? base.checkpoints_historico : []), ocorrencia],
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
/**
 * `checkpoints_todos`: cada parada com todas as respostas, na ordem em que foram dadas (resposta,
 * hora e reabertura). Só sai quando o histórico existe; ledger antigo segue com o shape de antes.
 */
function respostasPorParada(historico) {
  if (!Array.isArray(historico) || !historico.length) return {};
  const porParada = {};
  for (const o of historico) {
    if (!o || typeof o.step !== 'string' || !o.step) continue;
    (porParada[o.step] ||= []).push({ resposta: typeof o.resposta === 'string' ? o.resposta : '', ...(o.em ? { em: o.em } : {}), ...(o.reabertura ? { reabertura: o.reabertura } : {}) });
  }
  return Object.keys(porParada).length ? { checkpoints_todos: porParada } : {};
}

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
    // Todas as respostas de cada parada, na ordem: o mapa `checkpoints` guarda só a última, e na
    // retomada a decisão de mérito sumia (m2c da 0.9.82: no diagnóstico, "Confirmo as teses que a
    // fase zero sustentou..." virou "Aprovo, pode seguir."; repetido em 5 runs).
    ...respostasPorParada(ledger.checkpoints_historico),
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
/**
 * O run foi APROVADO pelo profissional? É o que libera a contribuição do squad à comunidade no
 * `complete` (decisão do dono de 26/09/2026: só a estrutura que já funcionou sobe). Aprovado é a
 * parada `aprovacao` respondida com "Aprovar...": a última resposta registrada numa parada dessa
 * fase, na abertura vigente do run (a original ou a última reabertura), começa por "aprov". Vale
 * também quando a meta reprovou e o profissional concluiu sob responsabilidade dele (a escalada
 * `escalada-meta` é outra parada), porque quem aprova a entrega é a parada `aprovacao`. Não é
 * aprovado: run sem parada de aprovação registrada, resposta "Ajustar", "Red-team", "Parar aqui",
 * e a aprovação de uma entrega anterior à reabertura vigente (o run reaberto passa de novo pela
 * parada antes de fechar). A fase da parada vem de `faseDoStep`, pelo id do step.
 */
function aprovacaoDoRun(ledger) {
  const l = ledger && typeof ledger === 'object' ? ledger : {};
  const vigente = Array.isArray(l.reaberturas) ? l.reaberturas.length : 0;
  const daAprovacao = (step) => typeof step === 'string' && faseDoStep({ stepId: step }) === 'aprovacao';
  const historico = Array.isArray(l.checkpoints_historico) ? l.checkpoints_historico : [];
  let ultima = null;
  for (const o of historico) if (o && daAprovacao(o.step)) ultima = o;
  // Ledger anterior ao histórico: só o mapa, que guarda a última resposta de cada parada.
  if (!historico.length && l.checkpoints && typeof l.checkpoints === 'object' && !Array.isArray(l.checkpoints)) {
    for (const [step, resposta] of Object.entries(l.checkpoints)) if (daAprovacao(step)) ultima = { step, resposta };
  }
  if (!ultima) return { aprovado: false, motivo: 'sem-parada-de-aprovacao' };
  const reabertura = Number(ultima.reabertura) || 0;
  if (reabertura !== vigente) return { aprovado: false, motivo: 'aprovacao-de-entrega-anterior', step: ultima.step };
  const resposta = String(ultima.resposta || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/^[\s"'\u201c\u201d\u00ab\u00bb([*_-]+/, '').replace(/^\d+\s*[.)\-:]?\s*/, '');
  if (!/^aprov/.test(resposta)) return { aprovado: false, motivo: 'resposta-nao-aprova', step: ultima.step };
  return { aprovado: true, step: ultima.step, ...(reabertura ? { reabertura } : {}) };
}
// <<< run-state:end

// Fases nomeadas do run: cópia VERBATIM de src/fases-do-run.js (o `step` grava a fase no ledger).
// >>> fases-do-run:begin
/**
 * A lista fechada. `imagens-sumario` é o registro único que o runner abre para os descritores de
 * imagem e o sumário do caso (`--step autos-imagens-sumario`); `imagens` e `sumario` separados vêm
 * dos despachos. `gate:<nome>:<ciclo>` não está aqui: é derivado do `review-state.json`.
 */
const FASES_DO_RUN = Object.freeze([
  'roteamento', 'arquiteto', 'intake', 'imagens', 'sumario', 'imagens-sumario', 'fase-zero',
  'diagnostico', 'pesquisa', 'contingencia', 'redacao', 'revisao', 'conferencia', 'cg-final', 'meta', 'aprovacao',
  'pacote', 'reabertura', 'outra',
]);

const semAcentoDaFase = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Regras na ordem: a primeira que casa decide. Valem para o id do step e, sem acerto, para o rótulo. */
const REGRAS_DE_FASE = [
  ['imagens-sumario', /autos-imagens-sumario|imagens?\b.*\bsumario|descricao das imagens/],
  ['fase-zero', /\bfase[- ]zero\b|\(\s*\d+\s+em\s+paralelo\s*\)/],
  ['sumario', /\bsumario (?:do caso|dos autos)\b/],
  ['imagens', /\bimagens?\b|\bdescritor/],
  ['intake', /\bintake\b|\btriagem\b/],
  ['diagnostico', /\bdiagnostico\b|\bfoco\b/],
  ['pesquisa', /\bpesquisa\b/],
  // A calculista (contingência, liquidação) tem fase própria: no m2r da 0.9.83 ela caía em "outra".
  ['contingencia', /\bcontingencia\b|\bcalculista\b|\bliquidacao\b/],
  ['conferencia', /\bconferencia\b|\bconferente\b/],
  ['revisao', /\brevisao\b|\brevisor\b/],
  ['redacao', /\bredacao\b|\bminuta\b|\bredator\b/],
  ['aprovacao', /\baprovacao\b/],
  ['pacote', /\bprotocolo\b|\bchecklist\b|\bdistribuicao\b|\bpacote\b|\bempacot/],
];

/**
 * A fase de um step do ledger. O id decide antes do rótulo: no run reaberto, o rótulo da redação é
 * "Redação da minuta (revisão depois da entrega)", e quem é revisão é o step, não a frase. O
 * registro do fan-out da fase zero de ledger antigo usava o id do diagnóstico com o rótulo
 * "(N em paralelo)": o rótulo do paralelo vence o id nesse caso.
 */
function faseDoStep({ stepId, label } = {}) {
  const id = semAcentoDaFase(stepId).replace(/[-_]+/g, ' ');
  const rotulo = semAcentoDaFase(label);
  if (/\(\s*\d+\s+em\s+paralelo\s*\)/.test(rotulo) || /^fase zero\b/.test(id) || /^paralelo\b/.test(id)) return 'fase-zero';
  for (const texto of [id ? `${id} ${semAcentoDaFase(stepId)}` : '', rotulo]) {
    if (!texto) continue;
    const regra = REGRAS_DE_FASE.find(([, re]) => re.test(texto));
    if (regra) return regra[0];
  }
  return 'outra';
}

/**
 * A fase de um despacho, pelo nome que o chefe deu ao `aguardar --despacho`; sem acerto, a do step
 * em que o despacho saiu. O avaliador da meta e o verificador de citações rodam dentro do step de
 * redação ou de conferência, e a conta deles é da meta e do gate, não do step.
 */
function faseDoDespacho(nome, faseDoStepAtual = 'outra') {
  const n = semAcentoDaFase(nome).replace(/[-_]+/g, ' ');
  if (/\bavaliador meta\b|\bmeta\b/.test(n)) return 'meta';
  if (/\bverificador citac|\bcitac|\bcitation\b/.test(n)) return faseDoStepAtual === 'conferencia' ? 'cg-final' : 'gate:citacao';
  if (/\bpersuas/.test(n)) return 'gate:persuasao';
  if (/\bcatalog scout\b|\bscout\b/.test(n)) return 'roteamento';
  if (/\bdescritor\b|\bimagens?\b/.test(n)) return 'imagens';
  if (/\bsumario\b/.test(n)) return 'sumario';
  if (/\bcalculista\b|\bcontingenc|\bliquidac/.test(n)) return 'contingencia';
  if (/\brevis/.test(n)) return 'revisao';
  if (/\bconferen/.test(n)) return 'conferencia';
  if (/\bleitor\b|\bnativo\b|\bpre mortem\b|\bcontraditor\b/.test(n) && faseDoStepAtual !== 'pesquisa') return 'fase-zero';
  if (/\bpesquis/.test(n)) return 'pesquisa';
  return faseDoStepAtual || 'outra';
}

/** Fase aceita pelo `squad-state fase` e pelo `--fase`: a lista fechada ou `gate:<nome>[:<ciclo>]`. */
function faseValida(nome) {
  return FASES_DO_RUN.includes(nome) || /^gate:[a-z0-9-]+(?::\d+)?$/.test(String(nome || ''));
}

/**
 * Roteamento e Arquiteto acontecem antes do `init`, e o ledger nasce sem eles. O que o disco sabe:
 * as linhas do `_legalsquad/logs/roteamento.jsonl` (cada decisão do roteador, com hora), a hora do
 * `_build/discovery.yaml` (o Arquiteto começou) e a do último arquivo de definição do squad gravado
 * antes do run (o Build terminou). `entradas` são as horas ISO do log; `discoveryEm` e `definicaoAte`,
 * ISO ou null. Devolve as duas fases com `origem: 'derivada'`, ou lista vazia sem log.
 *
 * O roteamento começa na primeira linha do log da sessão (as linhas sem intervalo maior que
 * `intervaloMin` antes do run); o Arquiteto, na última linha do log anterior ao Discovery. A linha é
 * gravada depois da decisão, então o roteamento medido é o piso, nunca mais que o real.
 */
function fasesAntesDoRun({ inicioDoRun, entradas = [], discoveryEm = null, definicaoAte = null, intervaloMin = 60 } = {}) {
  const inicio = Date.parse(inicioDoRun);
  if (!Number.isFinite(inicio)) return [];
  const horas = entradas.map((e) => Date.parse(e)).filter((t) => Number.isFinite(t) && t <= inicio).sort((a, b) => a - b);
  if (!horas.length) return [];
  let primeira = horas.length - 1;
  while (primeira > 0 && horas[primeira] - horas[primeira - 1] <= intervaloMin * 60000) primeira -= 1;
  if (inicio - horas[horas.length - 1] > intervaloMin * 60000 * 3) return [];
  const sessao = horas.slice(primeira);
  const iso = (t) => new Date(t).toISOString();
  const discovery = Date.parse(discoveryEm);
  const comArquiteto = Number.isFinite(discovery) && discovery >= sessao[0] && discovery <= inicio;
  if (!comArquiteto) return [{ fase: 'roteamento', inicio: iso(sessao[0]), fim: iso(inicio), origem: 'derivada' }];
  const antesDoDiscovery = sessao.filter((t) => t <= discovery);
  const inicioArq = antesDoDiscovery.length ? antesDoDiscovery[antesDoDiscovery.length - 1] : sessao[0];
  const ate = Date.parse(definicaoAte);
  const fimArq = Number.isFinite(ate) && ate >= inicioArq && ate <= inicio ? ate : inicio;
  return [
    { fase: 'roteamento', inicio: iso(sessao[0]), fim: iso(inicioArq), origem: 'derivada' },
    { fase: 'arquiteto', inicio: iso(inicioArq), fim: iso(fimArq), origem: 'derivada' },
  ];
}
// <<< fases-do-run:end

// Contribuição à comunidade: cópia VERBATIM de src/contribuicao.js (o `complete` de um run aprovado
// dispara o envio em segundo plano e diz os avisos pendentes).
// >>> contribuicao-ligada:begin
/** Onde fica o que já foi enviado, por projeto. É memória do projeto, nunca sai da máquina. */
const ARQUIVO_DO_REGISTRO = join('_legalsquad', '_memory', 'contribuicoes.json');
const TRAVA = join('_legalsquad', '_memory', '.contribuicoes.trava');
const DESLIGADO = /^(?:0|n|nao|não|no|false|off|desligad[oa])$/i;

/**
 * A contribuição vem ligada para o aluno. Desliga, para o dono e para instalação que não é da
 * comunidade, por qualquer um dos dois: `LEGALSQUAD_CONTRIBUIR=0` no ambiente (vale para a máquina
 * toda) ou `"contribuir": false` em `_legalsquad/config/acervo.json` (vale para a pasta).
 */
function contribuicaoLigada(cwd, { env = process.env } = {}) {
  if (typeof env.LEGALSQUAD_CONTRIBUIR === 'string' && DESLIGADO.test(env.LEGALSQUAD_CONTRIBUIR.trim())) {
    return { ligada: false, motivo: 'LEGALSQUAD_CONTRIBUIR desliga a contribuição nesta máquina' };
  }
  try {
    const bruto = JSON.parse(readFileSync(join(cwd, '_legalsquad', 'config', 'acervo.json'), 'utf8'));
    if (bruto && bruto.contribuir === false) return { ligada: false, motivo: '"contribuir": false em _legalsquad/config/acervo.json' };
  } catch { /* sem config: o padrão, ligada */ }
  return { ligada: true, motivo: null };
}

/**
 * Os squads barrados pela varredura de dado do caso que o aluno ainda não soube, uma vez cada:
 * devolve a lista e marca no registro que foram ditos. A passada em segundo plano não tem a quem
 * dizer; quem diz é o próximo `complete` (ou a próxima passada à vista). Com uma passada em curso
 * (a trava tem menos de dez minutos), não mexe no registro e devolve nada: ela o regrava no fim, e
 * o aviso sai na vez seguinte. Nunca falha.
 */
function avisosDaContribuicao(cwd) {
  try {
    try { if (Date.now() - statSync(join(cwd, TRAVA)).mtimeMs < 10 * 60_000) return []; } catch { /* sem passada em curso */ }
    const destino = join(cwd, ARQUIVO_DO_REGISTRO);
    const reg = JSON.parse(readFileSync(destino, 'utf8'));
    if (!reg || typeof reg.squads !== 'object' || !reg.squads) return [];
    const avisos = [];
    for (const [squad, x] of Object.entries(reg.squads)) {
      if (x?.estado !== 'barrado' || !x.avisar) continue;
      avisos.push({ squad, motivo: x.motivo || 'possível dado de caso' });
      x.avisar = false;
    }
    if (!avisos.length) return [];
    mkdirSync(dirname(destino), { recursive: true });
    const tmp = `${destino}.${process.pid}.avisos.tmp`;
    writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
    renameSync(tmp, destino);
    return avisos;
  } catch {
    return [];
  }
}

/** A linha que o chefe repete ao aluno, uma por squad barrado. */
const linhaDoAviso = (a) => `O squad «${a.squad}» não foi enviado à plataforma da comunidade: ${a.motivo}. Ele continua só nesta pasta.`;
// <<< contribuicao-ligada:end


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
 * `meta_verifiers` é o teto de avaliadores da Verificação da Meta, sobre o que o
 * squad declara: rápido 1, equilibrado 2, rigoroso o que o squad declara, até 3.
 * Decisão do dono depois da medição dos ritmos (0.9.83, due diligence): o rápido
 * pagava 3 vozes na meta (41,6 min, 622k tokens) e tirou 96 com a mesma conferência;
 * a nota baixa dos equilibrados veio de dupla contagem e de memória de cálculo fora
 * do relatório, não do número de avaliadores. Com 2 vozes, o voto que diverge do
 * outro num critério pede desempate (uma voz a mais), como o voto tardio (0.9.82).
 * Não há ajuste por run para este botão: ele segue o ritmo.
 */
// `max_review_cycles` conta ciclos de conferência, não correções: com teto N, o REJECT dos ciclos
// 1 a N-1 volta à redação e o do ciclo N escala. O rápido tem teto 2, uma rodada de correção.
// Medido no m2r da 0.9.83 (due diligence, ritmo rápido): com teto 1, o primeiro REJECT já escalava
// por teto, e os seis pontos do revisor ficaram como ressalva, sem nenhuma correção.
const PERFIS = {
  completo: { citation_verifiers: null, max_review_cycles: null, meta_verifiers: 3, persuasao: true, red_team: true },
  equilibrado: { citation_verifiers: 1, max_review_cycles: 2, meta_verifiers: 2, persuasao: true, red_team: false },
  rapido: { citation_verifiers: 1, max_review_cycles: 2, meta_verifiers: 1, persuasao: false, red_team: false },
};
/** Botões que seguem o ritmo e não têm ajuste por run. */
const SEM_AJUSTE_POR_RUN = new Set(['meta_verifiers']);

/**
 * As três opções do ritmo como o chefe as diz ao profissional no intake: o porquê com os números
 * medidos, em linguagem de gente, e o custo de cada uma. Números da medição dos ritmos (03 e
 * 04/10/2026, due diligence e contestação, avaliação cega): Rigoroso 241 e 266 min, a nota mais
 * estável (sem as quedas de 82 e 88 que dois Equilibrados tiveram); Rápido 149 e 184 min, 3 a 5
 * pontos abaixo dos melhores; Equilibrado com a maior variação de nota entre runs (82 a 99). Não
 * entra número que a medição não tenha.
 */
const TEXTO_DOS_RITMOS = {
  rapido: { rotulo: 'Rápido', para: 'para rotina e minuta que você vai revisar', medida: 'nos nossos testes levou cerca de 2h30 a 3h, com nota 3 a 5 pontos abaixo da melhor', como: 'uma conferência de citações; a revisão devolve o texto para correção uma vez e, se reprovar de novo, o ponto vem a você; um avaliador na conferência final de qualidade; sem teste de leitura rápida; o pré-mortem do diagnóstico (o contraditor lendo as teses antes da redação, quando a equipe o tem) roda como nos outros ritmos, e o que fica de fora é o ataque simulado ao texto antes da aprovação' },
  equilibrado: { rotulo: 'Equilibrado', para: 'opção intermediária', medida: 'nos nossos testes a nota variou mais de um trabalho para outro', como: 'uma conferência de citações; uma rodada de correção na revisão; até dois avaliadores na conferência final de qualidade; teste de leitura rápida em uma passada; pré-mortem do diagnóstico como nos outros ritmos, sem o ataque simulado ao texto antes da aprovação' },
  completo: { rotulo: 'Rigoroso', para: 'para a entrega que vai a quem decide', medida: 'mais conferências e ataque simulado; nos nossos testes deu a nota mais estável, em cerca de 4 horas', como: 'citações conferidas por três verificadores, em geral duas rodadas de correção, até três avaliadores na conferência final de qualidade, teste de leitura rápida, pré-mortem do diagnóstico e ataque simulado ao texto, oferecido antes da aprovação' },
};

/**
 * As três opções, com a recomendada primeiro e o porquê dela (`recomendado`, o que
 * `ritmoRecomendado` devolve); sem recomendação, na ordem de sempre (Rápido, Equilibrado,
 * Rigoroso). A mesma frase no runner, no step compilado e no `squad-state ritmo`.
 */
function opcoesDeRitmo(recomendado = null) {
  const base = ['rapido', 'equilibrado', 'completo'];
  const ordem = recomendado && TEXTO_DOS_RITMOS[recomendado.ritmo] ? [recomendado.ritmo, ...base.filter((r) => r !== recomendado.ritmo)] : base;
  return ordem.map((r) => {
    const t = TEXTO_DOS_RITMOS[r];
    // A recomendada diz o porquê desta entrega no lugar do "para quem" genérico, sem repetir.
    const para = recomendado && recomendado.ritmo === r ? `recomendado para esta entrega: ${recomendado.motivo}` : t.para;
    return `**"${t.rotulo}"** (${para}: ${t.medida}; ${t.como})`;
  }).join(' · ');
}


/**
 * O ritmo que o intake recomenda pelo tipo de entrega. Decisão do dono (04/10/2026), com a medição
 * dos ritmos: peça que vai a juízo ou a terceiro que decide (petição, contestação, recurso, parecer
 * e dossiê para comitê ou cliente) recomenda Rigoroso; rotina e minuta interna (triagem, relatório
 * interno, checklist, minuta para revisão própria) recomenda Rápido. Equilibrado fica como opção,
 * nunca recomendada. Lê o `delivery_type` do squad, o `destinatario` e o `reader` do modelo e, na
 * análise sem destinatário, o nome do squad. `teto` é o perfil do projeto: a recomendação nunca
 * passa dele. Devolve `{ ritmo, rotulo, motivo }`.
 */
const ROTINA_INTERNA = /\b(?:triagem|triagens|checklist|relatorios? interno|rotina|minuta interna|revisao propria|prazos?|intimac\w*|publicac\w*|preparacao|controle|agenda)\b/;
const MINUTA_INTERNA = /\b(?:minuta interna|revisao propria|rascunho interno|uso interno)\b/;
const DESTINATARIO_INTERNO = /\b(?:advogad[oa]s?|escritorio|equipe|uso interno|revisao propria)\b/;
// O modelo pode declarar o ritmo que recomenda (`squad.ritmo` no design.yaml, `ritmo_recomendado` no
// squad.yaml): vale acima da regra pelo tipo de entrega, sob o mesmo teto do perfil. Decisão do dono
// (10/10/2026): material interno do cliente que não vai a quem decide um pedido (política de RH,
// investigação interna, due diligence, plano de regularização) recomenda Equilibrado.
const MOTIVO_DO_DECLARADO = {
  rapido: 'a equipe deste modelo recomenda Rápido para esta entrega',
  equilibrado: 'material para o cliente decidir internamente, que não vai a juízo nem a autoridade; a equipe deste modelo recomenda Equilibrado',
  completo: 'a equipe deste modelo recomenda Rigoroso para esta entrega',
};
function ritmoRecomendado({ deliveryType = null, reader = null, destinatario = null, nome = null, teto = null, declarado = null } = {}) {
  const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]+/g, ' ');
  const tipo = norm(deliveryType).replace(/\s+/g, '-');
  const leitor = norm(reader).split(/[\s(]/)[0];
  const para = norm(destinatario);
  const qual = norm(nome);
  const quem = destinatario ? String(destinatario).trim() : { juiz: 'o juiz', autoridade: 'a autoridade', contraparte: 'a outra parte', cliente: 'o cliente' }[leitor] || null;
  let r;
  if (MINUTA_INTERNA.test(qual) || (para && DESTINATARIO_INTERNO.test(para))) r = { ritmo: 'rapido', motivo: `material interno${quem ? ` (${quem})` : ''}, que você revisa antes de usar` };
  else if (tipo === 'content') r = { ritmo: 'rapido', motivo: 'conteúdo de divulgação, que não vai a quem decide um pedido' };
  else if (tipo === 'legal-draft' || (!tipo && ['juiz', 'autoridade', 'contraparte'].includes(leitor))) r = { ritmo: 'completo', motivo: leitor === 'juiz' && !destinatario ? 'peça que vai a juízo' : `peça para ${quem || 'quem decide'}` };
  else if (ROTINA_INTERNA.test(qual)) r = { ritmo: 'rapido', motivo: 'rotina do escritório (triagem, prazos, checklist, relatório interno)' };
  else r = { ritmo: 'completo', motivo: `parecer ou dossiê para ${quem || 'quem decide'}` };
  const d = nomeDeRitmo(declarado);
  if (d) r = { ritmo: d, motivo: MOTIVO_DO_DECLARADO[d] };
  const t = nomeDeRitmo(teto);
  if (t && RITMOS.indexOf(r.ritmo) < RITMOS.indexOf(t)) r = { ritmo: t, motivo: `o perfil do projeto limita o run a ${TEXTO_DOS_RITMOS[t].rotulo} (sem o teto, a recomendação seria ${TEXTO_DOS_RITMOS[r.ritmo].rotulo}: ${r.motivo})` };
  return { ...r, rotulo: TEXTO_DOS_RITMOS[r.ritmo].rotulo };
}

/** A recomendação lida do `squad.yaml` do squad (`delivery_type`, `reader`, `destinatario`, `code`, `ritmo_recomendado`). */
function ritmoRecomendadoDoSquad(squadDir, teto = null) {
  let yaml = '';
  try { yaml = readFileSync(join(squadDir, 'squad.yaml'), 'utf-8'); } catch { /* sem squad.yaml: recomenda pelo que houver */ }
  const campo = (k) => { const m = yaml.match(new RegExp(`^${k}:[ \\t]*["']?([^"'\\n#]*?)["']?[ \\t]*(?:#.*)?$`, 'm')); return m && m[1].trim() ? m[1].trim() : null; };
  return ritmoRecomendado({ deliveryType: campo('delivery_type'), reader: campo('reader'), destinatario: campo('destinatario'), nome: `${campo('code') || ''} ${campo('name') || ''}`, teto, declarado: campo('ritmo_recomendado') });
}

/** Quantas vezes a revisão devolve à redação antes de escalar, com teto de `ciclos` ciclos. */
function rodadasDeCorrecao(ciclos) {
  if (!Number.isInteger(ciclos)) return 'rodadas de correção como a equipe declara';
  const n = Math.max(0, ciclos - 1);
  if (n === 0) return 'revisão sem rodada de correção (a primeira reprovação vem a você)';
  const rodadas = { 1: 'uma rodada', 2: 'duas rodadas', 3: 'três rodadas' }[n] || `${n} rodadas`;
  return `${rodadas} de correção na revisão antes de o ponto vir a você`;
}

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
    if (!(chave in ajustes) || SEM_AJUSTE_POR_RUN.has(chave)) continue;
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
  if (!perfil || perfil.nome === PERFIL_PADRAO) return 'ritmo rigoroso: conferência de citações, teste de leitura rápida, pré-mortem do diagnóstico, ataque simulado antes da aprovação e avaliadores da conferência final de qualidade (até três) como a equipe declara';
  const g = perfil.gates;
  const extenso = (n) => ({ 2: 'dois', 3: 'três' })[n] || String(n);
  const meta = g.meta_verifiers === 1 ? 'um avaliador na conferência final de qualidade' : Number.isInteger(g.meta_verifiers) ? `até ${extenso(g.meta_verifiers)} avaliadores na conferência final de qualidade, como a equipe declara` : 'avaliadores da conferência final de qualidade como a equipe declara';
  const citacoes = g.citation_verifiers === 1 ? 'uma conferência de citações' : Number.isInteger(g.citation_verifiers) ? `citações conferidas por ${extenso(g.citation_verifiers)} verificadores` : 'citações conferidas pelos verificadores que a equipe declara';
  const partes = [citacoes, meta, rodadasDeCorrecao(g.max_review_cycles)];
  partes.push(g.persuasao === false ? 'sem teste de leitura rápida' : 'teste de leitura rápida em uma passada');
  // O pré-mortem do diagnóstico (o contraditor lendo as teses antes da redação) roda em todo ritmo;
  // o red_team desliga só o ataque simulado ao texto antes da aprovação. Medido em 09/10/2026: "sem
  // ataque simulado" levou o dono a achar errado ver o contraditor no diagnóstico de um run Rápido.
  if (g.red_team === false) partes.push('sem ataque simulado antes da aprovação (o pré-mortem do diagnóstico roda em todo ritmo)');
  const rotulo = TEXTO_DOS_RITMOS[perfil.nome] ? TEXTO_DOS_RITMOS[perfil.nome].rotulo.toLowerCase() : perfil.nome;
  return `ritmo ${rotulo}: ${partes.join(', ')}`;
}
// <<< perfil:end

// Consenso da Verificação da Meta: as N avaliações do `avaliador-squad`
// combinadas por critério, em código. Canônico em `src/meta-consenso.js` (bloco
// `meta-consenso`, sincronizado por `sync-blocos`); o comando `meta-consenso`
// abaixo só lê os arquivos. O número de avaliadores vem do squad, sob o teto do ritmo (`vozesDaMeta`).
// Dado público × dado do caso: canônico em `src/dado-publico.js` (bloco `dado-publico`). Vem antes
// do bloco `meta-consenso`, que o lê ao carregar.
// >>> dado-publico:begin
/**
 * O que é dado público, lido sem acento e em minúsculas: o run o obtém na fonte oficial e a peça o
 * escreve com a fonte. Não é pendência do profissional nem dado do caso.
 */
const DADO_PUBLICO = [
  { tipo: 'indice-oficial', padrao: /\b(?:ipca(?:-e)?|inpc|igp-?m|igp-?di|ipc-?fipe|selic|taxa referencial|indices?(?! (?:cadastra\w*|remissivo\w*|de massa\b))|correcao|correcoes|atualizacao monetaria|juros)\b/, motivo: 'índice oficial, correção e juros são dado público: a peça obtém a série e aplica' },
  { tipo: 'orgao-publico', padrao: /\b(?:orgaos? de representacao|representacao judicial|procuradori\w*|advocacia[ -]geral|defensoria publica|agu|pgfn|pge|pgm)\b/, motivo: 'o órgão de representação de ente público é dado público: a peça o nomeia' },
  { tipo: 'norma-ou-tabela', padrao: /\b(?:lei|leis|decreto|decretos|resolucao|portaria|instrucao normativa|provimentos?|tabelas?|salarios? minimos?|teto)\b/, motivo: 'lei, norma e tabela oficial (o salário mínimo de qualquer época) são dado público' },
  // m5r e m5g da 0.9.84: o feriado municipal e as suspensões do TJSP saíam [CONFIRMAR] sem busca, e a
  // meta derrubava o critério de prazo. O calendário do tribunal sai de `fonte-oficial --calendario`.
  { tipo: 'calendario-forense', padrao: /\b(?:feriados?|recesso forense|expediente forense|calendario (?:forense|do tribunal|judicial|judiciario)|dias? sem expediente|ponto facultativo|suspens(?:ao|oes) (?:d[oa]s? )?(?:expediente|prazos?|atendimento))\b/, motivo: 'feriado local e suspensão de expediente ou de prazo do tribunal são dado público: o calendário forense sai da fonte oficial (fonte-oficial --calendario)' },
];

/** A regra, por escrito, para o redator, o revisor e o avaliador. */
const REGRA_DO_DADO_PUBLICO = 'Dado público (índice oficial e a série dele, salário mínimo de qualquer época, tabela e norma oficiais, órgão de representação de ente público, feriado local e suspensão de expediente ou de prazo do tribunal) não é pendência do profissional: o run o obtém na fonte oficial (`node scripts/fonte-oficial.mjs`; o calendário forense do tribunal, pelo modo `--calendario` do mesmo script) e a peça o escreve com a fonte. Marcador de dado ([CONFIRMAR], [PREENCHER]) em dado público só quando a fonte oficial foi tentada no run e falhou (`acesso_falhou` no `fontes/INDEX.jsonl`), com o marcador listado no manifesto; quem decide a exceção é o INDEX, não a redação da diligência; nenhum gate pede marcador para o dado que a fonte dá';

const semAcentoDoDadoPublico = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** O dado público de que o texto fala (`{ tipo, motivo }`), ou null. */
function dadoPublicoDe(texto) {
  const t = semAcentoDoDadoPublico(texto).replace(/\[[^\]]*\]/g, ' ');
  const achado = DADO_PUBLICO.find((p) => p.padrao.test(t));
  return achado ? { tipo: achado.tipo, motivo: achado.motivo } : null;
}

/** O fix que pede marcador de dado (ou "a confirmar") num dado público: `{ tipo, motivo }`, ou null. */
const PEDE_MARCADOR_DE_DADO = /\[(?:A[ _])?(?:CONFIRMAR|PREENCHER)\b|\b(?:marc\w+|sinaliz\w+|deix\w+)\b[^.;]{0,60}\b(?:a confirmar|a preencher|com (?:o )?marcador)\b/i;
function fixPedeMarcadorEmDadoPublico(fix) {
  const texto = String(fix ?? '');
  if (!PEDE_MARCADOR_DE_DADO.test(texto)) return null;
  return dadoPublicoDe(texto);
}
// <<< dado-publico:end

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
const META_EXIGENCIA_JURIDICA = /\b(?:teses?|fundament\w*|citacoes|(?<!\bpara (?:a )?)citacao\b(?! (?:do|da|dos|das|ao|a|aos|as) (?:reu|re|reus|res|parte|partes|requerid\w*|executad\w*|demandad\w*|impetrad\w*|autoridade|devedor\w*)| por edital| postal| pessoal| por oficial)|sumulas?|precedentes?|jurisprudenc\w*|temas?|repetitivos?)\b/;

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
  // O dado público vem da regra única (`src/dado-publico.js`), a mesma que o laço de revisão usa.
  ...DADO_PUBLICO,
  { tipo: 'data-ou-assinatura', padrao: /(?:^data$|\bdata da (?:peca|peticao|inicial|contestacao|impetracao|assinatura|distribuicao|protocolo)\b|\blocal e data\b|\bdata e (?:local|assinatura)\b|\bassinaturas?\b|\bfecho\b)/, motivo: 'data, assinatura e fecho são elementos que a própria peça produz' },
  { tipo: 'pedido', padrao: /\bpedidos?\b/, motivo: 'o pedido é elemento que a própria peça produz' },
  { tipo: 'calculo', padrao: /\b(?:calculos?|memoria|memorias|liquidacao|valor da causa)\b/, motivo: 'o cálculo é elemento que a própria peça produz' },
];

/**
 * No contrato (`reader: contraparte` ou `processo: nenhum` no squad.yaml), o índice
 * de reajuste, o prazo, o valor e a cláusula são DECISÃO das partes, não dado público:
 * a minuta não os escolhe sozinha. Só o índice oficial como NÚMERO (a série de um mês,
 * a variação apurada, o percentual) a peça obtém. Medido em 26/09/2026 (locação, motor
 * 0.9.58): "Índice não escolhido nomeado e listado", com `[PREENCHER: índice de
 * reajuste]` no manifesto, virou falta da peça nas duas verificações da meta, e o C4
 * caiu a PARCIAL pelo código.
 */
const META_INDICE_COMO_NUMERO = /\b(?:series?|variac(?:ao|oes) (?:mensal|mensais|acumulada|apurada|do mes|de (?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b)|numeros?[- ]indices?|percentua(?:l|is)|taxa do mes|valor do indice|indice do mes|fator de (?:correcao|atualizacao)|(?:0?[1-9]|1[0-2])\/\d{4})/;
const META_DECISAO_DO_CLIENTE = /\b(?:escolh\w*|elei(?:to|ta|tos|tas|cao)|a definir|decisao|decid\w*|opcao|optar|pactua\w*|negocia\w*|convencion\w*|acordad\w*)\b/;

/**
 * O objeto da exigência: o que o critério cobra, sem o que a descreve. Sai o parêntese (o
 * detalhe: "fls. 79 a 86, pedido do corréu e cota do MP") e o marcador entre colchetes (o
 * texto do marcador é o dado, não a exigência); o resto, sem acento e em minúsculas. As regras
 * de `META_NAO_E_DADO_DO_CLIENTE` leem só isso. Medido em 27/09/2026 (HC, motor 0.9.60,
 * rodada 1): "Cópia faltante (fls. 79 a 86, pedido do corréu e cota do MP) marcada como
 * diligência" caiu como "o pedido é elemento que a própria peça produz" nos três votos pela
 * palavra solta no parêntese, e a meta saiu REPROVADO com nota 92.
 */
function metaObjetoDaExigencia(exigencia) {
  return metaSemAcento(exigencia).toLowerCase()
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/**
 * O objeto que é documento ou peça dos autos (a cópia, a certidão, as folhas, o laudo, a
 * diligência de juntar): dado do caso, que a pasta pode não ter, qualquer que seja o assunto
 * dele. "Cópia do pedido de liberdade do corréu" é a cópia, não o pedido da peça.
 */
const META_OBJETO_DOCUMENTO = /^(?:(?:a|as|o|os|uma|um)\s+)?(?:copias?|certid\w+|documentos?|comprovantes?|fls\.?|folhas?|laudos?|procurac\w+|extratos?|holerites?|matriculas?|atas?|diligencias?|juntada)\b/;
/** O pedido de outra pessoa: o do corréu, do réu, do Ministério Público, da parte contrária, de terceiro. */
const META_PEDIDO_DE_TERCEIRO = /\bpedidos?\b[^,;.]*?\b(?:d[oa]s?|pel[oa]s?)\s+(?:co-?reu\w*|correu\w*|reu|reus|re|res|autor\w*|ministerio publico|mp|parte contraria|partes contrarias|acusac\w+|assistente\w*|querelante\w*|terceir\w+|impetrad\w+|autoridade\w*|juiz\w*|juizo|defesa d[oa]s?\s+\w+)\b/;

/**
 * Por que a exigência NÃO é dado do cliente nem do caso (dado público ou elemento da
 * peça, `META_NAO_E_DADO_DO_CLIENTE`; ou conteúdo jurídico), ou null.
 * Devolve `{ tipo, motivo }`. Com `contrato` (squad sem processo, lido pela contraparte),
 * índice, prazo, valor e cláusula que são escolha das partes continuam dado do cliente:
 * o índice oficial só é dado público como número (`META_INDICE_COMO_NUMERO`), e a
 * exigência que fala em escolha ou decisão (`META_DECISAO_DO_CLIENTE`) não é dado público.
 */
/** A falta diz que a citação não está no manifesto do Citation Gate (lido sem acento e em minúsculas). */
const META_CITACAO_FORA_DO_MANIFESTO = /\bmanifesto\b[^;\n]{0,160}?\b(?:nao (?:tem|traz|registr\w*|lista|cobre|inclui)|sem (?:entrada|registro)|so (?:tem|traz)|traz so|nenhuma entrada|nada d[oae]|mas nao)\b|\bnenhuma entrada\b[^;\n]{0,80}?\bmanifesto\b|\b(?:fora d[oa]|ausentes? d[oa]|sem entrada n[oa]|nao (?:esta|estao|consta\w*) n[oa])\s+(?:manifesto|citation-gate|citations)\b|\b(?:nao (?:ha|tem|tinham?)|sem) entrada\b[^;\n]{0,60}?\b(?:manifesto|citations)|\bcitations\[\]\s+sem\b|\bcitation gate (?:nao )?(?:registrou|conferiu)\b|\bque o citation gate nao\b/;
/** E o que falta é uma citação: dispositivo, súmula, Tema, precedente ou ato normativo. */
const META_E_CITACAO = /\b(?:art|arts|artigos?|sumulas?|temas?|lei|lc|adct|resp|ato conjunto|atos? tecnicos?|decreto|codigo|cc|cpc|clt|ctn|cf|anexos?)\b/;
/** Exigência de processo do run, que o ledger guarda: revisão com APPROVE, paradas humanas, aprovação. */
const META_EXIGENCIA_DE_PROCESSO = /\b(?:paradas? humanas?|aprovacao (?:do pacote|final|humana|registrada)|checkpoint|revisao isolada|com approve|veredito approve)\b/;
const META_DADO_DO_PROFISSIONAL = /\b(?:oab|inscricao|numero de inscricao|registro profissional)\b/;
function metaNaoEDadoDoCliente(exigencia, { contrato = false } = {}) {
  const t = metaObjetoDaExigencia(exigencia);
  if (META_EXIGENCIA_JURIDICA.test(t)) return { tipo: 'conteudo-juridico', motivo: 'exigência de conteúdo jurídico (tese, fundamento, citação, súmula, precedente, Tema) nunca é dado ausente' };
  // O documento do caso (cópia, certidão, folhas, laudo) é dado do caso, fale ele do que falar.
  if (META_OBJETO_DOCUMENTO.test(t)) return null;
  const achado = META_NAO_E_DADO_DO_CLIENTE.find((p) => {
    if (!p.padrao.test(t)) return false;
    // O pedido de outra pessoa (do corréu, do MP, da parte contrária) está nos autos: não é o da peça.
    if (p.tipo === 'pedido' && META_PEDIDO_DE_TERCEIRO.test(t)) return false;
    // No contrato, data, local e testemunhas se preenchem no ato da assinatura: dado do ato, não da minuta.
    // O número de inscrição de quem assina (OAB) é dado do profissional, não elemento que a peça
    // produz: medido na apelação de 01/10/2026 (m1, motor 0.9.80), a procuração da pasta trazia o
    // número mascarado, a peça o marcou [CONFIRMAR] com a diligência no manifesto, e o código o
    // devolvia à redação como "fecho" (C5 caiu nas três rodadas).
    if (p.tipo === 'data-ou-assinatura') return !contrato && !META_DADO_DO_PROFISSIONAL.test(metaSemAcento(exigencia).toLowerCase());
    if (!contrato) return true;
    if (META_DECISAO_DO_CLIENTE.test(t)) return false;
    return p.tipo !== 'indice-oficial' || META_INDICE_COMO_NUMERO.test(t);
  });
  return achado ? { tipo: achado.tipo, motivo: achado.motivo } : null;
}

/**
 * A diligência da pendência diz que quem decide é o profissional (define, fixa, decide, escolhe,
 * arbitra): o valor e o teto da multa, o prazo do comando, o valor do dano moral. Lida sem acento
 * e em minúsculas.
 */
const META_DECISAO_DO_PROFISSIONAL = /\b(?:advogad[oa]s?|profissional|defensor\w*|procurador\w*|promotor\w*)\b[^.;]{0,80}?\b(?:defin\w*|fix\w*|decid\w*|decis\w*|escolh\w*|arbitr\w*)|\bdecisao d[oa] (?:advogad\w*|profissional|cliente|autor\w*)/;
/** O dado que o marcador nomeia: "[CONFIRMAR: valor da multa diária]" → "valor da multa diária". */
const metaDadoDoMarcador = (m) => metaMarcadorNormalizado(m).replace(/^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)[\s:\u2013\u2014-]*/i, '').replace(/\]$/, '').trim();

/**
 * `metaNaoEDadoDoCliente` da exigência, com o que o manifesto diz da pendência dela. Quando todos
 * os marcadores da exigência estão em `pendencias_do_profissional[]`, vale o dado que o MARCADOR
 * nomeia, não a redação da exigência: "Multa diária proporcional com teto" com `[CONFIRMAR: valor
 * da multa diária]` é o valor que a profissional fixa, não "tabela oficial"; e a pendência cuja
 * diligência diz que o profissional decide é decisão dele. Conteúdo jurídico segue nunca sendo
 * dado ausente. Medido no run de 01/10/2026 (reabertura 2): o avaliador votou como `falta`
 * `dado-ausente` o valor e o teto da multa, o valor da causa e o endereço do réu para a citação,
 * todos listados no manifesto como decisão ou dado da profissional, e o código os devolveu à peça:
 * a mesma peça foi de 92 a 75.
 */
function metaNaoEDadoDaExigencia(e, contexto = {}) {
  const naoEDado = metaNaoEDadoDoCliente(e.exigencia, contexto);
  if (!naoEDado || naoEDado.tipo === 'conteudo-juridico') return naoEDado;
  const detalhe = Array.isArray(contexto.pendenciasDetalhe) ? contexto.pendenciasDetalhe : [];
  const marcadores = metaMarcadoresDaPendencia(e.pendencia).filter((m) => !META_MARCADOR_SO_TIPO.test(m));
  const listadas = marcadores.map((m) => detalhe.filter((p) => p.marcador === m));
  if (!marcadores.length || listadas.some((l) => !l.length)) return naoEDado;
  const decisao = listadas.every((l) => l.some((p) => META_DECISAO_DO_PROFISSIONAL.test(metaSemAcento(p.diligencia).toLowerCase())));
  const dadoDoCaso = marcadores.every((m) => !metaNaoEDadoDoCliente(metaDadoDoMarcador(m), contexto));
  // Dado público cuja fonte oficial falhou no run (`acesso_falhou` no INDEX das fontes): é a exceção
  // da regra única (`REGRA_DO_DADO_PUBLICO`), e o marcador listado vale como dado ausente. Decide o
  // INDEX, não a redação da diligência: no m2c da 0.9.82 o salário mínimo de 2026 (decretos do
  // Planalto com acesso_falhou) virou `peca` porque a diligência não repetia "fonte oficial
  // indisponível no run", e a TR, no mesmo formato, passou.
  const fonteFalhou = contexto.fontesFalharam === true && DADO_PUBLICO.some((p) => p.tipo === naoEDado.tipo);
  return decisao || dadoDoCaso || fonteFalhou ? null : naoEDado;
}

/**
 * A classe que o avaliador escreveu fora do enum ("dado_ausente_sem_diligencia", "redacao"):
 * `dado-ausente` quando o nome diz dado ausente ou a exigência diz que o dado depende do
 * profissional ou do cliente; `fora-do-alcance` quando o nome diz alcance; senão `peca`. Sempre com
 * aviso, nunca em silêncio (achado A8 do run de 01/10/2026: a classe fora do enum virava `peca`
 * sem aviso, e o dado da profissional voltava à redação).
 */
const META_DEPENDE_DO_PROFISSIONAL = /\b(?:depende|dependem|decisao|decide|define|fixa|confirma)\w*\b[^.;]{0,40}\b(?:d[oa]s?\s+)?(?:advogad\w*|profissional|cliente|autor\w*|parte)\b/;
function metaClasseForaDoEnum(valor, texto = '') {
  const v = metaSemAcento(valor).toLowerCase();
  if (!v || metaClasse(valor)) return null;
  if (/dado/.test(v) && /ausent/.test(v)) return 'dado-ausente';
  if (/alcance/.test(v)) return 'fora-do-alcance';
  return META_DEPENDE_DO_PROFISSIONAL.test(metaSemAcento(texto).toLowerCase()) ? 'dado-ausente' : 'peca';
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
    .map((p) => ({ marcador: metaMarcadorNormalizado(p && p.marcador), onde: metaMarcadorNormalizado(p && p.onde), diligencia: metaMarcadorNormalizado(p && p.diligencia) }))
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
function metaCamposFaltantes(e, contexto = {}) {
  if (!e.status) return ['status'];
  if (e.status !== 'atendida') return [];
  const campos = [];
  if (!e.evidencia) campos.push('evidencia');
  if (!e.local) campos.push('local');
  if (e.classe === 'dado-ausente' && !e.pendencia && !metaNaoEDadoDoCliente(e.exigencia, contexto)) campos.push('pendencia');
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
  const todos = [...new Set((texto.match(META_MARCADORES_NA_PENDENCIA) || []).map(metaMarcadorNormalizado))];
  // O marcador só com o tipo ("[PREENCHER]") não diz qual dado: ao lado de um marcador inteiro, é
  // texto acrescentado, não outro marcador a conferir. Medido em 26/09/2026 (K22, contrato social,
  // motor 0.9.59): "[PREENCHER: estado civil e regime de bens de Bianca Tavares] e os demais 18
  // [PREENCHER] da qualificação, sede e datas, todos listados" era recusada porque "[PREENCHER]"
  // não estava no manifesto. Sozinho, continua sendo o que é: marcador que não identifica o dado.
  const inteiros = todos.filter((m) => !META_MARCADOR_SO_TIPO.test(m));
  return inteiros.length ? inteiros : todos;
}

function motivoDadoAusenteRecusado(e, pendencias, contexto = {}) {
  const naoEDado = metaNaoEDadoDaExigencia(e, contexto);
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
/**
 * Os objetos JSON de primeiro nível de um texto, na ordem, por casamento de chaves que respeita
 * string e escape. É o que acha o voto escrito como JSON cru seguido de prosa, sem a cerca ```json:
 * medido no run de 01/10/2026 (m2, motor 0.9.80), a avaliação 3 da reabertura veio assim, inteira,
 * e o comando a deu por ilegível; o redespacho custaria 35 minutos com a API lenta.
 */
function objetosJsonDoTexto(texto) {
  const t = String(texto ?? '');
  const out = [];
  for (let i = t.indexOf('{'); i >= 0 && out.length < 20; i = t.indexOf('{', i + 1)) {
    let nivel = 0;
    let dentro = false;
    let escape = false;
    for (let j = i; j < t.length; j += 1) {
      const c = t[j];
      if (dentro) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') dentro = false;
        continue;
      }
      if (c === '"') dentro = true;
      else if (c === '{') nivel += 1;
      else if (c === '}') {
        nivel -= 1;
        if (nivel === 0) { out.push(t.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out;
}

function extrairAvaliacaoMeta(texto) {
  const bruto = String(texto ?? '').trim();
  const candidatos = [bruto];
  for (const m of bruto.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)) candidatos.push(m[1]);
  if (/avaliacao_meta|"criterios"/.test(bruto)) candidatos.push(...objetosJsonDoTexto(bruto));
  for (const candidato of candidatos) {
    let obj;
    try { obj = JSON.parse(candidato); } catch { continue; }
    const av = obj && typeof obj === 'object' ? (obj.avaliacao_meta || obj) : null;
    if (av && Array.isArray(av.criterios)) return av;
  }
  return null;
}

/**
 * O squad entrega contrato ou documento de negócio, não peça de processo: `reader: contraparte`
 * ou `processo: nenhum` no nível de cima do squad.yaml. Aí índice, prazo, valor e cláusula que
 * as partes escolhem continuam dado do cliente (`metaNaoEDadoDoCliente`).
 */
function metaContratoDoSquadYaml(yaml) {
  const campo = (nome) => (String(yaml ?? '').match(new RegExp(`^${nome}:[ \\t]*["']?([\\w-]+)`, 'm')) || [])[1] || '';
  return campo('reader') === 'contraparte' || campo('processo') === 'nenhum';
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
 * um step do pipeline; sem declaração, 1. O teto do ritmo do run vem depois, no `squad-state`
 * (`vozesDaMeta`): rápido 1, equilibrado 2, rigoroso até 3.
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
function normalizarAvaliacaoMeta(av, nCriterios, { pendencias = null, pendenciasOnde = null, stepsPosteriores = null, peca = null, rubrica = null, contrato = false, anterior = null, fontesFalharam = false } = {}) {
  const contexto = { contrato: contrato === true, pendenciasDetalhe: Array.isArray(pendenciasOnde) ? pendenciasOnde : [], fontesFalharam: fontesFalharam === true };
  const erros = [];
  const avisos = [];
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
      const saida = {
        exigencia: String((e && e.exigencia) ?? '').trim(),
        status: META_STATUS.includes(status) ? status : null,
        evidencia: String((e && e.evidencia) ?? '').trim(),
        local: String((e && e.local) ?? '').trim(),
        classe: metaClasse(e && e.classe),
        pendencia: metaMarcadorNormalizado(e && e.pendencia),
      };
      const bruta = String((e && e.classe) ?? '').trim();
      if (bruta && !saida.classe) {
        const derivada = metaClasseForaDoEnum(bruta, `${saida.exigencia} ${saida.evidencia} ${saida.pendencia}`);
        avisos.push(`C${n}: classe "${bruta}" fora do enum (peca, dado-ausente, fora-do-alcance) lida como ${derivada}: "${saida.exigencia}"`);
        return { ...saida, classe: derivada, classe_informada: bruta, classe_derivada_por_codigo: `"${bruta}" fora do enum` };
      }
      return saida;
    }).map((e) => {
      // Derivação honesta do que o avaliador deixou de preencher: o local e o marcador que a
      // própria evidência mostra. O que não se deriva é falha de formato (`fora_do_formato`).
      // A `falta` com `classe: dado-ausente` num voto ATENDE passa pela mesma derivação: ver abaixo.
      if (e.status !== 'atendida' && !(declarado === 'ATENDE' && e.status === 'falta' && e.classe === 'dado-ausente')) return e;
      let saida = e;
      if (!saida.local) {
        const local = metaLocalDaEvidencia(saida.evidencia);
        if (local) saida = { ...saida, local, local_derivado_por_codigo: `da evidência: "${local}"` };
      }
      // `pendencia` sem marcador (vazia, ou a diligência em prosa) é o campo sem o marcador: o código
      // o deriva da evidência. Medido em 26/09/2026 (defesa de auto de infração, motor 0.9.58): os
      // três avaliadores da primeira rodada escreveram em `pendencia` a diligência ("Pedir à
      // Madeireira Teles Pires o romaneio da carga"), com o marcador literal na `evidencia`; o código
      // só derivava do campo vazio, recusou os dados ausentes e C1, C3 e C4 caíram.
      if (saida.classe === 'dado-ausente' && !metaMarcadoresDaPendencia(saida.pendencia).length) {
        const achada = metaPendenciaDaEvidencia(saida, pendenciasOnde || pendencias);
        if (achada) saida = { ...saida, pendencia: achada.marcador, pendencia_derivada_por_codigo: `da evidência: ${achada.como}`, ...(saida.pendencia ? { pendencia_informada: saida.pendencia } : {}) };
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
        const naoEDado = metaNaoEDadoDaExigencia(e, contexto);
        if (naoEDado) return { ...e, classe: 'peca', reclassificada_por_codigo: `dado-ausente para peca: ${naoEDado.motivo}; dado-ausente é só o dado do cliente ou do caso fora da pasta` };
        // No voto ATENDE, a `falta` com `classe: dado-ausente` é o dado ausente que a rubrica aceita
        // escrito com o status errado: o próprio avaliador disse que o critério se cumpre. Vale o
        // que vale para a `atendida` com essa classe: marcador de dado listado no manifesto, é
        // atendida; marcador fora do manifesto, a falta é da peça; sem marcador nenhum (nem na
        // evidência), é formato, e o comando pede a avaliação de novo em vez de dar nota. Medido
        // em 26/09/2026 (K22, contrato social, rodada 1): C1 e C2 votados ATENDE com três faltas
        // assim, os marcadores no manifesto, e o consenso as rebaixou a PARCIAL (nota 70).
        if (declarado !== 'ATENDE') return e;
        const motivo = motivoDadoAusenteRecusado(e, pendencias, contexto);
        if (!motivo) return { ...e, status: 'atendida', status_convertido_por_codigo: 'falta com classe dado-ausente num voto ATENDE, marcador listado em `pendencias_do_profissional[]`: atendida com dado ausente' };
        return { ...e, recusada_por_codigo: motivo };
      }
      if (e.status !== 'atendida') return e;
      const motivo = motivoDadoAusenteRecusado(e, pendencias, contexto);
      if (!motivo) return e;
      // Recusada por não ser dado do cliente (conteúdo jurídico, dado público, elemento da peça): a falta é da peça.
      return metaNaoEDadoDaExigencia(e, contexto) ? { ...e, status: 'falta', classe: 'peca', recusada_por_codigo: motivo, reclassificada_por_codigo: `dado-ausente para peca: ${motivo}` } : { ...e, status: 'falta', recusada_por_codigo: motivo };
    });
    // Faltas que não são da peça e não pesam no veredito (motor leve, medição de 01/10/2026): a
    // citação que o manifesto não traz (o Citation Gate é do motor, e o extrator que não a leu não
    // é defeito da redação: m3, C6 em NAO nas três rodadas pelo ADCT e por intervalos), a
    // exigência de processo que o ledger garante e a lista fechada não mostra (revisão com
    // APPROVE, parada humana, aprovação: m1, C5 nas três rodadas), e o dado ausente com o marcador
    // listado em `pendencias_do_profissional[]` num voto abaixo de ATENDE.
    for (const [k, e] of exigencias.entries()) {
      if (e.status !== 'falta') continue;
      const texto = metaSemAcento(`${e.exigencia} ${e.evidencia}`).toLowerCase();
      // A citação é o objeto da exigência (não a lista de pendências do manifesto, que também é "do manifesto").
      if (META_CITACAO_FORA_DO_MANIFESTO.test(texto) && META_E_CITACAO.test(metaSemAcento(e.exigencia).toLowerCase()) && !/pendencias_do_profissional|marcador de dado|\bdiligencia/.test(texto)) {
        exigencias[k] = { ...e, classe: 'fora-do-alcance', nao_pesa: 'citacao-fora-do-manifesto: o manifesto do Citation Gate é do motor; a citação que ele não traz vai ao verificador de citações, não à redação', ...(e.classe && e.classe !== 'fora-do-alcance' ? { classe_informada: e.classe } : {}) };
      } else if (e.classe === 'fora-do-alcance' && META_EXIGENCIA_DE_PROCESSO.test(metaSemAcento(e.exigencia).toLowerCase())) {
        exigencias[k] = { ...e, nao_pesa: 'processo: revisão, paradas humanas e aprovação são do ledger do run, conferidas pelo código e pelo auditor, não pela peça' };
      }
    }
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
        : exigencias.map((e) => ({ n, exigencia: e.exigencia || null, campos: metaCamposFaltantes(soFormato(e) ? { ...e, status: 'atendida' } : e, contexto) })).filter((f) => f.campos.length);
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
    const perdida = exigencias.find((e) => e.status === 'falta' && e.classe && !e.nao_pesa) || exigencias.find((e) => e.status === 'falta' && e.classe);
    // A classe do critério fora do enum segue a mesma leitura da exigência, nunca `peca` em silêncio.
    const brutaDoCriterio = String(c.classe_da_perda ?? '').trim();
    const derivadaDoCriterio = brutaDoCriterio && !metaClasse(brutaDoCriterio) ? metaClasseForaDoEnum(brutaDoCriterio, perdida ? `${perdida.exigencia} ${perdida.evidencia}` : '') : null;
    if (veredito !== 'ATENDE' && brutaDoCriterio && !metaClasse(brutaDoCriterio)) avisos.push(`C${n}: classe_da_perda "${brutaDoCriterio}" fora do enum, lida como ${derivadaDoCriterio}`);
    let classe = veredito === 'ATENDE' ? null : (metaClasse(c.classe_da_perda) || derivadaDoCriterio || (perdida && perdida.classe) || 'peca');
    // O voto que chamou de dado ausente o que é da peça: a classe do critério segue a falta reclassificada.
    const reclassificada = exigencias.find((e) => e.reclassificada_por_codigo);
    let classeReclassificada = null;
    if (classe === 'dado-ausente' && reclassificada) {
      classe = 'peca';
      classeReclassificada = `dado-ausente para peca: ${reclassificada.exigencia || '(exigência sem texto)'} não é dado do cliente nem do caso`;
    }
    // Na reabertura, o voto que muda o veredito da entrega anterior diz por quê, com o trecho da
    // alteração (`mudanca`); sem isso, a mudança é da forma do voto, não da peça, e o voto volta ao
    // avaliador (achado B1 do run de 01/10/2026: 92 na entrega, 75 na reabertura, mesmos pontos).
    // O anterior é o veredito do CONSENSO da entrega anterior (não o voto bruto de quem votou lá),
    // com os vereditos que ele aceita sem explicação: o do consenso e, quando o código rebaixou o
    // ATENDE dos votos, o ATENDE. Medido no m2b da 0.9.81 (r2-1): o C3 era PARCIAL no consenso
    // anterior, a comparação era com o ATENDE bruto, e os três votos que mantinham o PARCIAL voltavam
    // ao avaliador pedindo `mudanca`.
    const doAnterior = anterior && anterior.get(n);
    const antes = doAnterior && typeof doAnterior === 'object' ? metaVeredito(doAnterior.veredito) : metaVeredito(doAnterior);
    const aceitos = doAnterior && typeof doAnterior === 'object' && Array.isArray(doAnterior.aceitos) ? doAnterior.aceitos.map(metaVeredito).filter(Boolean) : (antes ? [antes] : []);
    const mudanca = String(c.mudanca ?? '').trim();
    if (antes && !aceitos.includes(declarado) && mudanca.length < 12) foraDoFormato.push({ n, exigencia: null, campos: [`mudanca (o veredito era ${antes} na entrega anterior e veio ${declarado}: mantenha-o, ou diga o que a alteração mudou, com o trecho)`] });
    porN.set(n, { n, veredito, veredito_declarado: declarado, rebaixado_por_codigo: rebaixado, exigencias, classe_da_perda: classe, ...(classeReclassificada ? { classe_reclassificada_por_codigo: classeReclassificada } : {}), ...(antes ? { veredito_anterior: antes, ...(mudanca ? { mudanca } : {}) } : {}) });
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
        // E só quando repete a cláusula LITERALMENTE (`metaRepeteLiteral`): termos soltos em
        // comum não desmentem quem diz que o item está fora da rubrica.
        const literal = campo === 'sugestoes_fora_da_rubrica';
        // Nota de alcance ("não está na lista fechada e não foi aberto"), que o agente manda
        // escrever aqui, não é falta: medido (novo2), o HC C2 caía por ela em dois votos.
        if (META_NOTA_DE_ALCANCE.test(metaSemAcento(s).toLowerCase())) return true;
        // Nota sobre a rubrica (a cláusula "admite duas leituras", "não prevê o caso", "a rubrica
        // poderia dizer") fala da rubrica, não da peça: nunca é falta. Medido no m7 da 0.9.81: os três
        // avaliadores deram ATENDE no C6 e o código transformou a nota deles em falta, derrubando um
        // critério obrigatório da regra de entrega.
        if (META_NOTA_SOBRE_A_RUBRICA.test(metaSemAcento(s).toLowerCase())) return true;
        // Em `sugestoes_fora_da_rubrica` o avaliador afirma que a rubrica não pede o item: a
        // sugestão de lá nunca derruba critério (decisão do dono, outubro de 2026). Só o critério que
        // o próprio avaliador já pôs abaixo de ATENDE recebe a falta que a regra própria reconhece (a
        // citação sem o pedido), para ela ir à redação, sem mudar o veredito que ele declarou.
        const foraDaRubrica = campo === 'sugestoes_fora_da_rubrica';
        // Primeiro os critérios ATENDE (a falta derruba o voto); sem casamento, os que já
        // estão abaixo, só pelas regras próprias (`regra`): a falta entra na lista (volta à
        // redação) e o veredito não muda. Medido (novo2): reclamação a2 pôs a Súmula 389, II
        // sem o pedido em `sugestoes_fora_da_rubrica` com o C5 já em NAO, e o defeito sumia
        // da lista. Semelhança de termos contra critério já abaixo não entra: nos votos
        // reais, casava melhoria ("juntar captura do sítio da empresa daria âncora ao local
        // de trabalho") com exigência já cumprida.
        const achada = (atende.length && !foraDaRubrica ? sugestaoRepeteExigencia(s, exigencias, atende, { fontes, literal }) : null)
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
  // O voto abaixo de ATENDE cujas faltas são todas das que não pesam (a citação fora do manifesto,
  // o processo) ou dado ausente listado sobe a ATENDE: é a regra do próprio sistema aplicada ao
  // voto, depois das faltas que as sugestões acrescentaram. Falta da peça ao lado delas mantém o
  // voto como veio.
  const listado = (e) => e.classe === 'dado-ausente' && Array.isArray(pendencias) && !e.recusada_por_codigo && !motivoDadoAusenteRecusado(e, pendencias, contexto);
  for (const c of porN.values()) {
    if (c.veredito_declarado === 'ATENDE' || c.veredito !== c.veredito_declarado) continue;
    const faltas = c.exigencias.filter((e) => e.status === 'falta');
    if (!faltas.length || !faltas.some((e) => e.nao_pesa) || !faltas.every((e) => e.nao_pesa || listado(e))) continue;
    if (!c.exigencias.some((e) => e.status === 'atendida' && e.evidencia)) continue;
    c.veredito = 'ATENDE';
    c.classe_da_perda = null;
    c.promovido_por_codigo = `${c.veredito_declarado} só com faltas que não são da peça (${[...new Set(faltas.map((e) => (e.nao_pesa ? e.nao_pesa.split(':')[0] : 'dado-ausente listado')))].join(', ')})`;
  }
  return {
    erros,
    criterios: [...porN.values()].sort((a, b) => a.n - b.n),
    sugestoes: sugestoes.sugestoes,
    sugestoes_fora_da_rubrica: sugestoes.sugestoes_fora_da_rubrica,
    campos_ignorados: camposIgnorados,
    avisos,
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
/** Nota sobre a rubrica, lida sem acento: o avaliador fala do texto da rubrica, não da peça. */
const META_NOTA_SOBRE_A_RUBRICA = /\b(?:rubrica|quality-criteria(?:\.md)?|duas leituras|nao preve|nao prevê|poderia dizer)\b/;
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
/**
 * A exigência está LITERALMENTE na sugestão: os termos dela, na mesma ordem e seguidos
 * (sem palavra vazia, com plural e terminação normalizados como em `metaTermos`), aparecem
 * no texto da sugestão. É o teste para `sugestoes_fora_da_rubrica`: ali o avaliador afirma
 * que a rubrica não pede o item, e termos soltos não o desmentem. Medido em 26/09/2026
 * (locação, motor 0.9.58): "Levar à Nota ao revisor o risco do art. 52, § 3º (...) recusa da
 * renovação (...) a renúncia às benfeitorias da Cláusula 9.5 não o afasta" casava com a
 * cláusula NÃO "renúncia à renovação" por dois termos soltos, e o C5 caiu a PARCIAL.
 */
function metaSequenciaDeTermos(texto) {
  return metaChave(texto).split(' ').map(metaTermo).filter(Boolean);
}
function metaRepeteLiteral(exigencia, sugestao) {
  const ex = metaSequenciaDeTermos(exigencia);
  const su = metaSequenciaDeTermos(sugestao);
  if (ex.length < 2 || su.length < ex.length) return false;
  for (let i = 0; i + ex.length <= su.length; i += 1) {
    if (ex.every((t, k) => su[i + k] === t)) return true;
  }
  return false;
}

function sugestaoRepeteExigencia(sugestao, exigenciasPorCriterio, candidatos, { fontes = null, soRegra = false, literal = false } = {}) {
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
      if (literal && !metaRepeteLiteral(ex.texto, texto)) continue;
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
        const naoPesa = membros.find((m) => m.nao_pesa);
        if (naoPesa) item.nao_pesa = naoPesa.nao_pesa;
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
      faltas: exigenciasCom((e) => e.status === 'falta' && !e.nao_pesa),
      // Faltas que não são da peça (citação fora do manifesto, processo, dado ausente listado): não
      // pesam e não vão à redação; a citação fora do manifesto vai ao verificador de citações.
      nao_pesam: exigenciasCom((e) => e.status === 'falta' && e.nao_pesa),
      promovidos_por_codigo: votos.map((v, k) => (v.promovido_por_codigo ? `avaliador ${k + 1}: ${v.promovido_por_codigo}` : null)).filter(Boolean),
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

/** Nenhum ritmo paga mais que três avaliadores na meta, mesmo que o squad declare mais. */
const MAX_AVALIADORES_DA_META = 3;

/**
 * Quantas vozes a meta pede neste run: o que o squad declara, sob o teto do ritmo (rápido 1,
 * equilibrado 2, rigoroso até 3; botão `meta_verifiers` do perfil). Devolve `{ exigidos,
 * do_squad, teto, ritmo, motivo }`. Decisão do dono depois da medição dos ritmos (0.9.83): o
 * rápido pagava três vozes na meta (41,6 min, 622k tokens) e tirou 96 com a mesma conferência.
 */
function vozesDaMeta(dir, doSquad) {
  const perfil = perfilDoRun(dir);
  const doRitmo = perfil && perfil.gates && Number.isInteger(perfil.gates.meta_verifiers) ? perfil.gates.meta_verifiers : MAX_AVALIADORES_DA_META;
  const teto = Math.min(doRitmo, MAX_AVALIADORES_DA_META);
  const exigidos = Math.max(1, Math.min(doSquad, teto));
  const motivo = exigidos < doSquad
    ? `ritmo ${perfil.nome}: ${exigidos} avaliador(es) na meta (o squad declara ${doSquad}; o ritmo paga até ${teto})`
    : `meta_verifiers do squad: ${doSquad}`;
  return { exigidos, do_squad: doSquad, teto, ritmo: perfil.nome, motivo };
}

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
  // têm ajuste por run: seguem o ritmo, sobre os `meta_verifiers` do squad (ver `vozesDaMeta`).
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
  // `perfil` é o do PROJETO (o teto, de `_legalsquad/_memory/perfil.json`; sem arquivo, completo);
  // `efetivo` é o que vale neste run, o ritmo combinado com o teto, e é dele que vêm `gates` e
  // `descricao`. Medido no m2c da 0.9.82: o projeto sem perfil.json (completo) e o run em
  // equilibrado, e o `ritmo` dizia `perfil: equilibrado`, o nome do efetivo no campo do projeto.
  const projeto = perfilDoProjeto(dir);
  // `ritmo_recomendado`: o ritmo que o intake recomenda pelo tipo de entrega do squad, sob o teto do
  // projeto (decisão do dono, 04/10/2026); `opcoes_do_intake`: as três opções como o chefe as diz,
  // com a recomendada primeiro e o porquê.
  const recomendado = ritmoRecomendadoDoSquad(dir, projeto.nome);
  console.log(JSON.stringify({ ritmo: perfil.ritmo, ajustes: perfil.ajustes || {}, perfil: projeto.nome, perfil_origem: projeto.origem, efetivo: perfil.nome, gates: perfil.gates, descricao: descreverPerfil(perfil), ritmo_recomendado: recomendado, opcoes_do_intake: opcoesDeRitmo(recomendado) }, null, 2));
  // Como o run-status: a saída é o JSON, sem a linha "state.json atualizado" atrás.
  return null;
}

/**
 * As URLs cuja última tentativa no `fontes/INDEX.jsonl` do run terminou em `acesso_falhou` (a que
 * falhou e depois abriu não conta). É o que decide a exceção da regra do dado público na meta.
 */
function fontesQueFalharamNoRun(indice) {
  let linhas;
  try { linhas = indice ? readFileSync(indice, 'utf-8').split('\n') : []; } catch { return []; }
  const ultimo = new Map();
  for (const l of linhas) {
    if (!l.trim()) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e && typeof e.url === 'string' && typeof e.status === 'string') ultimo.set(e.url, e.status);
  }
  return [...ultimo].filter(([, status]) => status === 'acesso_falhou').map(([url]) => url);
}

/**
 * `meta-consenso <squad-dir> --avaliacao <arq> [--avaliacao <arq> ...]` combina as
 * avaliações do `avaliador-squad` na Verificação da Meta, critério a critério.
 * Cada arquivo é o retorno de UM avaliador (o JSON `avaliacao_meta`, puro ou num
 * bloco ```json). A rubrica é a do squad.yaml; a regra de entrega, o `meta_limiar`
 * do squad.yaml (sem ele, o padrão do motor: nenhum NAO e nota 85, com aviso se o
 * `quality-criteria.md` fala de limiar em texto, que o código não lê); o número
 * mínimo de avaliações, o `meta_verifiers` do squad sob o teto do ritmo do run
 * (rápido 1, equilibrado 2, rigoroso até 3). Não há flag para mudar nenhum dos três. Imprime a decisão em JSON: `acao: concluir` (exit 0),
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
 * (em `sugestoes`) que repete uma exigência de um
 * critério ATENDE, pelo texto do critério ou pelas cláusulas PARCIAL e NÃO do
 * `pipeline/data/quality-criteria.md`, vira falta daquele critério
 * (`recusada_por_codigo: "sugestao-repete-exigencia"`) e o voto cai para PARCIAL; a de
 * `sugestoes_fora_da_rubrica` e a nota sobre a rubrica nunca derrubam critério. No squad de contrato
 * (`reader: contraparte` ou `processo: nenhum`), índice, prazo e valor que as partes escolhem
 * continuam dado do cliente.
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
  // A fonte oficial que falhou no run (`acesso_falhou` no INDEX): a exceção da regra do dado público.
  const ledgerDaMeta = loadRunLedger(dir);
  const indice = ledgerDaMeta && ledgerDaMeta.runId ? join(dir, 'output', ledgerDaMeta.runId, 'fontes', 'INDEX.jsonl') : null;
  const fontesFalharam = fontesQueFalharamNoRun(indice).length > 0;
  if (!caminho) return { caminho: null, pendencias: null, pendenciasOnde: null, raiz: raizDoProjeto, fontesFalharam };
  let manifesto;
  try { manifesto = JSON.parse(readFileSync(caminho, 'utf-8')); } catch (e) { die(`manifesto ${caminho} ilegível (${e.message}); nada foi combinado`); }
  // Com o `onde` de cada entrada: é por ele que o código acha o marcador que a evidência mostra
  // quando o avaliador não preencheu `pendencia` (mesma linha ou mesma seção).
  return { caminho, pendencias: pendenciasDoManifesto(manifesto), pendenciasOnde: pendenciasDoManifesto(manifesto, { detalhe: true }), raiz: raizDoProjeto, fontesFalharam };
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

// ── Despacho da meta por código (motor leve, 2a fase, outubro de 2026) ──────────────────────
// Medido no m2 de 01/10/2026 (motor 0.9.80): os três avaliadores ficaram presos, o chefe os
// redespachou com "seja econômico; não releia" no prompt, e os redespachados deram 6/6 ATENDE;
// os dois originais, que voltaram tarde e foram descartados, deram C2, C3 e C6 PARCIAL com
// evidência, e pelo limiar do squad a entrega reprovaria. O prompt do avaliador agora sai inteiro
// do código, num arquivo do run; o chefe passa ao avaliador só a frase de despacho, e o avaliador
// copia no voto qualquer instrução a mais que tenha recebido. Cada voz tem a sua saída registrada,
// e o voto que volta depois do redespacho entra no consenso, no arquivo dele.

const ESQUELETO_DA_META = '{"avaliacao_meta":{"despacho":{"id":"<id do despacho>","voz":"<a voz>","texto_extra":""},"criterios":[{"n":1,"criterio":"...","veredito":"ATENDE|PARCIAL|NAO","exigencias":[{"exigencia":"...","status":"atendida|falta|posterior","evidencia":"...","local":"...","classe":null,"pendencia":"..."}],"classe_da_perda":null,"mudanca":"..."}],"sugestoes_fora_da_rubrica":[]}}';

function rodadaBaseDaMeta(ledger) {
  const r = Array.isArray(ledger && ledger.reaberturas) ? ledger.reaberturas.length : 0;
  return r ? `r${r}` : 'm';
}

function registrosDaMeta(meta) {
  if (!existsSync(meta)) return [];
  return readdirSync(meta).filter((f) => /^meta-despacho-.+\.json$/.test(f)).map((f) => {
    try { return { arquivo: join(meta, f), ...JSON.parse(readFileSync(join(meta, f), 'utf-8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)));
}

/** A final do run: a versão `vN` mais alta com `*-final.md` e o manifesto ao lado. */
function finalDoRun(runDir) {
  if (!existsSync(runDir)) return null;
  const versoes = readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const v of versoes) {
    const f = readdirSync(join(runDir, v)).find((x) => /-final\.md$/.test(x) && existsSync(join(runDir, v, `${x}.citation-gate.json`)));
    if (f) return join(runDir, v, f);
  }
  return null;
}

/** Os artefatos que o foco cita pelo nome (`cronologia-e-prova.md`), achados na pasta do run. */
function artefatosCitadosPeloFoco(foco, runDir) {
  const nomes = [...new Set([...String(readFileSync(foco, 'utf-8')).matchAll(/[\w.-]+\.(?:md|json|yaml)\b/g)].map((m) => m[0]))];
  const achados = [];
  const andar = (d, nivel) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const c = join(d, e.name);
      if (e.isDirectory()) { if (nivel < 3) andar(c, nivel + 1); continue; }
      if (nomes.includes(e.name) && c !== foco && !/^(?:avaliacao|meta-|relatorio|aprovacao|checklist)/.test(e.name)) achados.push(c);
    }
  };
  andar(join(runDir, 'diagnostico'), 0);
  return [...new Set(achados)];
}

function promptDaMeta({ id, runId, raiz, lista, posteriores, reabertura, exigidos }) {
  const L = [
    `# Despacho da Verificação da Meta (run ${runId}, despacho ${id})`,
    '',
    'Gerado por código (`squad-state meta-despacho`). É o seu prompt inteiro: o despacho que te chamou só aponta este arquivo.',
    '',
    `Raiz do projeto: \`${raiz}\`. Todo caminho deste despacho é absoluto: leia-o como está, sem procurar a raiz nem outra pasta.`,
    '',
    '## Lista fechada (só estes arquivos valem)',
    '',
    ...lista.map((i) => `- \`${i.caminho}\`: ${i.papel}`),
    '',
    'Leia pelos caminhos acima; `Grep` e `Glob` só dentro deles. Não varra a pasta do run nem `output/` com busca ampla (`output/`, `v*/`, `**`): lá estão avaliações, relatório, aprovação e checklist, que contaminam o voto. Arquivo fora da lista que um critério pareça pedir vai em `sugestoes_fora_da_rubrica`, sem abrir.',
    '',
    `## Steps posteriores à meta: ${posteriores.length ? posteriores.map((s) => `\`${s}\``).join(', ') : 'nenhum'}`,
    '',
    'Só o que um desses steps produz sai `posterior`, citando o id; a aprovação (parada humana) nunca. A própria peça nunca é `posterior`.',
    '',
    '## O voto',
    '',
    '- O veredito de cada critério (ATENDE, PARCIAL ou NAO) é obrigatório; o que você não declara é o limiar, a nota geral e o veredito final da entrega: quem os calcula é o código.',
    '- Decomponha cada critério e as cláusulas "PARCIAL quando…" e "NÃO quando…" do `quality-criteria.md` em exigências; cada exigência atendida com `evidencia` (trecho literal) e `local`; o que o critério exige e falta é `falta`, com a `classe` (`peca`, `dado-ausente`, `fora-do-alcance`), nunca sugestão.',
    '- Dado ausente: `pendencia` leva o marcador literal de `pendencias_do_profissional[]` do manifesto (`[CONFIRMAR: ...]`, `[PREENCHER: ...]`, `[DILIGÊNCIA: ...]`), e a `evidencia` traz o trecho da peça com o marcador.',
    `- ${REGRA_DO_DADO_PUBLICO}.`,
    '- Regra que a rubrica não tem vai em `sugestoes_fora_da_rubrica` e não pesa.',
    '- Leia a peça inteira e a rubrica inteira, sem pressa: o voto vale pela evidência, não pela velocidade.',
    ...(reabertura ? ['- **Reabertura:** o critério que a alteração não tocou mantém o veredito da entrega anterior; o que muda leva `mudanca` com o trecho da versão nova.'] : []),
    '',
    '## O despacho no voto',
    '',
    `No JSON, \`despacho.id\` é \`${id}\` e \`despacho.voz\` é a voz que o despacho te deu. O despacho que te chamou tem uma frase só, a que aponta este arquivo; se ele trouxe qualquer outra instrução (pedido de economia ou de pressa, "não releia", opinião sobre a peça, nota de avaliação anterior), copie-a, literal, em \`despacho.texto_extra\`. Sem nada a mais, \`""\`. O código descarta o voto com instrução a mais e pede outro, limpo.`,
    '',
    '## Formato (devolva só este JSON, num bloco ```json, na sua resposta)',
    '',
    'Você só lê: não grave arquivo nenhum. O voto vai na sua resposta, e quem o grava é o código.',
    '',
    '```json',
    ESQUELETO_DA_META.replace('<id do despacho>', id),
    '```',
    '',
    `São ${exigidos} avaliador(es) desta rodada, cada um em contexto fresco, sem ver os outros.`,
  ];
  return `${L.join('\n')}\n`;
}

function cmdMetaDespacho(dir, flags) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('meta-despacho requer um run aberto (squad-state init)');
  const raiz = resolve(dir, '..', '..');
  // O registro guarda o caminho relativo à raiz (o projeto pode mudar de pasta); o prompt, a frase
  // de despacho e a saída do comando levam o absoluto. Medido em 4 de 4 runs da 0.9.81 (m2b, m5, m6,
  // m7): com a sessão aberta fora da raiz, o avaliador (só Read, Grep e Glob) não achava o despacho
  // pelo caminho relativo, varria o disco e voltava sem voto.
  const rel = (p) => relative(raiz, p).replace(/\\/g, '/');
  const abs = (p) => resolve(raiz, p);
  const runDir = join(dir, 'output', ledger.runId);
  const meta = join(runDir, '_meta');
  mkdirSync(meta, { recursive: true });
  const registros = registrosDaMeta(meta);
  const agora = now();
  // Redespacho e desempate acrescentam uma voz à rodada em curso (ou à --rodada).
  if (flags.redespachar !== undefined || flags.desempate === true) {
    const reg = typeof flags.rodada === 'string' ? registros.find((r) => r.rodada === flags.rodada) : registros[registros.length - 1];
    if (!reg) die('meta-despacho: não há rodada da meta despachada neste run (rode meta-despacho sem --redespachar antes)');
    let voz;
    let cadeia = null;
    if (flags.desempate === true) {
      if (reg.desempate) die(`meta-despacho: a rodada ${reg.rodada} já teve o desempate (${reg.desempate}); o consenso decide com os votos que há`);
      voz = 'desempate';
      reg.desempate = agora;
    } else {
      const k = str(flags.redespachar).trim();
      const caida = reg.saidas.find((s) => s.voz === k);
      if (!caida) die(`meta-despacho --redespachar ${k}: voz desconhecida na rodada ${reg.rodada} (${reg.saidas.map((s) => s.voz).join(', ')})`);
      // O redespacho de um redespacho é da mesma cadeia: `de` aponta sempre a voz que a abriu.
      cadeia = caida.de || caida.voz;
      voz = `${cadeia}-redespacho${reg.saidas.filter((s) => s.de === cadeia).length + 1}`;
      caida.caido_em = agora;
    }
    const saida = join(meta, `avaliacao-${reg.rodada}-${voz}.json`);
    reg.saidas.push({ voz, arquivo: rel(saida), tipo: flags.desempate === true ? 'desempate' : 'redespacho', ...(flags.desempate === true ? {} : { de: cadeia }), criado_em: agora });
    const { arquivo, ...gravar } = reg;
    writeFileSync(arquivo, `${JSON.stringify(gravar, null, 2)}\n`, 'utf-8');
    console.log(JSON.stringify({ rodada: reg.rodada, despacho: reg.id, voz, saida, prompt_do_task: fraseDoDespacho(reg, voz, raiz), gravar: comandoDoVoto(dir, reg.rodada, voz), detail: 'despache o avaliador-squad em contexto fresco com o prompt_do_task, literal e sem nada a mais; o retorno dele vai ao código pelo comando `gravar` (o avaliador só lê); o voto da voz caída, se voltar, vai pelo mesmo comando, com a voz dela, e entra no consenso' }, null, 2));
    return null;
  }
  const peca = typeof flags.peca === 'string' ? (isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca)) : finalDoRun(runDir);
  if (!peca || !existsSync(peca)) die('meta-despacho: nenhuma final com manifesto ao lado no run (`vN/<peça>-final.md` e `.citation-gate.json`); passe --peca');
  const squadYaml = readFileSync(join(dir, 'squad.yaml'), 'utf-8');
  const pipelineYaml = existsSync(join(dir, 'pipeline', 'pipeline.yaml')) ? readFileSync(join(dir, 'pipeline', 'pipeline.yaml'), 'utf-8') : '';
  const doSquad = avaliadoresDaMeta(squadYaml, pipelineYaml);
  const lista = [{ caminho: resolve(peca), papel: 'a versão final a avaliar' }];
  const add = (p, papel) => { if (p && existsSync(p) && !lista.some((i) => i.caminho === resolve(p))) lista.push({ caminho: resolve(p), papel }); };
  add(`${peca}.citation-gate.json`, 'o manifesto da final, com `pendencias_do_profissional[]`');
  if (entregaDeContratoDoSquadYaml(squadYaml)) add(join(dirname(peca), 'verifica-contrato-final.json'), 'o verifica-contrato da final (critério que cobra os sinais dele)');
  add(join(dir, 'squad.yaml'), '`goal`, `success_criteria` e `meta_limiar`');
  add(join(dir, 'pipeline', 'data', 'quality-criteria.md'), 'a rubrica detalhada, que prevalece na interpretação');
  const foco = [join(runDir, 'diagnostico-foco.md')].find((p) => existsSync(p));
  add(foco, 'o diagnóstico aprovado ("Critérios da meta decididos aqui")');
  if (foco) for (const a of artefatosCitadosPeloFoco(foco, runDir)) add(a, 'artefato da fase zero que o foco cita');
  add(pesquisaDoRun(dir, ledger.runId), 'a pesquisa jurídica');
  add(join(pastaDeAutos(dir), '_index.yaml'), 'o índice dos documentos (fato e dado)');
  add(join(runDir, 'intake.md'), 'a intake');
  add(join(runDir, 'fontes', 'INDEX.jsonl'), 'as fontes oficiais do run (`acesso_falhou` é fora do alcance)');
  // Todo artefato que a rubrica pode cobrar, por código: o que os steps de agente antes da meta
  // gravam (a gravação no controle de prazos, a carteira), os anexos que a final traz, os convites
  // de agenda e as saídas das calculadoras. Medido no m7 da 0.9.81: C2 e C4 cobravam as saídas das
  // calculadoras, o registro no controle e os .ics, que ficavam fora da lista, e os avaliadores os
  // pediam em sugestões (ou a redação os copiava para dentro do boletim).
  for (const a of artefatosDaEntrega(runDir, peca, pipelineYaml)) add(a.caminho, a.papel);
  const reabertura = Array.isArray(ledger.reaberturas) && ledger.reaberturas.length ? ledger.reaberturas[ledger.reaberturas.length - 1] : null;
  const criteriosDoSquad = criteriosDoSquadYaml(squadYaml);
  const resolvido = typeof flags.anterior === 'string' && flags.anterior.trim()
    ? resolverAnteriorDaMeta(dir, flags.anterior.trim(), { criterios: criteriosDoSquad, qualityCriteria: existsSync(join(dir, 'pipeline', 'data', 'quality-criteria.md')) ? readFileSync(join(dir, 'pipeline', 'data', 'quality-criteria.md'), 'utf-8') : '', squadYaml, pipelineYaml, regra: metaLimiarDoSquadYaml(squadYaml, criteriosDoSquad.length).regra })
    : null;
  const anterior = resolvido ? resolvido.arquivo : null;
  if (anterior) add(anterior, resolvido.origem === 'consenso' ? 'o veredito de cada critério na entrega anterior (`meta-consenso` dela)' : `o veredito de cada critério na entrega anterior (${resolvido.detalhe})`);
  // Ajuste de forma (reabertura em `ajustes`, com o consenso da entrega anterior ao lado): o que
  // mudou é a forma, e uma voz com a referência basta para pegar regressão. A cadeia inteira (três
  // avaliadores) custou 36 minutos de espera por uma remissão no sumário (m2, M5, 01/10/2026). Em
  // revisão de mérito, ou sem a referência, vale o número do squad.
  const ajusteDeForma = !!(reabertura && reabertura.modo === 'ajustes' && ledger.status === 'running' && anterior && existsSync(anterior));
  // O ritmo do run põe o teto (rápido 1, equilibrado 2, rigoroso até 3) sobre o que o squad declara.
  const doRitmo = vozesDaMeta(dir, doSquad);
  const exigidos = ajusteDeForma ? 1 : doRitmo.exigidos;
  const motivoDasVozes = ajusteDeForma
    ? `ajuste de forma (reabertura em ajustes, com o consenso anterior): uma voz; o squad declara ${doSquad}`
    : doRitmo.motivo;
  const posteriores = stepsDeAgentePosteriores(stepsPosterioresDoPipeline(pipelineYaml, { detalhe: true }) || []).map((s) => s.id);
  const base = typeof flags.rodada === 'string' && flags.rodada.trim() ? flags.rodada.trim() : rodadaBaseDaMeta(ledger);
  let rodada = base;
  for (let i = 1; registros.some((r) => r.rodada === rodada) || (rodada === base && !flags.rodada); i += 1) rodada = `${base}-${i}`;
  const semId = promptDaMeta({ id: '<id>', runId: ledger.runId, raiz, lista, posteriores, reabertura: !!reabertura || !!anterior, exigidos });
  const id = createHash('sha256').update(`${ledger.runId}|${rodada}|${agora}|${semId}`).digest('hex').slice(0, 12);
  let prompt = promptDaMeta({ id, runId: ledger.runId, raiz, lista, posteriores, reabertura: !!reabertura || !!anterior, exigidos });
  if (reabertura && reabertura.pedido) prompt += `\n## Pedido do profissional na reabertura (literal)\n\n> ${String(reabertura.pedido).replace(/\n/g, '\n> ')}\n`;
  const promptArq = join(meta, `meta-despacho-${rodada}.md`);
  writeFileSync(promptArq, prompt, 'utf-8');
  const saidas = Array.from({ length: exigidos }, (_, k) => ({ voz: String(k + 1), arquivo: rel(join(meta, `avaliacao-${rodada}-${k + 1}.json`)), tipo: 'original', criado_em: agora }));
  const reg = { rodada, id, run: ledger.runId, criado_em: agora, prompt: rel(promptArq), prompt_sha256: createHash('sha256').update(prompt).digest('hex'), peca: rel(peca), exigidos, exigidos_do_squad: doSquad, motivo_das_vozes: motivoDasVozes, saidas, desempate: null };
  writeFileSync(join(meta, `meta-despacho-${rodada}.json`), `${JSON.stringify(reg, null, 2)}\n`, 'utf-8');
  console.log(JSON.stringify({
    rodada, despacho: id, raiz, prompt: promptArq, exigidos, motivo_das_vozes: motivoDasVozes,
    despachos: saidas.map((s) => ({ voz: s.voz, saida: abs(s.arquivo), prompt_do_task: fraseDoDespacho(reg, s.voz, raiz), gravar: comandoDoVoto(dir, rodada, s.voz) })),
    detail: `despache ${exigidos} avaliador-squad em contexto fresco, cada um com o seu prompt_do_task, literal e sem nada a mais (nem pedido de economia, nem opinião sobre a peça); o avaliador só lê e devolve o voto na resposta: entregue cada retorno ao código pelo comando \`gravar\` da voz (o retorno em arquivo, ou pela entrada padrão com --retorno -); depois, meta-consenso --rodada ${rodada}`,
  }, null, 2));
  return null;
}

/** O arquivo mais recente do run para um caminho do pipeline (`output/trabalho/x.md`): a versão `vN` mais alta, onde houver. */
function maisRecenteNoRun(runDir, sub) {
  const partes = String(sub).replace(/^output\//, '').split('/').filter(Boolean);
  const nome = partes.pop();
  const pasta = join(runDir, ...partes);
  const versoes = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name).sort((x, y) => Number(y.slice(1)) - Number(x.slice(1))); } catch { return []; } };
  for (const c of [...versoes(pasta).map((v) => join(pasta, v, nome)), join(pasta, nome), ...versoes(runDir).map((v) => join(runDir, v, nome))]) if (existsSync(c)) return c;
  return null;
}

/** Os steps do pipeline, na ordem, com o tipo, se é parada humana, se é o da meta e as saídas declaradas. */
function stepsDoPipeline(pipelineYaml) {
  const linhas = String(pipelineYaml ?? '').split(/\r?\n/);
  const inicio = linhas.findIndex((l) => /^steps:[ \t]*$/.test(l));
  if (inicio < 0) return [];
  const steps = [];
  for (const linha of linhas.slice(inicio + 1)) {
    if (/^\S/.test(linha) && !/^-/.test(linha)) break;
    const id = linha.match(/^[ \t]*-[ \t]+id:[ \t]*["']?([\w.-]+)/);
    if (id) { steps.push({ id: id[1], tipo: null, meta: false, saidas: [] }); continue; }
    const atual = steps[steps.length - 1];
    if (!atual) continue;
    if (/^[ \t]+meta_verifiers:/.test(linha)) atual.meta = true;
    const tipo = linha.match(/^[ \t]+type:[ \t]*["']?([\w-]+)/);
    if (tipo && !atual.tipo) atual.tipo = tipo[1];
    const saida = linha.match(/^[ \t]+-[ \t]+["']?([^\s"']+\.[a-z0-9]+)["']?[ \t]*$/i);
    if (saida && saida[1].includes('/')) atual.saidas.push(saida[1]);
  }
  return steps;
}

/** O que contamina o voto ou já está na lista: minuta, revisão, avaliação, relatório, aprovação, checklist, intake, foco. */
const ARTEFATO_FORA_DA_META = /(?:minuta|revisao|avaliacao|relatorio|aprovacao|checklist|meta-|intake|diagnostico-foco|-final)\b/i;

/**
 * Os artefatos da entrega que a rubrica pode cobrar, por código: as saídas declaradas dos steps de
 * agente antes da meta (a versão mais recente no run), os anexos que a final traz (o
 * `<final>.anexos.json` do `manifesto-final`, ou a frase da final que nomeia o arquivo), os convites
 * de agenda (`agenda/`, a versão mais recente) e as saídas das calculadoras (JSON com `data_limite`).
 */
function artefatosDaEntrega(runDir, peca, pipelineYaml) {
  const out = [];
  const add = (caminho, papel) => { if (caminho && existsSync(caminho) && !out.some((x) => x.caminho === resolve(caminho))) out.push({ caminho: resolve(caminho), papel }); };
  const steps = stepsDoPipeline(pipelineYaml);
  const ancora = steps.findIndex((st) => st.meta);
  for (const st of ancora < 0 ? steps : steps.slice(0, ancora)) {
    if (st.tipo === 'checkpoint') continue;
    for (const sub of st.saidas) if (!ARTEFATO_FORA_DA_META.test(basename(sub))) add(maisRecenteNoRun(runDir, sub), `o que o ${st.id} grava`);
  }
  let anexos;
  try { anexos = JSON.parse(readFileSync(`${peca}.anexos.json`, 'utf-8')); } catch { anexos = null; }
  const raiz = resolve(runDir, '..', '..', '..', '..');
  for (const a of (anexos && Array.isArray(anexos.anexos) ? anexos.anexos : [])) add([resolve(raiz, a.arquivo), resolve(a.arquivo)].find((c) => existsSync(c)), `anexo que a final traz (${a.referencia})`);
  try { for (const a of anexosDaFinal(readFileSync(peca, 'utf-8'), runDir).resolvidos) add(a.arquivo, `anexo que a final traz (${a.referencia})`); } catch { /* final ilegível: o resto da lista vale */ }
  const agenda = join(runDir, 'agenda');
  if (existsSync(agenda)) {
    const versoes = readdirSync(agenda, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name).sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)));
    const pasta = versoes.length ? join(agenda, versoes[0]) : agenda;
    for (const f of readdirSync(pasta).filter((x) => x.endsWith('.ics')).sort()) add(join(pasta, f), 'convite de agenda (.ics) da entrega');
  }
  for (const f of saidasDeCalculadora(runDir)) add(f, 'saída de calculadora (data-limite calculada)');
  return out;
}


/** A frase que despacha a voz: o caminho absoluto do prompt, e o voto na resposta (o avaliador só lê). */
function fraseDoDespacho(reg, voz, raiz) {
  return `Você é o avaliador da meta (despacho ${reg.id}, voz ${voz}). Leia e siga, à letra, o arquivo ${resolve(raiz, reg.prompt)}; devolva na sua resposta o bloco JSON que ele pede. Você só lê: quem grava o voto é o código.`;
}

/**
 * O voto que o retorno do subagente traz: o JSON `avaliacao_meta` no texto (bloco ```json, JSON cru
 * ou JSON seguido de prosa) ou, quando o retorno é a transcrição do subagente (uma linha JSON por
 * evento), o último voto achado nos textos dela. null quando não há voto.
 */
function votoDoRetorno(texto) {
  const direto = extrairAvaliacaoMeta(texto);
  if (direto) return direto;
  let achado = null;
  const textos = (v) => {
    if (typeof v === 'string') { if (/avaliacao_meta|"criterios"/.test(v)) { const av = extrairAvaliacaoMeta(v); if (av) achado = av; } return; }
    if (Array.isArray(v)) { for (const x of v) textos(x); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) textos(x);
  };
  for (const linha of String(texto ?? '').split(/\r?\n/)) {
    if (!linha.trim().startsWith('{')) continue;
    try { textos(JSON.parse(linha)); } catch { /* linha que não é JSON */ }
  }
  return achado;
}

/**
 * `meta-voto <squad-dir> --rodada <r> --voz <v> --retorno <arquivo|->`: grava o voto da voz pelo
 * código. O avaliador da meta é read-only: o voto existe só na resposta dele, e o chefe o
 * "gravava como veio" à mão (m2b e m7 da 0.9.81: script próprio para extrair o bloco; m6: texto
 * sem voto gravado como voto). Aqui o código lê o retorno (o arquivo de saída do subagente, ou a
 * entrada padrão), extrai o JSON `avaliacao_meta` e o grava na saída registrada da voz. Retorno
 * sem voto não grava nada: a voz segue sem retorno, e o consenso pede o redespacho.
 */
function cmdMetaVoto(dir, flags) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('meta-voto requer um run aberto (squad-state init)');
  const voz = str(flags.voz).trim();
  if (!voz || flags.voz === true) die('meta-voto requer --voz <a voz do despacho>');
  if (flags.retorno === undefined || flags.retorno === true) die('meta-voto requer --retorno <arquivo com o retorno do subagente, ou - para a entrada padrão>');
  const raiz = resolve(dir, '..', '..');
  const registros = registrosDaMeta(join(dir, 'output', ledger.runId, '_meta'));
  const reg = typeof flags.rodada === 'string' && flags.rodada.trim() ? registros.find((r) => r.rodada === flags.rodada.trim()) : registros[registros.length - 1];
  if (!reg) die(`meta-voto: rodada ${typeof flags.rodada === 'string' ? flags.rodada : '(a última)'} não despachada neste run`);
  const sd = reg.saidas.find((x) => x.voz === voz);
  if (!sd) die(`meta-voto --voz ${voz}: voz desconhecida na rodada ${reg.rodada} (${reg.saidas.map((x) => x.voz).join(', ')})`);
  const origem = str(flags.retorno).trim();
  let texto;
  let voltouEm = null;
  if (origem === '-') texto = readFileSync(0, 'utf-8');
  else {
    const caminho = isAbsolute(origem) ? origem : resolve(origem);
    if (!existsSync(caminho)) die(`meta-voto --retorno ${origem}: arquivo não existe`);
    texto = readFileSync(caminho, 'utf-8');
    voltouEm = new Date(statSync(caminho).mtimeMs).toISOString();
  }
  const av = votoDoRetorno(texto);
  if (!av) {
    console.log(JSON.stringify({ acao: 'sem-voto', rodada: reg.rodada, voz, detail: `o retorno não traz o JSON avaliacao_meta: nada foi gravado, e a voz ${voz} segue sem retorno; redespache (meta-despacho --redespachar ${voz} --rodada ${reg.rodada})` }, null, 2));
    process.exitCode = 1;
    return null;
  }
  const saida = resolve(raiz, sd.arquivo);
  mkdirSync(dirname(saida), { recursive: true });
  writeFileSync(saida, `${JSON.stringify({ avaliacao_meta: av }, null, 2)}\n`, 'utf-8');
  sd.gravado_em = now();
  if (voltouEm) sd.voltou_em = voltouEm;
  const { arquivo, ...gravar } = reg;
  writeFileSync(arquivo, `${JSON.stringify(gravar, null, 2)}\n`, 'utf-8');
  const d = av.despacho && typeof av.despacho === 'object' ? av.despacho : {};
  const avisos = [];
  if (String(d.id || '').trim() !== reg.id) avisos.push(`o voto não traz o despacho ${reg.id}: o consenso o recusa`);
  console.log(JSON.stringify({ acao: 'gravado', rodada: reg.rodada, voz, saida, criterios: (av.criterios || []).length, ...(voltouEm ? { voltou_em: voltouEm } : {}), ...(avisos.length ? { avisos } : {}) }, null, 2));
  return null;
}

/** O comando que grava o voto da voz, pelo código, a partir do retorno do subagente. */
function comandoDoVoto(dir, rodada, voz) {
  return `node scripts/squad-state.mjs meta-voto ${relative(resolve(dir, '..', '..'), resolve(dir)).replace(/\\/g, '/')} --rodada ${rodada} --voz ${voz} --retorno <arquivo com o retorno do subagente, ou - para a entrada padrão>`;
}

/** A saída do `meta-consenso` que combinou (concluir ou apresentar-falhas): um veredito por critério. */
function consensoValido(dado) {
  if (!dado || typeof dado !== 'object' || !Array.isArray(dado.criterios) || !dado.criterios.length) return false;
  if (dado.acao && !['concluir', 'apresentar-falhas'].includes(dado.acao)) return false;
  return dado.criterios.every((c) => Number.isInteger(c && c.n) && metaVeredito(c.veredito));
}

/**
 * O veredito de cada critério no consenso: `{ veredito, aceitos }`. Aceito sem `mudanca`, o veredito
 * do consenso e, quando o código rebaixou ou reclassificou os votos naquele critério, também o ATENDE
 * que eles declararam (o rebaixamento era do código, e pode não se repetir).
 */
function mapaDoConsenso(dado) {
  return new Map(dado.criterios.filter((c) => Number.isInteger(c && c.n) && metaVeredito(c.veredito)).map((c) => {
    const veredito = metaVeredito(c.veredito);
    const doCodigo = (c.rebaixados_por_codigo || []).length || (c.reclassificados_por_codigo || []).length;
    return [c.n, { veredito, aceitos: doCodigo && veredito !== 'ATENDE' ? [veredito, 'ATENDE'] : [veredito] }];
  }));
}

/**
 * O consenso dos votos que uma rodada tem, combinados como vieram (sem exigir o número de vozes):
 * é o anterior de uma entrega que fechou sem consenso (o profissional decidiu na escalada). Voto sem
 * o id do despacho fica de fora. Sem voto legível, null.
 */
function consensoDosVotosDaRodada(dir, registro, { criterios, qualityCriteria, squadYaml, pipelineYaml, regra }) {
  const raiz = resolve(dir, '..', '..');
  let manifesto;
  try { manifesto = registro.peca ? JSON.parse(readFileSync(resolve(raiz, `${registro.peca}.citation-gate.json`), 'utf-8')) : null; } catch { manifesto = null; }
  const contexto = {
    pendencias: manifesto ? pendenciasDoManifesto(manifesto) : null,
    pendenciasOnde: manifesto ? pendenciasDoManifesto(manifesto, { detalhe: true }) : null,
    stepsPosteriores: stepsPosterioresDoPipeline(pipelineYaml, { detalhe: true }),
    rubrica: { criterios, qualityCriteria },
    contrato: metaContratoDoSquadYaml(squadYaml),
  };
  const validas = [];
  for (const sd of registro.saidas || []) {
    const f = resolve(raiz, sd.arquivo);
    if (!existsSync(f)) continue;
    const av = extrairAvaliacaoMeta(readFileSync(f, 'utf-8'));
    if (!av || !av.despacho || String(av.despacho.id || '').trim() !== registro.id) continue;
    const n = normalizarAvaliacaoMeta(av, criterios.length, contexto);
    if (n.erros.length) continue;
    validas.push({ arquivo: f, ...n });
  }
  return validas.length ? combinarMeta(validas, { criterios, regra, exigidos: validas.length }) : null;
}

/**
 * O anterior da reabertura (`--anterior`): o arquivo da saída do `meta-consenso` da entrega anterior,
 * ou o nome da rodada dela (`m-2`). Quando o que se passa não é um consenso (a entrega fechou sem ele:
 * a rodada parou em `redespachar` e o profissional decidiu), vale o consenso dos votos daquela rodada,
 * gravado em `_meta/meta-consenso-{rodada}-dos-votos.json`; sem votos legíveis, o último consenso
 * válido do run. Medido no m2b da 0.9.81: a entrega da v14 fechou sem consenso, o arquivo dela era a
 * resposta `redespachar`, e o chefe passou o consenso de outra versão (m-1).
 */
function resolverAnteriorDaMeta(dir, valor, contexto) {
  const ledger = loadRunLedger(dir);
  const metaDir = ledger && ledger.runId ? join(dir, 'output', ledger.runId, '_meta') : null;
  const registros = metaDir ? registrosDaMeta(metaDir) : [];
  let caminho = null;
  let rodada = registros.some((r) => r.rodada === valor) ? valor : null;
  if (!rodada) {
    caminho = [isAbsolute(valor) ? valor : resolve(valor), metaDir ? join(metaDir, valor) : null].filter(Boolean).find((c) => existsSync(c)) || null;
    if (!caminho) die(`--anterior ${valor}: nem arquivo nem rodada da meta neste run (${registros.map((r) => r.rodada).join(', ') || 'nenhuma rodada'})`);
    let dado;
    try { dado = JSON.parse(readFileSync(caminho, 'utf-8')); } catch (e) { die(`--anterior ${valor}: ilegível (${e.message}); passe a saída JSON do meta-consenso da entrega anterior, ou o nome da rodada dela`); }
    if (consensoValido(dado)) return { arquivo: caminho, mapa: mapaDoConsenso(dado), origem: 'consenso', detalhe: 'o consenso da entrega anterior' };
    rodada = (typeof dado.rodada === 'string' && dado.rodada) || (basename(caminho).match(/^meta-consenso-(.+?)\.json$/) || [])[1] || null;
  }
  const reg = rodada ? registros.find((r) => r.rodada === rodada) : null;
  if (reg) {
    const salvo = join(metaDir, `meta-consenso-${rodada}.json`);
    let dado;
    try { dado = JSON.parse(readFileSync(salvo, 'utf-8')); } catch { dado = null; }
    if (consensoValido(dado)) return { arquivo: salvo, mapa: mapaDoConsenso(dado), origem: 'consenso', detalhe: `o consenso da rodada ${rodada}` };
    const c = consensoDosVotosDaRodada(dir, reg, contexto);
    if (c) {
      const arquivo = join(metaDir, `meta-consenso-${rodada}-dos-votos.json`);
      writeFileSync(arquivo, `${JSON.stringify({ acao: c.verdict === 'APROVADO' ? 'concluir' : 'apresentar-falhas', rodada, origem: `votos da rodada ${rodada}, que fechou sem consenso`, ...c }, null, 2)}\n`, 'utf-8');
      return { arquivo, mapa: mapaDoConsenso(c), origem: 'votos-da-rodada', detalhe: `a entrega anterior fechou sem consenso: vale o dos votos da rodada ${rodada} (${c.avaliadores} voto(s))` };
    }
  }
  const candidatos = metaDir && existsSync(metaDir) ? readdirSync(metaDir).filter((f) => /^meta-consenso-.+\.json$/.test(f)).map((f) => join(metaDir, f)).filter((f) => f !== caminho)
    .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs) : [];
  for (const f of candidatos) {
    let dado;
    try { dado = JSON.parse(readFileSync(f, 'utf-8')); } catch { continue; }
    if (consensoValido(dado)) return { arquivo: f, mapa: mapaDoConsenso(dado), origem: 'ultimo-consenso', detalhe: `sem consenso nem votos legíveis da entrega anterior: vale o último consenso válido do run (${basename(f)})` };
  }
  return die(`--anterior ${valor}: a entrega anterior não tem consenso, nem votos legíveis, nem há consenso válido no run`);
}

/** O começo da seção do refazer, que o código acrescenta ao prompt da voz e que o voto pode citar. */
const REFAZER_DO_CODIGO = 'Refazer de formato, pedido pelo código (meta-consenso, acao refazer-avaliacao): a lista `faltam` abaixo é o que ele devolveu para o seu voto anterior, por critério, com a exigência e os campos que faltam.';

/** A seção do refazer, com a lista `faltam` dentro: é parte do despacho, não instrução a mais. */
function secaoDoRefazer(faltam) {
  const L = [
    '## Refazer o voto (gerado pelo código)',
    '',
    REFAZER_DO_CODIGO,
    'Esta seção faz parte do despacho do código: não é instrução a mais, e não vai em `despacho.texto_extra`. Refaça o voto inteiro, todos os critérios, com o mesmo `despacho.id`; não é falha da peça e não muda veredito por si.',
    '',
    ...(Array.isArray(faltam) ? faltam : []).map((f) => `- C${f.n}${f.exigencia ? `, exigência "${f.exigencia}"` : ''}: falta ${(f.campos || []).join('; ')}`),
    '',
    'Em cada exigência atendida: `evidencia` com o trecho e `local`; no dado ausente: `pendencia` com o marcador literal de `pendencias_do_profissional[]`; o critério que mudou de veredito em relação à entrega anterior leva `mudanca` com o trecho da versão nova.',
    '',
  ];
  return `${L.join('\n')}\n`;
}

/** Os arrays e objetos JSON de primeiro nível de um texto que se leem como a lista `faltam`. */
function listaFaltamNoTexto(texto) {
  const t = String(texto ?? '');
  const achados = [];
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== '[' && t[i] !== '{') continue;
    let nivel = 0;
    let dentro = false;
    let escape = false;
    for (let j = i; j < t.length; j += 1) {
      const c = t[j];
      if (dentro) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') dentro = false; continue; }
      if (c === '"') dentro = true;
      else if (c === '[' || c === '{') nivel += 1;
      else if (c === ']' || c === '}') {
        nivel -= 1;
        if (nivel === 0) {
          try {
            const v = JSON.parse(t.slice(i, j + 1));
            const lista = Array.isArray(v) ? v : (v && Array.isArray(v.faltam) ? v.faltam : null);
            if (lista && lista.length && lista.every((f) => f && Number.isInteger(f.n) && Array.isArray(f.campos))) { achados.push({ de: i, ate: j + 1 }); i = j; }
          } catch { /* não é JSON */ }
          break;
        }
      }
    }
  }
  return achados;
}

/**
 * O `texto_extra` que cita o refazer do código (a lista `faltam` e a frase que a apresenta) não é
 * instrução a mais: o despacho da voz a trazia. Sem o JSON da lista, sem a raiz do projeto e sem o
 * vocabulário da seção do refazer, não pode sobrar palavra nenhuma.
 */
function extraDoRefazer(extra, { raiz = '', sd = null } = {}) {
  const lista = listaFaltamNoTexto(extra);
  const citaLista = lista.length > 0 || (sd && sd.refazer && /\bfaltam\b/.test(extra));
  if (!citaLista) return false;
  let resto = String(extra);
  for (const a of [...lista].reverse()) resto = `${resto.slice(0, a.de)} ${resto.slice(a.ate)}`;
  // Caminho não é instrução: a raiz do projeto (e qualquer caminho absoluto) que o avaliador repete sai da conta.
  if (raiz) resto = resto.split(raiz).join(' ');
  resto = resto.replace(/(?:^|[\s(])\/[\w./-]+/g, ' ');
  const base = metaTermos(`${REFAZER_DO_CODIGO} ${secaoDoRefazer(sd && sd.refazer ? sd.refazer.faltam : [])} Raiz do projeto ele devolveu com`);
  // Nenhuma palavra fora do vocabulário do refazer: "seja econômico" ao lado da lista contamina.
  return [...metaTermos(resto)].filter((x) => !/^\d+$/.test(x)).every((x) => base.has(x));
}

/**
 * As cadeias de voz de uma rodada, na ordem do registro: a original (ou o desempate) e os
 * redespachos dela, cada um com `de` apontando a raiz da cadeia. Sem registro, vazio.
 */
function cadeiasDaRodada(registro) {
  const cadeias = new Map();
  for (const sd of (registro && Array.isArray(registro.saidas) ? registro.saidas : [])) {
    const raiz = sd.de || sd.voz;
    if (!cadeias.has(raiz)) cadeias.set(raiz, []);
    cadeias.get(raiz).push(sd);
  }
  return cadeias;
}

function cmdMetaConsenso(dir, flags) {
  const squadPath = join(dir, 'squad.yaml');
  if (!existsSync(squadPath)) die(`squad.yaml não encontrado em ${dir}`);
  const squadYaml = readFileSync(squadPath, 'utf-8');
  const pipelinePath = join(dir, 'pipeline', 'pipeline.yaml');
  const pipelineYaml = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '';
  const criterios = criteriosDoSquadYaml(squadYaml);
  if (!criterios.length) die('squad.yaml sem success_criteria legíveis: não há rubrica a combinar');
  // Sem rodada despachada por código, o mesmo teto do ritmo que o `meta-despacho` aplica.
  let exigidos = vozesDaMeta(dir, avaliadoresDaMeta(squadYaml, pipelineYaml)).exigidos;
  const declarada = metaLimiarDoSquadYaml(squadYaml, criterios.length);
  if (declarada.presente && declarada.erros.length) die(`meta_limiar do squad.yaml ilegível, nada foi combinado: ${declarada.erros.join('; ')}`);
  const rubricaPath = join(dir, 'pipeline', 'data', 'quality-criteria.md');
  const qualityCriteria = existsSync(rubricaPath) ? readFileSync(rubricaPath, 'utf-8') : '';
  const avisos = [];
  if (!declarada.presente && qualityCriteria && rubricaDeclaraLimiarEmTexto(qualityCriteria)) {
    avisos.push('o pipeline/data/quality-criteria.md declara o limiar em texto, que o código não lê: usado o padrão do motor (nenhum NAO e nota 85). Declare a regra em `meta_limiar` no squad.yaml para o veredito seguir a rubrica do squad');
  }
  const limiarFonte = declarada.presente ? 'squad.yaml:meta_limiar' : 'padrao-do-motor';

  let arquivos = asList(flags.avaliacao).filter((v) => typeof v === 'string' && v.trim());
  // Rodada despachada por código (`meta-despacho`): os votos são os do registro, todos, também o da
  // voz que caiu e voltou depois do redespacho (o voto tardio entra no consenso; medido no m2 de
  // 01/10/2026, os dois tardios discordavam dos três redespachados e sumiam). A rodada vem por
  // --rodada ou pelo registro que lista uma das --avaliacao passadas.
  const raizDoRegistro = resolve(dir, '..', '..');
  const runDaMeta = loadRunLedger(dir);
  const registros = runDaMeta && runDaMeta.runId ? registrosDaMeta(join(dir, 'output', runDaMeta.runId, '_meta')) : [];
  let registro;
  if (typeof flags.rodada === 'string' && flags.rodada.trim()) {
    registro = registros.find((r) => r.rodada === flags.rodada.trim()) || die(`meta-consenso --rodada ${flags.rodada}: rodada não despachada neste run (${registros.map((r) => r.rodada).join(', ') || 'nenhuma'})`);
  } else {
    registro = registros.find((r) => r.saidas.some((sd) => arquivos.some((a) => resolve(a) === resolve(raizDoRegistro, sd.arquivo)))) || null;
  }
  const faltandoNoRegistro = [];
  // A saída vai também a `_meta/meta-consenso-{rodada}.json`, gravada pelo código: é o anterior da
  // reabertura seguinte (o chefe a copiava à mão, e a entrega que fechou sem consenso ficava sem ela).
  const emitirConsenso = (saida) => {
    console.log(JSON.stringify(saida, null, 2));
    // `--sem-gravar`: só recalcula (o auditor do run só lê; antes ele regravava o consenso do run).
    if (registro && runDaMeta && runDaMeta.runId && !flags['sem-gravar']) writeFileSync(join(dir, 'output', runDaMeta.runId, '_meta', `meta-consenso-${registro.rodada}.json`), `${JSON.stringify({ rodada: registro.rodada, ...saida }, null, 2)}\n`, 'utf-8');
  };
  // A rodada despachada por código diz quantas vozes pediu (uma, no ajuste de forma).
  if (registro && Number.isInteger(registro.exigidos) && registro.exigidos > 0) exigidos = registro.exigidos;
  // Cada voz é uma cadeia: a original e os redespachos dela, em qualquer profundidade (o redespacho
  // do redespacho é da mesma cadeia). A última da cadeia é a exigida; as que ela substituiu são
  // dispensadas, e o voto de uma delas que volte entra como tardio. Medido no m6 (rodada m-1, quatro
  // redespachos da voz 2) e no m2b (rodada m-2, voz 1 redespachada duas vezes) da 0.9.81: só a
  // original substituída era dispensada, cada redespacho caído virava nova exigência, e a rodada não
  // combinava nunca (219 minutos de meta no contrato social).
  const cadeiaDoArquivo = new Map();
  const saidaDoArquivo = new Map();
  const refeitos = new Set();
  const dispensados = new Set();
  const cadeias = cadeiasDaRodada(registro);
  if (registro) {
    arquivos = [];
    // Na ordem do registro (a das vozes despachadas), não na das cadeias.
    for (const sd of registro.saidas) {
      const cadeia = sd.de || sd.voz;
      const membros = cadeias.get(cadeia);
      const caminho = resolve(raizDoRegistro, sd.arquivo);
      saidaDoArquivo.set(caminho, sd);
      if (sd.refazer) refeitos.add(caminho);
      if (existsSync(caminho)) {
        arquivos.push(caminho);
        cadeiaDoArquivo.set(caminho, cadeia);
        if (sd !== membros[membros.length - 1]) dispensados.add(caminho);
      } else if (sd === membros[membros.length - 1] && !membros.some((m) => existsSync(resolve(raizDoRegistro, m.arquivo)))) faltandoNoRegistro.push(sd.arquivo);
    }
  }
  const validas = [];
  const invalidas = [];
  const lidas = [];
  // O arquivo de voz dispensada (substituída por redespacho) que não traz voto não pede nada: vira aviso.
  const recusar = (arquivo, erros) => {
    if (dispensados.has(arquivo)) avisos.push(`${basename(arquivo)}: voz substituída por redespacho, sem voto válido (${erros[0]}); dispensada`);
    else invalidas.push({ arquivo, erros });
  };
  for (const arquivo of faltandoNoRegistro) invalidas.push({ arquivo, erros: ['voz despachada sem voto gravado: entregue o retorno do avaliador ao código (meta-voto --voz <voz> --retorno <arquivo>), ou redespache a voz (meta-despacho --redespachar <voz>)'] });
  for (const arquivo of arquivos) {
    if (!existsSync(arquivo)) { recusar(arquivo, ['arquivo não existe']); continue; }
    const bruto = readFileSync(arquivo, 'utf-8');
    const av = extrairAvaliacaoMeta(bruto);
    if (av && registro) {
      // O prompt é do código: o voto sem o id do despacho não leu o arquivo de despacho, e o voto
      // que declara instrução a mais no despacho (economia, pressa, opinião) foi contaminado.
      const d = av.despacho && typeof av.despacho === 'object' ? av.despacho : null;
      const extra = d && typeof d.texto_extra === 'string' ? d.texto_extra.trim() : '';
      if (!d || String(d.id || '').trim() !== registro.id) { recusar(arquivo, [`voto sem o despacho ${registro.id} (\`despacho.id\`): o avaliador não seguiu o arquivo de despacho do código (${registro.prompt}); redespache a voz com o prompt_do_task literal`]); continue; }
      if (extra && extraDoRefazer(extra, { raiz: raizDoRegistro, sd: saidaDoArquivo.get(arquivo) })) {
        // O voto refeito que cita a lista `faltam` (do código) não foi contaminado: o despacho a trazia.
        refeitos.add(arquivo);
        avisos.push(`${basename(arquivo)}: \`texto_extra\` cita o refazer do código (a lista \`faltam\`), que não é instrução a mais`);
      } else if (extra) { recusar(arquivo, [`despacho contaminado: o avaliador declarou instrução a mais no prompt que o chamou ("${extra.slice(0, 160)}"); redespache a voz com o prompt_do_task literal, sem nada a mais`]); continue; }
    }
    if (!av) {
      // O formato antigo do agente (bloco YAML `avaliacao:` com nota e veredito) ainda aparece quando
      // a sessão foi aberta antes do update: a definição do agente fica carregada até a sessão reabrir.
      const antigo = /^\s*avaliacao:\s*$/m.test(bruto);
      recusar(arquivo, [antigo ? 'bloco YAML `avaliacao` do formato antigo do avaliador, não o JSON `avaliacao_meta`' : 'sem o JSON `avaliacao_meta` (arquivo JSON ou bloco ```json)']);
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
  // Contrato (sem processo, lido pela contraparte): índice, prazo e valor escolhidos pelas partes são dado do cliente.
  const contrato = metaContratoDoSquadYaml(squadYaml);
  const refazer = [];
  // Reabertura: o veredito de cada critério na entrega anterior (a saída do meta-consenso dela). O
  // ATENDE que o código rebaixou lá pode voltar como ATENDE sem explicação.
  let anterior = null;
  if (typeof flags.anterior === 'string' && flags.anterior.trim()) {
    const resolvido = resolverAnteriorDaMeta(dir, flags.anterior.trim(), { criterios, qualityCriteria, squadYaml, pipelineYaml, regra: declarada.regra });
    anterior = resolvido.mapa;
    if (resolvido.origem !== 'consenso') avisos.push(`--anterior: ${resolvido.detalhe}`);
  }
  for (const [i, { arquivo, av }] of lidas.entries()) {
    // A rubrica (critérios e cláusulas PARCIAL e NÃO) confere as sugestões: a que repete
    // uma exigência de critério ATENDE vira falta daquele critério.
    const normalizada = normalizarAvaliacaoMeta(av, criterios.length, { pendencias: manifesto.pendencias, pendenciasOnde: manifesto.pendenciasOnde, stepsPosteriores, peca, rubrica: { criterios, qualityCriteria }, contrato, anterior, fontesFalharam: manifesto.fontesFalharam });
    if (normalizada.erros.length) { recusar(arquivo, normalizada.erros); continue; }
    for (const aviso of normalizada.avisos || []) avisos.push(`${basename(arquivo)}: ${aviso}`);
    // Formato não vira nota: campo obrigatório que o código não deriva da evidência devolve a
    // avaliação ao avaliador (uma vez). Depois de refeita, a que segue fora do formato sai do
    // consenso como ilegível e vai a um avaliador em contexto fresco.
    const fora = normalizada.fora_do_formato || [];
    if (fora.length && dispensados.has(arquivo)) { avisos.push(`${basename(arquivo)}: voz substituída por redespacho, fora do formato; dispensada`); continue; }
    if (fora.length) {
      const item = { arquivo, avaliador: Number.isInteger(av.avaliador) ? av.avaliador : i + 1, faltam: fora };
      if (formatoRefeito || refeitos.has(arquivo)) invalidas.push({ arquivo, erros: fora.map((f) => `fora do formato depois de refeita: C${f.n}${f.exigencia ? ` "${f.exigencia}"` : ''} sem ${f.campos.join(', ')}`) });
      else refazer.push(item);
      continue;
    }
    validas.push({ arquivo, ...normalizada });
  }
  // Em cada cadeia, o voto válido mais recente é o da voz; os anteriores (da voz que caiu e voltou)
  // são tardios. A cadeia sem voto válido, com a última voz sem arquivo, pede o redespacho dela.
  if (registro) {
    for (const [cadeia, membros] of cadeias) {
      const daCadeia = validas.filter((v) => cadeiaDoArquivo.get(v.arquivo) === cadeia);
      if (!daCadeia.length) {
        const ultima = membros[membros.length - 1];
        if (!faltandoNoRegistro.includes(ultima.arquivo) && !existsSync(resolve(raizDoRegistro, ultima.arquivo)) && !invalidas.some((x) => x.arquivo === resolve(raizDoRegistro, ultima.arquivo)) && !refazer.some((x) => cadeiaDoArquivo.get(x.arquivo) === cadeia)) {
          invalidas.push({ arquivo: ultima.arquivo, erros: ['voz despachada sem voto gravado: entregue o retorno do avaliador ao código (meta-voto --voz <voz> --retorno <arquivo>), ou redespache a voz (meta-despacho --redespachar <voz>)'] });
        }
        continue;
      }
      const ordem = (v) => membros.findIndex((sd) => resolve(raizDoRegistro, sd.arquivo) === v.arquivo);
      const principal = daCadeia.reduce((a, b) => (ordem(b) > ordem(a) ? b : a));
      for (const v of daCadeia) if (v !== principal) v.tardio = true;
      // A cadeia já tem voto: o retorno ilegível da última voz dela não pede outro redespacho.
      const ultima = resolve(raizDoRegistro, membros[membros.length - 1].arquivo);
      const k = invalidas.findIndex((x) => x.arquivo === ultima);
      if (k >= 0) { avisos.push(`${basename(ultima)}: sem voto válido (${invalidas[k].erros[0]}), mas a voz já tem voto na cadeia (${basename(principal.arquivo)})`); invalidas.splice(k, 1); }
    }
  }
  if (!invalidas.length && refazer.length) {
    // A lista `faltam` vai DENTRO do prompt que o código gera para a voz (o despacho dela mais a
    // seção do refazer), e o chefe só repassa a frase de despacho. Medido no m2b da 0.9.81 (rodada
    // r2-1): o chefe passou a lista, os três avaliadores a copiaram em `texto_extra`, como o despacho
    // manda, e o mesmo consenso descartou os votos como contaminados: a rodada não combinava.
    if (registro) {
      const metaDir = join(dir, 'output', runDaMeta.runId, '_meta');
      const promptBase = readFileSync(resolve(raizDoRegistro, registro.prompt), 'utf-8');
      for (const item of refazer) {
        const sd = saidaDoArquivo.get(item.arquivo);
        if (!sd) continue;
        const arq = join(metaDir, `meta-despacho-${registro.rodada}-refazer-${sd.voz}.md`);
        writeFileSync(arq, `${promptBase}\n${secaoDoRefazer(item.faltam)}`, 'utf-8');
        sd.refazer = { prompt: relative(raizDoRegistro, arq).replace(/\\/g, '/'), criado_em: now(), faltam: item.faltam };
        Object.assign(item, { voz: sd.voz, prompt: arq, prompt_do_task: fraseDoDespacho({ ...registro, prompt: sd.refazer.prompt }, sd.voz, raizDoRegistro), gravar: comandoDoVoto(dir, registro.rodada, sd.voz) });
      }
      const { arquivo: arqDoRegistro, ...gravar } = registro;
      writeFileSync(arqDoRegistro, `${JSON.stringify(gravar, null, 2)}\n`, 'utf-8');
    }
    emitirConsenso({
      acao: 'refazer-avaliacao',
      ...(registro ? { rodada: registro.rodada, despacho: registro.id } : {}),
      exigidos,
      recebidas: arquivos.length,
      validas: validas.length,
      refazer,
      detalhe: registro
        ? `${refazer.length} avaliação(ões) fora do formato: campo obrigatório ausente que a evidência não mostra. Não é falha da peça e não vira nota; nada foi combinado. Redespache UMA vez cada voz listada, em contexto fresco, com o prompt_do_task dela, literal e sem nada a mais: a lista \`faltam\` já está no prompt que o código gerou para a voz, e você não repassa nada. Entregue o retorno pelo comando \`gravar\` e rode meta-consenso --rodada ${registro.rodada} de novo`
        : `${refazer.length} avaliação(ões) fora do formato: campo obrigatório ausente que a evidência não mostra. Não é falha da peça e não vira nota; nada foi combinado. Redespache UMA vez cada avaliador listado, em contexto fresco, com a mesma lista fechada e a lista \`faltam\` (em cada exigência atendida: \`evidencia\` com trecho e \`local\`; no dado ausente: \`pendencia\` com o marcador literal de \`pendencias_do_profissional[]\`), grave no mesmo arquivo e rode de novo com --formato-refeito`,
    });
    process.exitCode = 1;
    return null;
  }
  const principais = validas.filter((v) => !v.tardio).length;
  if (invalidas.length || principais < exigidos) {
    const faltam = Math.max(0, exigidos - principais);
    emitirConsenso({
      acao: 'redespachar',
      exigidos,
      recebidas: arquivos.length,
      validas: validas.length,
      invalidas,
      ...(refazer.length ? { refazer } : {}),
      detalhe: invalidas.length
        ? `${invalidas.length} avaliação(ões) ilegível(is): redespache o avaliador em contexto fresco para cada uma; nada foi combinado${invalidas.some(formatoAntigoDoAvaliador) ? `. ${DICA_DO_FORMATO_DA_META}` : ''}`
        : `a rodada pede ${exigidos} avaliador(es) (o meta_verifiers do squad sob o teto do ritmo) e chegaram ${principais}: despache mais ${faltam} avaliador(es) em contexto fresco`,
    });
    process.exitCode = 1;
    return null;
  }
  const consenso = combinarMeta(validas, { criterios, regra: declarada.regra, exigidos });
  // O voto tardio que diverge do consenso num critério decidido por um voto de diferença pede uma
  // voz a mais, uma vez por rodada (o desempate): o que dois avaliadores mais demorados acharam
  // com evidência não some, nem decide sozinho.
  // Número par de votos (duas vozes no equilibrado, ou uma voz e o voto tardio dela no rápido)
  // dividido ao meio num critério é empate: o consenso conservador ficaria com o voto mais baixo, e
  // duas vozes julgariam mais duro que três (ou o tardio decidiria sozinho). O empate pede a voz de
  // desempate, a mesma do voto tardio da 0.9.82, uma vez por rodada; com ela, a maioria decide.
  if (registro && !registro.desempate) {
    const pts = { ATENDE: 2, PARCIAL: 1, NAO: 0 };
    const empatados = consenso.criterios.filter((c) => {
      const p = c.votos.map((v) => pts[v]).sort((a, b) => b - a);
      return p.length >= 2 && p.length % 2 === 0 && p[p.length / 2 - 1] !== p[p.length / 2];
    }).map((c) => ({ n: c.n, votos: c.votos, veredito: c.veredito }));
    if (empatados.length) {
      const comTardio = validas.some((v) => v.tardio);
      emitirConsenso({
        acao: 'desempatar',
        rodada: registro.rodada,
        criterios: empatados,
        detalhe: `${comTardio ? 'com o voto tardio (de voz que caiu e voltou depois do redespacho), os votos' : 'as duas vozes'} empatam em ${empatados.map((a) => `C${a.n}`).join(', ')}: despache uma voz de desempate (meta-despacho --desempate --rodada ${registro.rodada}), grave o retorno e rode meta-consenso --rodada ${registro.rodada} de novo; nada foi concluído`,
      });
      process.exitCode = 1;
      return null;
    }
  }
  if (registro && validas.some((v) => v.tardio) && !registro.desempate) {
    const pts = { ATENDE: 2, PARCIAL: 1, NAO: 0 };
    const apertados = [];
    for (const c of consenso.criterios) {
      const votos = c.votos.map((v) => pts[v]);
      const nivel = pts[c.veredito];
      for (const [k, v] of validas.entries()) {
        if (!v.tardio || votos[k] === nivel) continue;
        const corte = votos[k] < nivel ? nivel : votos[k];
        const acima = votos.filter((x) => x >= corte).length;
        const margem = Math.abs(acima - (votos.length - acima));
        if (margem <= 1 && !apertados.some((a) => a.n === c.n)) apertados.push({ n: c.n, votos: c.votos, veredito: c.veredito, tardio: basename(v.arquivo) });
      }
    }
    if (apertados.length) {
      emitirConsenso({
        acao: 'desempatar',
        rodada: registro.rodada,
        criterios: apertados,
        detalhe: `voto tardio (de voz que caiu e voltou depois do redespacho) diverge do consenso por um voto em ${apertados.map((a) => `C${a.n}`).join(', ')}: despache uma voz de desempate (meta-despacho --desempate --rodada ${registro.rodada}), grave o retorno e rode meta-consenso --rodada ${registro.rodada} de novo; nada foi concluído`,
      });
      process.exitCode = 1;
      return null;
    }
  }
  // A citação que o manifesto não traz não pesa na meta, mas não fica sem conferência: vai ao
  // verificador de citações antes da parada aprovação (motor leve, outubro de 2026).
  const foraDoManifesto = consenso.criterios.flatMap((c) => (c.nao_pesam || []).filter((f) => /^citacao-fora-do-manifesto/.test(f.nao_pesa || '')).map((f) => ({ criterio: c.n, exigencia: f.exigencia, evidencia: f.evidencia, avaliadores: f.avaliadores })));
  if (foraDoManifesto.length) avisos.push(`${foraDoManifesto.length} citação(ões) que os avaliadores acharam na final sem entrada no manifesto (\`citacoes_fora_do_manifesto\`): não pesam na meta, mas vão ao verificador-citacoes antes da parada aprovação`);
  emitirConsenso({
    ...(foraDoManifesto.length ? { citacoes_fora_do_manifesto: foraDoManifesto } : {}),
    acao: consenso.verdict === 'APROVADO' ? 'concluir' : 'apresentar-falhas',
    limiar_fonte: limiarFonte,
    avisos,
    arquivos: validas.map((v) => v.arquivo),
    ...(registro ? { rodada: registro.rodada, despacho: registro.id, tardios: validas.filter((v) => v.tardio).map((v) => v.arquivo) } : {}),
    manifesto: manifesto.caminho,
    // Só step de agente: a parada humana (checkpoint) não cumpre exigência nenhuma, e listá-la
    // aqui a oferecia como `posterior` válido (H7, medido em 25/09/2026 na reclamação).
    steps_posteriores: Array.isArray(stepsPosteriores) ? stepsDeAgentePosteriores(stepsPosteriores).map((st) => st.id) : stepsPosteriores,
    ...consenso,
  });
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

/**
 * Cada retomada fica no ledger (`retomadas[]`): o step em que o run estava e a hora. Sem isto a
 * premissa D4 (retomada volta ao step certo sem refazer o que estava pronto) não tinha como ser
 * conferida por código: o init com `--run` só trocava o `total`. O `init --run` logo depois de um
 * `reabrir` não é queda de sessão: sai com `motivo: 'reabertura'`.
 */
function retomadaDoRun(ledger) {
  const steps = Array.isArray(ledger.steps) ? ledger.steps : [];
  const ultimo = steps.length ? steps[steps.length - 1] : null;
  const reab = Array.isArray(ledger.reaberturas) && ledger.reaberturas.length ? ledger.reaberturas[ledger.reaberturas.length - 1] : null;
  const depoisDaReabertura = reab && reab.em && (!ultimo || !ultimo.startedAt || ultimo.startedAt < reab.em);
  return {
    em: now(),
    step: ledger.step?.current ?? null,
    ...(ultimo && ultimo.stepId ? { stepId: ultimo.stepId } : {}),
    motivo: depoisDaReabertura ? 'reabertura' : 'queda',
  };
}

// Dupla contagem na contingência e no cálculo: canônico em `src/dupla-contagem.js` (bloco
// `dupla-contagem`); o comando `dupla-contagem`, o `review-open` e o `manifesto-final` o usam.
// >>> dupla-contagem:begin
const semAcentoDaConta = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const NUMEROS_POR_EXTENSO = Object.freeze({ dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20 });
const NUMERO_DO_GRUPO = `(\\d{1,3}|${Object.keys(NUMEROS_POR_EXTENSO).join('|')})`;
const lerNumeroDoGrupo = (t) => (/^\d+$/.test(t) ? Number(t) : NUMEROS_POR_EXTENSO[t] || null);

/** Quem forma grupo numa contingência trabalhista ou cível: as pessoas que a linha multiplica. */
const PESSOAS_DO_GRUPO = '(?:ex-?empregad\\w*|empregad\\w*|representantes?|recontratad\\w*|pessoas?|trabalhador\\w*|operador\\w*|ex-?vendedor\\w*|vendedor\\w*|reclamantes?|autor\\w*|prestador\\w*|terceirizad\\w*|analistas?|motoristas?|funcionari\\w*|colaborador\\w*|socios?|clientes?|consumidor\\w*|segurad\\w*)';

/** A linha diz que a ação está dentro de um grupo de N ("perfil dos 6", "um dos seis", "entre os 16"). */
const DENTRO_DO_GRUPO = new RegExp(`\\b(?:perfil|um|uma|integrante|membro|parte)\\s+d[oa]s\\s+${NUMERO_DO_GRUPO}\\b|(?<!nao\\s(?:esta|estao)\\s)\\bentre\\s+os\\s+${NUMERO_DO_GRUPO}\\b`);
/** A linha diz que já tirou a sobreposição: só a parte própria, contado uma vez, não soma. */
const SOBREPOSICAO_TRATADA = /sem o autor|exceto o autor|menos o autor|sem a acao|parcelas? propri|so (?:a|as) (?:diferenc|parcela)|apenas (?:a|as) (?:diferenc|parcela)|nao soma|sem somar|nao somad|contad[oa] (?:como )?um d|contad[oa] uma vez|uma vez so|ja (?:esta |estao )?(?:incluid|contad|dentro)|excluid[oa] d[oa] linha|fora d[oa] linha|tirad[oa] d[oa] linha|descontad[oa] d[oa] grupo|nao entra|\(nao somar/;

/** Os números de processo da linha: o sequencial de sete dígitos do CNJ ("0010733" e "0010733-64.2026.5.03.0080"). */
function processosDaLinha(texto) {
  const out = new Set();
  for (const m of String(texto ?? '').matchAll(/\b(\d{7})(?:-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})?\b/g)) out.add(m[1]);
  return [...out];
}

/** Os valores em reais da linha, como texto ("231.967,68"), sem os zerados. */
function valoresDaLinha(texto) {
  return [...String(texto ?? '').matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((m) => m[1]).filter((v) => !/^0(?:\.0+)*,00$/.test(v) && v !== '0,00');
}

/** As linhas de tabela com valor, com a tabela a que pertencem e a chave do risco (a 1a coluna ou a coluna "R1"). */
function linhasDeValor(texto) {
  const linhas = String(texto ?? '').split('\n');
  const out = [];
  let tabela = 0;
  let dentro = false;
  linhas.forEach((l, i) => {
    if (!/^\s*\|.*\|\s*$/.test(l)) { dentro = false; return; }
    if (!dentro) { tabela += 1; dentro = true; }
    const celulas = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (celulas.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return;
    const valores = valoresDaLinha(l);
    if (!valores.length) return;
    // A chave do risco é o id de topo: "R5a" e "R5c" são o risco R5; "3.3a" e "3.1" são o risco 3.
    // Linha sem id de risco (tabela de recomendações, de processos) fica sem chave.
    const limpas = celulas.map((c) => c.replace(/\*\*/g, '').trim());
    const comR = limpas.find((c) => /^R\d{1,2}(?:[.\d]*[a-z]?)?(?=[\s:.,)-]|$)/i.test(c));
    const comNumero = /^\d{1,2}(?:\.\d+[a-z]?|[a-z])?(?=[\s:.)-]|$)/i.test(limpas[0] || '') && /\D/.test(limpas[0]) ? limpas[0] : null;
    const chave = comR ? comR.match(/^(R\d{1,2})/i)[1].toUpperCase() : comNumero ? comNumero.match(/^(\d{1,2})/)[1] : null;
    out.push({ linha: i + 1, tabela, chave, texto: l.trim(), valores, processos: processosDaLinha(l), n: semAcentoDaConta(l) });
  });
  return out;
}

const trechoDaConta = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > 180 ? `${s.slice(0, 179).trimEnd()}…` : s; };

/**
 * Os avisos de dupla contagem de um texto (contingência, cálculo ou a final): `{ tipo, gravidade:
 * 'alta', linhas, detalhe, fix }`. Três heurísticas: a mesma ação com valor em dois riscos da mesma
 * tabela; a ação que a própria linha põe dentro de um grupo de N somada por inteiro ao lado do
 * grupo, que não a desconta; e o valor bloqueado (ou depositado) pedido como retenção quando o mesmo
 * texto já o tira do caixa da dívida líquida.
 */
function duplaContagem(texto) {
  const avisos = [];
  const linhas = linhasDeValor(texto);
  const visto = new Set();
  // 1. A mesma ação em dois riscos da mesma tabela, as duas com valor.
  for (const proc of new Set(linhas.flatMap((l) => l.processos))) {
    const porTabela = new Map();
    for (const l of linhas.filter((x) => x.chave && x.processos.includes(proc) && !SOBREPOSICAO_TRATADA.test(x.n))) {
      if (!porTabela.has(l.tabela)) porTabela.set(l.tabela, []);
      porTabela.get(l.tabela).push(l);
    }
    for (const doMesmo of porTabela.values()) {
      const chaves = [...new Set(doMesmo.map((l) => l.chave))];
      if (chaves.length < 2) continue;
      const k = `acao:${proc}:${chaves.join('|')}`;
      if (visto.has(k)) continue;
      visto.add(k);
      avisos.push({
        tipo: 'mesma-acao-em-dois-riscos', gravidade: 'alta', processo: proc, linhas: doMesmo.map((l) => l.linha),
        detalhe: `a ação ${proc} tem valor em ${chaves.length} riscos da mesma tabela (${chaves.join(', ')}; linhas ${doMesmo.map((l) => l.linha).join(', ')}), sem dizer que uma linha não soma`,
        fix: `alta: possível dupla contagem: a ação ${proc} tem valor em dois riscos da mesma tabela (linhas ${doMesmo.map((l) => l.linha).join(', ')}); some-a uma vez só, ou diga na linha que a outra não soma, e confira os totais`,
      });
    }
  }
  // 2. A ação dentro de um grupo de N, somada por inteiro ao lado da linha do grupo.
  for (const l of linhas) {
    const m = l.n.match(DENTRO_DO_GRUPO);
    if (!m || !l.processos.length || SOBREPOSICAO_TRATADA.test(l.n)) continue;
    const n = lerNumeroDoGrupo(m[1] || m[2]);
    if (!n || n < 2) continue;
    const grupo = new RegExp(`(?:^|[^\\d.,])(?:${n}|${Object.keys(NUMEROS_POR_EXTENSO).filter((p) => NUMEROS_POR_EXTENSO[p] === n).join('|') || n})\\s+${PESSOAS_DO_GRUPO}`);
    const doGrupo = linhas.filter((g) => g !== l && grupo.test(g.n) && !l.processos.some((p) => g.processos.includes(p)) && !/\bautor\b|\breclamante\b/.test(g.n) && !SOBREPOSICAO_TRATADA.test(g.n));
    if (!doGrupo.length) continue;
    const k = `grupo:${l.processos[0]}:${n}`;
    if (visto.has(k)) continue;
    visto.add(k);
    avisos.push({
      tipo: 'acao-dentro-do-grupo', gravidade: 'alta', processo: l.processos[0], grupo: n, linhas: [l.linha, ...doGrupo.map((g) => g.linha)],
      detalhe: `a linha ${l.linha} soma a ação ${l.processos[0]} e diz que ela é do grupo de ${n} ("${trechoDaConta(m[0])}"), e a linha ${doGrupo[0].linha} soma o grupo de ${n} sem descontá-la: "${trechoDaConta(doGrupo[0].texto)}"`,
      fix: `alta: possível dupla contagem: a ação ${l.processos[0]} (linha ${l.linha}) é de uma das ${n} pessoas que a linha ${doGrupo[0].linha} já soma; conte o autor dentro do grupo (e a ação só pelas parcelas próprias), ou diga, com o documento, que ele está fora do grupo, e refaça os totais`,
    });
  }
  // 3. O valor bloqueado tirado do caixa da dívida líquida e pedido de novo como retenção. Frase a
  // frase: o valor é o do bloqueio quando aparece colado à palavra, e é o da retenção quando vem logo
  // depois dela (até 120 caracteres); a frase que diz que a retenção é o que passa do bloqueio, ou
  // que a retém "sem os R$ X bloqueados", não conta.
  const BLOQUEIO = /\b(?:bloque\w*|constri\w*|constrit\w*|penhor\w*|deposit\w* judicia\w*|deposito recursal)\b/g;
  const RETENCAO = /\b(?:retenc\w*|retid\w*|reter|conta vinculada|escrow)\b/g;
  const RETENCAO_ALEM = /alem do (?:valor )?(?:bloque|constri)|\b(?:sem|menos|descontad\w*|deduzid\w*|abatid\w*|exclu\w*)\s+(?:(?:o|os|a|as)\s+)?(?:r\$ ?[\d.,]+ )?(?:valor(?:es)? )?(?:bloque|constri)|(?:debito|saldo) que faltar|liquid\w* do bloque/;
  const frases = [];
  String(texto ?? '').split('\n').forEach((l, i) => { for (const f of l.split(/(?<=[.;])\s+(?=\S)/)) frases.push({ linha: i + 1, texto: f, n: semAcentoDaConta(f) }); });
  // O valor é do bloqueio quando a palavra está colada a ele, sem outro valor no meio: logo antes
  // ("o bloqueio de R$ X") ou logo depois ("R$ X bloqueados"). A palavra depois de um valor e antes
  // do seguinte qualifica o primeiro, não o segundo.
  const perto = (f, re) => {
    const out = [];
    let fimDoAnterior = 0;
    for (const m of f.texto.matchAll(/R\$\s*([\d.]+,\d{2})/g)) {
      const antes = f.texto.slice(Math.max(fimDoAnterior, m.index - 40), m.index);
      fimDoAnterior = m.index + m[0].length;
      const depois = f.texto.slice(m.index + m[0].length, m.index + m[0].length + 30).split('R$')[0];
      re.lastIndex = 0;
      const a = re.test(semAcentoDaConta(antes));
      re.lastIndex = 0;
      if (a || re.test(semAcentoDaConta(depois))) out.push(m[1]);
    }
    return out;
  };
  // A frase do caixa que já diz que o valor não volta na retenção resolve a sobreposição.
  const caixa = frases.find((f) => { BLOQUEIO.lastIndex = 0; return BLOQUEIO.test(f.n) && /divida liquida/.test(f.n); });
  const resolvido = frases.some((f) => /divida liquida/.test(f.n) && /sem (?:o )?contar de novo|nao (?:somar|contar) de novo|nao (?:volta|entra) (?:de novo )?na retenc/.test(f.n));
  if (caixa && !resolvido) {
    const bloqueados = new Set(frases.flatMap((f) => perto(f, BLOQUEIO)));
    for (const f of frases) {
      RETENCAO.lastIndex = 0;
      if (!RETENCAO.test(f.n) || RETENCAO_ALEM.test(f.n)) continue;
      const retidos = [];
      for (const m of f.texto.matchAll(/R\$\s*([\d.]+,\d{2})/g)) {
        const antes = semAcentoDaConta(f.texto.slice(Math.max(0, m.index - 120), m.index));
        RETENCAO.lastIndex = 0;
        if (RETENCAO.test(antes)) retidos.push(m[1]);
      }
      const v = retidos.find((x) => bloqueados.has(x));
      if (!v || visto.has(`bloqueio:${v}`)) continue;
      visto.add(`bloqueio:${v}`);
      avisos.push({
        tipo: 'bloqueio-descontado-duas-vezes', gravidade: 'alta', valor: v, linhas: [f.linha, caixa.linha],
        detalhe: `o valor bloqueado R$ ${v} sai do caixa da dívida líquida (linha ${caixa.linha}) e é pedido de novo como retenção (linha ${f.linha}): o mesmo valor descontado duas vezes do preço`,
        fix: `alta: possível dupla contagem: o bloqueio de R$ ${v} já sai do caixa na dívida líquida (linha ${caixa.linha}) e volta como retenção (linha ${f.linha}); a retenção é o débito além do bloqueio, ou o bloqueio fica no caixa, e o texto diz qual`,
      });
    }
  }
  return avisos;
}
// <<< dupla-contagem:end

// Red-team que muda a peça: canônico em `src/red-team.js` (bloco `red-team`, sincronizado por
// `sync-blocos`); o comando `red-team`, mais abaixo, registra o retorno e a decisão no ledger.
// >>> red-team:begin
/** O que não fazer custa, por natureza do ataque, dito ao profissional na parada aprovação. */
const CUSTO_DE_NAO_CORRIGIR = Object.freeze({
  fato: 'a conclusão que depende desse fato fica exposta: quem está do outro lado aponta a prova que falta ou a que contradiz, e o ponto pode cair ou perder valor',
  direito: 'a tese fica sem resposta à leitura contrária: se ela prevalecer, o ponto cai, e com ele o valor, o pedido ou a recomendação que dependem dele',
  forma: 'o pressuposto (competência, prazo, legitimidade, preço ou garantia) pode derrubar, adiar ou encarecer o resultado inteiro sem chegar ao mérito',
  outra: 'o ataque fica sem resposta na entrega, e quem decide do outro lado o usa contra ela',
});

/** As opções da parada depois do red-team, na ordem: corrigir primeiro quando há ataque sem resposta. */
const OPCOES_DEPOIS_DO_RED_TEAM = Object.freeze({
  corrigir: ['Corrigir antes de aprovar (recomendado)', 'Aprovar e seguir', 'Ajustar (diga o quê)', 'Parar aqui'],
  aprovar: ['Aprovar e seguir', 'Ajustar (diga o quê)', 'Parar aqui'],
});

const semAcentoDoRedTeam = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const celulasDoRedTeam = (linha) => linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** A natureza do ataque pela célula ("FATO", "FORMA (preço e retenção)"). */
function naturezaDoAtaque(celula) {
  const n = semAcentoDoRedTeam(celula);
  if (/\bfato\b/.test(n)) return 'fato';
  if (/\bdireito\b/.test(n)) return 'direito';
  if (/\bforma\b/.test(n)) return 'forma';
  return 'outra';
}

/**
 * O estado do ataque: `descoberto`, `insuficiente` (antecipado com resposta insuficiente, parcial ou
 * fraca), `antecipado` ou `a-responder` (pré-mortem). Lê a célula do estado e, para a suficiência da
 * resposta, também a do lugar na peça ("ANTECIPADO | II.b | resposta insuficiente: ...").
 */
function estadoDoAtaque(estado, onde = '') {
  const e = semAcentoDoRedTeam(estado);
  const o = semAcentoDoRedTeam(onde);
  if (/\bdescoberto\b/.test(e)) return 'descoberto';
  if (/\ba responder\b/.test(e)) return 'a-responder';
  if (/\bantecipad/.test(e)) return /insuficient|parcial|fraca|incomplet/.test(`${e} ${o}`) ? 'insuficiente' : 'antecipado';
  return null;
}

/**
 * Os ataques da tabela do contraditor, na ordem: `{ n, natureza, estado, ataque, onde, fix }`. As
 * colunas vêm do cabeçalho (Natureza, Ataque, Estado, Onde, Fix); sem cabeçalho reconhecível, a
 * célula com DESCOBERTO ou ANTECIPADO é o estado e a primeira é a natureza.
 */
function ataquesDoContraditor(texto) {
  const linhas = String(texto ?? '').split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  const ataques = [];
  let col = null;
  for (const linha of linhas) {
    const c = celulasDoRedTeam(linha);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue;
    const n = c.map(semAcentoDoRedTeam);
    if (n.some((x) => /^natureza\b/.test(x)) && n.some((x) => /^estado\b/.test(x))) {
      col = {
        natureza: n.findIndex((x) => /^natureza\b/.test(x)),
        ataque: n.findIndex((x) => /^ataque\b/.test(x)),
        estado: n.findIndex((x) => /^estado\b/.test(x)),
        onde: n.findIndex((x) => /^onde\b|o que falta/.test(x)),
        fix: n.findIndex((x) => /^fix\b/.test(x)),
      };
      continue;
    }
    const iEstado = col ? col.estado : n.findIndex((x) => /\b(?:descoberto|antecipad|a responder)\b/.test(x));
    if (iEstado < 0 || c[iEstado] === undefined) continue;
    const onde = col && col.onde >= 0 ? c[col.onde] || '' : c[iEstado + 1] || '';
    const estado = estadoDoAtaque(c[iEstado], onde);
    if (!estado) continue;
    const pega = (k, padrao) => (col && col[k] >= 0 ? c[col[k]] || '' : padrao);
    ataques.push({
      n: ataques.length + 1,
      natureza: naturezaDoAtaque(pega('natureza', c[0])),
      estado,
      ataque: pega('ataque', c[1] || '').replace(/^["“]|["”]$/g, '').trim(),
      onde: onde.trim(),
      fix: pega('fix', '').trim(),
    });
  }
  return ataques;
}

/** Ataque que a peça não responde: descoberto, ou antecipado com resposta insuficiente. */
const ataqueSemResposta = (a) => a && (a.estado === 'descoberto' || a.estado === 'insuficiente');

const cortarDoRedTeam = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

/**
 * A oferta da parada aprovação depois do red-team: cada ataque com o custo de não corrigir, a
 * recomendação (`corrigir` quando há ataque sem resposta) e as opções, nesta ordem.
 */
function ofertaDoRedTeam(ataques) {
  const lista = Array.isArray(ataques) ? ataques : [];
  const semResposta = lista.filter(ataqueSemResposta);
  const recomendacao = semResposta.length ? 'corrigir' : 'aprovar';
  return {
    recomendacao,
    opcoes: [...OPCOES_DEPOIS_DO_RED_TEAM[recomendacao]],
    sem_resposta: semResposta.length,
    ataques: lista.map((a) => ({
      n: a.n,
      natureza: a.natureza,
      estado: a.estado,
      ataque: cortarDoRedTeam(a.ataque, 400),
      ...(a.onde ? { o_que_falta: cortarDoRedTeam(a.onde, 400) } : {}),
      ...(ataqueSemResposta(a) ? { custo_de_nao_corrigir: CUSTO_DE_NAO_CORRIGIR[a.natureza] || CUSTO_DE_NAO_CORRIGIR.outra } : {}),
    })),
  };
}

/** O fix de origem humana que o ataque sem resposta vira, para a redação: gravidade alta. */
function fixDoAtaque(a) {
  const natureza = String(a.natureza || 'outra').toUpperCase();
  const estado = a.estado === 'insuficiente' ? 'antecipado com resposta insuficiente' : 'descoberto';
  const falta = a.fix || a.onde;
  return `alta: red-team, ataque de ${natureza} ${estado}: ${cortarDoRedTeam(a.ataque, 500)}${falta ? ` O que a peça precisa responder: ${cortarDoRedTeam(falta, 500)}` : ''}`;
}
// <<< red-team:end

const TIPOS_FORA_DO_FLUXO = Object.freeze(['pergunta', 'correcao', 'pedido-novo']);

/**
 * O pedido do profissional no meio do run (runner, "Pedido fora do fluxo"), registrado no ledger:
 * o tipo que o chefe classificou, meia linha do que foi pedido e o step em que o run estava. É o
 * rastro que o RELATORIO.md promete e que o auditor das premissas confere (E2 a E4): a correção
 * tem de ser seguida de laço de revisão, e o pedido novo não pode virar step enxertado.
 */
function cmdForaDoFluxo(dir, flags) {
  const tipo = str(flags.tipo).trim();
  if (!TIPOS_FORA_DO_FLUXO.includes(tipo)) die(`fora-do-fluxo requer --tipo ${TIPOS_FORA_DO_FLUXO.join('|')}`);
  const resumo = str(flags.resumo).trim();
  if (!resumo) die('fora-do-fluxo requer --resumo "<meia linha do que o profissional pediu, sem dado do caso>"');
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('fora-do-fluxo requer um run aberto (squad-state init)');
  const ultimo = Array.isArray(ledger.steps) && ledger.steps.length ? ledger.steps[ledger.steps.length - 1] : null;
  const entrada = { tipo, resumo: resumo.slice(0, 200), em: now(), step: ledger.step?.current ?? null, ...(ultimo && ultimo.stepId ? { stepId: ultimo.stepId } : {}) };
  // A correção antes da redação vira fix pendente, entregue pelo `step` da redação; depois que a
  // redação começou, a correção segue como revisão (gate-open). O pedido novo fica pendente até
  // ser oferecido na entrega (`pedidos-novos --oferecidos`).
  if (flags.fix !== undefined) {
    const fix = str(flags.fix).trim();
    if (tipo !== 'correcao' || !fix) die('fora-do-fluxo: --fix "<a correção, como o redator a aplica>" vai só com --tipo correcao');
    const redacao = stepsDeRedacao(dir);
    if (!redacao.length) die('fora-do-fluxo --fix: o pipeline.yaml não tem step de redação (on_reject); a correção vai como revisão (gate-open)');
    const comecou = (ledger.steps || []).find((e) => redacao.includes(e.stepId));
    if (comecou) die(`fora-do-fluxo --fix: a redação (${comecou.stepId}) já começou; a correção depois da redação vai como revisão: gate-open --gate revisao --target ${comecou.stepId}`);
    // A correção vai inteira: o corte em 400 caracteres partia a palavra no meio, e o
    // `fixes_pendentes` e o contrato de redação repetiam o corte (m6, m3 e m4 da medição).
    Object.assign(entrada, { fix, pendente: true, para: redacao[0] });
  }
  if (tipo === 'pedido-novo') entrada.pendente = true;
  writeJson(dir, RUN_LEDGER, { ...ledger, fora_do_fluxo: [...(Array.isArray(ledger.fora_do_fluxo) ? ledger.fora_do_fluxo : []), entrada], updatedAt: now() });
  console.log(JSON.stringify({ registrado: entrada, total: (ledger.fora_do_fluxo || []).length + 1 }, null, 2));
  return null;
}

/** Os steps de agente do pipeline em blocos: `{ id, agente, tipo, saidas, on_reject }`. */
function blocosDoPipeline(dir) {
  const p = join(dir, 'pipeline', 'pipeline.yaml');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split(/^(?=[ \t]*-[ \t]+id:)/m).map((b) => ({
    id: (b.match(/^[ \t]*-[ \t]+id:[ \t]*["']?([\w.-]+)/m) || [])[1] || null,
    agente: (b.match(/^[ \t]+agent:[ \t]*["']?([\w.-]+)/m) || [])[1] || '',
    tipo: (b.match(/^[ \t]+type:[ \t]*["']?([\w-]+)/m) || [])[1] || '',
    on_reject: (b.match(/^[ \t]+on_reject:[ \t]*["']?([\w.-]+)/m) || [])[1] || null,
    saidas: [...b.matchAll(/^[ \t]+-[ \t]+["']?([^\s"']+\.[a-z0-9]+)["']?[ \t]*$/gim)].map((m) => m[1]).filter((x) => x.includes('/')),
  })).filter((x) => x.id);
}

/** O squad declara cálculo: um step de agente da calculista, da contingência ou da liquidação. */
const PASSO_DE_CALCULO = /calcul|conting|liquida/i;
function passosDeCalculo(dir) {
  return blocosDoPipeline(dir).filter((b) => b.tipo !== 'checkpoint' && PASSO_DE_CALCULO.test(`${b.id} ${b.agente}`));
}

/**
 * Os arquivos que a conferência de dupla contagem lê: a saída mais recente de cada step de cálculo
 * e, com `comPeca`, a da redação (a minuta, ou a final quando ela é mais nova).
 */
function arquivosDeContagem(dir, { comPeca = true } = {}) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) return [];
  const runDir = join(dir, 'output', ledger.runId);
  const out = [];
  const add = (c) => { if (c && existsSync(c) && !out.includes(c)) out.push(c); };
  for (const b of passosDeCalculo(dir)) for (const sub of b.saidas) add(maisRecenteNoRun(runDir, sub));
  if (comPeca) {
    const redacao = new Set(blocosDoPipeline(dir).map((b) => b.on_reject).filter(Boolean));
    for (const b of blocosDoPipeline(dir).filter((x) => redacao.has(x.id))) for (const sub of b.saidas) add(maisRecenteNoRun(runDir, sub));
  }
  return out;
}

/** Os avisos de dupla contagem dos arquivos, com o arquivo (relativo à raiz) em cada um. */
function avisosDeDuplaContagem(dir, arquivos) {
  const raiz = resolve(dir, '..', '..');
  return arquivos.flatMap((a) => duplaContagem(readFileSync(a, 'utf-8')).map((x) => ({ arquivo: relative(raiz, a).replace(/\\/g, '/'), ...x })));
}

/**
 * `dupla-contagem <squad-dir> [--arquivo <md> ...]`: o mesmo risco, a mesma pessoa ou a mesma ação
 * somada em duas linhas, e o valor bloqueado descontado duas vezes (dívida líquida e retenção).
 * Sem `--arquivo`, a saída mais recente dos steps de cálculo e da redação. É aviso de gravidade
 * alta, nunca recusa (sai 0): o `review-open` o leva ao revisor e o `manifesto-final`, ao conferente.
 * Medido na avaliação cega da due diligence: a ação de vínculo somada por inteiro em cima do grupo
 * que a contém custou a nota mais baixa (82).
 */
function cmdDuplaContagem(dir, flags) {
  const pedidos = asList(flags.arquivo).filter((v) => typeof v === 'string').map((a) => (isAbsolute(a) ? a : resolve(a)));
  for (const a of pedidos) if (!existsSync(a)) die(`dupla-contagem --arquivo: não encontrado: ${a}`);
  const arquivos = pedidos.length ? pedidos : arquivosDeContagem(dir);
  const avisos = avisosDeDuplaContagem(dir, arquivos);
  console.log(JSON.stringify({
    arquivos: arquivos.map((a) => relative(resolve(dir, '..', '..'), a).replace(/\\/g, '/')),
    avisos,
    detail: avisos.length
      ? `${avisos.length} possível(is) dupla(s) contagem(ns), gravidade alta: o revisor e o conferente as conferem, e cada uma confirmada volta à calculista ou à redação como fix (\`fix\` de cada aviso)`
      : arquivos.length ? 'nenhuma dupla contagem achada pelas heurísticas (ação em dois riscos, ação dentro do grupo, bloqueio na dívida líquida e na retenção)' : 'nenhum arquivo de cálculo ou de redação no run',
  }, null, 2));
  return null;
}

/**
 * O step de revisão do pipeline (o que tem `on_reject`), com o alvo e o teto declarados: é o laço
 * em que o fix de origem humana entra (red-team, correção depois da redação).
 */
function passoDeRevisao(dir) {
  const p = join(dir, 'pipeline', 'pipeline.yaml');
  if (!existsSync(p)) return null;
  const blocos = readFileSync(p, 'utf-8').split(/^(?=[ \t]*-[ \t]+id:)/m);
  for (const b of blocos) {
    const alvo = b.match(/^[ \t]+on_reject:[ \t]*["']?([\w.-]+)/m);
    if (!alvo) continue;
    const id = (b.match(/^[ \t]*-[ \t]+id:[ \t]*["']?([\w.-]+)/m) || [])[1];
    const max = Number((b.match(/^[ \t]+max_review_cycles:[ \t]*["']?(\d+)/m) || [])[1]);
    if (id) return { loop: id, target: alvo[1], max: Number.isInteger(max) && max > 0 ? max : null };
  }
  return null;
}

const DECISOES_DO_RED_TEAM = Object.freeze(['corrigir', 'seguir', 'ajustar', 'parar']);

/**
 * `red-team <squad-dir> --retorno <arquivo>`: lê a tabela do contraditor (o retorno, gravado como
 * veio), registra no ledger do run o que ele achou e devolve a oferta da parada aprovação: cada
 * ataque com o custo de não corrigir e, havendo ataque DESCOBERTO ou antecipado com resposta
 * insuficiente, "Corrigir antes de aprovar" como primeira opção, recomendada.
 * `red-team <squad-dir> --decisao corrigir|seguir|ajustar|parar --resposta "<literal>"`: grava a
 * escolha e o que foi feito com cada ataque. Com `corrigir`, cada ataque sem resposta vira fix de
 * origem humana no laço de revisão (o ciclo do profissional não gasta o teto do revisor, regra da
 * 0.9.80) e a decisão do laço vai na saída: `revise`, de volta à redação, e os gates de sempre.
 * Medido no m2g da 0.9.83: dois ataques descobertos e um mal respondido, "Aprovar e seguir" em
 * primeiro lugar sem custo dito, e a peça não mudou.
 */
function cmdRedTeam(dir, flags) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('red-team requer um run aberto (squad-state init)');
  const raiz = resolve(dir, '..', '..');
  if (typeof flags.retorno === 'string') {
    const arquivo = isAbsolute(flags.retorno) ? flags.retorno : resolve(flags.retorno);
    if (!existsSync(arquivo)) die(`red-team --retorno: arquivo não encontrado: ${arquivo}`);
    const ataques = ataquesDoContraditor(readFileSync(arquivo, 'utf-8'));
    if (!ataques.length) die('red-team --retorno: nenhum ataque na tabela do contraditor (colunas Natureza e Estado, com DESCOBERTO ou ANTECIPADO); grave o retorno como veio e rode de novo');
    const oferta = ofertaDoRedTeam(ataques);
    const em = now();
    const registro = {
      em,
      arquivo: relative(raiz, arquivo).replace(/\\/g, '/'),
      ataques: oferta.ataques.map((a) => ({ n: a.n, natureza: a.natureza, estado: a.estado, resumo: String(a.ataque).slice(0, 200) })),
      recomendacao: oferta.recomendacao,
      decisao: null,
    };
    atualizarRunLedger(dir, (l) => ({ ...l, red_team: registro, ...(l.red_team ? { red_team_anteriores: [...(Array.isArray(l.red_team_anteriores) ? l.red_team_anteriores : []), l.red_team] } : {}) }));
    console.log(JSON.stringify({
      ...oferta,
      registrado_em: em,
      detail: oferta.recomendacao === 'corrigir'
        ? `${oferta.sem_resposta} ataque(s) sem resposta na peça: mostre cada um com o custo de não corrigir e reapresente a parada com as opções nesta ordem, "Corrigir antes de aprovar" recomendada; grave a escolha com red-team --decisao`
        : 'a peça antecipa os três ataques: reapresente a parada com as opções de sempre e grave a escolha com red-team --decisao',
    }, null, 2));
    return null;
  }
  const decisao = str(flags.decisao).trim();
  if (!DECISOES_DO_RED_TEAM.includes(decisao)) die(`red-team: passe --retorno <arquivo do contraditor> ou --decisao ${DECISOES_DO_RED_TEAM.join('|')}`);
  const resposta = str(flags.resposta).trim();
  if (!resposta) die('red-team --decisao: falta --resposta "<a resposta do profissional, literal>"');
  const rt = ledger.red_team;
  if (!rt || !Array.isArray(rt.ataques)) die('red-team --decisao: o retorno do contraditor não foi registrado neste run (red-team --retorno <arquivo> antes)');
  if (rt.decisao) die(`red-team --decisao: a decisão já foi gravada (${rt.decisao.decisao}, ${rt.decisao.em}); o red-team roda uma vez por run`);
  const em = now();
  const semResposta = rt.ataques.filter(ataqueSemResposta);
  const destino = (a) => (!ataqueSemResposta(a) ? 'antecipado' : decisao === 'corrigir' ? 'fix' : decisao === 'seguir' ? 'ressalva' : decisao);
  let decisaoDoLaco = null;
  let fixes = [];
  if (decisao === 'corrigir' && semResposta.length) {
    const passo = passoDeRevisao(dir);
    if (!passo) die('red-team --decisao corrigir: o pipeline.yaml não tem step de revisão (on_reject): não há laço para o fix humano');
    // O retorno do contraditor guardado no ledger traz só o resumo; o fix sai da tabela inteira.
    const tabela = existsSync(resolve(raiz, rt.arquivo)) ? ataquesDoContraditor(readFileSync(resolve(raiz, rt.arquivo), 'utf-8')) : [];
    fixes = semResposta.map((a) => fixDoAtaque(tabela.find((t) => t.n === a.n) || { ...a, ataque: a.resumo }));
    let laco = loadLedger(dir, GATE_PADRAO);
    if (!laco || laco.status !== 'open') {
      arquivarLaco(dir, GATE_PADRAO);
      const max = tetoDoPerfil(dir, 'max_review_cycles', passo.max || DEFAULT_MAX_REVIEW_CYCLES, `teto de ciclos do gate "${GATE_PADRAO}"`);
      laco = { ...openReview({ loop: passo.loop, target: passo.target, maxCycles: max }), aberto_em: em };
      saveLedger(dir, GATE_PADRAO, laco);
    }
    const entry = { reviewer: 'profissional', verdict: 'REJECT', fixes, ajustes: [], em, origem: 'humana' };
    const recusa = recusaDeVeredito(laco, entry);
    if (recusa) die(`red-team --decisao corrigir: o laço de revisão recusou o fix humano (${recusa.detail})`);
    const { ledger: novo, result } = applyVerdict(laco, entry, { expect: 1, agora: em });
    saveLedger(dir, GATE_PADRAO, novo);
    decisaoDoLaco = { ...result, gate: GATE_PADRAO };
  }
  atualizarRunLedger(dir, (l) => ({
    ...l,
    red_team: {
      ...l.red_team,
      ataques: l.red_team.ataques.map((a) => ({ ...a, destino: destino(a) })),
      decisao: { decisao, resposta: resposta.slice(0, 400), em, ...(fixes.length ? { fixes: fixes.length } : {}) },
    },
  }));
  console.log(JSON.stringify({
    decisao,
    ataques: rt.ataques.map((a) => ({ n: a.n, natureza: a.natureza, estado: a.estado, destino: destino(a) })),
    ...(decisaoDoLaco ? { laco: decisaoDoLaco } : {}),
    detail: decisao === 'corrigir' && semResposta.length
      ? `${fixes.length} ataque(s) viraram fix de origem humana no laço de revisão (o ciclo do profissional não gasta o teto do revisor): volte à redação com a lista \`fixes\` do laço e siga os gates; a parada aprovação volta com a versão nova`
      : decisao === 'seguir' && semResposta.length
        ? `${semResposta.length} ataque(s) sem resposta aceitos pelo profissional como ressalva: registrados no ledger; diga-os no relatório do run`
        : 'decisão registrada',
  }, null, 2));
  return null;
}

/**
 * `anular-fora-do-fluxo <squad-dir> --indice N --motivo "<meia linha>"`: anula o registro N (1, 2,
 * ...: a ordem de `fora_do_fluxo[]` no ledger) gravado por engano, sem apagar. O registro fica com
 * `anulado: { em, motivo }` e deixa de valer: a correção não vai mais ao redator nem ao contrato de
 * redação, o pedido novo não é oferecido na entrega, e o auditor o mostra à parte. Medido no m2g da
 * 0.9.83: um `fora-do-fluxo` registrado por engano não tinha como sair, e o rastro do run mentia.
 */
function cmdAnularForaDoFluxo(dir, flags) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('anular-fora-do-fluxo requer um run aberto (squad-state init)');
  const fora = Array.isArray(ledger.fora_do_fluxo) ? ledger.fora_do_fluxo : [];
  const n = Number(str(flags.indice));
  if (!Number.isInteger(n) || n < 1) die(`anular-fora-do-fluxo requer --indice <1 a ${fora.length || 'N'}> (a ordem do registro em fora_do_fluxo[] do ledger)`);
  if (n > fora.length) die(`anular-fora-do-fluxo: o run tem ${fora.length} registro(s) fora do fluxo; --indice ${n} não existe`);
  const motivo = str(flags.motivo).trim();
  if (!motivo) die('anular-fora-do-fluxo requer --motivo "<meia linha do porquê, sem dado do caso>"');
  const alvo = fora[n - 1];
  if (alvo.anulado) die(`anular-fora-do-fluxo: o registro ${n} já foi anulado em ${alvo.anulado.em}`);
  if (alvo.entregue_em) console.error(`aviso: a correção ${n} já foi entregue à redação em ${alvo.entregue_em}; a anulação não desfaz a versão que a aplicou`);
  const em = now();
  const anulado = { ...alvo, pendente: false, anulado: { em, motivo: motivo.slice(0, 200) } };
  writeJson(dir, RUN_LEDGER, { ...ledger, fora_do_fluxo: fora.map((f, i) => (i === n - 1 ? anulado : f)), updatedAt: em });
  console.log(JSON.stringify({ anulado: { indice: n, tipo: alvo.tipo, resumo: alvo.resumo, em: alvo.em }, motivo: anulado.anulado.motivo, detail: 'o registro continua no ledger, marcado anulado; não vale para a redação, a entrega nem o auditor' }, null, 2));
  return null;
}

/**
 * A aprovação do desenho do Arquiteto (Phase G), gravada por código antes do Build: a resposta
 * literal do profissional, a hora e o hash do `_build/design.yaml` aprovado. Premissa B4
 * (revisoes/PREMISSAS-MOTOR-2026-10.md): no teste de ponta a ponta de 30/09/2026 a única prova era
 * um comentário "Aprovado na Phase G" que o próprio modelo escreveu no design. Uma nova aprovação
 * (o desenho mudou e foi reapresentado) guarda a anterior em `anteriores[]`.
 */
const APROVACAO_DO_DESIGN = ['_build', 'aprovacao-design.json'];

/**
 * O pedido novo que o profissional mandou deixar para depois (achado 26 do run de 01/10/2026): sem
 * isto nada lembrava o chefe de oferecê-lo ao fechar o run. Sem flag, lista os pendentes; com
 * `--oferecidos --resposta`, grava que foram oferecidos na entrega e o que o profissional respondeu.
 */
function cmdPedidosNovos(dir, flags) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('pedidos-novos: não há run aberto neste squad (squad-state init)');
  const fora = Array.isArray(ledger.fora_do_fluxo) ? ledger.fora_do_fluxo : [];
  const pendentes = fora.filter((f) => f.tipo === 'pedido-novo' && f.pendente);
  if (flags.oferecidos !== true) {
    console.log(JSON.stringify({ pendentes: pendentes.map((f) => ({ resumo: f.resumo, em: f.em })), detail: pendentes.length ? 'ofereça cada um ao profissional ao entregar o pacote (volta ao roteamento, nunca entra neste run) e grave com --oferecidos --resposta' : 'nenhum pedido novo pendente' }, null, 2));
    return null;
  }
  const resposta = str(flags.resposta).trim();
  if (!resposta) die('pedidos-novos --oferecidos: falta --resposta "<o que o profissional respondeu à oferta, literal>"');
  const em = now();
  writeJson(dir, RUN_LEDGER, { ...ledger, fora_do_fluxo: fora.map((f) => (pendentes.includes(f) ? { ...f, pendente: false, oferecido_em: em, resposta_oferta: resposta.slice(0, 400) } : f)), updatedAt: em });
  console.log(JSON.stringify({ oferecidos: pendentes.map((f) => f.resumo), em }, null, 2));
  return null;
}
function cmdAprovarDesign(dir, flags) {
  const resposta = str(flags.resposta).trim();
  if (!resposta) die('aprovar-design requer --resposta "<a resposta do profissional ao desenho, literal>"');
  const design = join(dir, '_build', 'design.yaml');
  if (!existsSync(design)) die(`aprovar-design: não há ${join(dir, '_build', 'design.yaml')}; a aprovação é do desenho que o Arquiteto apresentou`);
  const caminho = join(dir, ...APROVACAO_DO_DESIGN);
  let anterior;
  try { anterior = JSON.parse(readFileSync(caminho, 'utf-8')); } catch { anterior = null; }
  const registro = {
    resposta,
    em: now(),
    design_sha256: createHash('sha256').update(readFileSync(design)).digest('hex'),
    ...(anterior ? { anteriores: [...(Array.isArray(anterior.anteriores) ? anterior.anteriores : []), { resposta: anterior.resposta, em: anterior.em, design_sha256: anterior.design_sha256 }] } : {}),
  };
  const tmp = `${caminho}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registro, null, 2)}\n`, 'utf-8');
  renameSync(tmp, caminho);
  console.log(JSON.stringify({ gravado: join(...APROVACAO_DO_DESIGN), em: registro.em, design_sha256: registro.design_sha256, aprovacoes: (registro.anteriores || []).length + 1 }, null, 2));
  return null;
}

/**
 * Roteamento e Arquiteto, que acontecem antes do `init`, lidos do disco na abertura do run: as
 * horas do log do roteador, a do `_build/discovery.yaml` e a do último arquivo de definição do squad
 * (o fim do Build). A regra é `fasesAntesDoRun` (bloco fases-do-run); a leitura é esta.
 */
function fasesAntesDoRunNoDisco(dir, inicioIso) {
  const log = join(resolve(dir), '..', '..', '_legalsquad', 'logs', 'roteamento.jsonl');
  let entradas;
  try {
    entradas = readFileSync(log, 'utf-8').split('\n').map((l) => { try { return JSON.parse(l).ts; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
  const mtimeIso = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };
  const definicao = [];
  const varrer = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of readdirSync(p)) varrer(join(p, f)); return; }
    definicao.push(st.mtimeMs);
  };
  for (const parte of ['squad.yaml', 'squad-party.csv', 'agents', 'pipeline']) varrer(join(dir, parte));
  const inicio = Date.parse(inicioIso);
  const ate = definicao.filter((m) => m <= inicio).sort((a, b) => b - a)[0];
  return fasesAntesDoRun({ inicioDoRun: inicioIso, entradas, discoveryEm: mtimeIso(join(dir, '_build', 'discovery.yaml')), definicaoAte: Number.isFinite(ate) ? new Date(ate).toISOString() : null });
}

/** Tokens informados pelo chefe: `113245`, `113.245`, `113k`, `1,4M`. `null` sem valor; erro se ilegível. */
function lerTokens(valor, onde) {
  if (valor === undefined || valor === true) return null;
  const t = String(valor).trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d+(?:[.,]\d+)?)([km])?$/);
  if (!m) die(`${onde}: --tokens "${valor}" não é número (ex.: 113245, 113k, 1,4M)`);
  const sufixo = m[2];
  const numero = sufixo ? Number(m[1].replace(',', '.')) * (sufixo === 'k' ? 1e3 : 1e6) : Number(m[1].replace(/[.,]/g, ''));
  if (!Number.isFinite(numero) || numero < 0) die(`${onde}: --tokens "${valor}" não é número`);
  return Math.round(numero);
}

/** A fase do step aberto agora no ledger (o último registro sem fim), ou `outra`. */
function faseDoStepAberto(ledger) {
  const steps = ledger && Array.isArray(ledger.steps) ? ledger.steps : [];
  const ultimo = steps[steps.length - 1];
  if (!ultimo) return { fase: 'outra', stepId: null };
  return { fase: ultimo.fase || faseDoStep(ultimo), stepId: ultimo.stepId || null };
}

/**
 * Marca uma fase que não é step do pipeline (roteamento e Arquiteto registrados à mão, uma espera,
 * uma queda do serviço), com hora e, quando o chefe os tem, os tokens. `--inicio` e `--fim` aceitam
 * ISO para registrar depois do fato; sem `--fim`, a marca fica aberta e a próxima chamada com o
 * mesmo `--nome` e `--fim` a fecha.
 */
function cmdFase(dir, flags) {
  const nome = str(flags.nome).trim();
  if (!nome) die('fase requer --nome <fase> (a lista fechada das fases do run)');
  if (!faseValida(nome)) die(`fase: --nome "${nome}" fora da lista (${FASES_DO_RUN.join(', ')}, ou gate:<nome>[:<ciclo>])`);
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('fase requer um run aberto (squad-state init)');
  const hora = (v, rotulo) => {
    if (v === undefined) return null;
    const t = Date.parse(str(v));
    if (!Number.isFinite(t)) die(`fase: --${rotulo} "${str(v)}" não é data ISO`);
    return new Date(t).toISOString();
  };
  const inicio = hora(flags.inicio, 'inicio');
  const fim = flags.fim === true ? now() : hora(flags.fim, 'fim');
  const tokens = lerTokens(flags.tokens, 'fase');
  const fases = Array.isArray(ledger.fases) ? [...ledger.fases] : [];
  const aberta = !inicio ? fases.map((f, i) => [f, i]).reverse().find(([f]) => f.fase === nome && !f.fim) : null;
  let registro;
  if (aberta && fim) {
    registro = { ...aberta[0], fim, ...(tokens !== null ? { tokens } : {}) };
    fases[aberta[1]] = registro;
  } else {
    registro = { fase: nome, inicio: inicio || now(), ...(fim ? { fim } : {}), ...(tokens !== null ? { tokens } : {}), origem: 'chefe' };
    if (registro.fim && Date.parse(registro.fim) < Date.parse(registro.inicio)) die('fase: --fim antes do --inicio');
    fases.push(registro);
  }
  writeJson(dir, RUN_LEDGER, { ...ledger, fases, updatedAt: now() });
  console.log(JSON.stringify({ registrado: registro, total: fases.length }, null, 2));
  return null;
}

/**
 * O init de um run novo sobrescreve os ledgers da raiz, e o run-metricas e o auditor do run
 * anterior leem a cópia que fica na pasta dele (m1 e m4, 01/10/2026: o cleanup do chefe não
 * copiou o ledger da última reabertura, e as métricas misturaram os dois runs). Antes de
 * sobrescrever, o código guarda o ledger da raiz na pasta do run anterior, salvo se a cópia de lá
 * for mais nova. Sem pasta do run anterior, não há onde guardar e nada muda.
 */
function guardarLedgersDoRunAnterior(dir, anterior) {
  const pasta = join(dir, 'output', String(anterior.runId || ''));
  if (!anterior.runId || !existsSync(pasta)) return;
  const quando = (j) => Date.parse(j?.updatedAt || j?.endedAt || '') || 0;
  for (const nome of [RUN_LEDGER, LEDGER]) {
    const origem = join(dir, nome);
    if (!existsSync(origem)) continue;
    let daRaiz;
    try { daRaiz = JSON.parse(readFileSync(origem, 'utf-8')); } catch { continue; }
    if (nome === LEDGER && daRaiz && daRaiz.runId && daRaiz.runId !== anterior.runId) continue;
    const destino = join(pasta, nome);
    let guardado;
    try { guardado = JSON.parse(readFileSync(destino, 'utf-8')); } catch { guardado = null; }
    if (guardado && quando(guardado) > quando(daRaiz)) continue;
    writeFileSync(destino, `${JSON.stringify(daRaiz, null, 2)}\n`);
  }
}

const RESPOSTA_SIM = /^\s*(?:sim|pode(?:\s+abrir)?|abr[ae]|quero|ok|okay|confirmo|claro|isso|vamos|bora|manda|segue)\b/;
const RESPOSTA_NAO = /\b(?:nao|nem|espera|aguarda|depois|ainda nao|antes)\b|\?/;

/**
 * A recusa de reabrir por fato novo fica no ledger (`reabertura_recusada`); o init seguinte só
 * abre run novo com `--confirmacao "<resposta literal do profissional à pergunta de abrir um run
 * novo>"`, e a resposta tem de ser um sim sem ressalva nem pergunta de volta. Devolve o registro
 * para o ledger novo, ou null quando não havia recusa pendente.
 */
function confirmacaoDoRunNovo(anterior, confirmacao) {
  const recusa = anterior && anterior.reabertura_recusada;
  if (!recusa || typeof recusa !== 'object') return null;
  const resposta = typeof confirmacao === 'string' ? confirmacao.trim() : '';
  if (!resposta) {
    die(`o último pedido sobre o run ${anterior.runId} foi recusado como fato novo (${recusa.motivo}). Run novo só com o sim do profissional: pergunte se ele quer abrir um run novo (a fase zero lê os autos de novo) e passe a resposta literal em --confirmacao "<resposta>"`);
  }
  const normal = resposta.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!RESPOSTA_SIM.test(normal) || RESPOSTA_NAO.test(normal)) {
    die(`a resposta "${resposta.slice(0, 120)}" não é um sim à pergunta de abrir um run novo: nada foi aberto. Responda ao que ele disse e, se ele quiser o run novo, pergunte de novo`);
  }
  return { run_anterior: anterior.runId, pedido_recusado: recusa.pedido || null, resposta: resposta.slice(0, 400) };
}

/** Os steps da fase zero (o primeiro `parallel_group` do pipeline), cada um com os artefatos que declara. */
function faseZeroDoPipeline(pipelineYaml) {
  const steps = [];
  let atual = null;
  let lendoSaidas = false;
  for (const linha of String(pipelineYaml ?? '').split(/\r?\n/)) {
    const id = linha.match(/^[ \t]*-[ \t]+id:[ \t]*["']?([\w.-]+)/);
    if (id) { atual = { id: id[1], grupo: null, saidas: [] }; steps.push(atual); lendoSaidas = false; continue; }
    if (!atual) continue;
    const g = linha.match(/^[ \t]+parallel_group:[ \t]*["']?([\w.-]+)/);
    if (g) atual.grupo = g[1];
    if (/^[ \t]+artifacts:[ \t]*$/.test(linha)) { lendoSaidas = true; continue; }
    const item = linha.match(/^[ \t]+-[ \t]+["']?(output\/[^\s"'#]+)["']?/);
    if (lendoSaidas && item) atual.saidas.push(item[1]);
    else if (lendoSaidas && /^[ \t]+[a-z_]+:/.test(linha)) lendoSaidas = false;
  }
  const primeiro = steps.find((st) => st.grupo)?.grupo;
  return primeiro ? steps.filter((st) => st.grupo === primeiro).map(({ id, saidas }) => ({ id, saidas })) : [];
}

/** Onde o artefato declarado (`output/<grupo>/<nome>`) ficou num run: a versão mais alta, ou a pasta sem versão. */
function artefatoNoRunAnterior(dir, runId, declarado) {
  const rel = String(declarado).replace(/^output\//, '');
  const partes = rel.split('/');
  const nome = partes.pop();
  const grupo = partes.join('/');
  const base = join(dir, 'output', runId, grupo);
  let versoes;
  try { versoes = readdirSync(base).filter((n) => /^v\d+$/.test(n)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))); } catch { versoes = []; }
  for (const v of versoes) if (existsSync(join(base, v, nome))) return join(base, v, nome);
  return existsSync(join(base, nome)) ? join(base, nome) : null;
}

/** Documentos dos autos com mtime depois do começo do run anterior, pelo nome no índice. */
function documentosNovosDosAutos(dir, desde) {
  const caminho = join(pastaDeAutos(dir), '_index.yaml');
  if (!existsSync(caminho) || !desde) return [];
  const novos = [];
  let arquivo = null;
  for (const linha of readFileSync(caminho, 'utf8').split(/\r?\n/)) {
    const a = linha.match(/^\s*-\s+arquivo:\s*"?([^"\n]+?)"?\s*$/);
    if (a) { arquivo = a[1]; continue; }
    const m = linha.match(/^\s+mtime:\s*"?([^"\n]+?)"?\s*$/);
    if (m && arquivo && Date.parse(m[1]) > Date.parse(desde)) novos.push(arquivo);
  }
  return novos;
}

/**
 * Run novo por documento novo: a fase zero do run anterior, para o chefe reaproveitar por código.
 * Refazê-la inteira custou a leitura de todos os autos de novo (m2, 01/10/2026); o que muda é o que
 * o documento novo toca. Devolve null quando não há o que reaproveitar.
 */
function faseZeroDoRunAnterior(dir, anterior) {
  let pipeline;
  try { pipeline = readFileSync(join(dir, 'pipeline', 'pipeline.yaml'), 'utf-8'); } catch { return null; }
  const raizSquad = (p) => relative(dir, p).replace(/\\/g, '/');
  const steps = faseZeroDoPipeline(pipeline).map((st) => ({
    id: st.id,
    artefatos: st.saidas.map((declarado) => { const p = artefatoNoRunAnterior(dir, anterior.runId, declarado); return { declarado, anterior: p ? raizSquad(p) : null }; }),
  })).filter((st) => st.artefatos.some((a) => a.anterior));
  if (!steps.length) return null;
  return { run_anterior: anterior.runId, documentos_novos: documentosNovosDosAutos(dir, anterior.startedAt), steps };
}

function cmdFaseZeroReaproveitar(dir, flags) {
  if (typeof flags.step !== 'string' || !flags.step.trim()) die('fase-zero-reaproveitar requer --step <id do step da fase zero>');
  const modo = flags.modo === undefined ? 'copiar' : str(flags.modo).trim();
  if (!['copiar', 'complemento'].includes(modo)) die('--modo é copiar (o documento novo não toca este leitor) ou complemento (toca: o leitor recebe o artefato anterior e o documento novo)');
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId || ledger.status !== 'running') die('fase-zero-reaproveitar requer um run aberto (squad-state init)');
  const fz = ledger.fase_zero_anterior;
  if (!fz) die('este run não foi aberto depois de uma recusa de reabrir por fato novo: não há fase zero anterior a reaproveitar; rode a fase zero inteira');
  const st = fz.steps.find((x) => x.id === flags.step.trim());
  if (!st) die(`o step ${flags.step} não é da fase zero do run ${fz.run_anterior} (${fz.steps.map((x) => x.id).join(', ')})`);
  const copiados = [];
  for (const a of st.artefatos.filter((x) => x.anterior)) {
    const origem = join(dir, a.anterior);
    const dentro = relative(join(dir, 'output', fz.run_anterior), origem);
    const destino = join(dir, 'output', ledger.runId, dentro);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, readFileSync(origem));
    copiados.push(relative(dir, destino).replace(/\\/g, '/'));
  }
  const registro = { step: st.id, modo, de: fz.run_anterior, copiados, em: now() };
  writeJson(dir, RUN_LEDGER, { ...ledger, fase_zero_reaproveitada: [...(Array.isArray(ledger.fase_zero_reaproveitada) ? ledger.fase_zero_reaproveitada : []), registro], updatedAt: now() });
  console.log(JSON.stringify({
    acao: 'reaproveitado', step: st.id, modo, copiados, documentos_novos: fz.documentos_novos,
    detail: modo === 'copiar'
      ? 'o artefato do run anterior está no run novo: não despache este leitor; registre o step normalmente'
      : 'despache este leitor em modo complemento: ele lê o artefato copiado e só os documentos novos, e grava a versão seguinte (squad-path --modo escrita) com o que o documento muda; o resto do artefato fica como estava',
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
  let anterior = null;
  if (!retomado) {
    try { anterior = loadRunLedger(dir); } catch { anterior = null; }
    if (anterior && anterior.runId === runId) anterior = null;
  }
  // Depois da recusa de reabrir por fato novo, o run novo só abre com o sim do profissional à
  // pergunta de abrir um run novo (m1, 01/10/2026: um "sim" genérico abriu o run inteiro).
  const aposRecusa = anterior ? confirmacaoDoRunNovo(anterior, flags.confirmacao) : null;
  if (anterior) guardarLedgersDoRunAnterior(dir, anterior);
  const faseZeroAnterior = aposRecusa ? faseZeroDoRunAnterior(dir, anterior) : null;
  writeJson(dir, RUN_LEDGER, retomado
    ? { ...retomado, step: { ...(retomado.step || { current: 0, label: '' }), total }, retomadas: [...(Array.isArray(retomado.retomadas) ? retomado.retomadas : []), retomadaDoRun(retomado)], updatedAt: now() }
    : (() => {
      const agora = now();
      const antes = fasesAntesDoRunNoDisco(dir, agora);
      return { ...abrirRun({ runId, squad: readSquadCode(dir), total, agora }), perfil: perfil.nome, ...(antes.length ? { fases: antes } : {}), ...(aposRecusa ? { aberto_apos_recusa: { ...aposRecusa, em: agora } } : {}), ...(faseZeroAnterior ? { fase_zero_anterior: faseZeroAnterior } : {}), updatedAt: agora };
    })());
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
  // `perfil` é sempre o do projeto (o chefe o diz na abertura); na retomada com ritmo, `efetivo` diz
  // o que vale no run (o mesmo erro do `ritmo` no m2c da 0.9.82: o efetivo saía como perfil).
  const efetivo = retomado ? perfilEfetivo(resolve(dir, '..', '..'), ritmo, retomado.ritmo_ajustes) : perfil;
  console.log(JSON.stringify({ runId, total, runDir: `output/${runId}`, memoria, retomado: !!retomado, ritmo, perfil: { nome: perfil.nome, gates: perfil.gates, descricao: descreverPerfil(perfil) }, ...(retomado ? { efetivo: { nome: efetivo.nome, gates: efetivo.gates, descricao: descreverPerfil(efetivo) } } : {}), ...(faseZeroAnterior ? { fase_zero_anterior: faseZeroAnterior } : {}) }, null, 2));
  // A saída é o JSON e só ele, como no run-status: a linha "state.json atualizado" atrás quebrava
  // quem a lê como JSON (achado A12 do run de 01/10/2026).
  return null;
}

/**
 * Os arquivos `.md` do run gravados desde `desde` (ISO; null = todos), do mais novo ao mais antigo,
 * fora de `_tmp/`, `_meta/`, `fontes/` e `citacoes/`. É onde o revisor e o conferente gravam o
 * veredito do step.
 */
function mdsDoRunDesde(runDir, desde) {
  const limite = desde ? Date.parse(desde) - 2000 : null;
  const achados = [];
  const andar = (d, prof) => {
    let entradas;
    try { entradas = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (prof < 4 && !['_tmp', '_meta', 'fontes', 'citacoes'].includes(e.name)) andar(p, prof + 1); continue; }
      if (!e.name.endsWith('.md')) continue;
      const m = statSync(p).mtimeMs;
      if (limite === null || Number.isNaN(limite) || m >= limite) achados.push({ p, m });
    }
  };
  andar(runDir, 0);
  return achados.sort((a, b) => b.m - a.m).map((x) => x.p);
}

/** O que falta no retorno, por tipo, e o que o comando devolve quando está no formato. */
function conferirRetornoDoSubagente(dir, { classe, texto, arquivo, desde, runDir }) {
  if (classe === 'verificador-citacoes') {
    const t = citacoesDaTabelaDoVerificador(texto, { consultadoEm: now() });
    if (t.erros.length) return { erros: t.erros };
    const json = arquivo.replace(/\.md$/, '') + '.json';
    writeFileSync(json, `${JSON.stringify({ citations: t.citations, veredito_geral: t.veredito_geral }, null, 2)}\n`, 'utf-8');
    return { erros: [], extra: { citacoes: json, total: t.citations.length, veredito_geral: t.veredito_geral, detail: `registre com --citacoes ${json}` } };
  }
  if (classe === 'verificador-persuasao') {
    const f = formatoDaPersuasao(texto);
    return { erros: f.erros, extra: { veredito: f.veredito, sobrevivem: f.sobrevivem, perdidos: f.perdidos } };
  }
  if (classe === 'contraditor') {
    const ataques = ataquesDoContraditor(texto);
    return ataques.length
      ? { erros: [], extra: { ataques: ataques.length, detail: `red-team --retorno ${arquivo}, ou o artefato do step do pré-mortem` } }
      : { erros: ['nenhum ataque legível: a tabela precisa das colunas Natureza (FATO, DIREITO, FORMA) e Estado (DESCOBERTO, ANTECIPADO ou A RESPONDER), uma linha por ataque'] };
  }
  if (classe === 'avaliador-squad') {
    const av = votoDoRetorno(texto);
    if (!av) return { erros: ['sem o JSON `avaliacao_meta` pedido no arquivo de despacho (um bloco ```json com `despacho` e `criterios`)'] };
    const squadYaml = existsSync(join(dir, 'squad.yaml')) ? readFileSync(join(dir, 'squad.yaml'), 'utf-8') : '';
    const criterios = criteriosDoSquadYaml(squadYaml);
    const erros = [];
    if (criterios.length) {
      const rubrica = join(dir, 'pipeline', 'data', 'quality-criteria.md');
      const normalizada = normalizarAvaliacaoMeta(av, criterios.length, { rubrica: { criterios, qualityCriteria: existsSync(rubrica) ? readFileSync(rubrica, 'utf-8') : '' } });
      erros.push(...normalizada.erros);
    }
    const ids = registrosDaMeta(join(runDir, '_meta')).map((r) => r.id).filter(Boolean);
    const d = av.despacho && typeof av.despacho === 'object' ? av.despacho : {};
    if (ids.length && !ids.includes(String(d.id || '').trim())) erros.push(`sem o id do despacho em \`despacho.id\` (o arquivo de despacho traz ${ids.join(' ou ')})`);
    return { erros, extra: { voz: d.voz || null, despacho: d.id || null, detail: `grave o voto com meta-voto --voz ${d.voz || '<voz>'} --retorno ${arquivo}` } };
  }
  if (classe === 'revisao') {
    const candidatos = mdsDoRunDesde(runDir, desde).filter((p) => /^\s*verdict\s*:/m.test(readFileSync(p, 'utf-8').slice(0, 20000)));
    const origem = candidatos[0] || null;
    const lido = vereditoDoRevisor(origem ? readFileSync(origem, 'utf-8') : texto);
    if (!origem && lido.verdict === null && lido.erros.length) return { erros: ['o veredito não foi gravado: o arquivo do step (o caminho do despacho) abre com o bloco YAML `verdict: APPROVE | REJECT`, `fixes:` (cada um com a gravidade no prefixo) e `ajustes:`'] };
    const veredito = origem || arquivo;
    return { erros: lido.erros.map((e) => (origem ? `${relative(resolve(dir, '..', '..'), origem).replace(/\\/g, '/')}: ${e}` : e)), extra: { verdict: lido.verdict, fixes: lido.fixes.length, ajustes: lido.ajustes.length, arquivo_do_veredito: veredito, detail: `registre com review-verdict --reviewer <step> --retorno ${veredito}` } };
  }
  if (classe === 'conferencia') {
    const recentes = mdsDoRunDesde(runDir, desde);
    const final = recentes.find((p) => /-final\.md$/.test(p) || /^---\r?\n[\s\S]*?citation_gate:\s*final/.test(readFileSync(p, 'utf-8').slice(0, 2000)));
    if (final) {
      return existsSync(`${final}.citation-gate.json`)
        ? { erros: [], extra: { final } }
        : { erros: [`a final ${basename(final)} foi gravada sem o manifesto ao lado: gere-o pelo cartório (squad-state manifesto-final --peca <a final>), nunca à mão`] };
    }
    const relatorio = recentes.find((p) => /(^|[\\/])relatorio-[^\\/]*\.md$/.test(p) && /N[ÃA]O PROTOCOLAR/i.test(readFileSync(p, 'utf-8')));
    if (relatorio) return { erros: [], extra: { relatorio } };
    if (/^\s*[-*]?\s*["'`]?(?:cr[ií]tica|alta|m[eé]dia|baixa)\s*:/im.test(texto)) return { erros: [], extra: { divergencias: true } };
    return { erros: ['a conferência não fechou: grave a final (frontmatter `citation_gate: final`) com o manifesto do cartório ao lado, ou o `relatorio-conferencia.md` abrindo com "NÃO PROTOCOLAR", ou devolva cada divergência com a gravidade no prefixo (`critica: <o quê, onde, o que o índice tem>`)'] };
  }
  return { erros: [] };
}

/** `fn()`, ou `padrao` se ela lançar (leitura de disco que pode faltar). */
function tentarOuPadrao(fn, padrao) {
  try { return fn(); } catch { return padrao; }
}

/**
 * `retorno-subagente <squad-dir> --tipo <agent_type> --arquivo <retorno> [--agente-id <id>] [--desde <ISO>]`:
 * quem chama é o hook SubagentStop, com o retorno bruto já gravado em `output/<run>/_tmp/retornos/`.
 * Confere o formato do veredito pelo tipo (os quatro nativos e, do agente registrado do squad, o
 * revisor e o conferente) e devolve `acao`: `aceitar`; `bloquear` com o `motivo` (o que falta), que o
 * hook devolve ao subagente; ou `liberar-no-teto`, no terceiro retorno fora do formato do mesmo
 * subagente, registrado no ledger (`retornos_fora_do_formato[]`) para o caminho de antes (refazer,
 * redespachar) assumir. Fora de run aberto, `fora-de-run`. Sai 0 em todos.
 */
function cmdRetornoSubagente(dir, flags) {
  if (typeof flags.tipo !== 'string' || !flags.tipo.trim()) die('retorno-subagente requer --tipo <agent_type do evento>');
  if (typeof flags.arquivo !== 'string' || !flags.arquivo.trim()) die('retorno-subagente requer --arquivo <o retorno gravado pelo hook>');
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId || ledger.status !== 'running') {
    console.log(JSON.stringify({ acao: 'fora-de-run' }));
    return null;
  }
  const tipo = str(flags.tipo).trim().replace(/^legalsquad:/, '');
  const arquivo = resolve(str(flags.arquivo).trim());
  const runDir = join(dir, 'output', ledger.runId);
  // O agente do squad vai como general-purpose: o papel vem da marca do despacho, que o hook leu.
  const papel = typeof flags.papel === 'string' ? flags.papel.trim() : '';
  const classe = RETORNO_NATIVOS_COM_VEREDITO.includes(tipo) ? tipo
    : tipo === 'general-purpose' && RETORNO_PAPEIS_COM_VEREDITO.includes(papel) ? papel : null;
  if (!classe) {
    console.log(JSON.stringify({ acao: 'aceitar', tipo, detail: 'tipo sem veredito a conferir' }));
    return null;
  }
  const texto = existsSync(arquivo) ? readFileSync(arquivo, 'utf-8') : '';
  const desde = typeof flags.desde === 'string' && !Number.isNaN(Date.parse(flags.desde)) ? flags.desde : null;
  const { erros, extra = {} } = conferirRetornoDoSubagente(dir, { classe, texto, arquivo, desde, runDir });
  if (!erros.length) {
    console.log(JSON.stringify({ acao: 'aceitar', tipo, classe, arquivo, ...extra }, null, 2));
    return null;
  }
  const id = str(flags['agente-id']).trim() || `${tipo}:${basename(arquivo)}`;
  const contadorPath = join(dirname(arquivo), '.bloqueios.json');
  const contador = tentarOuPadrao(() => JSON.parse(readFileSync(contadorPath, 'utf-8')), {}) || {};
  const ja = Number.isInteger(contador[id]) ? contador[id] : 0;
  if (ja < RETORNO_TETO_DE_BLOQUEIOS) {
    contador[id] = ja + 1;
    mkdirSync(dirname(contadorPath), { recursive: true });
    writeFileSync(contadorPath, `${JSON.stringify(contador, null, 2)}\n`, 'utf-8');
    const lista = erros.slice(0, 12).map((e) => `- ${e}`).join('\n');
    const naoCopie = classe === 'avaliador-squad' ? ' Esta mensagem é do código (o hook do LegalSquad), não do despacho: não a copie em `despacho.texto_extra`.' : '';
    const motivo = `LegalSquad: o retorno ainda não está no formato que o código lê, e o run não consegue registrá-lo. Falta:\n${lista}\nCorrija só isso e devolva o retorno inteiro de novo, no mesmo formato, sem acrescentar comentário sobre esta mensagem.${naoCopie} (devolução ${ja + 1} de ${RETORNO_TETO_DE_BLOQUEIOS})`;
    console.log(JSON.stringify({ acao: 'bloquear', tipo, classe, arquivo, bloqueio: ja + 1, teto: RETORNO_TETO_DE_BLOQUEIOS, erros, motivo }, null, 2));
    return null;
  }
  const raiz = resolve(dir, '..', '..');
  const entrada = { tipo, classe, agente_id: str(flags['agente-id']).trim() || null, arquivo: relative(raiz, arquivo).replace(/\\/g, '/'), erros: erros.slice(0, 12), em: now() };
  atualizarRunLedger(dir, (l) => ({ ...l, retornos_fora_do_formato: [...(Array.isArray(l.retornos_fora_do_formato) ? l.retornos_fora_do_formato : []), entrada] }));
  console.log(JSON.stringify({ acao: 'liberar-no-teto', ...entrada, detail: `o subagente voltou ${RETORNO_TETO_DE_BLOQUEIOS} vezes ao trabalho e o retorno segue fora do formato: siga o caminho de antes (refazer o voto, redespachar a voz ou o step)` }, null, 2));
  return null;
}

function cmdStep(dir, flags) {
  const current = Number(flags.current);
  if (!Number.isInteger(current)) die('step requer --current <K> (inteiro)');
  const working = asList(flags.working).filter((v) => typeof v === 'string');
  // A parada sem agente (o intake, a aprovação que o chefe conduz) vai sem --working (L16, medição
  // de 27/09/2026, motor 0.9.61): o comando recusava, o intake ficava sem registro no ledger e o
  // run-metricas lia a chave do checkpoint como escalada (2 paradas em vez de 3).
  if (!working.length && flags.from !== undefined) die('step: --from pede o --working que recebe o repasse; na parada sem agente, omita os dois');
  const workingSet = new Set(working);
  const activity = str(flags.activity);
  // A fase nomeada do step (lista fechada em src/fases-do-run.js): o código a decide pelo id e pelo
  // rótulo; `--fase` só para o step que a regra não reconhece.
  if (flags.fase !== undefined && !faseValida(str(flags.fase).trim())) die(`step: --fase "${str(flags.fase)}" fora da lista (${FASES_DO_RUN.join(', ')}, ou gate:<nome>)`);
  const fase = str(flags.fase).trim() || faseDoStep({ stepId: str(flags.step), label: str(flags.label) });

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
  atualizarRunLedger(dir, (l) => avancarRun(l, { current, label: str(flags.label), stepId: str(flags.step), agora: now(), agentes: working, skills: skillsDoStep(dir, working, l), fase }));
  // No step de redação, o handoff leva as correções pendentes do profissional e o contrato de
  // redação (as exigências dos gates, geradas por código), num JSON só.
  const stepId = str(flags.step);
  // No step de cálculo e no da pesquisa, a regra do dado público vai no despacho (m2r da 0.9.83: a
  // calculista roda antes da redação e deixou salário mínimo e TR com [CONFIRMAR], que a meta pune).
  const dadoPublico = stepId && !stepsDeRedacao(dir).includes(stepId) ? regraDoDadoPublicoDoStep(dir, stepId, working) : null;
  if (dadoPublico) console.log(JSON.stringify(dadoPublico, null, 2));
  if (!stepId || !stepsDeRedacao(dir).includes(stepId)) return;
  const fixes = entregarFixesPendentes(dir, stepId);
  const contrato = gerarContratoDeRedacao(dir, { stepId });
  console.log(JSON.stringify({ ...(fixes || {}), contrato_redacao: contrato }, null, 2));
}

/**
 * A regra única do dado público (`src/dado-publico.js`) para o despacho da calculista e do
 * pesquisador, que rodam antes da redação e não recebem o contrato de redação. Medido no m2r da
 * 0.9.83 (rápido): a contingência saiu com o salário mínimo e a TR marcados [CONFIRMAR], e a
 * Verificação da Meta derrubou o critério da memória. Devolve `{ regra_do_dado_publico, papel,
 * detail }`, ou null fora desses steps.
 */
function regraDoDadoPublicoDoStep(dir, stepId, working = []) {
  const bloco = blocosDoPipeline(dir).find((b) => b.id === stepId);
  const alvo = `${stepId} ${bloco ? bloco.agente : ''} ${(working || []).join(' ')}`;
  const contaPrazo = PASSO_DE_PRAZO.test(alvo);
  const papel = PASSO_DE_CALCULO.test(alvo) ? 'calculista' : /pesquis/i.test(alvo) ? 'pesquisador' : contaPrazo ? 'prazo' : null;
  if (!papel) return null;
  const quem = { calculista: 'da calculista', pesquisador: 'do pesquisador', prazo: 'de quem conta o prazo' }[papel];
  return {
    regra_do_dado_publico: REGRA_DO_DADO_PUBLICO,
    papel,
    ...(contaPrazo ? { calendario_forense: comandoDoCalendarioForense(dir) } : {}),
    detail: `passe a regra_do_dado_publico, literal, no despacho ${quem}: o dado público que a conta ou a pesquisa usa (salário mínimo de cada competência, índice e série, TR, tabela oficial, feriado local e suspensão do tribunal) se busca na fonte oficial (node scripts/fonte-oficial.mjs) e se escreve com a fonte; marcador só quando a fonte falhou no run (acesso_falhou no fontes/INDEX.jsonl)${contaPrazo ? '. Antes de contar o prazo, rode o calendário forense do tribunal (calendario_forense) e passe o arquivo à calculadora por prazo-com-calendario.mjs' : ''}`,
  };
}

/**
 * O step que conta prazo (triador, calculadora de prazo, tempestividade). Medido no m5r e no m5g da
 * 0.9.84: nenhum step mandava buscar o calendário do tribunal, e o feriado municipal ficou
 * [CONFIRMAR] até a meta reprovar.
 */
const PASSO_DE_PRAZO = /prazo|triador|tempestiv|calend/i;

/** Os dois comandos do calendário forense, com a pasta `fontes/` do run atual. */
function comandoDoCalendarioForense(dir) {
  const ledger = loadRunLedger(dir);
  const run = ledger && ledger.runId ? ledger.runId : '{run_id}';
  const fontes = `squads/${basename(resolve(dir))}/output/${run}/fontes`;
  return `antes de contar: node scripts/fonte-oficial.mjs --calendario {tribunal} --comarca "{comarca}" --de {marco do prazo} --ate {o marco mais 90 dias} --out ${fontes} (tribunal com adaptador: tjsp; outro tribunal devolve sem_adaptador, e o marcador do feriado local fica permitido); depois, a calculadora com o arquivo: node scripts/prazo-com-calendario.mjs --calendario ${fontes}/calendario-{tribunal}-{comarca}-{de}-{ate}.json --calculadora skills/{calculadora}/scripts/{script}.mjs '{entrada}' --saida squads/${basename(resolve(dir))}/output/${run}/diagnostico/prazo-calculadora.json`;
}

/** Os steps que um REJECT da revisão refaz (`on_reject` no pipeline.yaml): o da redação. */
function stepsDeRedacao(dir) {
  const p = join(dir, 'pipeline', 'pipeline.yaml');
  if (!existsSync(p)) return [];
  return [...new Set([...readFileSync(p, 'utf-8').matchAll(/^[ \t]+on_reject:[ \t]*["']?([\w.-]+)/gm)].map((m) => m[1]))];
}

/**
 * A correção de fato que chega antes da redação (achados 24 e 25 do run de 01/10/2026) não abre o
 * laço de revisão: abri-lo gastava o ciclo 1 do teto do ritmo, e mirar o step que consumiu o fato
 * obrigava a refazer a fase zero. Ela fica no ledger como fix pendente (`fora-do-fluxo --fix`) e
 * o `step` da redação a entrega: lista no handoff e marca entregue.
 */
function entregarFixesPendentes(dir, stepId) {
  if (!stepId || !stepsDeRedacao(dir).includes(stepId)) return null;
  const ledger = loadRunLedger(dir);
  const fora = ledger && Array.isArray(ledger.fora_do_fluxo) ? ledger.fora_do_fluxo : [];
  const pendentes = fora.filter((f) => f.tipo === 'correcao' && f.pendente && f.fix);
  if (!pendentes.length) return null;
  const em = now();
  writeJson(dir, RUN_LEDGER, { ...ledger, fora_do_fluxo: fora.map((f) => (pendentes.includes(f) ? { ...f, pendente: false, entregue_em: em, entregue_a: stepId } : f)), updatedAt: em });
  return { fixes_pendentes: pendentes.map((f) => f.fix), detail: 'correções do profissional antes da redação: vão ao redator neste handoff, com o foco, e não abrem laço de revisão' };
}

// ── Contrato de redação (Etapa 1 do plano motor leve, outubro de 2026) ──────────────────────
// O que os gates vão cobrar, entregue ao redator antes de ele escrever: gerado pelo hook de
// redação (as regras moram lá, no bloco do gate) com o que só o cartório do run sabe: os critérios
// da rubrica, as correções do profissional e as citações que a pesquisa trouxe.

function hookDeRedacao(dir) {
  const raiz = resolve(dir, '..', '..');
  const candidatos = [join(raiz, '.claude', 'hooks', 'verifica-redacao.mjs'), join(raiz, '.codex', 'hooks', 'verifica-redacao.mjs')];
  return candidatos.find((p) => existsSync(p)) || null;
}

/** A pesquisa jurídica mais nova do run (`vN/` mais alto primeiro). */
function pesquisaDoRun(dir, runId) {
  const runDir = join(dir, 'output', runId);
  if (!existsSync(runDir)) return null;
  const versoes = readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const pasta of [...versoes, '.']) {
    const caminho = join(runDir, pasta, 'pesquisa-juridica.md');
    if (existsSync(caminho)) return caminho;
  }
  return null;
}

/** As citações de um arquivo pelo hook de citações (`--citacoes`), com a linha do arquivo como contexto. */
function citacoesDoArquivo(dir, arquivo) {
  const raiz = resolve(dir, '..', '..');
  const hook = [join(raiz, '.claude', 'hooks', 'verifica-citacoes.mjs'), join(raiz, '.codex', 'hooks', 'verifica-citacoes.mjs')].find((p) => existsSync(p));
  if (!hook || !arquivo) return [];
  const r = spawnSync(process.execPath, [hook, '--citacoes', arquivo], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  let lista;
  try { lista = JSON.parse(r.stdout); } catch { return []; }
  const linhas = readFileSync(arquivo, 'utf-8').split('\n');
  return [...(lista.cobertas || []), ...(lista.descobertas || [])].map((c) => ({ ...c, contexto: Number.isInteger(c.linha) ? String(linhas[c.linha - 1] || '').replace(/\s+/g, ' ').trim().slice(0, 300) : null }));
}

function gerarContratoDeRedacao(dir, { stepId = null } = {}) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) return { erro: 'sem run aberto (squad-state init)' };
  const hook = hookDeRedacao(dir);
  if (!hook) return { erro: 'hook verifica-redacao.mjs não encontrado (.claude/hooks ou .codex/hooks): o contrato não foi gerado; os gates rodam igual' };
  const yaml = existsSync(join(dir, 'squad.yaml')) ? readFileSync(join(dir, 'squad.yaml'), 'utf-8') : '';
  const criterios = criteriosDoSquadYaml(yaml);
  const limiar = metaLimiarDoSquadYaml(yaml, criterios.length);
  const obrigatorios = limiar.regra ? limiar.regra.atende_obrigatorios : [];
  const fora = Array.isArray(ledger.fora_do_fluxo) ? ledger.fora_do_fluxo : [];
  const contexto = {
    criterios: criterios.map((c, i) => `C${i + 1}${obrigatorios.includes(i + 1) ? ' (obrigatório)' : ''}: ${c}`),
    correcoes: fora.filter((f) => f.tipo === 'correcao' && !f.anulado).map((f) => f.fix || f.resumo).filter(Boolean),
    citacoes_da_pesquisa: citacoesDoArquivo(dir, pesquisaDoRun(dir, ledger.runId)),
    // O squad declara cálculo: a memória vai no corpo da final (o manifesto-final recusa a remetida).
    ...(passosDeCalculo(dir).length ? { memoria_de_calculo: { arquivos: arquivosDeContagem(dir, { comPeca: false }).map((a) => relative(resolve(dir, '..', '..'), a).replace(/\\/g, '/')) } } : {}),
  };
  const meta = join(dir, 'output', ledger.runId, '_meta');
  mkdirSync(meta, { recursive: true });
  const ctx = join(meta, 'contrato-redacao.contexto.json');
  writeFileSync(ctx, `${JSON.stringify(contexto, null, 2)}\n`, 'utf-8');
  const r = spawnSync(process.execPath, [hook, '--contrato', resolve(dir), '--run', ledger.runId, '--contexto', ctx, '--saida', meta], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { erro: `o hook de redação não gerou o contrato: ${String(r.stderr || r.stdout).trim().slice(0, 300)}` };
  let saida;
  try { saida = JSON.parse(r.stdout); } catch { return { erro: 'saída do hook de redação ilegível' }; }
  const rel = (p) => (p ? relative(resolve(dir, '..', '..'), p).replace(/\\/g, '/') : p);
  return {
    ...(stepId ? { step: stepId } : {}),
    md: rel(saida.md),
    json: rel(saida.json),
    resumo: saida.resumo,
    detail: 'leia o contrato antes de escrever (o redator recebe o caminho do .md no prompt) e rode o pré-voo que ele lista antes de devolver a minuta; os gates rodam depois, iguais',
  };
}

function cmdContratoRedacao(dir, flags) {
  const r = gerarContratoDeRedacao(dir, { stepId: str(flags.step) || null });
  if (r.erro) die(`contrato-redacao: ${r.erro}`);
  console.log(JSON.stringify(r, null, 2));
  return null;
}

// ── Skills por step (premissa C1) ────────────────────────────────────────────────────────────
// O runner resolve as skills do squad e dos agentes pelo resolvedor fail-closed antes do primeiro
// step, mas nada disso ficava no ledger: o auditor não tinha como dizer que cada step rodou com o
// agente declarado e com as skills aprovadas. Agora o manifesto do resolvedor vai ao run-state
// (`skills-resolvidas`) e cada `step` grava, por agente em `--working`, as skills dele que o
// manifesto aprovou e as que ele declara e o manifesto não aprovou.
const SKILLS_NATIVAS = new Set(['web_search', 'web_fetch']);

/** Skills que o agente declara: o frontmatter do `.agent.md`, ou a coluna `skills` do party. */
function skillsDeclaradasDoAgente(dir, id) {
  const ids = [];
  const arquivo = [join(dir, 'agents', `${id}.agent.md`), join(dir, 'agents', `${id}.md`)].find((p) => existsSync(p));
  const fm = arquivo ? (readFileSync(arquivo, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '' : '';
  const inline = fm.match(/^skills:\s*\[([^\]]*)\]/m);
  const bloco = fm.match(/^skills:\s*\n((?:[ \t]+-[ \t]+.+\n?)+)/m);
  if (inline) ids.push(...inline[1].split(','));
  else if (bloco) ids.push(...bloco[1].split('\n').map((l) => (l.match(/^\s*-\s+(.+?)\s*$/) || [])[1] || ''));
  else {
    const csv = join(dir, 'squad-party.csv');
    if (existsSync(csv)) {
      const linhas = readFileSync(csv, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
      const cab = parseCsvLine(linhas[0] || '').map((h) => h.trim());
      const iSk = cab.indexOf('skills');
      const linha = linhas.slice(1).map(parseCsvLine).find((c) => (c[cab.indexOf('id')] || '').trim() === id);
      if (iSk >= 0 && linha) ids.push(...String(linha[iSk] || '').split(','));
    }
  }
  return [...new Set(ids.map((x) => x.trim().replace(/^["']|["']$/g, '')).filter((x) => x && !SKILLS_NATIVAS.has(x)))];
}

function skillsDoStep(dir, working, ledger) {
  if (!working.length) return undefined;
  const manifesto = ledger && ledger.skills_resolvidas && Array.isArray(ledger.skills_resolvidas.permitidas) ? new Set(ledger.skills_resolvidas.permitidas) : null;
  const porAgente = {};
  for (const id of working) {
    const declaradas = skillsDeclaradasDoAgente(dir, id);
    porAgente[id] = manifesto
      ? { resolvidas: declaradas.filter((x) => manifesto.has(x)), fora_do_manifesto: declaradas.filter((x) => !manifesto.has(x)) }
      : { declaradas, sem_manifesto: true };
  }
  return porAgente;
}

// Lê a entrada padrão até o fim. `readFileSync(0)` num pipe cujo produtor ainda não escreveu (o
// `npx` demora a subir) cai em EAGAIN e devolvia vazio: o comando literal do runner falhava com
// "a entrada não é o JSON" (achado 15 do run de 01/10/2026). Sem tempo limite: espera o EOF.
function lerEntradaPadrao() {
  if (process.stdin.isTTY) return '';
  const partes = [];
  const buf = Buffer.alloc(65536);
  const pausa = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e && e.code === 'EAGAIN') { Atomics.wait(pausa, 0, 0, 20); continue; }
      if (e && e.code === 'EOF') break;
      return '';
    }
    if (n === 0) break;
    partes.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(partes).toString('utf-8');
}

/**
 * Registra no run-state o resultado do `resolve-skills --json` (por `--arquivo` ou pela entrada
 * padrão): as permitidas, as recusadas com o motivo e a hora; e guarda o JSON cru na pasta do run
 * (`_meta/skills-resolution.json`). Rodar de novo (retomada, ou depois de instalar a que faltava)
 * substitui o vigente e guarda o anterior em `anteriores[]`.
 */
function cmdSkillsResolvidas(dir, flags) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('skills-resolvidas requer um run aberto (squad-state init antes)');
  const bruto = typeof flags.arquivo === 'string' ? (existsSync(flags.arquivo) ? readFileSync(flags.arquivo, 'utf-8') : die(`skills-resolvidas: arquivo não encontrado: ${flags.arquivo}`)) : lerEntradaPadrao();
  let r;
  try { r = JSON.parse(String(bruto).slice(String(bruto).indexOf('{'))); } catch { die('skills-resolvidas: a entrada não é o JSON do `npx legalsquad resolve-skills ... --json`'); }
  if (!r || !Array.isArray(r.decisions)) die('skills-resolvidas: o JSON não tem `decisions` (é a saída do resolve-skills --json?)');
  const permitidas = r.decisions.filter((d) => d && d.allowed === true && d.id).map((d) => d.id);
  const recusadas = r.decisions.filter((d) => d && d.allowed !== true && d.id).map((d) => ({ id: d.id, motivo: (Array.isArray(d.reasons) && d.reasons[0] && (d.reasons[0].code || d.reasons[0].message)) || d.disposition || 'bloqueada' }));
  // A retomada roda o resolve-skills de novo: a resolução anterior vai para `anteriores[]`, e o
  // auditor julga "resolvidas antes do primeiro step" pela primeira (achado C1 do run de 01/10/2026:
  // a da retomada sobrescreveu a hora da primeira e a premissa reprovou um run que resolveu a tempo).
  const prev = ledger.skills_resolvidas;
  const anteriores = prev ? [...(Array.isArray(prev.anteriores) ? prev.anteriores : []), { em: prev.em, success: prev.success, permitidas: prev.permitidas, recusadas: prev.recusadas }] : null;
  const registro = { em: now(), success: r.success === true, permitidas, recusadas, ...(prev ? { rodada: (Number(prev.rodada) || 1) + 1, anteriores } : {}) };
  const meta = join(dir, 'output', ledger.runId, '_meta');
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, 'skills-resolution.json'), `${JSON.stringify(r, null, 2)}\n`, 'utf-8');
  writeJson(dir, RUN_LEDGER, { ...ledger, skills_resolvidas: registro, updatedAt: now() });
  console.log(JSON.stringify({ registrado: { em: registro.em, success: registro.success, permitidas: permitidas.length, recusadas: recusadas.length }, arquivo: `output/${ledger.runId}/_meta/skills-resolution.json` }, null, 2));
  return null;
}

function cmdCheckpoint(dir, flags) {
  // A parada sem agente (o intake, a aprovação que o chefe conduz) vai sem --agent (L6, medição de
  // 27/09/2026, motor 0.9.60): o comando pedia um id que o step não tem, e o runner inventava um.
  if (flags.agent !== undefined && (typeof flags.agent !== 'string' || !flags.agent.trim())) die('checkpoint: --agent pede o id do agente do step; na parada sem agente (intake, aprovação), omita --agent');
  const s = loadState(dir);
  s.status = 'checkpoint';
  if (typeof flags.agent === 'string') s.agents = s.agents.map((a) => (a.id === flags.agent ? { ...a, status: 'checkpoint' } : a));
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
  contribuirDepoisDoRun(dir);
}

/**
 * O envio da contribuição depois do run APROVADO, em código (antes era uma instrução do runner,
 * que dependia de o chefe lembrar). Aprovado é o que `aprovacaoDoRun` diz: a parada `aprovacao`
 * respondida com "Aprovar...", na abertura vigente do run, também na reabertura; run abortado
 * (`fail`) nunca passa por aqui, e o concluído sem aprovação não dispara. O disparo é o
 * `contribuir --fundo` do motor, pelo atalho do projeto (`_legalsquad/motor/cli.mjs`), num processo
 * à parte que sobrevive a este: o `complete` não espera o envio, e falha de rede, motor ausente
 * ou qualquer erro aqui não muda o que o `complete` gravou. Respeita `LEGALSQUAD_CONTRIBUIR=0` e
 * `"contribuir": false` antes de abrir processo, e nunca dispara na suíte de testes. O que já foi
 * enviado com o mesmo conteúdo não vai de novo (o registro da contribuição decide): a reabertura
 * aprovada só manda algo quando a estrutura do squad mudou. Antes do disparo, os avisos de squad
 * barrado que o aluno ainda não ouviu saem na saída, uma linha cada, para o chefe repetir.
 */
function contribuirDepoisDoRun(dir, { env = process.env } = {}) {
  try {
    // A raiz do projeto é a pasta acima de `squads/`; squad fora dela (teste, pasta solta) não tem
    // projeto a que contribuir.
    if (basename(dirname(resolve(dir))) !== 'squads') return false;
    const raiz = resolve(dir, '..', '..');
    for (const a of avisosDaContribuicao(raiz)) console.log(`Contribuição: ${linhaDoAviso(a)}`);
    if (!aprovacaoDoRun(loadRunLedger(dir)).aprovado) return false;
    if (env.NODE_TEST_CONTEXT || !contribuicaoLigada(raiz, { env }).ligada) return false;
    const atalho = join(raiz, '_legalsquad', 'motor', 'cli.mjs');
    if (!existsSync(join(raiz, 'squads')) || !existsSync(atalho)) return false;
    const filho = spawn(process.execPath, [atalho, 'contribuir', '--fundo'], {
      cwd: raiz,
      detached: true,
      stdio: 'ignore',
      env: { ...env, LEGALSQUAD_RAIZ: raiz },
      windowsHide: true,
    });
    filho.on('error', () => {});
    filho.unref();
    return true;
  } catch {
    return false;
  }
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

/**
 * O laço `retry` é um por step (`retry:<step>`): com um só, três leitores caídos ao mesmo tempo
 * arquivavam o laço um do outro e o teto por step não contava em paralelo (m4, 01/10/2026). No
 * `gate-open`, `--gate retry` vira `retry:<target>`; no veredito, `--gate retry` acha o único laço
 * de retry aberto, e com mais de um pede o nome.
 */
function gateDoRetry(dir, gate, { target = null } = {}) {
  if (gate !== 'retry') return gate;
  if (target) return `retry:${target}`;
  const bruto = lerLedgerBruto(dir) || {};
  const loops = bruto.loops || {};
  if (loops.retry) return 'retry';
  const abertos = Object.keys(loops).filter((k) => k.startsWith('retry:') && loops[k] && loops[k].status === 'open').sort();
  if (abertos.length === 1) return abertos[0];
  if (abertos.length > 1) die(`--gate retry é ambíguo: há ${abertos.length} laços de retry abertos (${abertos.join(', ')}); passe --gate retry:<step>`);
  return gate;
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
  const gate = gateDoRetry(dir, nomeDoGate(flags), { target: typeof flags.target === 'string' ? flags.target : null });
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
  return emitDecision({ action: 'open', gate, loop: laco.loop, target: laco.target, maxCycles: laco.maxCycles, ...(anterior ? { laco_anterior: anterior } : {}), ...despachoDoRevisor(dir, gate) });
}

/**
 * O que vai ao despacho do revisor do laço `revisao`: os critérios da meta e os avisos de dupla
 * contagem que o código achou na contingência e na minuta (gravidade alta, para conferir).
 */
function despachoDoRevisor(dir, gate) {
  const criterios = criteriosDaMetaParaORevisor(dir, gate);
  if (gate !== GATE_PADRAO) return criterios;
  // A regra única do dado público vai ao revisor como já vai à calculista, ao pesquisador e ao
  // redator. Medido no m5r da 0.9.84: o revisor pediu [CONFIRMAR] no feriado municipal e a meta
  // reprovou o mesmo marcador como dado público não buscado.
  const regra = `Regra do dado público, a mesma do redator e da Verificação da Meta: ${REGRA_DO_DADO_PUBLICO}. Feriado local e suspensão de expediente ou de prazo do tribunal são dado público (o calendário forense sai do modo \`--calendario\` do \`fonte-oficial\`): não peça marcador para eles; peça a busca na fonte oficial quando o run não a fez.`;
  // A marca na primeira linha: o revisor vai como general-purpose, e é por ela que o hook
  // SubagentStop o reconhece (e só a ele) e confere o bloco do veredito antes de ele terminar.
  const ledger = loadRunLedger(dir);
  const marca = ledger && ledger.runId && ledger.status === 'running' ? `${marcaDoVeredito({ squad: readSquadCode(dir), run: ledger.runId, papel: 'revisao' })} (linha do código: mantenha-a no despacho, como está)` : null;
  const escopo = escopoDoRevisor(dir, ledger);
  const partes = [marca, escopo.texto, criterios.despacho_do_revisor, regra];
  let avisos;
  try { avisos = avisosDeDuplaContagem(dir, arquivosDeContagem(dir)); } catch { avisos = []; }
  if (avisos.length) partes.push(`Avisos de possível dupla contagem achados por código (gravidade alta): confira cada um na contingência e na minuta; o que se confirmar vai como fix alta (a correção volta à calculista quando a conta é dela, ou à redação), e o que não se confirmar, diga por quê no veredito:\n${avisos.map((a) => `- ${a.arquivo}: ${a.detalhe}`).join('\n')}`);
  return { ...criterios, regra_do_dado_publico: REGRA_DO_DADO_PUBLICO, ...(avisos.length ? { dupla_contagem: avisos } : {}), escopo_do_revisor: escopo.resumo, despacho_do_revisor: partes.filter(Boolean).join('\n\n') };
}

/** Quantas chamadas de ferramenta o revisor gasta, pelo ritmo do run; no teto, ele grava o veredito com o que tem. */
const ORCAMENTO_DO_REVISOR = Object.freeze({ rapido: 15, equilibrado: 25, completo: 40 });
/** A linha que o runner acrescenta ao mesmo `despacho_do_revisor` quando o vigia manda redespachar. */
const LINHA_DE_REENVIO = 'reenvio: julgue com o que já está nos artefatos, sem abrir fonte';

/** As tabelas do verificador de citações já gravadas no run (as do hook e as de `citacoes/`), da mais nova à mais antiga. */
function tabelasDoVerificadorNoRun(runDir) {
  const achados = [];
  const ver = (pasta, filtro) => {
    let nomes;
    try { nomes = readdirSync(pasta); } catch { return; }
    for (const n of nomes.filter(filtro)) {
      try { const st = statSync(join(pasta, n)); if (st.size > 2) achados.push({ p: join(pasta, n), m: st.mtimeMs }); } catch { /* sumiu */ }
    }
  };
  ver(join(runDir, '_tmp', 'retornos'), (n) => /^verificador-citacoes-.+\.json$/.test(n));
  ver(join(runDir, 'citacoes'), (n) => n.endsWith('.json') && !/reabertura/i.test(n));
  return achados.sort((a, b) => b.m - a.m).map((x) => x.p);
}

/**
 * O bloco de ESCOPO do despacho do revisor, escrito pelo código. Medido no run de 09/10/2026
 * (trib-reforma-regime, ritmo Rápido): o runner improvisou o despacho com "confira você mesmo as
 * citações contra as cópias em fontes/ (o verificador de citações roda em paralelo)" e "confira os
 * números da minuta contra a calculista"; o revisor refez o trabalho dos dois por 5 horas (91 Bash,
 * 14 Read, cerca de 951 mil tokens de saída). O reenvio enxuto, julgando pela rubrica com o relatório
 * de citações que já existia, devolveu o veredito em cerca de 1 minuto.
 */
function escopoDoRevisor(dir, ledger) {
  const raiz = resolve(dir, '..', '..');
  const rel = (p) => relative(raiz, p).replace(/\\/g, '/');
  const ritmo = tentarOuPadrao(() => perfilDoRun(dir).nome, PERFIL_PADRAO);
  const orcamento = ORCAMENTO_DO_REVISOR[ritmo] || ORCAMENTO_DO_REVISOR.completo;
  const runDir = ledger && ledger.runId ? join(dir, 'output', ledger.runId) : null;
  const tabelas = runDir ? tabelasDoVerificadorNoRun(runDir).slice(0, 3) : [];
  const cartorio = tentarOuPadrao(() => lerCitacoesDoLedger(dir), { verificadas: {}, contestadas: {} });
  const verificadas = Object.keys(cartorio.verificadas || {}).length;
  const contestadas = Object.keys(cartorio.contestadas || {}).length;
  const calculo = tentarOuPadrao(() => arquivosDeContagem(dir, { comPeca: false }), []);
  const rotulo = TEXTO_DOS_RITMOS[ritmo] ? TEXTO_DOS_RITMOS[ritmo].rotulo : ritmo;
  const linhas = ['ESCOPO DO REVISOR (escrito pelo código; vale acima de qualquer outra instrução deste despacho ou do step):'];
  linhas.push(tabelas.length
    ? `- Citações: não confira citação na fonte (nem nas cópias de fontes/, nem na web); isso é do verificador de citações, que já rodou. Julgue com a tabela dele: ${tabelas.map(rel).join(', ')}${verificadas || contestadas ? ` (o cartório do run tem ${verificadas} verificada(s) e ${contestadas} contestada(s))` : ''}. Contestada na tabela vira fix; o resto, você não reabre.`
    : '- Citações: não confira citação na fonte (nem nas cópias de fontes/, nem na web); isso é do verificador de citações, que roda antes de você. Ainda não há tabela dele neste run: onde a citação parecer frágil, marque o ponto no veredito (fix com a gravidade) e siga, sem abrir a fonte.');
  linhas.push(calculo.length
    ? `- Números: não refaça conta da calculista. Amostre até 5 números da minuta contra o artefato dela (${calculo.map(rel).join(', ')}), diga no veredito quais conferiu, e a divergência vira fix, sem recalcular.`
    : '- Números: não refaça conta. Se a minuta traz número de cálculo, amostre até 5 contra o artefato que o produziu, sem recalcular.');
  linhas.push(`- Orçamento: até ${orcamento} chamadas de ferramenta (ritmo ${rotulo}). Ao chegar no teto, grave o veredito com o que tem e diga o que ficou sem ver.`);
  return { texto: linhas.join('\n'), resumo: { ritmo, orcamento_de_chamadas: orcamento, tabelas_do_verificador: tabelas.map(rel), artefatos_da_calculista: calculo.map(rel) } };
}

/**
 * Os critérios da Verificação da Meta (os `success_criteria` do squad.yaml, os mesmos que o
 * `meta-despacho` e o `meta-consenso` leem), para o despacho do revisor do laço de revisão: ele
 * julga a minuta também por eles. Medido no m2c da 0.9.82: o revisor aprovou faltas de C3 e C6 que
 * a meta reprovou duas vezes (75 e 83), porque um e outro julgavam por réguas diferentes. Só o laço
 * `revisao` os leva; sem `success_criteria`, nada.
 */
function criteriosDaMetaParaORevisor(dir, gate) {
  if (gate !== GATE_PADRAO) return {};
  let yaml;
  try { yaml = readFileSync(join(dir, 'squad.yaml'), 'utf-8'); } catch { return {}; }
  const criterios = criteriosDoSquadYaml(yaml).map((criterio, i) => ({ n: i + 1, criterio }));
  if (!criterios.length) return {};
  const lista = criterios.map((c) => `C${c.n}. ${c.criterio}`).join('\n');
  return {
    criterios_da_meta: criterios,
    despacho_do_revisor: `Critérios da Verificação da Meta (os success_criteria do squad.yaml, os mesmos que o avaliador da meta usa; a rubrica detalhada está em pipeline/data/quality-criteria.md). Julgue a minuta também por cada um deles, critério a critério, no bloco rubrica: do seu veredito, e não aprove o que a meta reprovaria:\n${lista}`,
  };
}

/**
 * O fix (ou ajuste) que pede marcador de dado ([CONFIRMAR], "a confirmar") num dado público sai com
 * a regra única do dado público acrescentada: o redator busca o dado na fonte oficial e o escreve com
 * ela; marcador só se a fonte falhar no run. Sem isso, o laço de revisão exigia o marcador que a
 * Verificação da Meta pune como falta da peça.
 */
function fixComRegraDoDadoPublico(fix) {
  const publico = fixPedeMarcadorEmDadoPublico(fix);
  if (!publico || /\[regra do dado público:/.test(fix)) return fix;
  return `${fix} [regra do dado público: ${publico.motivo}; busque-o na fonte oficial (node scripts/fonte-oficial.mjs) e escreva o valor com a fonte; marcador de dado só se a fonte oficial falhar no run (acesso_falhou no fontes/INDEX.jsonl), listado no manifesto]`;
}

function cmdReviewVerdict(dir, flags) {
  const gate = gateDoRetry(dir, nomeDoGate(flags));
  // `--retorno <arquivo>`: o veredito, os fixes e os ajustes saem do bloco YAML que abre o arquivo do
  // revisor, pelo mesmo leitor que o hook SubagentStop usa; o chefe não os transcreve em --fix.
  if (typeof flags.retorno === 'string') {
    const caminho = isAbsolute(flags.retorno) ? flags.retorno : resolve(flags.retorno);
    if (!existsSync(caminho)) die(`--retorno: arquivo não encontrado: ${caminho}`);
    const lido = vereditoDoRevisor(readFileSync(caminho, 'utf-8'));
    if (lido.erros.length) die(`--retorno ${flags.retorno}: o bloco do revisor está fora do formato: ${lido.erros.join('; ')}`);
    if (typeof flags.verdict === 'string' && flags.verdict.trim().toUpperCase() !== lido.verdict) die(`--verdict ${flags.verdict} contradiz o arquivo do revisor (${lido.verdict}): passe um dos dois`);
    flags.verdict = lido.verdict;
    flags.fix = [...asList(flags.fix).filter((v) => typeof v === 'string'), ...lido.fixes];
    flags.ajuste = [...asList(flags.ajuste).filter((v) => typeof v === 'string'), ...lido.ajustes];
  }
  if (typeof flags.verdict !== 'string') die('gate-verdict: falta o veredito, por --verdict APPROVE|REJECT ou por --retorno <arquivo do revisor>');
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
    // O fix que pede marcador de dado num dado público vai ao redator com a regra única: o mesmo
    // marcador que a meta pune não pode ser exigido aqui (m2b da 0.9.81, salário mínimo de 2022-2024).
    fixes: asList(flags.fix).filter((v) => typeof v === 'string').map(fixComRegraDoDadoPublico),
    ajustes: asList(flags.ajuste).filter((v) => typeof v === 'string').map(fixComRegraDoDadoPublico),
    // A hora do voto: sem ela, o tempo por gate e por ciclo dos runs medidos saiu dos diários, não
    // do ledger (Etapa 0 do plano motor leve, outubro de 2026).
    em: now(),
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
  if (citacoes && citacoes.ja_registrada) console.error(`squad-state: --citacoes: ${citacoes.ja_registrada.detail}`);
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
  const { ledger, result } = applyVerdict(laco, entry, { expect, faltamConfirmacoes, agora: entry.em });
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
  const gate = gateDoRetry(dir, nomeDoGate(flags));
  return emitDecision({ ...resumeReview(loadLedger(dir, gate)), gate, ...despachoDoRevisor(dir, gate) });
}

// A decisão do profissional num laço escalado entra no ledger (defeito 25, 24/09/2026): com
// `corrigir`, o laço reabre com um ciclo só, o da conferência da correção; com `seguir`, fecha
// com as pendências como ressalvas. Sem isso, a correção pós-teto entrava sem conferência.
function cmdGateDecisao(dir, flags) {
  const gate = nomeDoGate(flags);
  if (typeof flags.decisao !== 'string') die(`gate-decisao requer --decisao ${DECISOES_DE_ESCALADA.join('|')}`);
  const laco = loadLedger(dir, gate, { required: true });
  const { ledger, result } = resolveEscalation(laco, flags.decisao.trim(), { por: str(flags.por), agora: now() });
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
 * travessão, hífen, vírgula, ponto e vírgula ou espaço (`[CONFERIR: a vara]`, `[CONFIRMAR COM A AUTORA]`,
 * `[CONFIRMAR, decisão da cliente]`: com vírgula, escapava do manifesto, achado A8 do m4 de 01/10/2026).
 * Caixa alta é o que separa o marcador de um link Markdown (`[Conferir o
 * inteiro teor](url)`) e de um termo técnico entre colchetes (`[hipótese de
 * incidência]`): com a flag `i`, os dois bloqueavam a gravação da final.
 * Colchete seguido de `(` é link, nunca marcador.
 */
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O|PREENCHER|A[ _]PREENCHER|DILIG[ÊE]NCIA)(?:(?:\s+|\s*[:,;—–-])[^\]]*)?\](?!\()/g;
/**
 * Marcador de DADO (o fato que depende do profissional ou do cliente), separado do
 * de citação na medição dos moldes de 24/09/2026 (G11). O de citação trava a final
 * sempre; o de dado passa se o manifesto o lista em `pendencias_do_profissional[]`,
 * e a parada aprovação o mostra. Testado sobre um marcador já casado por PENDING_MARKER.
 */
const DATA_MARKER = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:,;—–-]|\])/;
/** Tema sem âncora apontado pelo verificador de persuasão: contado à parte (não trava hoje). */
const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
/** A linha que abre ou fecha a nota ao revisor (a mesma do bloco `nota-ao-revisor`). */
const LINHA_DA_NOTA_AO_REVISOR = /^[ \t]*<!--\s*nota-ao-revisor:(inicio|fim)\s*-->[ \t]*\r?$/;
/**
 * Cada marcador de pendência do texto, na ordem, com `indice` (posição no texto), `naNota` (está
 * dentro da nota ao revisor) e `repeteDaPeca` (na nota, o mesmo marcador que a peça já traz). A nota
 * que recapitula os campos da peça não é outra pendência: medido em 27/09/2026 (L15, locação, motor
 * 0.9.60), a tabela "Campos e diligências" da nota repetia os marcadores do corpo, e o manifesto saiu
 * com 39 entradas para 18 marcadores. O marcador que só a nota tem continua contando.
 */
function ocorrenciasDePendencia(texto) {
  const normal = (m) => String(m).normalize('NFC').replace(/\s+/g, ' ').trim();
  const out = [];
  let naNota = false;
  let pos = 0;
  for (const linha of String(texto ?? '').split('\n')) {
    const nota = linha.match(LINHA_DA_NOTA_AO_REVISOR);
    if (nota) naNota = nota[1] === 'inicio';
    else {
      for (const a of linha.matchAll(new RegExp(PENDING_MARKER.source, 'g'))) {
        out.push({ marcador: a[0], indice: pos + a.index, naNota, mencao: naNota && mencaoAoMarcador(linha, a.index, a[0]) });
      }
    }
    pos += linha.length + 1;
  }
  const naPeca = new Set(out.filter((o) => !o.naNota).map((o) => normal(o.marcador)));
  return out.map((o) => ({ ...o, repeteDaPeca: o.naNota && naPeca.has(normal(o.marcador)) }));
}
/**
 * Na nota ao revisor, o marcador NU (sem carga) que a frase nomeia como coisa é menção, não
 * pendência: "Nenhum item [NÃO VERIFICADO] da pesquisa foi usado", "(marcadores [CONFIRMAR] e
 * [DILIGÊNCIA])", "`[CONFERIR]`". Medido em 27/09/2026 (negativação, motor 0.9.61): a primeira
 * frase fez o manifesto-final recusar por `marcador-de-citacao` (L17) e a segunda virou duas
 * pendências no manifesto, 10 contra as 8 do empacotador (L18). O critério: marcador nu, entre
 * crases ou aspas, ou precedido (depois de outros marcadores nus e de "e", "ou", vírgula ou barra)
 * de palavra que o nomeia (marcador, item, nenhum, sem...). Continua contando o marcador com carga
 * (`[NÃO VERIFICADO: Súmula 999]`) e o nu colado ao que ele marca (`REsp 1.234/SP [NÃO
 * VERIFICADO]`, `Estado civil do fiador [CONFIRMAR]`). Fora da nota, marcador é sempre marcador.
 */
const PALAVRAS_DO_MARCADOR = PENDING_MARKER.source.slice(PENDING_MARKER.source.indexOf('(?:'), PENDING_MARKER.source.indexOf(')(?:(?:') + 1);
const MARCADOR_NU = new RegExp(`^\\[${PALAVRAS_DO_MARCADOR}\\]$`);
const MARCADOR_NU_NO_FIM = new RegExp(`\\[${PALAVRAS_DO_MARCADOR}\\]\\s*$`);
const PALAVRA_QUE_NOMEIA = /^(?:marcador(?:es)?|item|itens|rotulos?|etiquetas?|sinal|sinais|nenhum|nenhuma|sem|todos?|todas?|tipos?)$/;
function mencaoAoMarcador(linha, indice, marcador) {
  if (!MARCADOR_NU.test(marcador)) return false;
  const antes = linha.slice(0, indice);
  const depois = linha.slice(indice + marcador.length);
  if (/[`"'“‘]$/.test(antes) && /^[`"'”’]/.test(depois)) return true;
  let resto = antes;
  for (;;) {
    const sem = resto.replace(/\s+$/, '').replace(/(?:\s(?:e|ou)|[,/])$/, '').replace(MARCADOR_NU_NO_FIM, '');
    if (sem === resto) break;
    resto = sem;
  }
  const palavra = (resto.match(/([\p{L}]+)[\s(]*$/u) || [])[1] || '';
  return PALAVRA_QUE_NOMEIA.test(palavra.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
}
// <<< pendencia:end
// O bloco vem inteiro para não divergir; aqui o marcador de tema não é usado.
void TEMA_MARKER;

// Situação do verbete no acervo: cópia do bloco canônico de src/situacao-acervo.js. O cartório não
// aceita como verificada a citação cuja cópia do acervo declara a súmula cancelada, revogada ou
// superada (a Súmula 228 do TST passava assim, 29/09/2026).
// >>> situacao-acervo:begin
/** Os valores que o campo `situacao` aceita (frontmatter do acervo e entrada do índice). */
const SITUACOES_DO_ACERVO = new Set(['vigente', 'cancelada', 'superada', 'revogada', 'parcialmente_cancelada', 'alterada']);
/** Situação que tira o verbete do fundamento: a citação não se verifica por ele. */
const SITUACOES_QUE_IMPEDEM = new Set(['cancelada', 'superada', 'revogada']);
/** Situação que deixa o verbete de pé, com a ressalva de conferir o trecho ou a redação citada. */
const SITUACOES_COM_AVISO = new Set(['parcialmente_cancelada', 'alterada']);

const MARCAS_DA_SITUACAO = [
  [/^PARCIALMENTE\s+CANCELAD[AO]S?\b/u, 'parcialmente_cancelada'],
  [/^CANCELAD[AO]S?\b/u, 'cancelada'],
  [/^SUPERAD[AO]S?\b/u, 'superada'],
  [/^REVOGAD[AO]S?\b/u, 'revogada'],
  [/^(?:ALTERAD|REVISAD|MODIFICAD)[AO]S?\b/u, 'alterada'],
];

/** `"Parcialmente cancelada"`, `parcialmente-cancelada` → `parcialmente_cancelada`. */
function normalizarSituacao(valor) {
  return String(valor ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

/**
 * O primeiro parágrafo depois do título `## <nome>` (linhas juntas por espaço, até a linha em branco
 * ou o próximo título), ou ''. Parágrafo, não linha: o livro antigo do TST quebra a nota da fonte no
 * meio ("(cancelada por perda de eficácia a partir de 11.11.2017, pela Lei" / "13.467/2017) – Res.").
 */
function primeiroParagrafoDaSecao(linhas, nome) {
  const i = linhas.findIndex((l) => nome.test(l));
  if (i < 0) return '';
  const partes = [];
  for (const linha of linhas.slice(i + 1)) {
    if (/^#{1,6}\s/.test(linha)) break;
    const limpa = linha.replace(/^[\s>*_]+/, '').trim();
    if (!limpa) {
      if (partes.length) break;
      continue;
    }
    partes.push(limpa);
  }
  return partes.join(' ');
}

// A nota do livro do TST abre o parêntese com a palavra da situação ("(mantida)", "(nova redação)",
// "(cancelada)", "(item I cancelado ...)"); parêntese de título ("(REFLEXOS)") não é nota. Vale a
// ÚLTIMA nota do parágrafo: "(nova redação) - Res. 121/2003 ... (cancelada em decorrência ...) -
// Res. 129/2005" é a súmula que ganhou redação nova e depois foi cancelada. A nota que o livro
// antigo deixou sem fechar no fim do parágrafo ("(cancelada por perda de eficácia ..., pela Lei") vale.
const NOTA_DO_LIVRO = /\(((?:mantida|cancelad[ao]|cancelamento|nova\s+reda[çc][ãa]o|reda[çc][ãa]o|alterad[ao]|atualizad[ao]|incorporad[ao]s?|convers[ãa]o|ite(?:m|ns)|republicad[ao]|aglutinad[ao])\b[^()]*)(?:\)|$)/giu;

/**
 * A situação que o arquivo declara. Devolve `{ situacao, origem, invalida }`: `situacao` é um dos
 * `SITUACOES_DO_ACERVO` ou null (nada declarado: vigente por padrão); `origem` diz de onde veio
 * (`frontmatter`, `situacao`, `fonte`); `invalida` traz o valor do frontmatter que não é situação
 * conhecida (ignorado, e o corpo decide).
 */
function situacaoDoTexto(texto) {
  const raw = String(texto ?? '').replace(/^\uFEFF/, '');
  let invalida = null;
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw.slice(0, 8192));
  if (fm) {
    const linha = /^situacao:[ \t]*(.*?)[ \t]*$/m.exec(fm[1]);
    const valor = linha ? normalizarSituacao(linha[1]) : '';
    if (valor && SITUACOES_DO_ACERVO.has(valor)) return { situacao: valor, origem: 'frontmatter', invalida: null };
    if (valor && valor !== 'null' && valor !== '~') invalida = linha[1].trim();
  }
  const corpo = fm ? raw.slice(fm.index + fm[0].length) : raw;
  const linhas = corpo.split(/\r?\n/);
  const naSituacao = primeiroParagrafoDaSecao(linhas, /^#{2,6}\s+Situa[çc][ãa]o\s*$/iu);
  for (const [marca, situacao] of MARCAS_DA_SITUACAO) {
    if (marca.test(naSituacao)) return { situacao, origem: 'situacao', invalida };
  }
  const naFonte = primeiroParagrafoDaSecao(linhas, /^#{2,6}\s+Fonte\s+de\s+publica[çc][ãa]o\s*$/iu);
  const notas = [...naFonte.matchAll(NOTA_DO_LIVRO)];
  const nota = notas.length ? notas[notas.length - 1][1].trim() : '';
  // "cancelada" sozinha, ou seguida de "por"/"em" ("por perda de eficácia", "em decorrência da sua
  // incorporação"): "cancelada a parte final da antiga redação" é histórico de súmula vigente.
  if (/^(?:cancelad[ao]|cancelamento\s+mantido)(?=$|[\s,;]+(?:por|em|a\s+partir)\b)/iu.test(nota)) return { situacao: 'cancelada', origem: 'fonte', invalida };
  if (/^ite(?:m|ns)\b.*\bcancelad[oa]s?\b/iu.test(nota)) return { situacao: 'parcialmente_cancelada', origem: 'fonte', invalida };
  return { situacao: null, origem: null, invalida };
}

/**
 * A frase que acompanha a situação na saída de quem consome o índice: "súmula cancelada: não
 * fundamente nela" (o que impede) ou o aviso de conferir o trecho (o que só ressalva).
 */
function mensagemDaSituacao(situacao, { sumula = true } = {}) {
  const s = normalizarSituacao(situacao);
  if (SITUACOES_QUE_IMPEDEM.has(s)) {
    return sumula ? `súmula ${s}: não fundamente nela` : `precedente ${s.replace(/a$/, 'o')}: não fundamente nele`;
  }
  if (s === 'parcialmente_cancelada') return 'súmula parcialmente cancelada: confira no documento se o item citado continua vigente';
  if (s === 'alterada') return 'súmula com redação alterada: cite a redação vigente, a do documento';
  return '';
}

/**
 * Cópia local de LEGISLAÇÃO (`acervo/legislacao/` do projeto ou `acervo/_packs/<pacote>/legislacao/`,
 * o pacote `acervo.legislacao`): o artigo como a curadoria o coletou no Planalto, com a data em
 * `coletado_ate`. Serve para achar o texto e a URL oficial (`fonte_url`), nunca para fechar a
 * citação: lei muda de redação, e a palavra final é a fonte oficial aberta no run (decisão do dono,
 * 06/10/2026). Súmula e julgado do acervo assinado seguem como antes.
 */
const RE_LEGISLACAO_LOCAL = /(^|[\\/])acervo[\\/](?:_packs[\\/][^\\/]+[\\/])?legislacao[\\/]/;
function ehLegislacaoLocal(caminho) {
  return typeof caminho === 'string' && RE_LEGISLACAO_LOCAL.test(caminho);
}

/** A data `coletado_ate` (AAAA-MM-DD) do frontmatter, ou null. */
function coletadoAteDoTexto(texto) {
  const fm = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(texto ?? '').slice(0, 8192));
  const linha = fm && /^coletado_ate:[ \t]*["']?(\d{4}-\d{2}-\d{2})["']?[ \t]*$/m.exec(fm[1]);
  return linha ? linha[1] : null;
}

/** O aviso da lei conferida só no texto local: de quando é o texto e o que fazer. */
function avisoDaLegislacaoLocal(coletadoAte) {
  return `o texto local da lei é a coleta da curadoria ${coletadoAte ? `de até ${coletadoAte}` : 'sem data de coleta'} e não fecha a citação: confira na fonte oficial (a fonte_url do artigo, por scripts/fonte-oficial.mjs); se ela não abrir, a citação fica pendente`;
}
// <<< situacao-acervo:end

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
const STATUS_CONTESTADA = new Set(['divergente', 'nao_encontrada', 'nao-encontrada', 'acesso_falhou', 'acesso-falhou', 'fonte_mudou', 'fonte-mudou', 'cancelada']);
// Súmula cancelada, revogada ou superada: contestação de mérito, como a não encontrada (reprova
// sempre, nenhum votante a reconfere). O cartório grava tudo como `cancelada`, com a `situacao`.
const STATUS_CANCELADA = 'cancelada';
const SITUACAO_POR_STATUS = { cancelada: 'cancelada', revogada: 'revogada', superada: 'superada' };

/**
 * A situação que a cópia do acervo lida declara, ou null: só vale para `fonte_local` dentro de
 * acervo/ (relativa à raiz do projeto, a pasta acima de squads/, ou absoluta) que exista no disco.
 */
function situacaoDaCopiaDoAcervo(dir, fonteLocal) {
  if (!ehCopiaDoAcervo(fonteLocal)) return null;
  const caminho = isAbsolute(fonteLocal) ? fonteLocal : resolve(dir, '..', '..', fonteLocal);
  let texto;
  try { texto = readFileSync(caminho, 'utf-8'); } catch { return null; }
  return situacaoDoTexto(texto).situacao;
}

/** A `coletado_ate` da cópia local de legislação lida, ou null (mesma resolução de caminho da situação). */
function coletadoAteDaCopia(dir, fonteLocal) {
  if (!ehLegislacaoLocal(fonteLocal)) return null;
  const caminho = isAbsolute(fonteLocal) ? fonteLocal : resolve(dir, '..', '..', fonteLocal);
  try { return coletadoAteDoTexto(readFileSync(caminho, 'utf-8')); } catch { return null; }
}
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

/**
 * Sinônimos do status que o verificador escreve fora do enum. Medido no run de 01/10/2026: uma
 * rodada devolveu "VERIFICADA" em maiúsculas e outra misturou "VERIFICADA" na tabela com
 * "verificada_no_acervo" no JSON; o chefe normalizou à mão. A caixa, o acento e o separador o
 * código já tira; o sinônimo vira o status do enum, e quem registra recebe aviso.
 */
const SINONIMOS_DE_STATUS = {
  verificado: 'verificada', conferida: 'verificada', conferido: 'verificada', confere: 'verificada', verified: 'verificada', ok: 'verificada',
  verificada_acervo: 'verificada_no_acervo', verificado_no_acervo: 'verificada_no_acervo', verificada_no_acervo_assinado: 'verificada_no_acervo', no_acervo: 'verificada_no_acervo', 'verificada_(acervo)': 'verificada_no_acervo',
  nao_verificada: 'nao_encontrada', inexistente: 'nao_encontrada', not_found: 'nao_encontrada',
};
function statusNormalizado(status) {
  const s = String(status || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
  return SINONIMOS_DE_STATUS[s.replace(/-/g, '_')] || s;
}

function lerCitacoesDoLedger(dir) {
  const bruto = lerLedgerBruto(dir) || {};
  const c = bruto.citacoes && typeof bruto.citacoes === 'object' ? bruto.citacoes : {};
  return { verificadas: { ...(c.verificadas || {}) }, contestadas: { ...(c.contestadas || {}) }, ...(c.tabelas ? { tabelas: { ...c.tabelas } } : {}), ...(c.legislacao_local ? { legislacao_local: { ...c.legislacao_local } } : {}) };
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
    for (const url of new Set([e.url, e.url_final].filter((u) => typeof u === 'string' && u).map(urlSemEntidades))) {
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
 * A URL sem entidade HTML (L5, HC de 27/09/2026, motor 0.9.60): o verificador copiou a `source_url`
 * do HTML da página, com "&amp;amp;" no lugar de "&", e a URL gravada não era a que se abre (nem a
 * do INDEX.jsonl da pesquisa). A entidade se desfaz até parar de mudar ("&amp;amp;" vira "&").
 */
function urlSemEntidades(url) {
  let atual = String(url ?? '').trim();
  for (let i = 0; i < 5; i += 1) {
    const proxima = atual.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
    if (proxima === atual) break;
    atual = proxima;
  }
  return atual;
}

/**
 * Registra a tabela de um verificador (JSON com `citations[]` no formato do
 * manifesto, ou um array). `verificada` exige `source_url` HTTPS e
 * `consulted_at`: sem os dois não é verificação, é afirmação, e o cartório a
 * recusa por item (fail-closed, sem derrubar o comando).
 */
function registrarCitacoes(dir, arquivo, { gate, reviewer }) {
  const caminho = isAbsolute(arquivo) ? arquivo : resolve(arquivo);
  // Arquivo vazio é a saída de um processo que não terminou, nunca "zero citações". Medido no run de
  // 09/10/2026: a reabertura do gate final rodou com `nohup … > reabertura.json &` dentro de um Bash
  // em segundo plano, a tarefa acabou na hora e o arquivo ficou com 0 bytes.
  const ehReabertura = /reabertura/i.test(basename(caminho));
  const semReabertura = 'a reabertura não terminou; rode de novo em primeiro plano com timeout de 10 min (600000 ms): node scripts/fonte-oficial.mjs --reabrir <manifesto> --out <run>/fontes --json --saida <run>/citacoes/reabertura.json';
  let bruto;
  try { bruto = readFileSync(caminho, 'utf-8'); } catch (erro) { return die(`--citacoes: não consegui ler ${caminho} (${erro.code || erro.message})${ehReabertura ? `: ${semReabertura}` : ''}`); }
  if (!bruto.trim()) return die(`--citacoes: ${caminho} está vazio (0 citações lidas, nada foi registrado): ${ehReabertura ? semReabertura : 'o retorno não foi gravado; use o arquivo que o hook gravou em _tmp/retornos/ (o .md do verificador também entra)'}`);
  let dados;
  try {
    dados = JSON.parse(bruto);
  } catch (erro) {
    if (ehReabertura) return die(`--citacoes: ${caminho} está incompleto (${erro.message}), nada foi registrado: ${semReabertura}`);
    // O retorno bruto do verificador (a tabela Markdown, como o hook SubagentStop o grava) também
    // entra: a hora da consulta é a do arquivo, gravado quando o retorno chegou.
    const tabela = tentarOuPadrao(() => citacoesDaTabelaDoVerificador(readFileSync(caminho, 'utf-8'), { consultadoEm: new Date(statSync(caminho).mtimeMs).toISOString() }), null);
    if (!tabela || !tabela.citations.length) return die(`--citacoes: JSON ilegível em ${caminho} (${erro.message}), e não há tabela de citações do verificador no arquivo`);
    dados = { citations: tabela.citations };
  }
  const entradas = Array.isArray(dados) ? dados : Array.isArray(dados && dados.citations) ? dados.citations : null;
  if (!entradas) die('--citacoes: esperado um array ou um objeto com `citations[]`');
  // Zero citações num JSON que tem ao lado o retorno do verificador com tabela é leitura perdida, não
  // conferência vazia (09/10/2026: o hook gravou `citations: []` de um retorno com 17 citações em
  // bloco JSON, o APROVADO passou e um segundo verificador refez as mesmas 17).
  if (!entradas.length && /\.json$/i.test(caminho)) {
    const retorno = caminho.replace(/\.json$/i, '.md');
    const lida = existsSync(retorno) ? tentarOuPadrao(() => citacoesDaTabelaDoVerificador(readFileSync(retorno, 'utf-8'), {}), null) : null;
    if (lida && lida.citations.length) return die(`--citacoes: ${basename(caminho)} tem 0 citações, mas o retorno do verificador ao lado (${retorno}) traz ${lida.citations.length}: o JSON perdeu a tabela e nada foi registrado. Registre o retorno: --citacoes ${retorno}`);
  }
  const ledger = lerCitacoesDoLedger(dir);
  // A mesma tabela não entra duas vezes (K25). Medido em 26/09/2026 (contrato social, motor 0.9.59):
  // a tabela do verificador, registrada no gate de citação às 21:40, foi passada de novo com o
  // veredito da revisão às 21:56; o cartório a aceitou como outra voz, a contestação do "art. 1.028,
  // I", já resolvida pela reescrita, voltou como fix crítico da revisão, e cada citação ganhou uma
  // confirmação falsa do "step-07-revisao". A identidade é o conteúdo (`citations[]` lido), não o
  // nome do arquivo: a tabela já registrada é ignorada, e a saída diz quando e por quem entrou.
  const hashDaTabela = createHash('sha256').update(JSON.stringify(entradas)).digest('hex');
  const jaRegistrada = ledger.tabelas && ledger.tabelas[hashDaTabela];
  if (jaRegistrada) {
    return {
      verificadas: 0, verificadas_no_acervo: 0, contestadas: 0, sem_evidencia: 0, reabertas_sem_evidencia: 0, recusadas: [], avisos: [], contestadas_itens: [], verificadas_itens: [], verificadas_no_acervo_itens: [],
      ja_registrada: { ...jaRegistrada, sha256: hashDaTabela, detail: `tabela já registrada em ${jaRegistrada.registrada_em} por ${jaRegistrada.reviewer || '(sem voz)'} no gate ${jaRegistrada.gate}: ignorada (a mesma conferência não conta duas vezes nem reabre contestação)` },
      total_verificadas: Object.keys(ledger.verificadas).length, total_contestadas: Object.keys(ledger.contestadas).length,
    };
  }
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
    if (typeof entrada.status === 'string' && entrada.status.trim() !== status && [STATUS_VERIFICADA, STATUS_NO_ACERVO, 'nao_encontrada'].includes(status)) {
      resumo.avisos.push(`"${title}": status "${entrada.status.trim()}" fora do formato, lido como ${status} (o formato é minúsculo: verificada, verificada_no_acervo, divergente, nao_encontrada)`);
    }
    if (status === STATUS_VERIFICADA || status === STATUS_NO_ACERVO) {
      const url = typeof entrada.source_url === 'string' ? urlSemEntidades(entrada.source_url) : '';
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
      // Lei cuja única evidência é o texto local de legislação (o pacote acervo.legislacao, ou
      // acervo/legislacao/ do projeto): o texto acha o artigo e a URL oficial, não fecha a citação
      // (decisão do dono, 06/10/2026). Fecha só a fonte oficial aberta no run: `verificada` com a
      // cópia da source_url no fontes/INDEX.jsonl. Sem ela, a citação fica pendente, a contestação
      // `acesso_falhou` anterior fica de pé, e o aviso diz de quando é o texto local.
      if (ehLegislacaoLocal(desta.fonte_local) && !(status === STATUS_VERIFICADA && indiceDeFontes && indiceDeFontes.porUrl.has(url))) {
        const coletado = coletadoAteDaCopia(dir, desta.fonte_local);
        const aviso = avisoDaLegislacaoLocal(coletado);
        if (ledger.contestadas[chave]) ledger.contestadas[chave] = { ...ledger.contestadas[chave], aviso_texto_local: aviso };
        ledger.legislacao_local = { ...(ledger.legislacao_local || {}), [chave]: { title, source_url: url, fonte_local: desta.fonte_local, coletado_ate: coletado, aviso, verificador: reviewer || '', gate, registrada_em: quando } };
        resumo.recusadas.push(`"${title}": ${status} só com o texto local de legislação (${desta.fonte_local}): ${aviso}`);
        continue;
      }
      const deOutra = hashDeOutraPagina(indiceDeFontes, url, desta);
      if (deOutra) {
        resumo.recusadas.push(`"${title}": ${deOutra}`);
        continue;
      }
      // A cópia do acervo lida declara a súmula cancelada, revogada ou superada: a citação existe,
      // e é isso que não basta. Entra como contestação `cancelada`, não como verificada (29/09/2026,
      // Súmula 228 do TST).
      const situacaoDaCopia = situacaoDaCopiaDoAcervo(dir, desta.fonte_local);
      if (SITUACOES_QUE_IMPEDEM.has(situacaoDaCopia)) {
        const mensagem = mensagemDaSituacao(situacaoDaCopia);
        delete ledger.verificadas[chave];
        ledger.contestadas[chave] = { title, status: STATUS_CANCELADA, situacao: situacaoDaCopia, observacao: `${mensagem} (${desta.fonte_local} declara a súmula ${situacaoDaCopia})`, verificador: reviewer || '', gate, registrada_em: quando };
        resumo.contestadas += 1;
        resumo.contestadas_itens.push({ title, status: STATUS_CANCELADA });
        resumo.avisos.push(`"${title}": veio como ${status}, mas ${desta.fonte_local} declara a súmula ${situacaoDaCopia}; registrada como cancelada (${mensagem})`);
        continue;
      }
      // Parcialmente cancelada ou alterada: a súmula está de pé e a conferência vale, com a ressalva.
      if (SITUACOES_COM_AVISO.has(situacaoDaCopia)) resumo.avisos.push(`"${title}": ${desta.fonte_local}: ${mensagemDaSituacao(situacaoDaCopia)}`);
      delete ledger.contestadas[chave];
      if (ledger.legislacao_local) delete ledger.legislacao_local[chave];
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
    if (STATUS_CONTESTADA.has(status) || SITUACAO_POR_STATUS[status]) {
      delete ledger.verificadas[chave];
      const observacao = typeof entrada.observacao === 'string' ? entrada.observacao : typeof entrada.motivo === 'string' ? entrada.motivo : '';
      if (SITUACAO_POR_STATUS[status]) {
        const situacao = SITUACAO_POR_STATUS[typeof entrada.situacao === 'string' && SITUACAO_POR_STATUS[entrada.situacao] ? entrada.situacao : status];
        ledger.contestadas[chave] = { title, status: STATUS_CANCELADA, situacao, observacao: observacao || mensagemDaSituacao(situacao), verificador: reviewer || '', gate, registrada_em: quando };
        resumo.contestadas += 1;
        resumo.contestadas_itens.push({ title, status: STATUS_CANCELADA });
        continue;
      }
      ledger.contestadas[chave] = { title, status, observacao, verificador: reviewer || '', gate, registrada_em: quando };
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
    resumo.recusadas.push(`"${title}": status "${entrada.status}" desconhecido (aceitos: verificada, verificada_no_acervo, divergente, nao_encontrada, cancelada, acesso_falhou, fonte_mudou, sem_evidencia)`);
  }
  ledger.tabelas = { ...(ledger.tabelas || {}), [hashDaTabela]: { arquivo: basename(caminho), reviewer: reviewer || '', gate, registrada_em: quando, entradas: entradas.length } };
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
/**
 * Pré-voo de citações (`--previa`), antes do Citation Gate: só o que se sabe sem verificador. A
 * remissão sem diploma no contexto (`sem_diploma`, que volta do gate ao redator) e a citação que a
 * pesquisa do run não traz (julgado, súmula ou Tema fora da pesquisa é `alta`: o redator só cita o
 * que a pesquisa trouxe; artigo de diploma da pesquisa que ela não abriu é `media`). Não toca o
 * cartório nem conta confirmação.
 */
function citacoesPrevia(dir, peca, flags) {
  const ledger = loadRunLedger(dir);
  const pesquisa = typeof flags.pesquisa === 'string' ? (isAbsolute(flags.pesquisa) ? flags.pesquisa : resolve(flags.pesquisa)) : ledger && ledger.runId ? pesquisaDoRun(dir, ledger.runId) : null;
  hookDeCitacoes(dir);
  const daPeca = citacoesDoArquivo(dir, peca);
  const daPesquisa = pesquisa && existsSync(pesquisa) ? citacoesDoArquivo(dir, pesquisa) : [];
  const chaveJur = (c) => `${c.classe}|${String(c.numero || '').replace(/\D/g, '')}`;
  const chaveLei = (c) => `${String(c.diploma || '').toLowerCase()}|${c.numeroLei || ''}|${String(c.artigo || '').replace(/\D/g, '')}`;
  const jurDaPesquisa = new Set(daPesquisa.filter((c) => c.classe !== 'lei').map(chaveJur));
  const leiDaPesquisa = new Set(daPesquisa.filter((c) => c.classe === 'lei' && !c.sem_diploma).map(chaveLei));
  const unicas = (lista, chave) => [...new Map(lista.map((c) => [chave(c), c])).values()];
  const semDiploma = unicas(daPeca.filter((c) => c.sem_diploma), (c) => `${c.bruto}|${c.linha}`).map((c) => ({ bruto: c.bruto, linha: c.linha, gravidade: 'alta', fix: `alta: nomeie o diploma junto de "${c.bruto}" (linha ${c.linha}): CC, art. N ou art. N do CPC` }));
  const foraJur = pesquisa ? unicas(daPeca.filter((c) => c.classe !== 'lei' && !jurDaPesquisa.has(chaveJur(c))), chaveJur).map((c) => ({ bruto: c.bruto, linha: c.linha, gravidade: 'alta', fix: `alta: "${c.bruto}" (linha ${c.linha}) não está na pesquisa do run; tire, ou peça o complemento da pesquisa` })) : [];
  const foraLei = pesquisa ? unicas(daPeca.filter((c) => c.classe === 'lei' && !c.sem_diploma && !leiDaPesquisa.has(chaveLei(c))), chaveLei).map((c) => ({ bruto: c.bruto, linha: c.linha, gravidade: 'media' })) : [];
  const alta = semDiploma.length + foraJur.length;
  console.log(JSON.stringify({
    peca,
    previa: true,
    pesquisa: pesquisa || null,
    sem_diploma: semDiploma,
    fora_da_pesquisa: foraJur,
    artigos_fora_da_pesquisa: foraLei,
    acao: alta ? 'corrigir-antes-do-gate' : 'seguir-para-o-gate',
    detail: `${daPeca.length} dispositivo(s) na peça; ${semDiploma.length} sem diploma; ${foraJur.length} julgado(s), súmula(s) ou Tema(s) fora da pesquisa; ${foraLei.length} artigo(s) que a pesquisa não abriu${pesquisa ? '' : ' (sem pesquisa no run: só o sem diploma foi conferido)'}. O Citation Gate roda depois, igual.`,
  }, null, 2));
  return null;
}

/**
 * O lote do verificador de citações, por tamanho: o dispositivo de lei pesa 1, súmula, OJ, PN e Tema
 * pesam 2, o acórdão (inteiro teor, trecho longo na evidência) pesa 3, e cada lote vai até
 * PESO_DO_LOTE_DE_CITACOES. A mesma citação (o mesmo trecho) fica num lote só. Medido no m2g da 0.9.83:
 * o verificador com a lista inteira do gate final devolveu a resposta cortada e o run ficou 25 minutos
 * parado.
 */
const PESO_DO_LOTE_DE_CITACOES = 12;
function pesoDaCitacao(item) {
  const classe = String(item.classe || '').toLowerCase();
  if (classe === 'lei') return 1;
  if (['sumula', 'oj', 'pn', 'tema'].includes(classe)) return 2;
  if (classe) return 3;
  const t = String(item.title || item.bruto || '');
  if (/\b(?:REsp|AREsp|RE|ARE|HC|RHC|AgInt|AgRg|EDcl|RR|AIRR|E-RR|ADI|ADC|ADPF|MS|RMS|Rcl|IRDR|Ap(?:Civ|elação)?)\b|\d{7}-\d{2}\.\d{4}/.test(t)) return 3;
  if (/\b(?:s[úu]mula|tema|OJ|PN)\b/i.test(t)) return 2;
  return 1;
}
function lotesDeCitacoes(itens, chaveDe) {
  const grupos = [];
  for (const it of itens) {
    const k = chaveDe(it);
    const g = grupos.find((x) => x.chave === k);
    if (g) g.itens.push(it); else grupos.push({ chave: k, itens: [it], peso: pesoDaCitacao(it) });
  }
  const lotes = [];
  for (const g of grupos) {
    const ultimo = lotes[lotes.length - 1];
    if (ultimo && ultimo.peso + g.peso <= PESO_DO_LOTE_DE_CITACOES) { ultimo.itens.push(...g.itens); ultimo.peso += g.peso; } else lotes.push({ itens: [...g.itens], peso: g.peso });
  }
  return lotes.map((l, i) => ({ lote: i + 1, peso: l.peso, itens: l.itens }));
}

function cmdCitacoesPendentes(dir, flags) {
  if (typeof flags.peca !== 'string') die('citacoes-pendentes requer --peca <caminho real da minuta>');
  const peca = isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca);
  if (!existsSync(peca)) die(`peça não encontrada: ${peca}`);
  if (flags.previa === true) return citacoesPrevia(dir, peca, flags);
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
  // Pelo título e, no que sobrar, pela chave canônica (entrada sem diploma no título, com a fonte
  // do mesmo diploma): a remissão registrada com outro título não volta a pendente (K10).
  const saida = coberturaComChave(dir, peca, verificadas);
  const reaproveitadas = [...new Set(saida.cobertas.map((c) => c.titulo))].map((i) => verificadas[i]);
  const contestadas = Object.values(ledger.contestadas);
  // Lei que um verificador trouxe só com o texto local de legislação: o cartório recusou, e a lista
  // diz de quando é o texto e que a conferência é na fonte oficial (some quando ela confirma).
  const soNoTextoLocal = Object.entries(ledger.legislacao_local || {}).filter(([k]) => !ledger.verificadas[k]).map(([, v]) => ({ title: v.title, source_url: v.source_url, fonte_local: v.fonte_local, coletado_ate: v.coletado_ate, aviso: v.aviso }));
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
  // A lista grande vai ao verificador em lotes, para a resposta não sair cortada.
  const aVerificar = acao === 'verificar-pendentes' ? pendentes.filter((p) => !p.sem_diploma) : acao === 'confirmar-consenso' ? pendentesDeConsenso : [];
  const lotes = lotesDeCitacoes(aVerificar, (it) => it.bruto || it.title);
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
    ...(soNoTextoLocal.length ? { legislacao_so_no_texto_local: soNoTextoLocal } : {}),
    acao,
    ...(lotes.length > 1 ? { lotes } : {}),
    ...(semDiploma.length ? { sem_diploma: semDiploma.length } : {}),
    detail: acao === 'verificar-pendentes'
      ? `${pendentes.length} dispositivo(s) citado(s) sem veredito nesta versão; ${reaproveitadas.length} citação(ões) já conferida(s) neste run${pendentesDeConsenso.length ? `; ${pendentesDeConsenso.length} ainda sem ${exigidas} confirmações` : ''} (${contas}: artigo, parágrafo e inciso contam à parte)${semDiploma.length ? `; ${semDiploma.length} remissão(ões) sem diploma no contexto (\`sem_diploma\`): vão ao redator, que nomeia o diploma no texto (${[...new Set(semDiploma.map((p) => `"${p.bruto}", linha ${p.linha}`))].slice(0, 5).join('; ')})` : ''}`
      : acao === 'confirmar-consenso'
        ? final
          ? `gate final: ${pendentesDeConsenso.length} de ${total} citação(ões) sem confirmação nova com evidência (idêntica por código ou de um votante) ou abaixo de ${exigidas} confirmações; despache ao menos um votante com a lista (${contas})`
          : `todas as ${total} citações do texto já foram conferidas neste run; ${pendentesDeConsenso.length} ainda não soma(m) ${exigidas} confirmações distintas (${contas})`
        : `todas as ${total} citações do texto (${saida.total} dispositivos: artigo, parágrafo e inciso contam à parte) já foram conferidas neste run${exigidas > 1 ? `, cada uma com ${exigidas} ou mais confirmações` : ''}${final ? ' e uma confirmação nova com evidência no gate final' : ''}; nenhum verificador a despachar`,
  };
  if (lotes.length > 1) resultado.detail += `; a lista vai em ${lotes.length} lotes por tamanho (\`lotes\`, até ${PESO_DO_LOTE_DE_CITACOES} de peso cada: lei 1, súmula e Tema 2, acórdão 3): um verificador por lote, cada um só com a lista do seu lote, como vozes do mesmo ciclo`;
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
// ── Casar pela chave canônica (K10) ────────────────────────────────────────────────────────
// Medido em 26/09/2026 (defesa de auto de infração, motor 0.9.58): "(Decreto nº 6.514/2008, arts.
// 15-A e 108)" foi conferida e registrada com o título "art. 108", sem o diploma, e source_url do
// d6514.htm; o `citacoes-pendentes` seguiu listando o art. 108 como pendente, porque o título não
// nomeia o diploma, e o chefe a registrou de novo com o título canônico. A citação é a mesma: o
// diploma está na fonte aberta. O cartório casa a entrada sem diploma no título com a citação do
// texto quando a `source_url` é do mesmo diploma (planalto: l<N>, d<N>, del<N>, lcp<N>, mpv<N>;
// a Constituição) e o título, completado com o diploma do texto, cobre a citação pelo extrator do
// hook (mesmo artigo, mesmo dispositivo). Título com diploma nunca é completado.
const DIPLOMA_NO_TITULO = /\b(?:lei|leis|decreto|decretos|decreto-lei|resolu\w*|portaria|instru\w*|provimentos?|medida|emenda|lc|dl|mp|ec|cf|crfb|cpc|ncpc|cpp|cc|ccb|cp|cpb|clt|cdc|ctn|ctb|lep|eca|lindb|constitui\w*|c[óo]digo|estatuto|s[úu]mula|tema|resp|re|hc)\b/i;
const CODIGO_POR_NUMERO = { 13105: 'cpc', 10406: 'cc', 5452: 'clt', 8078: 'cdc', 5172: 'ctn', 3689: 'cpp', 2848: 'cp', 7210: 'lep', 8069: 'eca', 4737: 'ce', 9503: 'ctb', 4657: 'lindb' };
const RE_DIPLOMA_NO_TRECHO = /\b((?:lei\s+complementar|lei|decreto-lei|decreto|resolu[çc][ãa]o|portaria|instru[çc][ãa]o\s+normativa|provimento(?:\s+conjunto)?|c[óo]digo\s+de\s+normas|medida\s+provis[óo]ria|emenda\s+constitucional)(?:\s+[A-Za-zÀ-ú]{2,12}\.?){0,2}\s*(?:n[º°o.]*\s*)?\d[\d.]*(?:\/\d{2,4})?)/i;

/** O diploma que a `source_url` aponta: `{ numero }` (lei, decreto) ou `{ sigla: 'cf' }`; null quando não se lê. */
function diplomaDaUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/\/constituicao\/constituicao/.test(u)) return { sigla: 'cf' };
  const m = u.match(/\/(?:l|d|del|lcp|mpv)(\d+)(?:compilad[oa])?\.html?\b/);
  return m ? { numero: String(Number(m[1])) } : null;
}

/** O diploma da citação do texto: `{ numero }` pela lei, `{ sigla }` pelo código. */
function diplomaDaCitacao(c) {
  const numero = String(c.numeroLei || '').split('/')[0].replace(/\D/g, '');
  if (numero) return { numero: String(Number(numero)), sigla: CODIGO_POR_NUMERO[Number(numero)] || null };
  return c.diploma && c.diploma !== 'lei' ? { sigla: c.diploma } : null;
}

/** Como o texto nomeia o diploma da citação ("Decreto nº 6.514/2008", "CPC"), para completar o título. */
function rotuloDoDiploma(c) {
  const doTrecho = String(c.bruto || '').match(RE_DIPLOMA_NO_TRECHO);
  if (doTrecho) return doTrecho[1].replace(/\s+/g, ' ').trim();
  if (c.diploma && c.diploma !== 'lei') return c.diploma.toUpperCase();
  return c.numeroLei ? `Lei nº ${c.numeroLei}` : null;
}

function mesmoDiploma(daUrl, daCitacao) {
  if (!daUrl || !daCitacao) return false;
  if (daUrl.sigla) return daUrl.sigla === daCitacao.sigla;
  return daUrl.numero === daCitacao.numero || (daCitacao.sigla && CODIGO_POR_NUMERO[Number(daUrl.numero)] === daCitacao.sigla);
}

/**
 * A cobertura do texto pelas entradas do cartório, pelo título (hook) e, para o que sobrar, pela
 * chave canônica: entrada sem diploma no título, com `source_url` do diploma da citação, cujo título
 * completado com o diploma do texto cobre a citação. Devolve a saída do hook com essas descobertas
 * passadas a `cobertas`, cada uma com `titulo_canonico` (o título completado, que vai ao manifesto).
 */
/**
 * Entrada do cartório que enumera mais de uma súmula ou tema no título ("Súmulas 718 e 719 do STF",
 * "Súmula 718 do STF; Súmula 719 do STF") tem uma fonte só: atestaria as duas com a evidência de uma.
 * Medido no run m9 (06/10/2026): a meta reprovou a citação que a entrada única dava por verificada.
 * Essa entrada não cobre nada; cada número vai pendente e se registra à parte.
 */
function numerosDeSumulaOuTema(titulo) {
  const t = String(titulo || '');
  const numeros = [];
  for (const m of t.matchAll(/\b(s[úu]mulas?|temas?)\s+(?:vinculantes?\s+)?(?:n[º°.o]*\s*)?(\d[\d.]*(?:\s*(?:,|\be\b)\s*(?:n[º°.o]*\s*)?\d[\d.]*)*)/gi)) {
    for (const n of m[2].match(/\d[\d.]*/g) || []) numeros.push(`${m[1].toLowerCase().replace(/s$/, '').replace('ú', 'u')}:${n.replace(/\D/g, '')}`);
  }
  return [...new Set(numeros)];
}
const entradaComVariasSumulas = (e) => numerosDeSumulaOuTema(e && e.title).length > 1;

function coberturaComChave(dir, peca, todas) {
  const plurais = todas.filter(entradaComVariasSumulas);
  if (plurais.length) console.error(`cartório: ${plurais.length} entrada(s) com mais de uma súmula ou tema no título não cobrem a peça (uma fonte não atesta duas): ${plurais.map((e) => `"${e.title}"`).join(', ')}; registre cada número com a sua fonte`);
  const entradas = todas.filter((e) => !entradaComVariasSumulas(e));
  const saida = coberturaPeloHook(dir, peca, entradas.map((e) => e.title));
  const semDiploma = entradas.map((e, i) => ({ e, i })).filter(({ e }) => /\bart/i.test(String(e.title || '')) && !DIPLOMA_NO_TITULO.test(String(e.title || '')) && diplomaDaUrl(e.source_url));
  if (!semDiploma.length || !saida.descobertas.length) return saida;
  const candidatos = [];
  for (const c of saida.descobertas) {
    if (c.classe !== 'lei' || c.sem_diploma) continue;
    const rotulo = rotuloDoDiploma(c);
    const daCitacao = diplomaDaCitacao(c);
    if (!rotulo || !daCitacao) continue;
    for (const { e, i } of semDiploma) {
      if (mesmoDiploma(diplomaDaUrl(e.source_url), daCitacao)) candidatos.push({ chave: c.chave, indice: i, titulo: `${rotulo}, ${String(e.title).trim()}` });
    }
  }
  if (!candidatos.length) return saida;
  // Um título por candidato distinto: o título completado sai da ENTRADA ("CPC, art. 85, § 11"), e
  // toda citação do mesmo diploma ainda descoberta gera um candidato com o mesmo título. O hook
  // devolve, para cada citação coberta, o índice do PRIMEIRO título que a cobre; com a lista
  // repetida, era sempre o candidato de outra citação (o art. 1.009), a chave não batia e a remissão
  // voltava a pendente. Medido no teste com autos reais de 27/09/2026 (P7, apelação, motor 0.9.62):
  // "art. 85, § 11" registrado duas vezes com a fonte do CPC ficou pendente até o texto nomear o CPC.
  const titulos = [...new Set(candidatos.map((k) => k.titulo))];
  const conferida = coberturaPeloHook(dir, peca, titulos);
  const casadas = new Map();
  for (const c of conferida.cobertas) {
    const k = candidatos.find((x) => x.titulo === titulos[c.titulo] && x.chave === c.chave);
    if (k && !casadas.has(c.chave)) casadas.set(c.chave, k);
  }
  if (!casadas.size) return saida;
  return {
    ...saida,
    cobertas: [...saida.cobertas, ...saida.descobertas.filter((c) => casadas.has(c.chave)).map((c) => ({ ...c, titulo: casadas.get(c.chave).indice, titulo_canonico: casadas.get(c.chave).titulo, casada_por: 'chave-canonica' }))],
    descobertas: saida.descobertas.filter((c) => !casadas.has(c.chave)),
  };
}

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

/**
 * O título de seção que a linha é, ou ''. Três formas: o título de Markdown ("## Síntese"), a
 * linha inteira em negrito ("**CLÁUSULA 7ª. ADMINISTRAÇÃO E USO DO NOME**") e a linha curta em
 * caixa alta, numerada ou não ("1. DO AUTOR DA HERANÇA.", "ANEXO II. RELAÇÃO DE DOCUMENTOS (na
 * ordem da matriz)", "REQUERIMENTO AO 1º TABELIONATO"). Na caixa alta, o que vem entre parênteses
 * pode ter minúscula e sai do rótulo. Linha de tabela, lista, citação ou com marcador nunca é título.
 */
function tituloDaLinha(linha) {
  const h = linha.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
  if (h) return semMarkdown(h[1]);
  if (/^\s*(?:[|>]|[-*+]\s)/.test(linha) || linha.includes('[')) return '';
  const negrito = linha.match(/^\s*\*\*([^*]{2,120}?)\*\*\s*$/);
  if (negrito) return semMarkdown(negrito[1]).replace(/[.:]$/, '');
  const texto = semMarkdown(linha);
  if (!texto || texto.length > 160 || /[,;]$/.test(texto)) return '';
  const rotulo = texto.split('(')[0].trim();
  if (/\p{Ll}/u.test(rotulo) || (rotulo.match(/\p{Lu}/gu) || []).length < 3) return '';
  return rotulo.replace(/[.:]$/, '');
}

/**
 * Onde está a ocorrência: a seção real acima (título de Markdown, cláusula em negrito, título em
 * caixa alta, anexo), o item numerado da própria linha ("item 8.3"), a linha da tabela ou a
 * abertura em negrito do parágrafo, e a linha. Medido em 26/09/2026 (K17, inventário extrajudicial,
 * motor 0.9.59): a escritura só tinha um título de Markdown ("## Síntese do ato"), e as 48
 * pendências da final saíram como "Síntese do ato, linha N", as das cláusulas 1 a 12 e as dos
 * anexos; no contrato social, as das cláusulas em negrito saíam como "CONTRATO SOCIAL CONSOLIDADO".
 */
function localNaPeca(linhas, indice) {
  let secao = '';
  for (let i = indice; i >= 0; i -= 1) {
    const titulo = tituloDaLinha(linhas[i]);
    if (titulo) { secao = titulo; break; }
  }
  const linha = linhas[indice];
  const item = linha.match(/^\s*(?:\*\*)?(\d+(?:\.\d+)+)\.?(?:\*\*)?\s/);
  const celula = linha.match(/^\s*\|\s*([^|\n]{1,12}?)\s*\|/);
  const abertura = linha.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?\*\*([^*]{2,90}?)\*\*/);
  const paragrafo = abertura && !tituloDaLinha(linha) ? semMarkdown(abertura[1]).replace(/[.:]$/, '') : '';
  const aqui = item ? `item ${item[1]}` : celula && !/^[-:\s]+$/.test(celula[1]) ? `linha "${semMarkdown(celula[1])}" da tabela` : paragrafo ? `parágrafo "${paragrafo}"` : '';
  const partes = [secao, aqui].filter(Boolean);
  return `${partes.length ? partes.join(', ') : 'corpo da peça'}, linha ${indice + 1}`;
}

/** Lê `--pendencias <json>`: array, ou objeto com `pendencias_do_profissional[]`. */
function lerPendenciasInformadas(arquivo) {
  const caminho = isAbsolute(arquivo) ? arquivo : resolve(arquivo);
  // Arquivo vazio é a saída de um processo que não terminou, nunca "zero citações". Medido no run de
  // 09/10/2026: a reabertura do gate final rodou com `nohup … > reabertura.json &` dentro de um Bash
  // em segundo plano, a tarefa acabou na hora e o arquivo ficou com 0 bytes.
  const ehReabertura = /reabertura/i.test(basename(caminho));
  const semReabertura = 'a reabertura não terminou; rode de novo em primeiro plano com timeout de 10 min (600000 ms): node scripts/fonte-oficial.mjs --reabrir <manifesto> --out <run>/fontes --json --saida <run>/citacoes/reabertura.json';
  let bruto;
  try { bruto = readFileSync(caminho, 'utf-8'); } catch (erro) { return die(`--citacoes: não consegui ler ${caminho} (${erro.code || erro.message})${ehReabertura ? `: ${semReabertura}` : ''}`); }
  if (!bruto.trim()) return die(`--citacoes: ${caminho} está vazio (0 citações lidas, nada foi registrado): ${ehReabertura ? semReabertura : 'o retorno não foi gravado; use o arquivo que o hook gravou em _tmp/retornos/ (o .md do verificador também entra)'}`);
  let dados;
  try {
    dados = JSON.parse(bruto);
  } catch (erro) {
    if (ehReabertura) return die(`--citacoes: ${caminho} está incompleto (${erro.message}), nada foi registrado: ${semReabertura}`);
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
function pendenciasDoTexto(texto, informadas, { versao = null } = {}) {
  const defasados = [];
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
  // A nota ao revisor que recapitula os marcadores da peça não é outra pendência (L15): a mesma
  // contagem do hook, pela `ocorrenciasDePendencia` do bloco `pendencia`.
  // A menção ao marcador na nota ("Nenhum item [NÃO VERIFICADO]", "marcadores [CONFIRMAR] e
  // [DILIGÊNCIA]") também fica fora: nomeia o marcador, não o usa (L17 e L18).
  const repetidas = new Set(ocorrenciasDePendencia(texto).filter((o) => o.mencao || (o.repeteDaPeca && DATA_MARKER.test(o.marcador))).map((o) => o.indice));
  for (const achado of texto.matchAll(re)) {
    if (repetidas.has(achado.index)) continue;
    const literal = marcadorNormalizado(achado[0]);
    const linha = linhaDe(achado.index);
    if (!DATA_MARKER.test(achado[0])) { deCitacao.push({ marcador: literal, linha: linha + 1 }); continue; }
    const k = usadas.get(literal) || 0;
    usadas.set(literal, k + 1);
    const doProfissional = informadas.get(literal) || [];
    const entrada = doProfissional[Math.min(k, doProfissional.length - 1)] || {};
    const aqui = localNaPeca(linhas, linha);
    const informado = textoDe(doProfissional[k] && doProfissional[k].onde);
    const defasado = informado ? ondeDefasado(informado, linha, versao) : null;
    // O `onde` informado que cita a linha certa é a localização que o próprio comando gerou numa
    // chamada anterior (o chefe copia o `modelo` e completa procurado_em e diligencia): vale a
    // localização de agora, lida do texto. Foi assim que as 48 pendências da final do inventário
    // (K17, 26/09/2026) ficaram com "Síntese do ato". Sem linha, o `onde` é texto de quem conferiu.
    const onde = informado && !defasado && !/\blinhas?\s+\d+/i.test(informado) ? informado : aqui;
    const item = { marcador: literal, onde, procurado_em: textoDe(entrada.procurado_em), diligencia: textoDe(entrada.diligencia) };
    if (defasado) defasados.push({ marcador: literal, informado, na_peca: aqui, motivo: defasado });
    if (!item.procurado_em || !item.diligencia) faltam.push(item);
    pendencias.push(item);
  }
  const sobrando = [...informadas.keys()].filter((m) => !usadas.has(m));
  return { pendencias, faltam, deCitacao, sobrando, defasados };
}

/**
 * O `onde` informado em `--pendencias` aponta outra versão da peça: a linha que ele cita não é a
 * do marcador neste texto, ou ele nomeia uma pasta `vN` que não é a da peça. Devolve o motivo, ou
 * null. Medido em 26/09/2026 (locação, motor 0.9.58): o pendencias.json da v11 serviu à v7 (e o da
 * v7 à v11), com as linhas deslocadas em duas pela definição nova do Aluguel, e o manifesto gravou
 * oito `onde` que apontavam a linha errada.
 */
function ondeDefasado(informado, indice, versao) {
  const linhaInformada = Number(String(informado).match(/\blinhas?\s+(\d+)/i)?.[1]);
  if (linhaInformada && linhaInformada !== indice + 1) return `cita a linha ${linhaInformada}, e o marcador está na linha ${indice + 1} desta versão`;
  const outra = String(informado).match(/(?:^|[\s/(])(v\d+)(?=[\s/),.;:]|$)/)?.[1];
  if (versao && outra && outra !== versao) return `cita a pasta ${outra}, e a peça está em ${versao}`;
  return null;
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

// Conferências de entrega: cópia VERBATIM de src/conferencias-de-entrega.js.
// Datas depois da data legal e convites de agenda: canônico em `src/datas-legais.js` (bloco `datas-legais`).
// >>> datas-legais:begin
const semAcentoDasDatas = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** As datas dd/mm[/aaaa] do texto, com o ano do contexto quando faltar. Devolve `{ iso, indice, bruto }`. */
function datasDoTexto(texto, anoPadrao = null) {
  const t = String(texto ?? '');
  const brutas = [...t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)];
  const anoDoTexto = brutas.map((m) => m[3]).find((a) => a && a.length === 4) || anoPadrao || String(new Date().getFullYear());
  const out = [];
  for (const m of brutas) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    const ano = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : anoDoTexto;
    out.push({ iso: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, indice: m.index, bruto: m[0] });
  }
  return out;
}

/** Palavra que faz da data uma alternativa (hipótese, condição), lida sem acento. */
const DATA_ALTERNATIVA = /\b(?:se|caso|hipoteses?|alternativ\w*)\b/;
/** A marca explícita de que a data alternativa não vale. */
const DATA_NAO_USAR = /\bnao usar\b|\bnunca usar\b|\bnao vale\b|\bdescartad\w*\b|\bafastad\w*\b|\bnao se aplica\b/;
/** O que separa as cláusulas de um trecho: ponto e vírgula, colchete, barra de tabela, fim de frase. */
const SEPARADOR_DE_CLAUSULA = /[;[\]|]|\.\s/g;

/** O começo e o fim da cláusula em que está a posição `i` do texto. */
function clausulaEm(texto, i) {
  let inicio = 0;
  let fim = texto.length;
  for (const m of texto.matchAll(SEPARADOR_DE_CLAUSULA)) {
    if (m.index < i) inicio = m.index + 1;
    else { fim = m.index; break; }
  }
  return { inicio, fim, texto: texto.slice(inicio, fim) };
}

/**
 * As datas apresentadas como alternativa (cláusula condicional) depois da data legal calculada, num
 * texto de uma linha só (linha da final, descrição de convite). A data legal de referência é a mais
 * próxima antes da cláusula, no mesmo trecho, entre as `legais` (ISO). A cláusula que diz "não usar"
 * (ou "descartada", "afastada") não conta. Devolve `{ data, legal, trecho }`.
 */
function alternativasDepoisDaLegalNoTrecho(trecho, legais, anoPadrao = null) {
  const t = String(trecho ?? '');
  const datas = datasDoTexto(t, anoPadrao);
  const conjunto = legais instanceof Set ? legais : new Set(legais || []);
  const achados = [];
  for (const d of datas) {
    const c = clausulaEm(t, d.indice);
    const clausula = semAcentoDasDatas(c.texto);
    if (!DATA_ALTERNATIVA.test(clausula) || DATA_NAO_USAR.test(clausula)) continue;
    const antes = datas.filter((x) => x.indice < c.inicio && conjunto.has(x.iso));
    if (!antes.length) continue;
    const legal = antes[antes.length - 1].iso;
    if (d.iso > legal) achados.push({ data: d.iso, legal, trecho: c.texto.trim().slice(0, 200) });
  }
  return achados;
}

/** Na final (sem a nota ao revisor, que o chamador tira), linha a linha: `{ linha, data, legal, trecho }`. */
function datasDepoisDaLegal(texto, legais) {
  const linhas = String(texto ?? '').split('\n');
  const ano = (String(texto ?? '').match(/\b\d{1,2}\/\d{1,2}\/(\d{4})\b/) || [])[1] || null;
  return linhas.flatMap((l, k) => alternativasDepoisDaLegalNoTrecho(l, legais, ano).map((a) => ({ linha: k + 1, ...a })));
}

/** O texto de uma propriedade do iCalendar, com as linhas desdobradas e os escapes desfeitos. */
function propriedadesDoIcs(ics) {
  const linhas = String(ics ?? '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  return linhas.map((l) => {
    const m = l.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    return m ? { nome: m[1], parametros: m[2], valor: m[3].replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1') } : null;
  }).filter(Boolean);
}

/**
 * No convite (.ics): a data alternativa da descrição depois da data legal, e o evento marcado depois
 * da data legal que a própria descrição declara ("Data legal: 06/10/2026"). `{ evento, data, legal, trecho }`.
 */
function convitesDepoisDaLegal(ics, legais) {
  const achados = [];
  let evento = null;
  for (const p of propriedadesDoIcs(ics)) {
    if (p.nome === 'BEGIN' && p.valor === 'VEVENT') evento = { props: [] };
    else if (p.nome === 'END' && p.valor === 'VEVENT' && evento) {
      const pega = (n) => evento.props.find((x) => x.nome === n);
      const inicio = pega('DTSTART');
      const dataDoEvento = inicio ? `${inicio.valor.slice(0, 4)}-${inicio.valor.slice(4, 6)}-${inicio.valor.slice(6, 8)}` : null;
      const texto = [pega('SUMMARY'), pega('DESCRIPTION')].filter(Boolean).map((x) => x.valor).join(' | ');
      const declarada = texto.match(/\bdata legal(?: anotada)?:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const legalDeclarada = declarada ? datasDoTexto(declarada[1])[0].iso : null;
      // A data legal que o convite declara é a do prazo dele; sem ela, as do run.
      const conjunto = new Set(legalDeclarada ? [legalDeclarada] : (legais || []));
      const resumo = pega('SUMMARY') ? pega('SUMMARY').valor : '';
      for (const a of alternativasDepoisDaLegalNoTrecho(texto, conjunto, dataDoEvento ? dataDoEvento.slice(0, 4) : null)) achados.push({ evento: resumo, ...a });
      if (dataDoEvento && legalDeclarada && dataDoEvento > legalDeclarada) achados.push({ evento: resumo, data: dataDoEvento, legal: legalDeclarada, trecho: 'a data do evento vem depois da data legal que o convite declara' });
      evento = null;
    } else if (evento) evento.props.push(p);
  }
  return achados;
}

/** Os JSON do run com `data_limite` (a saída das calculadoras de prazo), fora de `_meta`, do pacote e das fontes. */
function saidasDeCalculadora(runDir) {
  const achados = [];
  const andar = (d, nivel) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const c = join(d, e.name);
      if (e.isDirectory()) { if (nivel < 3 && !['_meta', 'pacote', 'fontes', 'citacoes', 'despachos', 'persuasao'].includes(e.name)) andar(c, nivel + 1); continue; }
      if (!e.name.endsWith('.json') || /-entrada\.json$/.test(e.name)) continue;
      try { const v = JSON.parse(readFileSync(c, 'utf-8')); if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.data_limite === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.data_limite)) achados.push(c); } catch { /* não é JSON */ }
    }
  };
  andar(runDir, 0);
  return achados.sort();
}

/** As datas legais calculadas no run (o `data_limite` de cada saída de calculadora), em ISO. */
function datasLegaisDoRun(runDir) {
  const out = new Set();
  for (const f of saidasDeCalculadora(runDir)) { try { out.add(JSON.parse(readFileSync(f, 'utf-8')).data_limite); } catch { /* lida acima */ } }
  return out;
}
// <<< datas-legais:end

// >>> conferencias-de-entrega:begin
// Padrões medidos na 1a rodada por molde (01/10/2026, motor 0.9.80): anexo citado na final e ausente do
// pacote (m2: "segue anexa como arquivo próprio (contingencia.md)"; m3: "a saída íntegra no Anexo I
// deste parecer"); ponto aprovado no diagnóstico que some da final (m4: a cl. 8.1, no ponto 4 do
// foco); premissa marcada [CONFIRMAR] que entra no total sem linha própria (m2: contribuição de
// 20%); documento à contraparte no mesmo arquivo do roteiro interno (m4).

const semAcentoDaEntrega = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** O texto sem o bloco da nota ao revisor (linhas trocadas por vazias, para as linhas não mudarem). */
function pecaSemNota(texto) {
  let dentro = false;
  return String(texto ?? '').split('\n').map((l) => {
    const m = l.match(LINHA_DA_NOTA_AO_REVISOR);
    if (m) { dentro = m[1] === 'inicio'; return ''; }
    return dentro ? '' : l;
  }).join('\n');
}

/** Arquivos do run por nome (versões `vN/` e a raiz do run; nunca `_meta`, `_tmp` nem `pacote`). */
function arquivosDoRunPorNome(runDir) {
  const mapa = new Map();
  const andar = (d, nivel) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('_') || e.name.startsWith('.') || e.name === 'pacote') continue;
      const c = join(d, e.name);
      if (e.isDirectory()) { if (nivel < 3) andar(c, nivel + 1); continue; }
      const atual = mapa.get(e.name);
      // A versão mais alta vence: `v12/contingencia.md` sobre `v2/contingencia.md`.
      const v = Number((c.match(/\/v(\d+)\//) || [])[1] || 0);
      if (!atual || v > atual.v) mapa.set(e.name, { caminho: c, v });
    }
  };
  andar(runDir, 0);
  return mapa;
}

const ANEXO_PROPRIO = /\banex[oa]s?\b[^.\n]{0,60}?\b(?:a|deste|desta|a este|a esta|neste|nesta)\s+(?:parecer|relatorio|peca|peticao|roteiro|documento|minuta|memorial|laudo|estudo)\b|\b(?:segue|seguem|vai|vao|acompanha|acompanham)\s+(?:em\s+)?anex[oa]s?\b|\banexo\s+(?:[ivxlc]+|\d+|[a-z])\s+(?:deste|desta)\b/;
// O que a final diz que a acompanha sem dizer "anexo" (m2c da 0.9.82: "na tabela de contingência que
// acompanha este relatório (arquivo contingencia.md)") e o arquivo que ela nomeia como tal ("arquivo
// contingencia.md"): também é anexo, e tem de estar no pacote.
const ACOMPANHA_A_FINAL = /\b(?:acompanha|acompanham|segue|seguem|vai|vao)\s+(?:junto\s+(?:a|com)\s+|com\s+)?(?:este|esta|o presente|a presente)\s+(?:parecer|relatorio|peca|peticao|roteiro|documento|minuta|memorial|laudo|estudo|dossie)\b/;
const ARQUIVO_NOMEADO = /\barquivos?\s+(?:proprios?\s+|anexos?\s+|separados?\s+)?\(?[\w.-]+\.(?:md|pdf|xlsx|csv|docx)\b/;
// Documento do cliente citado pela numeração dos autos ("a procuração que acompanha esta petição
// (Doc. 01)"): é prova, não anexo da peça; o cruzamento dos documentos é do empacotador.
const DOC_DO_CLIENTE = /\bdocs?\.\s*(?:\d|$)/;

/**
 * Os anexos que a final diz trazer: a frase que diz que algo "segue anexo", está "no Anexo I deste
 * parecer", "acompanha este relatório" ou está no "arquivo contingencia.md". Cada um se resolve pelo
 * arquivo que a frase nomeia (`contingencia.md`), achado no run, ou pelo `--anexo "Anexo I=<caminho>"`
 * (ou `--anexo "contingencia.md=<caminho>"`) do conferente. O documento do cliente ("Anexo I do
 * contrato do Município", "acompanha esta petição (Doc. 01)") e o anexo de lei ("Anexo XII da LC
 * 214/2025") não são anexo da peça.
 */
function anexosDaFinal(texto, runDir, mapeados = new Map()) {
  const doRun = arquivosDoRunPorNome(runDir);
  const frases = pecaSemNota(texto).split(/(?<=[.;!?])\s+|\n/);
  const resolvidos = [];
  const semArquivo = [];
  for (const frase of frases) {
    const n = semAcentoDaEntrega(frase);
    const nomes = [...frase.matchAll(/([\w.-]+\.(?:md|pdf|xlsx|csv|docx|json))\b/g)].map((m) => m[1]);
    const acompanha = ACOMPANHA_A_FINAL.test(n) && (nomes.length || !DOC_DO_CLIENTE.test(n));
    if (!ANEXO_PROPRIO.test(n) && !acompanha && !ARQUIVO_NOMEADO.test(n)) continue;
    const ref = (frase.match(/\bAnexo\s+(?:[IVXLC]+|\d+|[A-Z])\b/) || [null])[0];
    const mapeado = (ref && mapeados.get(semAcentoDaEntrega(ref))) || nomes.map((x) => mapeados.get(semAcentoDaEntrega(x))).find(Boolean);
    const achado = mapeado ? { caminho: mapeado } : nomes.map((x) => doRun.get(x)).find(Boolean);
    const item = { referencia: ref || nomes[0] || frase.trim().slice(0, 80), frase: frase.trim().slice(0, 200) };
    if (achado && existsSync(achado.caminho)) { if (!resolvidos.some((r) => r.arquivo === achado.caminho)) resolvidos.push({ ...item, arquivo: achado.caminho }); } else semArquivo.push({ ...item, ...(nomes.length ? { nomeado: nomes } : {}) });
  }
  return { resolvidos, semArquivo };
}

/** As seções do foco aprovado que listam o que a final carrega (pontos, teses, danos e valores aprovados). */
function itensAprovadosDoFoco(foco) {
  const L = String(foco ?? '').split('\n');
  const itens = [];
  for (let i = 0; i < L.length; i += 1) {
    const h = L[i].match(/^(#{1,6})\s+(.+)/);
    if (!h || !/(?:pontos|teses) aprovad|danos e valores aprovad|clausulas aprovad/.test(semAcentoDaEntrega(h[2]))) continue;
    for (let j = i + 1; j < L.length; j += 1) {
      const o = L[j].match(/^(#{1,6})\s/);
      if (o && o[1].length <= h[1].length) break;
      const m = L[j].match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/);
      if (m) itens.push(m[1]);
      else if (itens.length && L[j].trim()) itens[itens.length - 1] += ` ${L[j].trim()}`;
    }
  }
  return itens;
}

/**
 * O que o foco aprovado nomeia e a final não traz. A âncora que recusa é a cláusula (do contrato,
 * da convenção): é o ponto que a tese usa e que o resumo perde em silêncio. Valor e data faltando
 * vão como aviso, porque a final os escreve de outro jeito (por extenso, somados).
 */
function focoForaDaFinal(foco, final) {
  const f = semAcentoDaEntrega(final);
  const recusas = [];
  const avisos = [];
  itensAprovadosDoFoco(foco).forEach((it, i) => {
    for (const m of it.matchAll(/\b(?:cl\.|cl[aá]usula)\s*(\d+(?:\.\d+)*)/gi)) {
      const v = m[1].replace(/\./g, '\\.');
      if (!new RegExp(`\\b(?:cl\\.|clausulas?)\\s*(?:\\d+(?:\\.\\d+)*\\s*(?:,|e|a)\\s*)*${v}\\b`).test(f) && !recusas.some((r) => r.ancora === `cl. ${m[1]}`)) recusas.push({ item: i + 1, ancora: `cl. ${m[1]}`, trecho: it.slice(0, 160) });
    }
    for (const m of it.matchAll(/R\$\s*([\d.]+,\d{2})/g)) if (!f.includes(m[1])) avisos.push({ item: i + 1, ancora: `R$ ${m[1]}` });
  });
  return { recusas, avisos };
}

/** Premissa marcada como dado a confirmar que entra em valor: aviso, para o total sair com e sem ela. */
function premissasNoTotal(texto) {
  const peca = pecaSemNota(texto);
  if (!/\btotal\b/i.test(peca)) return [];
  const out = [];
  peca.split('\n').forEach((l, i) => {
    if (!/\[(?:A[ _])?CONFIRMAR\b/.test(l)) return;
    const n = semAcentoDaEntrega(l);
    if (/\d+(?:,\d+)?\s?%|\baliquota\b|\bpremissa\b|\bbase de calculo\b|\bencargos?\b|\bcontribuicao\b/.test(n) && /r\$\s*[\d.]+,\d{2}/.test(n)) out.push({ linha: i + 1, trecho: l.trim().slice(0, 160) });
  });
  return out;
}

const BLOCO_DA_CONTRAPARTE = /^[ \t]*<!--\s*para-a-contraparte:(inicio|fim)\s*-->[ \t]*\r?$/m;

/**
 * A memória de cálculo no corpo da final (squad que declara cálculo: calculista, contingência,
 * liquidação). Vale a seção da própria final cujo título fala em memória (a "Memória aplicada" do
 * chefe não conta) com números dentro, ou a coluna "Memória" de uma tabela com valores. Devolve
 * `{ noCorpo, onde, remetida }`: `remetida` são as frases que mandam a memória a um arquivo ou anexo.
 * Medido na avaliação cega da due diligence (0.9.80 a 0.9.83): três dos cinco relatórios diziam que a
 * memória estava na "tabela de contingência que acompanha este relatório (arquivo contingencia.md)"
 * e perderam ponto, porque o comitê não refaz a conta sem ela; o de nota máxima a trazia no corpo.
 */
function memoriaDeCalculoNaFinal(texto) {
  const linhas = pecaSemNota(texto).split('\n');
  let onde = null;
  for (let i = 0; i < linhas.length && !onde; i += 1) {
    const h = linhas[i].match(/^(#{1,6})\s+(.+)/);
    if (!h) continue;
    const t = semAcentoDaEntrega(h[2]);
    if (!/\bmemoria\b/.test(t) || /memoria (?:aplicada|do chefe|do escritorio)/.test(t)) continue;
    let numeros = 0;
    for (let j = i + 1; j < linhas.length; j += 1) {
      const o = linhas[j].match(/^(#{1,6})\s/);
      if (o && o[1].length <= h[1].length) break;
      if (/r\$\s*[\d.]+,\d{2}|\d+\s*(?:x|×|meses|competencias|h\b)/i.test(semAcentoDaEntrega(linhas[j]))) numeros += 1;
    }
    if (numeros >= 2) onde = `seção "${h[2].trim().slice(0, 80)}" (linha ${i + 1})`;
  }
  for (let i = 0; i < linhas.length && !onde; i += 1) {
    if (!/^\s*\|.*\|\s*$/.test(linhas[i])) continue;
    const celulas = linhas[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => semAcentoDaEntrega(c.replace(/\*\*/g, '').trim()));
    if (!celulas.some((c) => /^memoria\b/.test(c) && !/memoria aplicada/.test(c))) continue;
    const corpo = linhas.slice(i + 2).filter((l, k, arr) => /^\s*\|/.test(l) && arr.slice(0, k).every((x) => /^\s*\|/.test(x)));
    if (corpo.some((l) => /R\$\s*[\d.]+,\d{2}/.test(l))) onde = `coluna "Memória" da tabela da linha ${i + 1}`;
  }
  const remetida = pecaSemNota(texto).split(/(?<=[.;!?])\s+|\n/).filter((f) => {
    const n = semAcentoDaEntrega(f);
    return /\bmemoria\b/.test(n) && !/memoria aplicada/.test(n) && /\b(?:arquivo|anex[oa]|acompanha|em separado|apartad[oa])\b|[\w-]+\.(?:md|xlsx|csv|pdf|docx)\b/.test(n);
  }).map((f) => f.trim().slice(0, 200));
  return { noCorpo: !!onde, onde, remetida };
}

// <<< conferencias-de-entrega:end

function conferenciasDeEntrega(dir, peca, texto, flags) {
  const run = loadRunLedger(dir);
  const runDir = run && run.runId ? join(dir, 'output', run.runId) : dirname(dirname(peca));
  const raiz = resolve(dir, '..', '..');
  const mapeados = new Map();
  for (const par of asList(flags.anexo).filter((v) => typeof v === 'string')) {
    const i = par.indexOf('=');
    if (i < 1) die(`manifesto-final --anexo "${par}": use "Anexo I=<caminho do arquivo>"`);
    const caminho = par.slice(i + 1).trim();
    mapeados.set(semAcentoDaEntrega(par.slice(0, i).trim()), isAbsolute(caminho) ? caminho : [resolve(caminho), resolve(raiz, caminho)].find((c) => existsSync(c)) || resolve(caminho));
  }
  const anexos = anexosDaFinal(texto, runDir, mapeados);
  const focoPath = join(runDir, 'diagnostico-foco.md');
  const foco = existsSync(focoPath) ? focoForaDaFinal(readFileSync(focoPath, 'utf-8'), texto) : { recusas: [], avisos: [] };
  const premissas = premissasNoTotal(texto);
  const yaml = existsSync(join(dir, 'squad.yaml')) ? readFileSync(join(dir, 'squad.yaml'), 'utf-8') : '';
  const campo = (k) => (yaml.match(new RegExp(`^${k}:[ \\t]*["']?([\\w-]+)`, 'm')) || [])[1] || '';
  const comContraparte = campo('contraparte') === 'true' && campo('reader') !== 'contraparte';
  // Data apresentada como alternativa depois da data legal calculada (na final, sem a nota ao
  // revisor, e nos convites da versão mais recente da agenda): barra a final (m7 da 0.9.81, o 07/10
  // com legal 06/10 na síntese, na tabela, no anexo e no convite).
  const legais = datasLegaisDoRun(runDir);
  const datas = legais.size ? datasDepoisDaLegal(pecaSemNota(texto), legais) : [];
  const convites = [];
  const agenda = join(runDir, 'agenda');
  if (existsSync(agenda)) {
    const versoes = readdirSync(agenda, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name).sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)));
    const pasta = versoes.length ? join(agenda, versoes[0]) : agenda;
    for (const f of readdirSync(pasta).filter((x) => x.endsWith('.ics'))) for (const a of convitesDepoisDaLegal(readFileSync(join(pasta, f), 'utf-8'), legais)) convites.push({ convite: relative(raiz, join(pasta, f)).replace(/\\/g, '/'), ...a });
  }
  return {
    anexos,
    foco,
    premissas,
    datas,
    convites,
    contraparte: comContraparte ? { delimitado: BLOCO_DA_CONTRAPARTE.test(texto) } : null,
    rel: (p) => relative(raiz, p).replace(/\\/g, '/'),
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
 * passar em `--pendencias`), quando o `onde` de `--pendencias` aponta outra versão da peça
 * (`pendencia-de-outra-versao`), quando o manifesto não passa no schema e quando o hook do
 * projeto o recusa (aí o manifesto anterior volta ao lugar). Com `--de <minuta aprovada>`,
 * grava antes a final (a minuta com `citation_gate: final`) e a desfaz se recusar.
 */
// --- Carimbo da persuasão (Passo 4.6) ----------------------------------------
// O marcador de síntese: cópia do bloco canônico de src/sintese-marcador.js, o mesmo que o
// Redação Gate usa no sinal de frente (M2, 27/09/2026).
// >>> sintese-marcador:begin
/**
 * As palavras que abrem um bloco de síntese, como a peça as escreve. É daqui que o gate monta o
 * reconhecimento e que o contrato de redação (`src/contrato-redacao.js`) diz ao redator o que é
 * aceito: uma lista só, para o squad não ensinar "## O essencial" e o gate recusar (achados M2b 3 e
 * M4 do plano motor leve, outubro de 2026).
 */
const PALAVRAS_DE_SINTESE = Object.freeze(['Síntese', 'Em síntese', 'Resumo', 'Sumário', 'Tese', 'Teses']);
/**
 * Texto (já normalizado: sem acento, minúsculo) que abre um bloco de síntese.
 * Casa por palavra inteira, não por prefixo solto: `tese` não é `tesouraria`.
 */
const MARCADOR_DE_SINTESE = new RegExp(`^(?:${PALAVRAS_DE_SINTESE
  .map((p) => p.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).join('\\s+'))
  .sort((x, y) => y.length - x.length)
  .join('|')})\\b`);

/**
 * O que a peça real põe ANTES da palavra de síntese num heading forense: o
 * enumerador (`1.`, `1.1`, `2)`, `I.`, `II -`, `a)`) e a preposição que costuma
 * segui-lo (`DA SÍNTESE`). A §3 diz "comece com"; `## I. DA SÍNTESE` obedece
 * ao espírito e reprová-la seria o gate mentindo sobre quem cumpriu. Tolerar o
 * prefixo não afrouxa a regra: depois dele, o texto ainda tem de COMEÇAR pela
 * palavra de síntese. Roman/letra exigem pontuação ou traço para não engolir
 * palavra comum (`civil`, `a`).
 */
const PREFIXO_DE_HEADING = /^(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+(?:[.)]|(?=\s+[-\u2013\u2014:]))|[a-z][.)])\s*(?:[-\u2013\u2014:]\s*)?/;
const PREPOSICAO_DE_HEADING = /^d[aeo]s?\s+/;

/**
 * Heading (`#`, `##`, `###`) ou linha que abre em negrito (`**...**`) cujo texto
 * começa por síntese / em síntese / resumo / sumário / tese(s). Só chega aqui
 * linha redigida: quem chama já tirou o blockquote, porque `> ## Síntese`
 * transcrito de um acórdão não é a síntese da peça. Devolve `false`, `'heading'`
 * ou `'negrito'` (o carimbo precisa saber onde a seção acaba).
 */
export function ehMarcadorDeSintese(linha) {
  const heading = linha.match(/^\s*#{1,3}\s+(.+?)\s*$/);
  const negrito = heading ? null : linha.match(/^\s*\*\*(.+?)\*\*/);
  const bruto = heading?.[1] ?? negrito?.[1];
  if (!bruto) return false;
  const texto = String(bruto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .trim()
    .replace(/\s+#+\s*$/, '') // fecho opcional do heading ATX: `## Síntese ##`
    .replace(/^[*_]+/, '') // `## **Síntese**`
    .replace(PREFIXO_DE_HEADING, '')
    .replace(PREPOSICAO_DE_HEADING, '');
  return MARCADOR_DE_SINTESE.test(texto) ? (heading ? 'heading' : 'negrito') : false;
}
// <<< sintese-marcador:end
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

/**
 * O texto da síntese. O título "Síntese" (`## I. Da síntese`) segue como antes; sem ele, vale o
 * marcador de síntese do Redação Gate (bloco `sintese-marcador`, acima): o título `#` a `###` que
 * abre por síntese, resumo, sumário ou tese(s), até o próximo título do mesmo nível ou acima, ou a
 * linha que abre em negrito ("**Síntese da réplica.** A autora pede..."), com ela, até o próximo
 * título. Medido em 27/09/2026 (réplica, motor 0.9.61, M2): a síntese em negrito passava no
 * Redação Gate e o carimbo gravava `sintese_sha256: null`, fora da comparação com a final.
 */
function textoDaSintese(texto) {
  const doTitulo = textoDaSecao(texto, SECOES_DA_FRENTE.sintese);
  if (doTitulo !== null) return doTitulo;
  const saida = [];
  let abertura = null;
  let nivel = 0;
  for (const linha of String(texto).replace(/\r\n?/g, '\n').split('\n')) {
    const t = linha.match(RE_TITULO_DE_SECAO);
    if (abertura) {
      if (t && (abertura === 'negrito' || t[1].length <= nivel)) break;
      saida.push(linha);
      continue;
    }
    if (/^\s*>/.test(linha)) continue; // `> **Síntese do acórdão.**` transcrito não é a síntese da peça
    abertura = ehMarcadorDeSintese(linha);
    if (abertura === 'heading') nivel = t ? t[1].length : 1;
    if (abertura === 'negrito') saida.push(linha);
  }
  return abertura ? saida.join('\n').replace(/\s+/g, ' ').trim() : null;
}

/**
 * A frente sem a numeração das remissões internas ("item V", "seção III.3", "III.3", "pedido 9"):
 * o ajuste de forma que só renumera tópicos não muda o que o resumo leva. Medido no run de
 * 01/10/2026 (reabertura em ajustes): juntar dois tópicos trocou "quesitos do item V" por "item IV"
 * no pedido 9, o manifesto deu `persuasao.confere: false` e o gate 4.6 rodou de novo por isso.
 */
const semNumeracao = (t) => (t === null ? null : t
  .replace(/\b(item|itens|se[çc][ãa]o|se[çc][õo]es|t[óo]pico|t[óo]picos|cap[íi]tulo|cap[íi]tulos|pedido|pedidos)\s+(?:n[º°o.]\s*)?(?:[IVXL]+|\d+)(?:\.\d+)*(?:\s*(?:,|e|a)\s*(?:[IVXL]+|\d+)(?:\.\d+)*)*/giu, '$1 #')
  .replace(/(?<![\w.])[IVXL]+\.\d+(?:\.\d+)*(?![\w])/g, '#'));

function hashesDaFrente(texto) {
  const h = (t) => (t === null ? null : createHash('sha256').update(t).digest('hex'));
  const sintese = textoDaSintese(texto);
  const pedidos = textoDaSecao(texto, SECOES_DA_FRENTE.pedidos);
  return { sintese: h(sintese), pedidos: h(pedidos), sintese_sem_numeracao: h(semNumeracao(sintese)), pedidos_sem_numeracao: h(semNumeracao(pedidos)) };
}

function cmdPersuasaoCarimbo(dir, flags) {
  if (typeof flags.peca !== 'string') die('persuasao-carimbo requer --peca <minuta que o gate 4.6 aprovou>');
  const peca = isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca);
  if (!existsSync(peca)) die(`peça não encontrada: ${peca}`);
  const hashes = hashesDaFrente(readFileSync(peca, 'utf-8').normalize('NFC'));
  const carimbo = { peca: basename(peca), sintese_sha256: hashes.sintese, pedidos_sha256: hashes.pedidos, sintese_sem_numeracao_sha256: hashes.sintese_sem_numeracao, pedidos_sem_numeracao_sha256: hashes.pedidos_sem_numeracao, registrado_em: now() };
  const bruto = lerLedgerBruto(dir) || {};
  writeJson(dir, LEDGER, { ...bruto, persuasao_carimbo: carimbo, updatedAt: now() });
  const faltam = ['sintese', 'pedidos'].filter((k) => hashes[k] === null);
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
  // Só a numeração das remissões mudou (carimbo com o hash sem numeração): o resumo leva o mesmo.
  const soNumeracao = mudou.every((k) => carimbo[`${k}_sem_numeracao_sha256`] && carimbo[`${k}_sem_numeracao_sha256`] === agora[`${k}_sem_numeracao`]);
  if (soNumeracao) return { persuasao: { carimbo: carimbo.peca, confere: true, so_numeracao: mudou } };
  const nomes = mudou.map((k) => (k === 'sintese' ? 'a síntese' : 'os pedidos')).join(' e ');
  return {
    persuasao: { carimbo: carimbo.peca, confere: false, mudou },
    aviso: `persuasão desatualizada: o gate 4.6 aprovou ${carimbo.peca} em ${carimbo.registrado_em}, e ${nomes} da final ${mudou.length > 1 ? 'mudaram' : 'mudou'} depois disso; a reconferência de persuasão (um verificador-persuasao, modo reconferência) é obrigatória antes da parada aprovação`,
  };
}

/**
 * O texto da final a partir da minuta aprovada, sem caneta: só o frontmatter muda
 * (`citation_gate: final`). Frontmatter sem a chave ganha a linha; sem frontmatter, ganha um.
 */
function textoDaFinal(minuta, { versao = null } = {}) {
  // O cabeçalho que o redator escreveu na primeira minuta ("versao: minuta v1", "# Petição ...
  // (minuta)") seguia na final de todas as versões (achado A13 do run de 01/10/2026, v13 a v21):
  // a `versao` do frontmatter passa a dizer a final, e o título perde o "(minuta)".
  const semMinutaNoTitulo = (t) => t.replace(/^(#[ \t]+.*?)[ \t]*\((?:minuta|rascunho)\)[ \t]*$/im, '$1');
  const fm = minuta.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fm) return `---\ncitation_gate: final\n---\n\n${semMinutaNoTitulo(minuta)}`;
  let corpo = /^citation_gate:/m.test(fm[1]) ? fm[1].replace(/^citation_gate:.*$/m, 'citation_gate: final') : `${fm[1]}\ncitation_gate: final`;
  if (versao) corpo = corpo.replace(/^versao:.*$/m, `versao: final ${versao}`);
  return `---\n${corpo}\n---\n${semMinutaNoTitulo(minuta.slice(fm[0].length))}`;
}

/**
 * `--de <minuta aprovada>`: o comando grava a final (a minuta sem caneta, com `citation_gate:
 * final`) e o manifesto numa operação só, e desfaz a final se recusar. Medido em 26/09/2026
 * (locação, motor 0.9.58): o runner mandava gravar a final e depois rodar o manifesto-final, e o
 * hook de citações bloqueava a gravação da final por falta do manifesto, que só o passo seguinte
 * gera; o conferente lia o bloqueio como falha da gravação. Pela ferramenta de escrita, a final sem
 * manifesto continua bloqueada; pelo comando, as duas saem juntas.
 */
function promoverFinal(de, peca) {
  const origem = isAbsolute(de) ? de : resolve(de);
  if (!existsSync(origem)) die(`--de: minuta não encontrada: ${origem}`);
  if (resolve(origem) === resolve(peca)) die('--de e --peca são o mesmo arquivo: a final é gravada ao lado da minuta, com outro nome');
  if (/-final\.md$/i.test(basename(origem))) die(`--de aponta uma final (${basename(origem)}): passe a minuta aprovada`);
  const anterior = existsSync(peca) ? readFileSync(peca) : null;
  mkdirSync(dirname(peca), { recursive: true });
  const tmp = `${peca}.tmp`;
  const versao = /^v\d+$/.test(basename(dirname(peca))) ? basename(dirname(peca)) : null;
  writeFileSync(tmp, textoDaFinal(readFileSync(origem, 'utf-8'), { versao }), 'utf-8');
  renameSync(tmp, peca);
  // Recusado (process.exit), a final volta ao que era: sem manifesto, não existe final.
  const desfazer = () => { if (anterior) writeFileSync(peca, anterior); else rmSync(peca, { force: true }); };
  process.on('exit', desfazer);
  return () => process.removeListener('exit', desfazer);
}

function cmdManifestoFinal(dir, flags) {
  if (typeof flags.peca !== 'string') die('manifesto-final requer --peca <caminho real da peça final>');
  const peca = isAbsolute(flags.peca) ? flags.peca : resolve(flags.peca);
  const confirmarFinal = typeof flags.de === 'string' && flags.de.trim() ? promoverFinal(flags.de.trim(), peca) : null;
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
  const cobertura = coberturaComChave(dir, peca, [...verificadas, ...contestadas]);
  const semEntrada = [
    ...cobertura.descobertas.map((c) => ({ bruto: c.bruto, linha: c.linha, contestada: null })),
    ...cobertura.cobertas.filter((c) => c.titulo >= verificadas.length).map((c) => {
      const k = contestadas[c.titulo - verificadas.length];
      return { bruto: c.bruto, linha: c.linha, contestada: { title: k.title, status: k.status, ...(k.situacao ? { situacao: k.situacao } : {}), ...(k.aviso_texto_local ? { aviso: k.aviso_texto_local } : {}) } };
    }),
  ].sort((a, b) => a.linha - b.linha);
  const indices = [...new Set(cobertura.cobertas.filter((c) => c.titulo < verificadas.length).map((c) => c.titulo))];
  const versao = basename(dirname(peca)).match(/^v\d+$/) ? basename(dirname(peca)) : null;
  const { pendencias, faltam, deCitacao, sobrando, defasados } = pendenciasDoTexto(texto, informadas, { versao });
  if (semEntrada.length) {
    recusarManifesto({ motivo: 'citacao-sem-entrada-no-cartorio', peca, total: cobertura.total, sem_entrada: semEntrada, detail: `${semEntrada.length} citação(ões) da peça sem entrada verificada no cartório do run: vão ao verificador (Citation Gate incremental) antes do manifesto` },
      `${semEntrada.length} citação(ões) da peça sem entrada verificada no cartório: ${semEntrada.slice(0, 8).map((c) => `"${c.bruto}" (linha ${c.linha}${c.contestada ? `, ${c.contestada.status === STATUS_CANCELADA ? mensagemDaSituacao(c.contestada.situacao || 'cancelada') : c.contestada.status}` : ''})`).join('; ')}${semEntrada.length > 8 ? '; …' : ''}`);
  }
  if (deCitacao.length) {
    recusarManifesto({ motivo: 'marcador-de-citacao', peca, marcadores: deCitacao },
      `marcador de citação na peça (${[...new Set(deCitacao.map((m) => m.marcador))].join(', ')}): a citação se verifica ou sai, pelo redator`);
  }
  if (faltam.length) {
    recusarManifesto({ motivo: 'pendencia-sem-diligencia', peca, faltam, modelo: pendencias, detail: 'preencha procurado_em e diligencia de cada marcador de dado no modelo e passe o arquivo em --pendencias' },
      `${faltam.length} marcador(es) de dado sem procurado_em ou diligencia: ${[...new Set(faltam.map((f) => f.marcador))].join(', ')}`);
  }
  if (defasados.length) {
    recusarManifesto({ motivo: 'pendencia-de-outra-versao', peca, defasados, modelo: pendencias, detail: 'o `onde` de --pendencias aponta outra versão da peça: corrija o arquivo pelo `modelo` (o `onde` desta versão, com o mesmo procurado_em e diligencia) e rode de novo' },
      `${defasados.length} entrada(s) de --pendencias com \`onde\` de outra versão da peça: ${defasados.slice(0, 5).map((d) => `${d.marcador} (${d.motivo})`).join('; ')}${defasados.length > 5 ? '; …' : ''}`);
  }
  for (const m of sobrando) avisos.push(`--pendencias lista ${m}, que não está no texto da peça; ignorado`);

  // Conferências de entrega por código: anexo citado sem arquivo, ponto do foco fora da final.
  const entrega = conferenciasDeEntrega(dir, peca, texto, flags);
  if (entrega.anexos.semArquivo.length) {
    recusarManifesto({ motivo: 'anexo-sem-arquivo', peca, anexos: entrega.anexos.semArquivo, detail: 'a final diz que segue anexo o que o run não tem como arquivo: nomeie o arquivo na frase (`contingencia.md`), passe --anexo "Anexo I=<caminho>", ou tire a menção' },
      `${entrega.anexos.semArquivo.length} anexo(s) que a final diz trazer sem arquivo no run: ${entrega.anexos.semArquivo.map((a) => `"${a.referencia}"`).join('; ')}`);
  }
  // A memória de cálculo vai NO corpo da final quando o squad declara cálculo (calculista,
  // contingência, liquidação): seção própria ou apêndice da própria final, não arquivo citado. A
  // regra do anexo (acima) continua valendo para os outros anexos. Medido na avaliação cega da due
  // diligence: três dos cinco relatórios remetiam a memória a contingencia.md e perderam ponto.
  if (passosDeCalculo(dir).length) {
    const memoria = memoriaDeCalculoNaFinal(texto);
    if (!memoria.noCorpo) {
      recusarManifesto({ motivo: 'memoria-de-calculo-fora-da-final', peca, remetida: memoria.remetida, passos_de_calculo: passosDeCalculo(dir).map((b) => b.id), detail: 'o squad declara cálculo e a final não traz a memória no corpo: o redator a integra à final, numa seção com "Memória" no título (ou como apêndice da própria final), linha a linha (período, base, quantidade, premissa, fonte) e com os totais que fecham; remeter a memória a arquivo citado não basta' },
        `a memória de cálculo não está no corpo da final${memoria.remetida.length ? ` (a final a remete a arquivo: "${memoria.remetida[0].slice(0, 120)}")` : ''}: integre-a como seção ou apêndice da própria final`);
    }
  }
  if (entrega.datas.length || entrega.convites.length) {
    const lista = [...entrega.datas.map((d) => `linha ${d.linha}: ${d.data} depois da data legal ${d.legal} ("${d.trecho.slice(0, 80)}")`), ...entrega.convites.map((c) => `${c.convite}: ${c.data} depois da data legal ${c.legal}`)];
    recusarManifesto({ motivo: 'data-depois-da-legal', peca, datas: entrega.datas, convites: entrega.convites, detail: 'data apresentada como prazo ou alternativa depois da data legal calculada (a calculadora do run): tire-a da final e do convite, ou marque-a "não usar"; volta ao redator' },
      `${lista.length} data(s) depois da data legal calculada: ${lista.slice(0, 5).join('; ')}${lista.length > 5 ? '; …' : ''}`);
  }
  if (entrega.foco.recusas.length) {
    recusarManifesto({ motivo: 'foco-fora-da-final', peca, ausentes: entrega.foco.recusas, detail: 'o diagnóstico aprovou estes pontos e a final não os traz: o redator os usa, ou registra na nota ao revisor por que ficaram fora (a nota conta)' },
      `${entrega.foco.recusas.length} âncora(s) do foco aprovado fora da final: ${entrega.foco.recusas.map((r) => `${r.ancora} (item ${r.item})`).join('; ')}`);
  }
  for (const a of entrega.foco.avisos) avisos.push(`foco aprovado, item ${a.item}: ${a.ancora} não aparece na final (confira se foi escrito de outro jeito)`);
  for (const p of entrega.premissas) avisos.push(`premissa marcada [CONFIRMAR] que entra em valor (linha ${p.linha}): mostre o total com e sem ela, em linha própria (${p.trecho})`);
  // Dupla contagem por código (gravidade alta, aviso ao conferente): na final e na contingência.
  let duplas;
  try { duplas = avisosDeDuplaContagem(dir, [peca, ...arquivosDeContagem(dir, { comPeca: false })]); } catch { duplas = []; }
  for (const d of duplas) avisos.push(`ALTA: possível dupla contagem (${d.arquivo}): ${d.detalhe}; confira e, confirmada, devolva à calculista ou à redação (${d.fix})`);
  if (entrega.contraparte && !entrega.contraparte.delimitado) avisos.push('o squad tem contraparte e entrega documento interno: o que vai à contraparte fica entre <!-- para-a-contraparte:inicio --> e <!-- para-a-contraparte:fim -->, para o pacote o separar do roteiro');

  // A entrada casada pela chave canônica vai ao manifesto com o título completado pelo diploma do
  // texto: é por ele que o hook reconhece a citação (K10).
  const canonicos = new Map(cobertura.cobertas.filter((c) => c.titulo_canonico && c.titulo < verificadas.length).map((c) => [c.titulo, c.titulo_canonico]));
  const citations = indices.map((i) => citacaoDoCartorio(canonicos.has(i) ? { ...verificadas[i], title: canonicos.get(i) } : verificadas[i], avisos));
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
  if (confirmarFinal) confirmarFinal();
  // Os anexos que a final diz trazer, para o empacotador levá-los ao pacote.
  const anexosArq = `${peca}.anexos.json`;
  if (entrega.anexos.resolvidos.length) writeFileSync(anexosArq, `${JSON.stringify({ artifact: basename(peca), anexos: entrega.anexos.resolvidos.map((a) => ({ referencia: a.referencia, arquivo: entrega.rel(a.arquivo) })) }, null, 2)}\n`, 'utf-8');
  else rmSync(anexosArq, { force: true });
  const conferenciaDoContrato = verificaContratoDaFinal(dir, peca, avisos);
  const semEvidencia = citations.filter((c) => !c.evidence || !(c.evidence.sha256_texto || c.evidence.sha256_bytes || c.evidence.trecho)).map((c) => c.title);
  const daPersuasao = avisoDaPersuasao(dir, texto);
  if (daPersuasao && daPersuasao.aviso) {
    avisos.push(daPersuasao.aviso);
    console.error(`AVISO: ${daPersuasao.aviso}`);
  }
  console.log(JSON.stringify({
    acao: 'gravado',
    ...(confirmarFinal ? { final: peca, final_de: flags.de.trim() } : {}),
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
    ...(conferenciaDoContrato ? { verifica_contrato: conferenciaDoContrato } : {}),
    ...(entrega.anexos.resolvidos.length ? { anexos: entrega.anexos.resolvidos.map((a) => ({ referencia: a.referencia, arquivo: entrega.rel(a.arquivo) })) } : {}),
    ...(duplas.length ? { dupla_contagem: duplas } : {}),
    avisos,
    detail: `manifesto gerado do cartório: ${citations.length} citação(ões), ${citations.length - semEvidencia.length} com hash ou trecho; ${pendencias.length} pendência(s) do profissional${semEvidencia.length ? `; ${semEvidencia.length} sem evidência (a reabertura do gate final não tem o que comparar nelas e as devolve a um votante)` : ''}`,
  }, null, 2));
  return null;
}

/**
 * A entrega é contrato (o verifica-contrato vale): leitor contraparte, ou squad sem processo cuja
 * entrega é minuta (`delivery_type` legal-draft, ou ausente nos squads antigos). Parecer, relatório
 * e roteiro (`legal-analysis`, `content`) não têm cláusula para o verificador numerar, e ele
 * reprovava sempre (m2, due diligence, 01/10/2026).
 */
function entregaDeContratoDoSquadYaml(yaml) {
  const campo = (nome) => (String(yaml ?? '').match(new RegExp(`^${nome}:[ \\t]*["']?([\\w-]+)`, 'm')) || [])[1] || '';
  if (campo('reader') === 'contraparte') return true;
  return campo('processo') === 'nenhum' && !['legal-analysis', 'content'].includes(campo('delivery_type'));
}

/**
 * No squad de contrato (`reader: contraparte`, ou `processo: nenhum` com minuta), o resultado do
 * verifica-contrato NA FINAL, gravado ao lado dela (`vN/verifica-contrato-final.json`), para a
 * lista fechada do avaliador da meta. Medido em 26/09/2026 (K23, contrato social, motor 0.9.59):
 * o critério cobrava "o verifica-contrato aprova os cinco sinais na versão final", a lista fechada
 * não tinha o resultado, o avaliador julgou lendo a peça e deu falta; o chefe gravou o arquivo à
 * mão, e com a saída de outra versão (a v16 minuta, não a v17 final). Aqui ele sai da final que
 * acabou de ser gravada, com o hash dela. Devolve o resumo, ou null fora do contrato.
 */
function verificaContratoDaFinal(dir, peca, avisos) {
  let yaml;
  try { yaml = readFileSync(join(dir, 'squad.yaml'), 'utf-8'); } catch { return null; }
  if (!entregaDeContratoDoSquadYaml(yaml)) return null;
  const aqui = dirname(fileURLToPath(import.meta.url));
  const script = [join(aqui, 'verifica-contrato.mjs'), join(resolve(dir, '..', '..'), 'scripts', 'verifica-contrato.mjs')].find((p) => existsSync(p));
  if (!script) {
    avisos.push('verifica-contrato.mjs não encontrado: o resultado da final não foi gravado para o avaliador da meta');
    return null;
  }
  const r = spawnSync(process.execPath, [script, peca, '--json'], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  let resultado;
  try { resultado = JSON.parse(r.stdout); } catch {
    avisos.push(`verifica-contrato falhou na final: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    return null;
  }
  const arquivo = join(dirname(peca), 'verifica-contrato-final.json');
  const sha = createHash('sha256').update(readFileSync(peca)).digest('hex');
  writeFileSync(arquivo, `${JSON.stringify({ ...resultado, arquivo: peca, artifact_sha256: sha, gerado_em: now() }, null, 2)}\n`, 'utf-8');
  const reprovados = Object.entries(resultado.sinais || {}).filter(([, v]) => v === 'reprovado').map(([k]) => k);
  if (reprovados.length) avisos.push(`verifica-contrato reprova a final em ${reprovados.join(', ')} (${arquivo})`);
  return { arquivo, ok: resultado.ok === true, sinais: resultado.sinais || {}, ...(reprovados.length ? { reprovados } : {}) };
}

// O retorno dos subagentes que dão veredito, lido por código (cópia do bloco canônico de
// src/retorno-subagente.js): a tabela do verificador de citações, o bloco do revisor, a persuasão.
// >>> retorno-subagente:begin
/** Quantas vezes o hook devolve o mesmo subagente ao trabalho por formato; no terceiro, ele termina. */
const RETORNO_TETO_DE_BLOQUEIOS = 2;
/** Os nativos que dão veredito (o nome sem o prefixo `legalsquad:` do plugin). */
const RETORNO_NATIVOS_COM_VEREDITO = Object.freeze(['verificador-citacoes', 'verificador-persuasao', 'avaliador-squad', 'contraditor']);
/**
 * Os papéis do agente do squad que dão veredito. Ele vai como `general-purpose`, e o hook só o
 * reconhece pela marca que o código põe no despacho (`marcaDoVeredito`).
 */
const RETORNO_PAPEIS_COM_VEREDITO = Object.freeze(['revisao', 'conferencia']);

/** A linha que o código põe no despacho do agente do squad que dá veredito; o hook a lê no prompt. */
function marcaDoVeredito({ squad, run, papel }) {
  return `[legalsquad:veredito squad=${squad} run=${run} papel=${papel}]`;
}

const semAcentoDoRetorno = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const celulasDoRetorno = (linha) => linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const ehSeparadorDoRetorno = (celulas) => celulas.every((c) => /^:?-{2,}:?$/.test(c) || c === '');

/** As tabelas Markdown do texto: `{ cabecalho, linhas }`, com o cabeçalho sem acento e em minúsculas. */
function tabelasDoRetorno(texto) {
  const tabelas = [];
  let atual = null;
  for (const linha of String(texto ?? '').split(/\r?\n/)) {
    if (!/^\s*\|.*\|\s*$/.test(linha)) { atual = null; continue; }
    const celulas = celulasDoRetorno(linha);
    if (!atual) { atual = { cabecalho: celulas.map(semAcentoDoRetorno), linhas: [] }; tabelas.push(atual); continue; }
    if (ehSeparadorDoRetorno(celulas)) continue;
    atual.linhas.push(celulas);
  }
  return tabelas;
}

/** O texto fora das tabelas (onde ficam a contagem e o veredito geral). */
const foraDasTabelasDoRetorno = (texto) => String(texto ?? '').split(/\r?\n/).filter((l) => !/^\s*\|.*\|\s*$/.test(l)).join('\n');

/** O último APROVADO ou REPROVADO fora das tabelas, ou null. */
function vereditoGeralDoRetorno(texto) {
  const achados = [...foraDasTabelasDoRetorno(texto).matchAll(/\b(APROVADO|REPROVADO)\b/g)];
  return achados.length ? achados[achados.length - 1][1] : null;
}

/** O veredito de uma linha do verificador no enum do cartório, ou null. */
function statusDaCitacaoDoRetorno(celula) {
  const v = semAcentoDoRetorno(celula).replace(/[`*_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^verificad[ao] no acervo\b/.test(v)) return 'verificada_no_acervo';
  if (/^verificad[ao]\b/.test(v)) return 'verificada';
  if (/^divergente\b/.test(v)) return 'divergente';
  if (/^nao encontrad[ao]\b/.test(v)) return 'nao_encontrada';
  if (/^(?:cancelad|revogad|superad)/.test(v)) return 'cancelada';
  if (/^acesso falhou\b/.test(v)) return 'acesso_falhou';
  if (/^fonte mudou\b/.test(v)) return 'fonte_mudou';
  return null;
}

const tirarAspasDoRetorno = (t) => String(t ?? '').trim().replace(/^[`*]+|[`*]+$/g, '').replace(/^["“”«']+|["“”»']+$/g, '').trim();

/**
 * A frase inteira de ausência ("nenhuma citação a verificar", "não há citação"), nunca o pedaço de
 * outra frase. Medido no run de 09/10/2026 (trib-reforma-regime): o atalho casava "sem reprovar
 * nenhuma citação:" no resumo de um retorno com 17 citações em bloco JSON, e o hook gravou
 * `citations: []` com APROVADO. "Nenhuma citação inventada" ou "divergente" não é ausência.
 */
function retornoDizQueNaoHaCitacao(texto) {
  const t = semAcentoDoRetorno(texto).replace(/[`*_]/g, ' ').replace(/[ \t]+/g, ' ');
  const aVerificar = '(?:a|para) (?:verificar|conferir|checar)';
  return new RegExp(`\\b(?:(?:nenhuma|zero) citac(?:ao|oes) ${aVerificar}|nao ha (?:nenhuma )?citac(?:ao|oes)(?: ${aVerificar})?(?: (?:na|no|nesta|neste) (?:peca|minuta|texto|parecer|documento))? ?(?:[.;!?\\n]|$)|sem citac(?:ao|oes) ${aVerificar}|a (?:peca|minuta) nao (?:cita|traz) (?:nenhuma )?(?:citacao|lei|sumula|precedente|julgado) ?(?:[.;!?\\n]|$))`).test(t);
}

/** O primeiro array de citações de um objeto lido do retorno (`citations`, `tabela` ou `citacoes`), ou null. */
function arrayDeCitacoesDoRetorno(objeto) {
  if (Array.isArray(objeto)) return objeto;
  if (!objeto || typeof objeto !== 'object') return null;
  for (const chave of ['citations', 'tabela', 'citacoes']) if (Array.isArray(objeto[chave])) return objeto[chave];
  return null;
}

/**
 * O bloco JSON do retorno do verificador (```json ... ``` ou o retorno inteiro em JSON) com o array
 * de citações. Devolve `{ objeto, itens }` do primeiro bloco que tem o array, ou null.
 */
function blocoJsonDoVerificador(texto) {
  const bruto = String(texto ?? '');
  const candidatos = [...bruto.matchAll(/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)].map((m) => m[1]);
  if (/^\s*[[{]/.test(bruto)) candidatos.push(bruto);
  for (const c of candidatos) {
    let objeto;
    try { objeto = JSON.parse(c); } catch { continue; }
    const itens = arrayDeCitacoesDoRetorno(objeto);
    if (itens) return { objeto, itens };
  }
  return null;
}

/** APROVADO ou REPROVADO no começo de um campo (`"APROVADO (para as citações pedidas)"`), ou null. */
function vereditoDoCampo(valor) {
  const m = semAcentoDoRetorno(valor).trim().match(/^\W*(aprovado|reprovado)\b/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Uma linha já lida (da tabela Markdown ou do bloco JSON) no formato do cartório, com os mesmos
 * erros para os dois formatos. `bruta` traz `title`, `veredito`, `fonte`, `obs`, `trecho` e a
 * `evidence` que o bloco JSON já trouxe estruturada.
 */
function citacaoDoRetorno(bruta, k, { consultadoEm, erros }) {
  const title = tirarAspasDoRetorno(bruta.title);
  if (!title) return null;
  const onde = `linha ${k + 1} (${title.slice(0, 60)})`;
  const status = statusDaCitacaoDoRetorno(bruta.veredito);
  if (!status) { erros.push(`${onde}: veredito "${String(bruta.veredito ?? '').trim()}" fora do formato (VERIFICADA, VERIFICADA NO ACERVO, DIVERGENTE, NÃO ENCONTRADA, CANCELADA ou acesso_falhou)`); return null; }
  const fonte = String(bruta.fonte ?? '');
  const obs = String(bruta.obs ?? '');
  const juntas = `${fonte} ${obs}`;
  const url = (fonte.match(/https:\/\/[^\s|)>\]"'`]+/) || [])[0] || '';
  const trechoBruto = tirarAspasDoRetorno(bruta.trecho);
  const trecho = /^(?:n[aã]o h[aá]|nenhum|n\/a|-+|\u2014)?$/i.test(trechoBruto) ? '' : trechoBruto;
  const evidence = {};
  const dada = bruta.evidence && typeof bruta.evidence === 'object' ? bruta.evidence : {};
  if (trecho) evidence.trecho = trecho;
  for (const campo of ['sha256_texto', 'sha256_bytes']) {
    const v = typeof dada[campo] === 'string' && /^[a-f0-9]{64}$/i.test(dada[campo].trim()) ? dada[campo].trim() : (juntas.match(new RegExp(`${campo}\\s*[:=]?\\s*\`?([a-f0-9]{64})`, 'i')) || [])[1];
    if (v) evidence[campo] = v.toLowerCase();
  }
  for (const campo of ['fonte_local', 'registro', 'dt_publicacao']) {
    const v = typeof dada[campo] === 'string' && dada[campo].trim() ? dada[campo].trim() : (juntas.match(new RegExp(`${campo}\\s*[:=]\\s*\`?([^\\s;|\`,]+)`, 'i')) || [])[1];
    if (v) evidence[campo] = v;
  }
  if (status === 'verificada' || status === 'verificada_no_acervo') {
    if (!url) erros.push(`${onde}: ${status === 'verificada' ? 'VERIFICADA' : 'VERIFICADA NO ACERVO'} sem a URL https da fonte conferida na coluna Fonte`);
    if (!trecho) erros.push(`${onde}: sem o trecho literal que sustenta (sem trecho, o veredito é acesso_falhou)`);
    if (status === 'verificada_no_acervo' && !/(^|[\\/])acervo[\\/]/.test(evidence.fonte_local || '')) erros.push(`${onde}: VERIFICADA NO ACERVO sem "fonte_local: <o arquivo do acervo lido>" na Observação`);
  }
  // A hora é a do relógio da máquina quando o retorno chegou; a declarada só vale sem ela.
  const consultada = consultadoEm || (typeof bruta.consultadaDeclarada === 'string' && !Number.isNaN(Date.parse(bruta.consultadaDeclarada)) ? bruta.consultadaDeclarada.trim() : '');
  return {
    title,
    status,
    ...(url ? { source_url: url } : {}),
    ...(consultada ? { consulted_at: consultada } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
    ...(obs.trim() && status !== 'verificada' && status !== 'verificada_no_acervo' ? { observacao: obs.trim().slice(0, 400) } : {}),
  };
}

const textoDoCampo = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * A tabela do `verificador-citacoes` como `citations[]` no formato que o cartório registra
 * (`gate-verdict --citacoes`). Aceita a tabela Markdown (Citação · Veredito · Fonte conferida ·
 * Consultada em · Trecho que sustenta · Observação) e o bloco JSON (```json com `citations`,
 * `tabela` ou `citacoes`; por item, `citacao`/`title`, `veredito`/`status`, `source_url`,
 * `consulted_at`, `trecho` e `evidence`): medido em 09/10/2026, o verificador devolveu 17 citações
 * só em JSON e o leitor, que só conhecia a tabela, gravou zero com APROVADO. `consultadoEm` é a
 * hora em que o retorno chegou, do relógio da máquina (o verificador não tem relógio, e o runner
 * nunca usa a hora que ele declara). Devolve `{ citations, veredito_geral, erros }`; `erros` diz,
 * linha a linha, o que falta. Retorno com conteúdo e nenhuma citação lida é fora do formato; só a
 * frase inteira de ausência ("nenhuma citação a verificar") com APROVADO devolve a lista vazia.
 */
function citacoesDaTabelaDoVerificador(texto, { consultadoEm } = {}) {
  const erros = [];
  const tabela = tabelasDoRetorno(texto).find((t) => t.cabecalho.some((c) => /^cita/.test(c)) && t.cabecalho.some((c) => /^veredito/.test(c)));
  const bloco = tabela ? null : blocoJsonDoVerificador(texto);
  let veredito_geral = vereditoGeralDoRetorno(texto);
  let brutas;
  if (tabela) {
    const col = (re) => tabela.cabecalho.findIndex((c) => re.test(c));
    const iCitacao = col(/^cita/);
    const iVeredito = col(/^veredito/);
    const iFonte = col(/fonte|source/);
    const iTrecho = col(/trecho/);
    const iObs = col(/observ|corre/);
    brutas = tabela.linhas.map((c) => ({ title: c[iCitacao], veredito: c[iVeredito], fonte: iFonte >= 0 ? c[iFonte] : '', trecho: iTrecho >= 0 ? c[iTrecho] : '', obs: iObs >= 0 ? c[iObs] : '' }));
  } else if (bloco) {
    const doBloco = bloco.objeto && !Array.isArray(bloco.objeto) ? vereditoDoCampo(bloco.objeto.veredito_geral ?? bloco.objeto.veredito) : null;
    if (doBloco) veredito_geral = doBloco;
    brutas = bloco.itens.map((it) => {
      const o = it && typeof it === 'object' ? it : {};
      const ev = o.evidence && typeof o.evidence === 'object' ? o.evidence : {};
      return {
        title: textoDoCampo(o.citacao ?? o.title ?? o.citação),
        veredito: textoDoCampo(o.veredito ?? o.status),
        fonte: textoDoCampo(o.source_url ?? o.fonte ?? o.url),
        trecho: textoDoCampo(o.trecho ?? ev.trecho),
        obs: [o.observacao, o.observação, o.motivo, o.fiel_na_minuta].filter((v) => typeof v === 'string' && v.trim()).join(' '),
        evidence: ev,
        consultadaDeclarada: o.consulted_at,
      };
    });
  } else {
    if (veredito_geral === 'APROVADO' && retornoDizQueNaoHaCitacao(texto)) return { citations: [], veredito_geral, erros };
    return { citations: [], veredito_geral, erros: ['sem a tabela de citações: uma linha por citação, com as colunas Citação | Veredito | Fonte conferida (source_url) | Consultada em | Trecho que sustenta | Observação (ou o bloco ```json com `citations[]`); só "nenhuma citação a verificar", com APROVADO, dispensa a tabela'] };
  }
  const citations = [];
  brutas.forEach((b, k) => {
    const c = citacaoDoRetorno(b, k, { consultadoEm, erros });
    if (c) citations.push(c);
  });
  if (!citations.length && !erros.length && !(veredito_geral === 'APROVADO' && retornoDizQueNaoHaCitacao(texto))) erros.push(`${tabela ? 'a tabela' : 'o bloco JSON'} de citações não tem nenhuma linha com citação lida: retorno com conteúdo e zero citações é fora do formato`);
  if (!veredito_geral) erros.push('sem o veredito geral no fechamento: APROVADO (todas verificadas, na fonte ou no acervo) ou REPROVADO');
  return { citations, veredito_geral, erros };
}

/**
 * O bloco `verdict`/`fixes`/`ajustes` que abre o arquivo do revisor do squad (cercado por ```yaml,
 * por `---` ou solto no topo). Devolve `{ verdict, fixes, ajustes, erros }`: `verdict` só APPROVE ou
 * REJECT; cada fix com a gravidade no prefixo; REJECT com ao menos um fix crítico ou alto (só eles
 * sustentam REJECT); APPROVE sem fix crítico ou alto (o APPROVE descarta os fixes, e o problema
 * sumiria). `null` em `verdict` quando o bloco não existe.
 */
function vereditoDoRevisor(texto) {
  const linhas = String(texto ?? '').split(/\r?\n/);
  const inicio = linhas.findIndex((l, i) => i < 400 && /^\s*verdict\s*:/.test(l));
  if (inicio < 0) return { verdict: null, fixes: [], ajustes: [], erros: ['sem o bloco YAML no topo do arquivo do step: `verdict: APPROVE | REJECT`, `fixes:` (cada um com a gravidade no prefixo: critica, alta, media ou baixa) e `ajustes:`'] };
  const recuo = linhas[inicio].match(/^\s*/)[0].length;
  const bruto = linhas[inicio].replace(/^\s*verdict\s*:\s*/, '').replace(/\s+#.*$/, '');
  const verdict = tirarAspasDoRetorno(bruto).toUpperCase();
  const listas = { fixes: [], ajustes: [] };
  let atual = null;
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const l = linhas[i];
    if (/^\s*(```|---)\s*$/.test(l)) break;
    if (!l.trim()) continue;
    const nivel = l.match(/^\s*/)[0].length;
    const item = l.match(/^\s*-\s+(.*)$/);
    if (item && atual && nivel >= recuo) { listas[atual].push(tirarAspasDoRetorno(item[1]).replace(/\\"/g, '"')); continue; }
    const chave = l.match(/^\s*([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (chave && nivel <= recuo) {
      atual = Object.hasOwn(listas, chave[1]) ? chave[1] : null;
      const resto = chave[2].trim();
      if (atual && resto.startsWith('[')) {
        try { listas[atual].push(...JSON.parse(resto).map((x) => String(x))); } catch { /* lista inline que não é JSON: fica vazia */ }
        atual = null;
      }
      continue;
    }
    // Prosa no nível do bloco: o bloco acabou.
    if (nivel <= recuo && !item) break;
  }
  const erros = [];
  if (verdict !== 'APPROVE' && verdict !== 'REJECT') erros.push(`verdict "${bruto.trim() || '(vazio)'}" não é APPROVE nem REJECT`);
  for (const fix of listas.fixes) if (!gravidadeDoFix(fix).explicita) erros.push(`fix sem a gravidade no prefixo (critica, alta, media ou baixa): "${fix.slice(0, 120)}"`);
  const bloqueantes = listas.fixes.filter((f) => ['critica', 'alta'].includes(gravidadeDoFix(f).gravidade) && gravidadeDoFix(f).explicita);
  if (verdict === 'REJECT' && !bloqueantes.length) erros.push('REJECT sem fix critica ou alta: só crítica e alta sustentam REJECT; correção de forma vai em `ajustes:` com APPROVE');
  if (verdict === 'APPROVE' && bloqueantes.length) erros.push(`APPROVE com ${bloqueantes.length} fix critica ou alta: o APPROVE descarta os fixes; com problema crítico ou alto o veredito é REJECT (ou a correção é de forma e vai em \`ajustes:\`)`);
  return { verdict: verdict === 'APPROVE' || verdict === 'REJECT' ? verdict : null, fixes: listas.fixes, ajustes: listas.ajustes, erros };
}

/** O relatório do `verificador-persuasao`: a tabela SOBREVIVE/PERDIDO e o veredito. `{ veredito, sobrevivem, perdidos, erros }`. */
function formatoDaPersuasao(texto) {
  const erros = [];
  const tabela = tabelasDoRetorno(texto).find((t) => t.cabecalho.some((c) => /sobreviv/.test(c)));
  let sobrevivem = 0;
  let perdidos = 0;
  if (!tabela) erros.push('sem a tabela do inventário: uma linha por pedido, tese, Tema e linha de ataque, com a coluna Sobrevive? (SOBREVIVE ou PERDIDO)');
  else {
    const i = tabela.cabecalho.findIndex((c) => /sobreviv/.test(c));
    for (const c of tabela.linhas) {
      const v = semAcentoDoRetorno(c[i]);
      if (/\bperdid/.test(v)) perdidos += 1;
      else if (/\bsobreviv/.test(v)) sobrevivem += 1;
    }
    if (!sobrevivem && !perdidos) erros.push('a tabela do inventário não marca nenhum item como SOBREVIVE ou PERDIDO');
  }
  const veredito = vereditoGeralDoRetorno(texto);
  if (!veredito) erros.push('sem o veredito: APROVADO ou REPROVADO, seguido dos fixes, um por linha');
  return { veredito, sobrevivem, perdidos, erros };
}
// <<< retorno-subagente:end

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

/**
 * A versão da peça entregue: a pasta da final mais alta com o manifesto ao lado (`*-final.md` e
 * `*-final.md.citation-gate.json`); sem final, a pasta mais alta. Medido no run de 01/10/2026: a
 * pasta mais alta era a do checklist de protocolo (v14, v17), e o reabrir e o termo diziam que a
 * entrega anterior era ela.
 */
function versaoEntregue(dir, runId) {
  const pasta = join(dir, 'output', runId);
  if (!existsSync(pasta)) return null;
  const versoes = readdirSync(pasta, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => Number(e.name.slice(1))).sort((a, b) => b - a);
  const daFinal = versoes.find((v) => readdirSync(join(pasta, `v${v}`)).some((f) => /-final\.md$/.test(f) && existsSync(join(pasta, `v${v}`, `${f}.citation-gate.json`))));
  return versoes.length ? { entregue: `v${daFinal ?? versoes[0]}`, proxima: `v${versoes[0] + 1}` } : null;
}

/**
 * O pedido que fala de documento novo ("chegou o atestado", "junta o laudo", "segue o contrato em
 * anexo"): o reabrir só via documento novo depois que ele entrava na pasta dos autos, e o anunciado
 * na conversa passava (run de 01/10/2026, M7: só a instrução do chefe barrou). Heurística estreita:
 * verbo de chegada ou juntada perto de um documento; "junta os tópicos" não casa.
 */
const PEDIDO_COM_DOCUMENTO_NOVO = /\b(?:cheg(?:ou|aram)|receb(?:i|emos|eu)|mand(?:ou|aram|ei)|trouxe|segue|seguem|junt(?:a|e|ar|em)|anex(?:a|e|ar|o|os)|inclu(?:i|a|ir))\b[^.;]{0,60}?\b(?:documentos?|atestados?|laudos?|certid(?:ao|oes)|comprovantes?|recibos?|notas? fisca(?:l|is)|contratos?|fotos?|fotografias?|boletim|boletins|declarac(?:ao|oes)|exames?|receitas?|orcamentos?|matriculas?|extratos?|prints?|videos?)\b/;
function pedidoComDocumentoNovo(pedido) {
  return PEDIDO_COM_DOCUMENTO_NOVO.test(String(pedido).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
}

const PERGUNTA_DO_RUN_NOVO = 'Nada foi aberto: pergunte ao profissional se ele quer um run novo (a fase zero lê os autos de novo, com o documento) e só rode o init com a resposta literal dele em --confirmacao.';

/** A recusa fica no ledger, sem mudar o status: o init seguinte cobra o sim a essa pergunta. */
function registrarRecusaDeReabrir(dir, ledger, motivo, pedido) {
  writeJson(dir, RUN_LEDGER, { ...ledger, reabertura_recusada: { motivo, pedido: String(pedido || '').slice(0, 400), em: now() }, updatedAt: now() });
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
    if (novos.length) {
      registrarRecusaDeReabrir(dir, ledger, 'autos-mudaram', flags.pedido);
      die(`os autos mudaram depois do run (${novos.length} documento(s) com mtime posterior a ${ledger.startedAt}): alteração de fato novo não é ajuste da peça. ${PERGUNTA_DO_RUN_NOVO}`);
    }
  }
  if (pedidoComDocumentoNovo(flags.pedido) && flags['documento-dos-autos'] !== true) {
    registrarRecusaDeReabrir(dir, ledger, 'documento-novo', flags.pedido);
    die(`o pedido fala de documento novo (chegou, junta, anexo): documento novo é fato novo, e fato novo é run novo, com o documento na pasta dos autos, lido na fase zero e conferido. Se o documento citado já estava nos autos deste run, rode de novo com --documento-dos-autos. ${PERGUNTA_DO_RUN_NOVO}`);
  }
  const guardaDosAutos = autos ? (ledger.startedAt ? 'conferidos' : 'sem startedAt no ledger') : `sem índice em ${pastaDeAutos(dir)}: não dá para saber se os autos mudaram`;
  const versoes = versaoEntregue(dir, ledger.runId);
  const versao = versoes ? versoes.entregue : null;
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
  console.log(JSON.stringify({ runId: novo.runId, reabertura: r.numero, modo: r.modo, pedido: r.pedido, versao_anterior: versao, proxima_versao: versoes ? versoes.proxima : 'v1', checkpoints: Object.keys(novo.checkpoints || {}), ritmo: novo.ritmo || null, autos: guardaDosAutos }, null, 2));
  return null;
}

// ── Despacho com prazo (K21) ────────────────────────────────────────────────────────────────
// Medido em 26/09/2026 (contrato social, motor 0.9.59): o avaliador da meta ficou 60 minutos
// numa chamada que terminou em 502, três vezes (22:10 a 23:10, 23:35 a 00:36, 00:36 a 01:36),
// com o limite de 25 minutos escrito no runner. O chefe despachava em primeiro plano, e a chamada
// da ferramenta só volta quando a API responde: quem espera uma chamada bloqueada não mede nada.
// O prazo só existe com o despacho em segundo plano e um relógio fora do subagente: o chefe
// despacha, e em seguida chama `aguardar`, que marca a hora do despacho no run (na primeira
// chamada), espera em janelas curtas (a ferramenta de shell tem limite de tempo por chamada),
// volta cedo quando o artefato esperado aparece e responde `caido` quando o prazo passa. O
// relógio é o do run, não o da conversa: sobrevive a quantas chamadas forem.
const PRAZO_DO_DESPACHO_MIN = 25;
const JANELA_DO_AGUARDAR_MIN = 5;
// O limite de "caído" por papel, lido no nome do despacho (ou em --papel). Medido na 0.9.81: o
// calculista do m2b levou 47,8 minutos vivo, e a regra de 25 o deu como caído (com o redespacho,
// dois escritores); a revisora levou 24,8; os avaliadores da meta, até 20,5 (e as chamadas presas
// voltavam em 502 depois de 60). O limite fica abaixo de 60 e acima do trabalho longo de cada papel.
const PRAZO_POR_PAPEL = [
  { papel: 'calculista', re: /calcul|contingenc|liquida/, min: 55 },
  { papel: 'revisor', re: /revis/, min: 40 },
  { papel: 'avaliador', re: /avaliador|avaliacao|(?:^|-)meta(?:-|$)/, min: 35 },
];
/**
 * O papel do `--papel`, pelo nome canônico ou por sinônimo ("revisao", "revisora", "contingencia",
 * "calculo", "meta"): o mesmo radical que lê o papel no nome do despacho. Medido no m2g da 0.9.83:
 * `--papel revisao` foi recusado, só "revisor" passava.
 */
function papelPedidoCanonico(pedido) {
  const n = nomeDoDespacho(pedido);
  const achado = PRAZO_POR_PAPEL.find((p) => p.papel === n || p.re.test(n));
  return achado ? achado.papel : null;
}
function papelDoDespacho(nome, pedido) {
  const canonico = pedido ? papelPedidoCanonico(pedido) : null;
  const n = nomeDoDespacho(nome);
  const achado = PRAZO_POR_PAPEL.find((p) => (canonico ? p.papel === canonico : p.re.test(n)));
  return achado ? { papel: achado.papel, min: achado.min } : { papel: null, min: PRAZO_DO_DESPACHO_MIN };
}

// Queda é o que o serviço diz (o erro da API, a conexão que caiu), nunca a demora: a demora tem o
// `caido` do relógio. Medido no m7 da 0.9.81: `--erro` por inferência ("o subagente só demorou")
// zerou o relógio e gravou "erro" num despacho que terminou bem.
const SINAL_DE_QUEDA = /\b(?:5\d\d|429|529)\b|api error|terminated early|upstream|enotfound|econnreset|econnrefused|etimedout|eai_again|socket hang up|can.?t reach|request interrupted|interrupted|connection (?:reset|closed|refused|error|lost)|network error|overloaded|rate[ _-]?limit|too many requests|timed? ?out|stream (?:error|closed)|internal server error|service unavailable|bad gateway|gateway timeout/i;

/** `--duracao` (o que o retorno do subagente informa): "398s", "398", "6,6min", "123456ms", "1h". Em ms. */
/** Nenhum despacho dura mais que isto: acima, o número é milissegundo lido como segundo, ou erro de conta. */
const DURACAO_MAXIMA_MS = 6 * 3600000;
function lerDuracao(valor) {
  const m = String(valor).trim().toLowerCase().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(ms|s|seg|segundos?|min|m|minutos?|h)?$/);
  if (!m) die(`--duracao "${valor}": use segundos (398 ou 398s), minutos (6.6min), milissegundos (398000ms) ou horas (1h)`);
  const n = Number(m[1]);
  const u = m[2] || 's';
  const ms = Math.round(u === 'ms' ? n : /^min|^m$|^minuto/.test(u) ? n * 60000 : u === 'h' ? n * 3600000 : n * 1000);
  // Medido no m2r da 0.9.83: o retorno informou milissegundos, o número puro foi lido como segundos
  // e o fim ficou 27 horas no futuro, sem recusa.
  if (ms > DURACAO_MAXIMA_MS) {
    die(m[2]
      ? `--duracao "${valor}": ${Math.round(ms / 360000) / 10} h é implausível para um despacho (mais de 6 h); confira a unidade`
      : `--duracao "${valor}": número puro é segundos, e ${Math.round(ms / 360000) / 10} h é implausível para um despacho (mais de 6 h); se o retorno informou milissegundos, passe com o sufixo (${valor}ms), ou use s ou min`);
  }
  return ms;
}

/** `--volta`: a hora em que o subagente voltou, ISO ou HH:MM[:SS] de hoje (ou de ontem, se ainda não chegou). */
function lerVolta(valor) {
  const v = String(valor).trim();
  const hm = v.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] || 0), 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) die(`--volta "${valor}": use a hora ISO (2026-10-02T18:05:00Z) ou HH:MM[:SS] de hoje`);
  return t;
}

// Um arquivo por despacho (L3, medido em 27/09/2026 no HC, motor 0.9.60): os três avaliadores da
// meta se despachavam juntos, cada um seguido do seu `aguardar`, e os três processos liam e
// regravavam o mesmo `despachos.json`: a marca de um sumia na gravação do outro, e o `--fim` dizia
// "nenhum despacho marcado". E o `pronto` (ou o `caido`) apagava a marca, então o `--fim` que o
// runner manda rodar depois dele também morria. Agora cada despacho tem o seu arquivo em
// `_tmp/despachos/`, o estado final (`pronto`, `caido`) fica gravado até o `--fim`, e o nome se
// casa sem caixa, acento nem separador ("Avaliador Meta 1 v10" é "avaliador-meta-1-v10").
function nomeDoDespacho(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function despachosDoRun(dir) {
  const ledger = loadRunLedger(dir);
  if (!ledger || !ledger.runId) die('aguardar requer um run aberto (squad-state init)');
  const pasta = join(dir, 'output', ledger.runId, '_tmp', 'despachos');
  const legado = join(dir, 'output', ledger.runId, '_tmp', 'despachos.json');
  const caminho = (nome) => join(pasta, `${nomeDoDespacho(nome)}.json`);
  const ler = (nome) => {
    try { return JSON.parse(readFileSync(caminho(nome), 'utf-8')); } catch { /* sem marca própria */ }
    // A marca gravada pelo formato anterior (um arquivo só), num run aberto antes do update.
    try {
      const antigos = JSON.parse(readFileSync(legado, 'utf-8'));
      const chave = Object.keys(antigos).find((k) => nomeDoDespacho(k) === nomeDoDespacho(nome));
      return chave ? antigos[chave] : null;
    } catch { return null; }
  };
  const gravar = (nome, d) => {
    mkdirSync(pasta, { recursive: true });
    const destino = caminho(nome);
    const temporario = `${destino}.${process.pid}.tmp`;
    writeFileSync(temporario, `${JSON.stringify(d, null, 2)}\n`, 'utf-8');
    renameSync(temporario, destino);
  };
  const apagar = (nome) => {
    rmSync(caminho(nome), { force: true });
    try {
      const antigos = JSON.parse(readFileSync(legado, 'utf-8'));
      const chave = Object.keys(antigos).find((k) => nomeDoDespacho(k) === nomeDoDespacho(nome));
      if (chave) { delete antigos[chave]; writeFileSync(legado, `${JSON.stringify(antigos, null, 2)}\n`, 'utf-8'); }
    } catch { /* sem o formato anterior */ }
  };
  const marcados = () => {
    try { return readdirSync(pasta).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
  };
  return { ler, gravar, apagar, marcados };
}

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A marca antes de tudo (M3, medido em 27/09/2026 na réplica, motor 0.9.61): o chefe despachou os
// três avaliadores da meta e marcou dois deles com `--janela 0` (marcar sem esperar); a janela zero
// era recusada ANTES da marca, e o `--fim` dos dois não achou despacho. Agora a marca é gravada
// antes de qualquer espera e de qualquer recusa da janela; `--janela 0` só marca e volta
// (`marcado`); e vários `--despacho` numa chamada marcam todos (e o `--fim` com vários encerra
// todos), cada um com o seu relógio e, se vier um `--saida` por despacho, com o seu artefato.
function cmdAguardar(dir, flags) {
  const nomes = asList(flags.despacho).map((n) => str(n).trim());
  if (!nomes.length || nomes.some((n) => !n)) die('aguardar requer --despacho <nome do despacho> (ex.: avaliador-meta-v11)');
  const semLetra = nomes.find((n) => !nomeDoDespacho(n));
  if (semLetra) die(`--despacho "${semLetra}" não tem letra nem número`);
  const limitePedido = flags.limite === undefined ? null : Number(flags.limite);
  if (limitePedido !== null && !(limitePedido > 0)) die('--limite são minutos maiores que zero');
  const papelPedido = flags.papel === undefined ? null : str(flags.papel).trim();
  if (papelPedido && !papelPedidoCanonico(papelPedido)) die(`--papel "${papelPedido}": use ${PRAZO_POR_PAPEL.map((p) => p.papel).join(', ')} ou um sinônimo (revisao, contingencia, calculo, meta); sem papel, o limite é ${PRAZO_DO_DESPACHO_MIN} minutos`);
  const limiteDe = (nome) => limitePedido ?? papelDoDespacho(nome, papelPedido).min;
  const limite = limiteDe(nomes[0]);
  if (flags.fase !== undefined && !faseValida(str(flags.fase).trim())) die(`aguardar: --fase "${str(flags.fase)}" fora da lista (${FASES_DO_RUN.join(', ')}, ou gate:<nome>)`);
  const tokensPedidos = asList(flags.tokens).map((t) => lerTokens(t, 'aguardar'));
  if (tokensPedidos.length && flags.fim !== true) die('aguardar: --tokens vai com --fim (os tokens são do retorno do subagente)');
  if (tokensPedidos.length && tokensPedidos.length !== nomes.length) die(`aguardar: ${tokensPedidos.length} --tokens para ${nomes.length} --despacho; um por despacho, na mesma ordem`);
  const { ler, gravar, apagar, marcados } = despachosDoRun(dir);
  const agora = Date.now();
  const saidas = asList(flags.saida).filter((s) => typeof s === 'string').map((s) => (isAbsolute(s) ? s : resolve(s)));
  const mtime = (f) => { try { const st = statSync(f); return st.size > 0 ? st.mtimeMs : null; } catch { return null; } };
  const minutos = (desde, ate = Date.now()) => Math.round((ate - desde) / 600) / 100;
  if (flags.erro !== undefined || flags.recuo === true) return erroOuRecuoDoDespacho(nomes, flags, { ler, gravar, agora, limite });
  // A hora real de volta: `--volta`, `--duracao` (o que o retorno do subagente informa), ou o mtime
  // da saída que ele gravou. Medido no m2b da 0.9.81: o `--fim` media até a hora do comando (31 min
  // registrados, 15 reais, porque a espera do shell estourou antes do fechamento).
  const duracoes = asList(flags.duracao).filter((v) => typeof v === 'string').map(lerDuracao);
  const voltas = asList(flags.volta).filter((v) => typeof v === 'string').map(lerVolta);
  for (const [lista, nome] of [[duracoes, 'duracao'], [voltas, 'volta']]) if (lista.length && lista.length !== nomes.length) die(`aguardar: ${lista.length} --${nome} para ${nomes.length} --despacho; um por despacho, na mesma ordem`);
  if ((duracoes.length || voltas.length || flags.tardio === true) && flags.fim !== true) die('aguardar: --duracao, --volta e --tardio vão com --fim (são do retorno do subagente)');
  const voltaReal = (d, i) => {
    if (voltas.length) return { ate: voltas[i], como: 'volta' };
    if (duracoes.length) return { ate: Date.parse(d.inicio) + duracoes[i], como: 'duracao' };
    const alvos = d.saidas || (d.saida ? [{ saida: d.saida, base_mtime: d.base_mtime }] : []);
    const gravados = alvos.map((a) => mtime(a.saida)).filter((m, k) => m !== null && m >= Date.parse(d.inicio) && (alvos[k].base_mtime === null || alvos[k].base_mtime === undefined || m > alvos[k].base_mtime));
    if (alvos.length && gravados.length === alvos.length) return { ate: Math.max(...gravados), como: 'saida' };
    if (d.fim && d.estado) return { ate: Date.parse(d.fim), como: d.estado };
    return null;
  };
  if (flags.fim === true) {
    const ledgerDoRun = loadRunLedger(dir);
    // Retorno tardio do despacho que caiu e já foi redespachado (a marca é do redespacho) ou já foi
    // fechado: corrige o registro da tentativa caída, que voltou bem, com a hora real e os tokens.
    if (flags.tardio === true) {
      if (nomes.length > 1) die('aguardar --fim --tardio: um despacho por vez');
      const n = nomes[0];
      const tokens = tokensPedidos.length ? tokensPedidos[0] : null;
      const d = ler(n);
      const anteriores = d && Array.isArray(d.anteriores) ? d.anteriores : [];
      const k = [...anteriores.keys()].reverse().find((x) => ['erro', 'caido'].includes(anteriores[x].estado) && !anteriores[x].tardio);
      const corrigir = (t) => {
        const real = voltaReal({ ...t, estado: null, fim: null }, 0);
        const ate = real ? real.ate : Date.now();
        return { ...t, estado: 'pronto', tardio: true, estado_anterior: t.estado, fim: new Date(ate).toISOString(), ...(real ? {} : { fim_estimado: 'hora do comando' }), ...(tokens !== null ? { tokens } : {}) };
      };
      if (k !== undefined) {
        anteriores[k] = corrigir(anteriores[k]);
        gravar(n, { ...d, anteriores });
        console.log(JSON.stringify({ acao: 'corrigido', despacho: n, tentativa: k + 1, estado: 'pronto', tardio: true, minutos: minutos(Date.parse(anteriores[k].inicio), Date.parse(anteriores[k].fim)), detail: 'a tentativa caída voltou bem: o registro foi corrigido e vai ao ledger com o fechamento do despacho' }, null, 2));
        return null;
      }
      const lista = Array.isArray(ledgerDoRun.despachos) ? ledgerDoRun.despachos : [];
      const j = [...lista.keys()].reverse().find((x) => lista[x].despacho === nomeDoDespacho(n) && ['erro', 'caido'].includes(lista[x].estado));
      if (j === undefined) die(`aguardar --tardio: nenhuma tentativa caída de "${n}" a corrigir neste run`);
      const corrigido = corrigir(lista[j]);
      atualizarRunLedger(dir, (l) => ({ ...l, despachos: l.despachos.map((x, y) => (y === j ? corrigido : x)) }));
      console.log(JSON.stringify({ acao: 'corrigido', despacho: n, estado: 'pronto', tardio: true, minutos: minutos(Date.parse(corrigido.inicio), Date.parse(corrigido.fim)), detail: 'o registro do despacho caído foi corrigido no ledger: ele voltou bem' }, null, 2));
      return null;
    }
    const faltam = nomes.filter((n) => !ler(n));
    if (faltam.length) {
      const outros = marcados();
      die(`nenhum despacho ${faltam.map((n) => `"${n}"`).join(', ')} marcado neste run${outros.length ? ` (marcados: ${outros.join(', ')})` : ''}`);
    }
    const avisos = [];
    const encerrados = nomes.map((n, i) => {
      const d = ler(n);
      apagar(n);
      const tokens = tokensPedidos.length ? tokensPedidos[i] : null;
      // O despacho marcado como erro ou caído que fecha com o retorno (tokens, duração ou hora de
      // volta) voltou bem: o registro sai corrigido, nunca "erro" num despacho que terminou.
      const voltou = ['erro', 'caido'].includes(d.estado) && (tokens !== null || duracoes.length || voltas.length);
      const real = voltaReal(voltou ? { ...d, estado: null, fim: null } : d, i);
      const ate = real ? real.ate : Date.now();
      if (!real) avisos.push(`${n}: sem a hora real de volta (nenhuma saída gravada pelo subagente): o fim é a hora deste comando; passe --duracao com a duração que o retorno do subagente informa`);
      const estado = voltou ? 'pronto' : d.estado;
      const fase = str(flags.fase).trim() || d.fase || faseDoDespacho(n, faseDoStepAberto(ledgerDoRun).fase);
      const tentativas = (Array.isArray(d.anteriores) ? d.anteriores : []);
      const registro = { despacho: nomeDoDespacho(n), inicio: d.inicio, fim: new Date(ate).toISOString(), fase, ...(d.stepId ? { stepId: d.stepId } : {}), ...(estado ? { estado } : {}), ...(voltou ? { tardio: true, estado_anterior: d.estado } : {}), ...(real ? { fim_por: real.como } : { fim_estimado: 'hora do comando' }), ...(tokens !== null ? { tokens } : {}), ...(tentativas.some((t) => !t.tardio) ? { tentativas: tentativas.filter((t) => !t.tardio) } : {}) };
      // A tentativa caída que voltou bem (corrigida com --tardio) é trabalho real: vai ao ledger como despacho próprio.
      const tardios = tentativas.filter((t) => t.tardio).map((t) => ({ despacho: nomeDoDespacho(n), inicio: t.inicio, fim: t.fim, fase, ...(d.stepId ? { stepId: d.stepId } : {}), estado: 'pronto', tardio: true, estado_anterior: t.estado_anterior, ...(t.tokens !== undefined ? { tokens: t.tokens } : {}) }));
      return { despacho: n, ...(estado ? { estado } : {}), ...(voltou ? { tardio: true } : {}), minutos: minutos(Date.parse(d.inicio), ate), ...(tokens !== null ? { tokens } : {}), _registros: [...tardios, registro] };
    });
    // O despacho encerrado vai ao ledger do run (`despachos[]`): a marca em `_tmp/despachos/` some
    // no --fim, e sem o registro o tempo e os tokens por fase não tinham de onde sair.
    atualizarRunLedger(dir, (l) => ({ ...l, despachos: [...(Array.isArray(l.despachos) ? l.despachos : []), ...encerrados.flatMap((e) => e._registros)] }));
    for (const e of encerrados) delete e._registros;
    console.log(JSON.stringify(encerrados.length === 1 ? { acao: 'encerrado', ...encerrados[0], ...(avisos.length ? { avisos } : {}) } : { acao: 'encerrado', despachos: encerrados, ...(avisos.length ? { avisos } : {}) }, null, 2));
    return null;
  }
  // Marca de um despacho que já terminou (pronto ou caído, sem o --fim): o novo despacho com o mesmo nome começa um relógio novo.
  // Um despacho com vários artefatos (o lote do descritor de imagens grava um por imagem) leva um
  // --saida por artefato, e só fica pronto com todos: com um só, "pronto" veio com 1 de 8 gravados
  // (achado 19 do run de 01/10/2026).
  const marcar = (nome, lista) => {
    const atual = ler(nome);
    if (atual && !atual.estado) return atual;
    if (atual && atual.recuo_ate && Date.parse(atual.recuo_ate) > Date.now()) {
      die(`o despacho ${nome} está no recuo de um limite da API (429) até ${atual.recuo_ate}: rode \`aguardar --despacho ${nome} --recuo\` e só então redespache`);
    }
    const seguidos = atual && atual.estado === 'erro' && Number(atual.limites_seguidos) > 0 ? { limites_seguidos: Number(atual.limites_seguidos) } : {};
    // A tentativa que terminou (caída, com erro) e não foi fechada fica na marca nova: se voltar
    // tarde, o `--fim --tardio` corrige o registro dela.
    const anteriores = atual && atual.estado ? [...(Array.isArray(atual.anteriores) ? atual.anteriores : []), { inicio: atual.inicio, fim: atual.fim || null, estado: atual.estado, ...(atual.erro ? { erro: atual.erro } : {}) }] : [];
    const alvos = (lista || []).filter(Boolean);
    const comSaida = alvos.length === 1 ? { saida: alvos[0], base_mtime: mtime(alvos[0]) } : alvos.length > 1 ? { saidas: alvos.map((saida) => ({ saida, base_mtime: mtime(saida) })) } : {};
    // A fase e o step em que o despacho saiu: o `--fim` os leva ao ledger, com os tokens.
    const aberto = faseDoStepAberto(loadRunLedger(dir));
    const fase = str(flags.fase).trim() || faseDoDespacho(nome, aberto.fase);
    const papel = papelDoDespacho(nome, papelPedido).papel;
    const d = { inicio: new Date(agora).toISOString(), limite_min: limiteDe(nome), ...(papel ? { papel } : {}), fase, ...(aberto.stepId ? { stepId: aberto.stepId } : {}), ...comSaida, ...seguidos, ...(anteriores.length ? { anteriores } : {}) };
    gravar(nome, d);
    return d;
  };
  if (nomes.length > 1) {
    const pareadas = saidas.length === nomes.length;
    const despachos = nomes.map((n, i) => {
      const d = marcar(n, pareadas ? [saidas[i]] : null);
      return { despacho: n, inicio: d.inicio, minutos: minutos(Date.parse(d.inicio)), ...(d.saida ? { saida: d.saida } : {}) };
    });
    console.log(JSON.stringify({
      acao: 'marcado', despachos,
      ...(saidas.length && !pareadas ? { aviso: `${saidas.length} --saida para ${nomes.length} despachos: nenhum artefato foi associado; marque cada um com o seu --saida, se precisar` } : {}),
      detail: 'as marcas estão gravadas e os relógios correm desde agora; espere cada um com `aguardar --despacho <nome>` e feche com `aguardar --despacho <nome> --fim`',
    }, null, 2));
    return null;
  }
  const nome = nomes[0];
  const d = marcar(nome, saidas);
  const janela = flags.janela === undefined ? JANELA_DO_AGUARDAR_MIN : Number(flags.janela);
  if (!(janela >= 0) || janela > 9) die(`--janela são minutos de 0 (só marca, sem esperar) a 9 (a ferramenta de shell corta a chamada em 10); a marca do despacho já foi gravada: chame \`aguardar --despacho ${nome}\` com uma janela válida`);
  const inicio = Date.parse(d.inicio);
  const prazo = inicio + (Number(d.limite_min) || limiteDe(nome)) * 60000;
  const fimDaJanela = Math.min(agora + janela * 60000, prazo);
  const pollMs = Math.max(50, Number(process.env.LEGALSQUAD_AGUARDAR_POLL_MS) || 15000);
  const alvos = d.saidas || (d.saida ? [{ saida: d.saida, base_mtime: d.base_mtime }] : saidas.map((saida) => ({ saida })));
  const alvo = alvos.length ? alvos[0].saida : null;
  // Gravado depois do despacho, não só diferente do que havia na marca: a cópia preparada para o
  // complemento, com o mtime do original, dava `pronto` sem o subagente ter gravado (m4, 01/10/2026).
  const novo = (a) => { const m = mtime(a.saida); return m !== null && m >= inicio && (a.base_mtime === null || a.base_mtime === undefined || m > a.base_mtime); };
  const contagem = () => (alvos.length > 1 ? { saidas_prontas: `${alvos.filter(novo).length}/${alvos.length}` } : {});
  const terminar = (estado) => gravar(nome, { ...d, estado, fim: new Date().toISOString() });
  for (;;) {
    if (alvos.length && alvos.every(novo)) {
      terminar('pronto');
      console.log(JSON.stringify({ acao: 'pronto', despacho: nome, ...(alvos.length > 1 ? { saidas: alvos.map((a) => a.saida) } : { saida: alvo }), minutos: minutos(inicio) }, null, 2));
      return null;
    }
    if (Date.now() >= prazo) {
      terminar('caido');
      console.log(JSON.stringify({
        acao: 'caido', despacho: nome, minutos: minutos(inicio), limite_min: Number(d.limite_min) || limiteDe(nome), ...(d.papel ? { papel: d.papel } : {}),
        ...contagem(),
        detail: `o despacho passou de ${Number(d.limite_min) || limiteDe(nome)} minutos sem retorno${alvo ? ` nem ${alvos.length > 1 ? 'todos os artefatos esperados' : 'o artefato esperado'}` : ''}: interrompa o subagente e redespache uma vez, em contexto fresco, como numa queda por erro da API (o redespacho com o mesmo --despacho começa um relógio novo)`,
      }, null, 2));
      return null;
    }
    if (Date.now() >= fimDaJanela) break;
    dormir(Math.min(pollMs, fimDaJanela - Date.now()));
  }
  const restam = Math.max(0, Math.round((prazo - Date.now()) / 600) / 100);
  console.log(JSON.stringify(janela === 0
    ? { acao: 'marcado', despacho: nome, minutos: minutos(inicio), restam_min: restam, detail: 'marca gravada, sem espera; o relógio corre desde a marca: espere com `aguardar --despacho <nome>` e feche com `--fim`' }
    : {
      acao: 'esperando', despacho: nome, minutos: minutos(inicio), restam_min: restam, ...contagem(),
      detail: 'se o subagente já voltou, siga e rode `aguardar --despacho <nome> --fim`; se não, chame `aguardar` de novo com o mesmo --despacho',
    }, null, 2));
  return null;
}

// Limite da API (429, rate limit, sobrecarga 529) não se resolve com redespacho imediato: o mesmo
// limite volta (m2, 01/10/2026). `--erro` registra a queda; no limite, devolve o recuo (1 minuto,
// dobrando a cada limite seguido do mesmo despacho, teto de 8) e recusa a marca nova até ele
// passar; `--recuo` espera o que falta. Outra queda (502, conexão) redespacha na hora.
const ERRO_DE_LIMITE_DA_API = /\b(?:429|529)\b|rate[ _-]?limit|too many requests|overloaded/i;
function erroOuRecuoDoDespacho(nomes, flags, { ler, gravar, agora, limite }) {
  if (nomes.length > 1) die('aguardar --erro/--recuo: um despacho por vez');
  const nome = nomes[0];
  const atual = ler(nome);
  if (flags.recuo === true) {
    const ate = atual && atual.recuo_ate ? Date.parse(atual.recuo_ate) : null;
    if (ate && ate > Date.now()) dormir(Math.min(ate - Date.now(), 9 * 60000));
    const falta = ate && ate > Date.now() ? Math.ceil((ate - Date.now()) / 1000) : 0;
    console.log(JSON.stringify(falta
      ? { acao: 'recuar', despacho: nome, esperar_ms: falta * 1000, detail: `o recuo ainda não acabou (${falta} s): chame \`aguardar --despacho ${nome} --recuo\` de novo` }
      : { acao: 'pode-redespachar', despacho: nome, limites_seguidos: Number(atual?.limites_seguidos) || 0, detail: 'redespache em contexto fresco, com o mesmo despacho, e marque com o mesmo --despacho' }, null, 2));
    return null;
  }
  const mensagem = str(flags.erro).trim();
  if (!mensagem) die('aguardar --erro requer a mensagem do erro, literal');
  if (atual && atual.estado === 'pronto') die(`aguardar --erro: o despacho ${nome} já está pronto (a saída foi gravada); feche-o com --fim`);
  if (!SINAL_DE_QUEDA.test(mensagem)) die(`aguardar --erro: "${mensagem.slice(0, 120)}" não é sinal de queda (o erro da API, a conexão perdida, 5xx, 429). Despacho que só demorou não é erro: espere com \`aguardar --despacho ${nome}\`, que responde \`caido\` passado o limite do papel; se ele voltar, feche com --fim`);
  const limiteDaApi = ERRO_DE_LIMITE_DA_API.test(mensagem);
  const seguidos = limiteDaApi ? (Number(atual?.limites_seguidos) || 0) + 1 : 0;
  const baseMs = Number(process.env.LEGALSQUAD_RECUO_BASE_MS) || 60000;
  const esperar = limiteDaApi ? Math.min(baseMs * 2 ** (seguidos - 1), 8 * baseMs) : 0;
  const base = atual || { inicio: new Date(agora).toISOString(), limite_min: limite };
  gravar(nome, { ...base, estado: 'erro', fim: new Date(agora).toISOString(), erro: mensagem.slice(0, 300), limites_seguidos: seguidos, ...(esperar ? { recuo_ate: new Date(agora + esperar).toISOString() } : { recuo_ate: null }) });
  console.log(JSON.stringify(limiteDaApi
    ? { acao: 'recuar', despacho: nome, esperar_ms: esperar, limites_seguidos: seguidos, recuo_ate: new Date(agora + esperar).toISOString(), detail: `limite da API: não redespache agora. Rode \`aguardar --despacho ${nome} --recuo\` (espera o recuo) e só então redespache, com no máximo dois subagentes ao mesmo tempo até o fim da fase` }
    : { acao: 'redespachar', despacho: nome, detail: 'queda da API que não é limite: redespache na hora, uma vez, em contexto fresco; a segunda queda seguida vai ao profissional' }, null, 2));
  return null;
}

// ---------------------------------------------------------------------------
// Vigia de tempo do subagente (0.9.100). Medido no run de 09/10/2026 (trib-reforma-regime, ritmo
// Rápido): o revisor trabalhou de 17:59Z a 23:03Z (91 Bash, 14 Read, turnos de 6 a 35 min entre
// chamadas) sem que ninguém medisse, e a sessão diagnosticou "parado desde 14:59" olhando o arquivo
// errado. O vigia lê a transcrição do próprio subagente, que o Claude Code grava em
// `<projetos>/<slug do cwd>/<sessão>/subagents/agent-<agentId>.jsonl`, e sai com JSON.
// ---------------------------------------------------------------------------
/** Minutos que o subagente pode trabalhar, pelo ritmo do run. */
const VIGIA_TETO_POR_RITMO = Object.freeze({ rapido: 30, equilibrado: 45, completo: 60 });
/** Minutos sem escrita na transcrição que contam como subagente sem atividade. */
const VIGIA_SEM_ATIVIDADE_MIN = 20;

/** A pasta do projeto no Claude Code: o caminho absoluto com todo caractere fora de [A-Za-z0-9] trocado por "-". */
function slugDoProjetoClaude(caminho) {
  return String(caminho).replace(/[^A-Za-z0-9]/g, '-');
}

/** `<config do Claude Code>/projects`: `--projetos-dir`, ou `$CLAUDE_CONFIG_DIR/projects` quando definido, ou `~/.claude/projects`. */
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
  const nome = `agent-${agente}.jsonl`;
  const real = (p) => tentarOuPadrao(() => realpathSync(p), p);
  const doProjeto = [...new Set([raiz, real(raiz), process.cwd(), real(process.cwd())].map(slugDoProjetoClaude))].map((s) => join(projetos, s));
  const naPasta = (pastas) => {
    let melhor = null;
    for (const pasta of pastas) {
      let sessoes;
      try { sessoes = readdirSync(pasta, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
      for (const sessao of sessoes) {
        const f = join(pasta, sessao.name, 'subagents', nome);
        const m = tentarOuPadrao(() => statSync(f).mtimeMs, null);
        if (m !== null && (!melhor || m > melhor.m)) melhor = { f, m, sessao: sessao.name };
      }
    }
    return melhor;
  };
  const achado = naPasta(doProjeto) || naPasta(tentarOuPadrao(() => readdirSync(projetos).map((n) => join(projetos, n)), []));
  return achado ? { arquivo: achado.f, sessao: achado.sessao } : null;
}

/** O que a transcrição diz: começo (primeiro timestamp), chamadas de ferramenta por nome e a hora da última escrita (mtime). */
function lerTranscricaoDoSubagente(arquivo) {
  let bruto;
  let mtime;
  try { bruto = readFileSync(arquivo, 'utf-8'); mtime = statSync(arquivo).mtimeMs; } catch { return null; }
  let inicio = null;
  const porFerramenta = {};
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue;
    let r;
    try { r = JSON.parse(linha); } catch { continue; }
    if (!inicio && typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp))) inicio = Date.parse(r.timestamp);
    const conteudo = r && r.type === 'assistant' && r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const c of conteudo) if (c && c.type === 'tool_use') porFerramenta[c.name || '?'] = (porFerramenta[c.name || '?'] || 0) + 1;
  }
  const total = Object.values(porFerramenta).reduce((a, b) => a + b, 0);
  return { inicio, mtime, chamadas: total, por_ferramenta: porFerramenta };
}

/**
 * `vigiar <squad-dir> --agente <agentId> --espera <arquivo> [--teto-min N] [--sem-atividade-min N]
 * [--intervalo-s N] [--projetos-dir <dir>]`: o runner o roda em segundo plano (Bash com
 * run_in_background, sem `&` nem `nohup`) logo depois de despachar revisor, verificador de citações
 * ou avaliador. Sai com JSON: `pronto` quando o arquivo esperado aparece (gravado depois do começo do
 * subagente), `passou-do-teto` quando passa o teto (default pelo ritmo: rápido 30 min, equilibrado
 * 45, rigoroso 60) e `sem-atividade` quando a transcrição fica 20 min sem escrita; nos dois últimos,
 * com minutos, chamadas de ferramenta e minutos desde a última escrita, e sai com 3.
 */
function cmdVigiar(dir, flags) {
  const agente = str(flags.agente).trim().replace(/^agent-/, '').replace(/\.jsonl$/, '');
  if (!agente || !/^[A-Za-z0-9_-]+$/.test(agente)) die('vigiar requer --agente <agentId> (o id que o Agent devolve, ex.: ad31a21d97b5f9262)');
  if (typeof flags.espera !== 'string' || !flags.espera.trim()) die('vigiar requer --espera <arquivo que o subagente grava ao terminar> (o veredito do revisor; o JSON do hook do verificador)');
  const espera = isAbsolute(flags.espera) ? flags.espera : resolve(flags.espera);
  const numero = (nome, valor, padrao) => {
    if (valor === undefined) return padrao;
    const n = Number(String(valor).replace(',', '.'));
    if (!(n > 0)) die(`--${nome} são números maiores que zero`);
    return n;
  };
  const ritmo = tentarOuPadrao(() => perfilDoRun(dir).nome, PERFIL_PADRAO);
  const teto = numero('teto-min', flags['teto-min'], VIGIA_TETO_POR_RITMO[ritmo] || VIGIA_TETO_POR_RITMO.completo);
  const semAtividade = numero('sem-atividade-min', flags['sem-atividade-min'], VIGIA_SEM_ATIVIDADE_MIN);
  const intervalo = numero('intervalo-s', flags['intervalo-s'], 20);
  const raiz = resolve(dir, '..', '..');
  const projetos = pastaDeProjetosDoClaude(flags['projetos-dir']);
  const inicioDoVigia = Date.now();
  const min = (ms) => Math.round(ms / 6000) / 10;
  const br = (n) => String(n).replace('.', ',');
  const rotulo = TEXTO_DOS_RITMOS[ritmo] ? TEXTO_DOS_RITMOS[ritmo].rotulo : ritmo;
  let achado = null;
  for (;;) {
    if (!achado) achado = transcricaoDoSubagente(projetos, raiz, agente);
    const t = achado ? lerTranscricaoDoSubagente(achado.arquivo) : null;
    const inicio = t && t.inicio ? t.inicio : inicioDoVigia;
    const agora = Date.now();
    const base = {
      agente, ritmo, teto_min: teto, espera, transcricao: achado ? achado.arquivo : null,
      minutos: min(agora - inicio), chamadas_de_ferramenta: t ? t.chamadas : null, por_ferramenta: t ? t.por_ferramenta : null,
      minutos_desde_a_ultima_escrita: t && t.mtime ? min(agora - t.mtime) : null,
    };
    const gravado = tentarOuPadrao(() => { const st = statSync(espera); return st.size > 0 && st.mtimeMs >= inicio - 5000 ? st.mtimeMs : null; }, null);
    if (gravado !== null) {
      console.log(JSON.stringify({ estado: 'pronto', ...base, minutos: min(gravado - inicio), detail: 'o arquivo esperado foi gravado: siga com o retorno do subagente' }, null, 2));
      return null;
    }
    const numeros = `${br(base.minutos)} min desde o começo, ${base.chamadas_de_ferramenta === null ? 'transcrição não encontrada' : `${base.chamadas_de_ferramenta} chamadas de ferramenta`}${base.minutos_desde_a_ultima_escrita !== null ? `, última escrita na transcrição há ${br(base.minutos_desde_a_ultima_escrita)} min` : ''}`;
    const saida = (estado, motivo) => {
      console.log(JSON.stringify({
        estado, ...base,
        acao: `pare o subagente ${agente} e redespache o mesmo despacho (para o revisor, o despacho_do_revisor do review-status) com a linha a mais: "${LINHA_DE_REENVIO}"`,
        linha_de_reenvio: LINHA_DE_REENVIO,
        mensagem_ao_profissional: `${motivo} (${numeros}; ritmo ${rotulo}, teto de ${teto} min). Parei e reenviei para julgar com o que já está nos artefatos, sem abrir fonte.`,
      }, null, 2));
      process.exitCode = 3;
      return null;
    };
    if (base.minutos >= teto) return saida('passou-do-teto', `O subagente ${agente} passou do teto de tempo do ritmo sem gravar o resultado`);
    if (base.minutos_desde_a_ultima_escrita !== null && base.minutos_desde_a_ultima_escrita >= semAtividade) return saida('sem-atividade', `O subagente ${agente} ficou ${br(base.minutos_desde_a_ultima_escrita)} min sem escrever na transcrição e sem gravar o resultado`);
    dormir(Math.max(50, intervalo * 1000));
  }
}

function cmdRunStatus(dir) {
  console.log(JSON.stringify(retomarRun(loadRunLedger(dir)), null, 2));
  return null;
}

if (process.argv[2] === '--uso') {
  console.log(JSON.stringify(USO_SQUAD_STATE, null, 2));
  process.exit(0);
}
const { command, dir, flags } = parseArgs(process.argv.slice(2));
if (!command || !dir)
  die('uso: squad-state <init|ritmo|step|checkpoint|fora-do-fluxo|anular-fora-do-fluxo|red-team|dupla-contagem|aprovar-design|skills-resolvidas|complete|fail|reabrir|review-open|review-verdict|review-status|citacoes-pendentes|citacoes-status|manifesto-final|persuasao-carimbo|run-status|meta-consenso|meta-despacho|meta-voto|steps-posteriores|aguardar|fase|contrato-redacao|pedidos-novos|retorno-subagente|vigiar> <squad-dir> [opções]');
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
  'meta-despacho': cmdMetaDespacho,
  'meta-voto': cmdMetaVoto,
  'steps-posteriores': cmdStepsPosteriores,
  reabrir: cmdReabrir,
  'fora-do-fluxo': cmdForaDoFluxo,
  'anular-fora-do-fluxo': cmdAnularForaDoFluxo,
  'red-team': cmdRedTeam,
  'dupla-contagem': cmdDuplaContagem,
  'pedidos-novos': cmdPedidosNovos,
  'aprovar-design': cmdAprovarDesign,
  'skills-resolvidas': cmdSkillsResolvidas,
  aguardar: cmdAguardar,
  'fase-zero-reaproveitar': cmdFaseZeroReaproveitar,
  fase: cmdFase,
  'contrato-redacao': cmdContratoRedacao,
  'retorno-subagente': cmdRetornoSubagente,
  vigiar: cmdVigiar,
};
if (!commands[command]) die(`comando desconhecido: ${command}`);
// Comandos de revisão já imprimiram o JSON da decisão; os de estado confirmam
// a escrita em uma linha (como sempre fizeram).
if (commands[command](dir, flags) !== null) console.log(`state.json atualizado (${command}) em ${dir}`);
