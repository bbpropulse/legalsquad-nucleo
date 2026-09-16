// Lib compartilhada dos scripts "orchestra" do LegalSquad.
// Padrão importado do My-Brain-Is-Full-Crew: helpers pré-aprovados que consultam um
// cache LOCAL (JSONL) — respostas instantâneas, sem re-consultar a API do DJEN.
// O cache vive em _legalsquad/_memory/djen-tracker.jsonl (gitignored, privado).

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/orchestra/ -> raiz do projeto -> _legalsquad/_memory/
const TRACKER_PADRAO = join(__dirname, '..', '..', '_legalsquad', '_memory', 'djen-tracker.jsonl');

// Resolvido a cada chamada (e não uma vez no import) para que teste e operação
// possam apontar outro cache via LEGALSQUAD_TRACKER sem depender da ordem do import.
export function trackerPath() {
  return process.env.LEGALSQUAD_TRACKER || TRACKER_PADRAO;
}
export const TRACKER = TRACKER_PADRAO;

/** Marcador da última VARREDURA do DJEN — vizinho do tracker, também privado. */
export function sweepPath() {
  return join(dirname(trackerPath()), 'djen-varredura.json');
}

/**
 * Lê o tracker devolvendo { entries, ilegiveis }.
 * O arquivo é append-only: um crash no meio de um append deixa a última linha
 * truncada. Descartá-la em silêncio faria um prazo sumir e o total mentir — por
 * isso as linhas que não parseiam são CONTADAS e reportadas ao chamador.
 */
export function readTrackerResult() {
  const file = trackerPath();
  if (!existsSync(file)) return { entries: [], ilegiveis: 0, arquivo_ausente: true };
  const entries = [];
  let ilegiveis = 0;
  for (const linha of readFileSync(file, 'utf8').split('\n')) {
    const l = linha.trim();
    if (!l) continue;
    try {
      const obj = JSON.parse(l);
      // JSON válido que não é objeto (ex.: `null`, `3`) também é ilegível como registro.
      if (obj && typeof obj === 'object') entries.push(obj);
      else ilegiveis += 1;
    } catch { ilegiveis += 1; }
  }
  return { entries, ilegiveis, arquivo_ausente: false };
}

/** Lê o tracker tolerante a arquivo ausente e linhas inválidas (só as legíveis). */
export function readTracker() {
  return readTrackerResult().entries;
}

/** Chave de dedupe: nº do processo + hash curto do teor. */
export function entryId(obj) {
  const teorHash = createHash('sha1').update(String(obj.teor || '')).digest('hex').slice(0, 8);
  return obj.id || `${obj.processo || '?'}|${teorHash}`;
}

/**
 * Registra o instante de uma VARREDURA do DJEN.
 * Separado da última intimação gravada: varredura bem sucedida sem novidades é o
 * caso comum, e sem este marcador o frescor gritaria "desatualizado" todo dia
 * mesmo com o monitoramento em dia — alarme falso destrói a confiança no alarme.
 */
