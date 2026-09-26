#!/usr/bin/env node
// Prazos com data fatal HOJE (lê o cache local; instantâneo, sem API).
// "Hoje" é o dia no fuso do FORO, não o da máquina — ver _lib.mjs.
// Uso: node scripts/orchestra/prazos-hoje.mjs [--json]
import { readTrackerResult, today, output } from './_lib.mjs';

const t = today();
const { entries, ilegiveis } = readTrackerResult();
const rows = entries
  .filter((e) => e.fatal === t)
  .sort((a, b) => (a.processo || '').localeCompare(b.processo || ''));

output(rows, ['fatal', 'processo', 'tipo', 'cliente', 'teor'], { ilegiveis });
