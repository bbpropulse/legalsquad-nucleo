#!/usr/bin/env node
// Intimações capturadas nas últimas N horas (default 24) — cache local.
// Uso: node scripts/orchestra/intimacoes-recentes.mjs [horas] [--json]
import { readTrackerResult, output, firstArg, instante } from './_lib.mjs';

const horas = Number(firstArg()) > 0 ? Number(firstArg()) : 24;
// Compara INSTANTES, não strings: 'capturado_em' pode vir com offset -03:00, que
// como texto fica "menor" que um corte escrito em Z e sumiria do resultado.
const corte = Date.now() - horas * 3600 * 1000;
const { entries, ilegiveis } = readTrackerResult();
const rows = entries
  .filter((e) => { const ms = instante(e.capturado_em); return ms !== null && ms >= corte; })
  .sort((a, b) => (instante(b.capturado_em) ?? 0) - (instante(a.capturado_em) ?? 0));

output(rows, ['capturado_em', 'processo', 'tipo', 'cliente', 'teor'], { ilegiveis });
