#!/usr/bin/env node
// Tudo o que o cache tem sobre um processo (por nº, parcial).
// Uso: node scripts/orchestra/processo-lookup.mjs <nº do processo> [--json]
import { readTrackerResult, output, firstArg, instante } from './_lib.mjs';

const q = firstArg();
if (!q) { console.error('uso: node scripts/orchestra/processo-lookup.mjs <nº do processo> [--json]'); process.exit(1); }
const { entries, ilegiveis } = readTrackerResult();
const rows = entries
  .filter((e) => (e.processo || '').includes(q))
  .sort((a, b) => (instante(b.capturado_em) ?? 0) - (instante(a.capturado_em) ?? 0));

// Frescor também aqui: esta é a pergunta feita antes de peticionar.
output(rows, ['capturado_em', 'processo', 'tipo', 'fatal', 'teor'], { ilegiveis });
