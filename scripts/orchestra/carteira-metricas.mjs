#!/usr/bin/env node
// Métricas gerenciais determinísticas da carteira, para o relatório executivo.
// Lê o dataset consolidado (acervo/casos/*/carteira-row.json) e imprime os
// agregados: total, por fase, em risco, com pendência, com/sem prazo, por
// confiança e valor total. É a fonte de NÚMEROS reproduzíveis do relatório —
// a narrativa gerencial (síntese) fica na skill `relatorio-executivo-escritorio`.

import { join } from 'node:path';
import { metricasCarteira } from './carteira-consolidar.mjs';

const asJson = process.argv.includes('--json');
const casosDir = join(process.cwd(), 'acervo', 'casos');
const m = metricasCarteira(casosDir);

if (m.diretorio_ausente) {
  // Fail-closed: relatório executivo não pode receber "0 casos" quando a verdade
  // é "não encontrei o diretório". São situações opostas e exigem ações opostas.
  if (asJson) console.log(JSON.stringify(m));
  console.error(`CARTEIRA_METRICAS: diretório de casos não encontrado (${casosDir}) — nenhuma métrica apurada. Isto NÃO significa carteira vazia.`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(m));
} else {
  console.log(`CARTEIRA_METRICAS: ${m.total} casos (${m.pulados} pulados)`);
  console.log(`  em risco: ${m.em_risco} · com pendência: ${m.com_pendencia} · com prazo fatal: ${m.com_prazo} · sem prazo: ${m.sem_prazo}`);
  console.log(`  por fase: ${Object.entries(m.por_fase).filter(([, n]) => n > 0).map(([f, n]) => `${f}=${n}`).join(' · ') || '—'}`);
  console.log(`  por confiança: alta=${m.por_confianca.alta} · media=${m.por_confianca.media} · baixa=${m.por_confianca.baixa} · sem=${m.por_confianca.sem}`);
  console.log(`  valor total (valores numéricos): ${m.valor_total}`);
}
