#!/usr/bin/env node
// Resumo AGREGADO dos scores de eval — lê `<squads>/<squad>/_evals/scores.md`
// (preenchido pelo `/legalsquad eval`). Determinístico (sem IA): mostra a
// nota média/última e pega REGRESSÃO ao longo do tempo.
//
//   node scripts/eval-resumo.mjs <squad>                    um squad
//   node scripts/eval-resumo.mjs                            todos com scores
//   node scripts/eval-resumo.mjs [<squad>] --squads-dir <d> raiz alternativa
//
// (ou: npm run eval:resumo <squad>)
//
// AUTO-CONTIDO de propósito: este script é distribuído ao usuário
// (templates/scripts/eval-resumo.mjs, espelho verificado por
// tests/templates-paridade.test.js) e roda num projeto que NÃO tem `src/`.
// Por isso a lógica mora aqui e é exportada para teste, em vez de importada de
// um módulo do motor.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Raiz padrão: `squads/` do projeto onde o script está instalado. */
export function squadsDirPadrao() {
  return join(PACKAGE_ROOT, 'squads');
}

/**
 * Lê a tabela `| Data | Run/Caso | Nota | Verdict | Observações |`.
 * Ignora cabeçalho, separadores e linhas sem nota numérica.
 */
export function parseScores(file) {
  const linhas = [];

  for (const linha of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!linha.trim().startsWith('|')) continue;
    if (/^\|[\s|:-]+\|?\s*$/.test(linha)) continue; // separador (---)

    const celulas = linha.split('|').map((c) => c.trim());
    if (celulas[1] === 'Data') continue; // cabeçalho

    // Primeiro número da célula: aceita "85", "8,5" e "61/100" (lê 61).
    // Placeholders não-numéricos ("n/a", "—", "TBD") são descartados — se
    // entrassem como 0, corromperiam média e regressão em silêncio.
    const m = String(celulas[3] ?? '').match(/\d+(?:[.,]\d+)?/);
    const nota = m ? Number(m[0].replace(',', '.')) : NaN;
    if (!Number.isFinite(nota)) continue;

    linhas.push({
      data: celulas[1],
      caso: celulas[2],
      nota,
      verdict: celulas[4] ?? '',
    });
  }

  return linhas;
}

/**
 * Estatísticas de um squad. Devolve `null` quando não há `scores.md` —
 * distinto de `{ n: 0 }`, que significa "log existe, ainda sem avaliação".
 */
export function statsForSquad(squad, options = {}) {
  const squadsDir = options.squadsDir || squadsDirPadrao();
  const file = join(squadsDir, squad, '_evals', 'scores.md');
  if (!existsSync(file)) return null;

  const linhas = parseScores(file);
  if (!linhas.length) {
    return { squad, n: 0, media: null, ultima: null, min: null, max: null, aprovados: 0, regressao: false };
  }

  const notas = linhas.map((l) => l.nota);
  const media = Math.round(notas.reduce((a, b) => a + b, 0) / notas.length);
  const ultima = notas[notas.length - 1];

  return {
    squad,
    n: linhas.length,
    media,
    ultima,
    min: Math.min(...notas),
    max: Math.max(...notas),
    aprovados: linhas.filter((l) => /APROVAD/i.test(l.verdict)).length,
    // O sinal que justifica o log: a última avaliação piorou em relação ao
    // histórico. Não é veredito de qualidade — é gatilho de investigação.
    regressao: ultima < media,
  };
}

/** Todos os squads que já têm `_evals/scores.md`, em ordem de diretório. */
export function resumirSquads(options = {}) {
  const squadsDir = options.squadsDir || squadsDirPadrao();
  if (!existsSync(squadsDir)) return [];

  return readdirSync(squadsDir)
    .filter((d) => existsSync(join(squadsDir, d, '_evals', 'scores.md')))
    .map((d) => statsForSquad(d, { squadsDir }))
    .filter(Boolean);
}

export function main(argv = process.argv.slice(2)) {
  const iDir = argv.indexOf('--squads-dir');
  const squadsDir = iDir >= 0 ? argv[iDir + 1] : squadsDirPadrao();
  const squad = argv.filter((a, i) => !a.startsWith('--') && i !== iDir + 1)[0];

  const linhas = squad
    ? [statsForSquad(squad, { squadsDir })].filter(Boolean)
    : resumirSquads({ squadsDir });

  if (!linhas.length) {
    console.log('Nenhum squad com _evals/scores.md ainda. Rode /legalsquad eval <squad> primeiro.');
    return 0;
  }

  console.log('Squad | Avaliações | Média | Última | Min–Max | Aprovados');
  console.log('------|-----------|-------|--------|---------|----------');

  for (const st of linhas) {
    if (st.n === 0) {
      console.log(`${st.squad} | 0 | — | — | — | —`);
      continue;
    }
    const tendencia = st.regressao ? ' ⚠️ abaixo da média' : '';
    console.log(
      `${st.squad} | ${st.n} | ${st.media} | ${st.ultima}${tendencia} | ${st.min}–${st.max} | ${st.aprovados}/${st.n}`
    );
  }

  return 0;
}

// Só executa quando chamado direto — importar o arquivo num teste não dispara o CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
