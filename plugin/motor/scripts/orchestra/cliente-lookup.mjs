#!/usr/bin/env node
// Intimações por cliente (nome parcial, sem distinção de maiúsculas).
// Uso: node scripts/orchestra/cliente-lookup.mjs <nome do cliente> [--json]
import { readTrackerResult, output, firstArg, instante } from './_lib.mjs';

const q = (firstArg() || '').toLowerCase();
if (!q) { console.error('uso: node scripts/orchestra/cliente-lookup.mjs <nome do cliente> [--json]'); process.exit(1); }
const { entries, ilegiveis } = readTrackerResult();
const rows = entries
  .filter((e) => (e.cliente || '').toLowerCase().includes(q))
  .sort((a, b) => (instante(b.capturado_em) ?? 0) - (instante(a.capturado_em) ?? 0));

// Frescor também aqui: esta é a pergunta feita antes de uma reunião com o cliente.
output(rows, ['capturado_em', 'processo', 'tipo', 'fatal', 'cliente'], { ilegiveis });
