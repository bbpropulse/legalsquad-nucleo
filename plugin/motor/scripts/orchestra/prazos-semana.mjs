#!/usr/bin/env node
// Prazos com data fatal nos próximos 7 dias (cache local).
// Uso: node scripts/orchestra/prazos-semana.mjs [--json]
import { readTrackerResult, today, addDays, output } from './_lib.mjs';

const ini = today();
const fim = addDays(ini, 7);
const { entries, ilegiveis } = readTrackerResult();
const rows = entries
  .filter((e) => e.fatal && e.fatal >= ini && e.fatal <= fim)
  .sort((a, b) => (a.fatal || '').localeCompare(b.fatal || ''));

output(rows, ['fatal', 'processo', 'tipo', 'cliente', 'teor'], { ilegiveis });
