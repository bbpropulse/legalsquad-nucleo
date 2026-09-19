#!/usr/bin/env node
// Mede quanto de um diretório de skills é conteúdo próprio × molde repetido.
//
//   node scripts/medir-originalidade.mjs <dir-de-skills> [--top N] [--json]
//
// Existe porque `check-skills` e `audit-skills` não enxergam isto: um lote
// gerado por template passa nos dois — o contrato está lá, o frontmatter está
// completo, os gates estão escritos. O que eles não perguntam é se as N skills
// dizem a MESMA coisa com o assunto trocado.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { medirOriginalidade } from '../src/skill-originality.js';
import { extractFrontMatter, parseSkillMetadata } from '../src/frontmatter.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { top: { type: 'string' }, json: { type: 'boolean' } },
});

const dir = positionals[0];
if (!dir || !existsSync(dir)) {
  console.error(`Uso: node scripts/medir-originalidade.mjs <dir-de-skills> [--top N] [--json]`);
  process.exit(1);
}

const corpus = [];
for (const entrada of readdirSync(dir, { withFileTypes: true })) {
  if (!entrada.isDirectory() || entrada.name.startsWith('_')) continue;
  const caminho = join(dir, entrada.name, 'SKILL.md');
  if (!existsSync(caminho)) continue;

  const bruto = readFileSync(caminho, 'utf8');
  const metadata = parseSkillMetadata(bruto, { fallbackName: entrada.name });
  // Só o CORPO: o frontmatter tem metadata legítima por skill (gatilhos,
  // categorias) e mediria ruído junto com conteúdo.
  const fm = extractFrontMatter(bruto);
  const corpo = fm ? bruto.slice(bruto.indexOf(fm) + fm.length).replace(/^\s*---\s*/, '') : bruto;

  corpus.push({
    id: entrada.name,
    titulo: corpo.match(/^#\s+(.+)$/m)?.[1]?.trim() || metadata.name || entrada.name,
    texto: corpo,
  });
}

const relatorio = medirOriginalidade(corpus, { limiteBoilerplate: Number(values.top) || 12 });

if (values.json) {
  console.log(JSON.stringify(relatorio, null, 2));
  process.exit(0);
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const { resumo, skills, boilerplate } = relatorio;

console.log(`\nORIGINALIDADE — ${dir}\n`);
console.log(`  skills medidas ............. ${resumo.totalSkills}`);
console.log(`  originalidade MEDIANA ...... ${pct(resumo.medianaOriginalidade)}`);
console.log(`  originalidade média ........ ${pct(resumo.mediaOriginalidade)}`);
console.log(`  linhas somadas ............. ${resumo.totalLinhasSomadas.toLocaleString('pt-BR')}`);
console.log(`  linhas DISTINTAS no corpus . ${resumo.linhasDistintasNoCorpus.toLocaleString('pt-BR')}`);
console.log(`  linhas exclusivas .......... ${resumo.totalLinhasExclusivas.toLocaleString('pt-BR')}`);

// A razão que interessa: quanto o corpus REALMENTE tem, contra quanto ele
// aparenta ter.
const inflacao = resumo.linhasDistintasNoCorpus
  ? resumo.totalLinhasSomadas / resumo.linhasDistintasNoCorpus
  : 0;
console.log(`\n  → o corpus aparenta ${resumo.totalLinhasSomadas.toLocaleString('pt-BR')} linhas`);
console.log(`    e contém ${resumo.linhasDistintasNoCorpus.toLocaleString('pt-BR')} distintas (${inflacao.toFixed(1)}x de repetição)`);

const ordenadas = [...skills].sort((a, b) => a.originalidade - b.originalidade);
console.log(`\n  MENOS originais:`);
for (const s of ordenadas.slice(0, 5)) {
  console.log(`    ${pct(s.originalidade).padStart(6)}  ${s.id} (${s.linhasExclusivas}/${s.totalLinhas} linhas próprias)`);
}
console.log(`\n  MAIS originais:`);
for (const s of ordenadas.slice(-5).reverse()) {
  console.log(`    ${pct(s.originalidade).padStart(6)}  ${s.id} (${s.linhasExclusivas}/${s.totalLinhas} linhas próprias)`);
}

console.log(`\n  MOLDE mais repetido:`);
for (const linha of boilerplate.slice(0, 8)) {
  const corte = linha.linha.length > 78 ? `${linha.linha.slice(0, 75)}…` : linha.linha;
  console.log(`    ${String(linha.skills).padStart(5)}x  ${corte}`);
}
console.log('');
