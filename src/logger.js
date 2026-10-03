import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function logEvent(action, details = {}, targetDir = process.cwd()) {
  try {
    const logDir = join(targetDir, '_legalsquad', 'logs');
    await mkdir(logDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      details,
    });
    await appendFile(join(logDir, 'cli.log'), entry + '\n', 'utf-8');
  } catch {
    // Silent — logging must never break the operation
  }
}

export async function readCliLogs({ action, limit } = {}, targetDir = process.cwd()) {
  try {
    const raw = await readFile(join(targetDir, '_legalsquad', 'logs', 'cli.log'), 'utf-8');
    const lines = raw.trim().split('\n');
    let entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    entries.reverse(); // newest first
    if (action) entries = entries.filter((e) => e.action === action);
    if (limit) entries = entries.slice(0, limit);
    return entries;
  } catch {
    return [];
  }
}

const SKILL_RUN_FIELDS = new Set([
  'runId', 'skill', 'skillVersion', 'lifecycle', 'mode', 'status', 'startedAt',
  'durationMs', 'inputTokens', 'outputTokens', 'retries', 'hardFailCount',
  'humanDecision', 'humanCorrectionSeverity', 'humanCorrectionCount',
  'baselineMinutes', 'assistedMinutes', 'sourceFreshness', 'evalCaseIds',
]);

// Telemetria operacional sem conteúdo do caso. A lista positiva de campos evita
// que fatos, nomes, documentos ou argumentos jurídicos sejam gravados por engano.
export async function logSkillRun(details, targetDir = process.cwd()) {
  try {
    const safe = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (SKILL_RUN_FIELDS.has(key)) safe[key] = value;
    }
    if (!safe.runId || !safe.skill || !safe.status) return false;
    const logDir = join(targetDir, '_legalsquad', 'logs');
    await mkdir(logDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...safe,
    });
    await appendFile(join(logDir, 'skill-runs.jsonl'), entry + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export async function readSkillRunMetrics(targetDir = process.cwd()) {
  try {
    const raw = await readFile(join(targetDir, '_legalsquad', 'logs', 'skill-runs.jsonl'), 'utf-8');
    const entries = raw.trim().split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const number = (key) => entries.map((entry) => Number(entry[key])).filter(Number.isFinite);
    const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const baseline = number('baselineMinutes');
    const assisted = number('assistedMinutes');
    const comparable = entries.filter((entry) => Number(entry.baselineMinutes) > 0 && Number(entry.assistedMinutes) > 0);
    return {
      runs: entries.length,
      concluded: entries.filter((entry) => entry.status === 'concluido').length,
      blocked: entries.filter((entry) => entry.status === 'bloqueado').length,
      hardFails: number('hardFailCount').reduce((sum, value) => sum + value, 0),
      humanCorrections: number('humanCorrectionCount').reduce((sum, value) => sum + value, 0),
      averageDurationMs: average(number('durationMs')),
      averageTokens: average(entries.map((entry) => Number(entry.inputTokens || 0) + Number(entry.outputTokens || 0)).filter(Number.isFinite)),
      averageBaselineMinutes: average(baseline),
      averageAssistedMinutes: average(assisted),
      measuredSpeedup: comparable.length
        ? comparable.reduce((sum, entry) => sum + Number(entry.baselineMinutes) / Number(entry.assistedMinutes), 0) / comparable.length
        : null,
    };
  } catch {
    return {
      runs: 0, concluded: 0, blocked: 0, hardFails: 0, humanCorrections: 0,
      averageDurationMs: null, averageTokens: null, averageBaselineMinutes: null,
      averageAssistedMinutes: null, measuredSpeedup: null,
    };
  }
}