export function recordSweep(quando = new Date().toISOString()) {
  const file = sweepPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ultima_varredura: quando })}\n`, 'utf8');
  return quando;
}

/** Instante da última varredura registrada, ou null. */
export function lastSweep() {
  const file = sweepPath();
  if (!existsSync(file)) return null;
  try {
    const { ultima_varredura } = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isFinite(Date.parse(ultima_varredura)) ? ultima_varredura : null;
  } catch { return null; }
}

/** Acrescenta uma intimação ao cache, ignorando duplicatas (mesmo processo+teor). */
export function appendEntry(obj) {
  const id = entryId(obj);
  // Toda gravação é fruto de uma varredura — registra o instante mesmo em duplicata.
  recordSweep();
  if (readTracker().some((e) => e.id === id)) return { added: false, id };
  const entry = { capturado_em: new Date().toISOString(), lido: false, ...obj, id };
  mkdirSync(dirname(trackerPath()), { recursive: true });
  appendFileSync(trackerPath(), JSON.stringify(entry) + '\n', 'utf8');
  return { added: true, id };
}

// Fuso do FORO, não o da máquina: contêiner, cron e viagem rodam em UTC, e o campo
// `fatal` é data de calendário brasileira. Comparar com a data local da máquina
// devolveria lista vazia COM selo verde no próprio dia do vencimento.
export const FUSO_FORO = 'America/Sao_Paulo';
const FORMATADOR_FORO = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_FORO, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Data de hoje (AAAA-MM-DD) no fuso do foro. `agora` é injetável para teste. */
export const today = (agora = new Date()) => FORMATADOR_FORO.format(agora);

export function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Instante (ms) de um timestamp ISO, ou null se ilegível. Respeita o offset escrito. */
export function instante(ts) {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

export const hasFlag = (f) => process.argv.includes(f);
export const firstArg = () => process.argv.slice(2).find((a) => !a.startsWith('--'));

/** Timestamp ISO da captura mais recente no tracker, ou null se vazio. */
export function lastCapture(entries = readTracker()) {
  let max = null;
  let maxMs = -Infinity;
  for (const e of entries) {
    const ms = instante(e.capturado_em);
    // Compara INSTANTES: '...-03:00' e '...Z' não são comparáveis como string.
    if (ms !== null && ms > maxMs) { maxMs = ms; max = e.capturado_em; }
  }
  return max;
}

/**
 * Frescor do cache como dado estruturado — cache velho responde silêncio e vira
 * falsa tranquilidade ("nenhum prazo hoje") num produto de prazo processual.
 * A referência é o mais recente entre a última VARREDURA e a última intimação:
 * varrer sem achar novidade também é monitoramento em dia.
 */
export function freshness(maxHoras = 24) {
  const capture = lastCapture();
  const sweep = lastSweep();
  const msCapture = instante(capture);
  const msSweep = instante(sweep);
  const refMs = Math.max(msCapture ?? -Infinity, msSweep ?? -Infinity);
  const reference = Number.isFinite(refMs) ? new Date(refMs).toISOString() : null;
  const age_hours = reference === null ? null : Math.floor((Date.now() - refMs) / 3600000);
  return {
    last_capture: capture,
    last_sweep: sweep,
    reference,
    age_hours,
    max_hours: maxHoras,
    stale: age_hours === null || age_hours > maxHoras,
  };
}

/** Uma linha legível de frescor (só no modo humano; em --json vai como campo). */
export function printFreshness(maxHoras = 24, f = freshness(maxHoras)) {
  if (!f.stale) {
    const quanto = f.age_hours < 1 ? 'há menos de 1 h' : `há ${f.age_hours} h`;
    console.log(`última varredura do DJEN: ${quanto}\n`);
    return;
  }
  const quando = f.age_hours === null ? 'nenhuma captura no cache' : `última varredura há ${f.age_hours} h`;
  console.log(`⚠️ monitoramento desatualizado — ${quando}. Acione a varredura do DJEN antes de confiar nesta resposta.\n`);
}

function trunc(v, n = 60) { const s = v == null ? '' : String(v).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * Imprime tabela legível ou o envelope JSON.
 * O JSON carrega SEMPRE o frescor e a contagem de linhas ilegíveis: é o canal por
 * onde skills e agentes leem prazos, e nele "cache inexistente", "cache de 2 anos"
 * e "realmente não há prazo" precisam ser distinguíveis.
 */
export function output(rows, columns, meta = {}) {
  const { json = hasFlag('--json'), ilegiveis = 0, maxHoras = 24 } = meta;
  const f = freshness(maxHoras);
  if (json) {
    console.log(JSON.stringify({ freshness: f, ilegiveis, total: rows.length, registros: rows }, null, 2));
    return;
  }
  printFreshness(maxHoras, f);
  if (ilegiveis) {
    console.log(`⚠️ ${ilegiveis} linha(s) ilegível(is) no cache — registro possivelmente perdido; o total abaixo pode estar incompleto.\n`);
  }
  if (!rows.length) { console.log('(nenhum registro no cache para este filtro)'); return; }
  console.log(columns.join(' | '));
  for (const r of rows) console.log(columns.map((c) => trunc(r[c])).join(' | '));
  console.log(`\n${rows.length} registro(s).`);
}
