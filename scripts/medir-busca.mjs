#!/usr/bin/env node
/**
 * Mede a busca de jurisprudência (`ref jurisprudencia`, só o índice local) contra um gabarito:
 * acerto no top 1 e no top 5, MRR, e, para o julgado que não está no índice, se a busca devolve outro
 * no lugar dele. Feito em 11/11/2026 para medir antes e depois de cada mudança na busca. Só leitura.
 *
 * Uso: node scripts/medir-busca.mjs [--gabarito dados/busca/gabarito-jurisprudencia.json] [--json] [--falhas]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirReferencia, buscarNoProjeto } from '../src/ref-cliente.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

export async function medirBusca(gabarito, { ref }) {
  const casos = [];
  for (const c of gabarito.casos) {
    const r = await buscarNoProjeto(ref, c.q, { sub: 'jurisprudencia', values: { 'so-local': true, ...(c.area ? { area: c.area } : {}), ...(c.tribunal ? { tribunal: c.tribunal } : {}) } });
    const ids = r.jurisprudencia.map((x) => x.id);
    if (c.ausente) {
      const avisou = (r.avisos || []).some((a) => /não está no índice/.test(a));
      casos.push({ ...c, passa: avisou && !ids.length, avisou, devolvidos: ids.slice(0, 3) });
      continue;
    }
    const pos = ids.findIndex((id) => c.espera.includes(id));
    const top = c.top || 5;
    casos.push({ ...c, posicao: pos < 0 ? null : pos + 1, passa: pos >= 0 && pos < top, rr: pos < 0 ? 0 : 1 / (pos + 1), devolvidos: ids.slice(0, 3) });
  }
  const grupos = {};
  for (const c of casos) {
    const g = (grupos[c.grupo] = grupos[c.grupo] || { casos: 0, passam: 0, rr: 0 });
    g.casos += 1; g.passam += c.passa ? 1 : 0; g.rr += c.rr || 0;
  }
  for (const g of Object.values(grupos)) g.mrr = Number((g.rr / g.casos).toFixed(3));
  return { total: casos.length, passam: casos.filter((c) => c.passa).length, grupos, casos };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--gabarito');
  const arquivo = i >= 0 ? args[i + 1] : join(AQUI, '..', 'dados', 'busca', 'gabarito-jurisprudencia.json');
  const ref = await abrirReferencia({});
  const r = await medirBusca(JSON.parse(readFileSync(arquivo, 'utf-8')), { ref });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`Busca de jurisprudência: ${r.passam}/${r.total} casos passam`);
    for (const [g, v] of Object.entries(r.grupos)) console.log(`  ${g.padEnd(8)} ${v.passam}/${v.casos}${g === 'ausente' ? '' : `  MRR ${v.mrr}`}`);
    if (args.includes('--falhas')) for (const c of r.casos.filter((x) => !x.passa)) console.log(`  FALHA [${c.grupo}] "${c.q}"${c.area ? ` (${c.area})` : ''}: ${c.ausente ? (c.avisou ? 'avisou, mas devolveu' : 'sem aviso; devolveu') : `posição ${c.posicao ?? '—'}; top 3`} ${c.devolvidos.join(', ')}`);
  }
}
