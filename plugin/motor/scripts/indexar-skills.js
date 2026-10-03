#!/usr/bin/env node
// Regenera o catálogo canônico de skills. O conteúdo é determinístico: não há
// timestamp, ordem de filesystem ou outro dado volátil no arquivo gerado.
//
// Uso:
//   npm run indexar-skills
//   node scripts/indexar-skills.js --check
//   node scripts/indexar-skills.js --root /caminho/do/projeto
//
// A raiz é parametrizável porque o pack-apply (F3) instala o pacote de área no
// projeto do USUÁRIO e precisa reindexar lá, não dentro do pacote. Sem `--root`
// o default é a raiz deste repositório — o comportamento antigo, intacto.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverSkillCatalog,
  renderSkillIndex,
  validateSkillCatalog,
} from '../src/skill-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `--root DIR`, `--root=DIR` ou o primeiro argumento posicional. Flags conhecidas
// (--check) nunca são confundidas com raiz.
function raizDosArgumentos(argv, padrao) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) {
        console.error('--root exige um diretório.');
        process.exit(1);
      }
      return resolve(argv[i + 1]);
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) {
        console.error('--root exige um diretório.');
        process.exit(1);
      }
      return resolve(value);
    }
    if (!arg.startsWith('-')) return resolve(arg);
  }
  return padrao;
}

const root = raizDosArgumentos(process.argv.slice(2), join(__dirname, '..'));
const skillsDir = join(root, 'skills');
const indexPath = join(skillsDir, '_index.yaml');

// Fail-closed com diagnóstico: raiz errada é o erro mais provável de quem passa
// `--root`, e um stack de ENOENT não diz qual pasta faltou.
if (!existsSync(skillsDir)) {
  console.error(`Pasta de skills não existe: ${skillsDir}`);
  console.error('Passe --root <diretório do projeto> ou instale um pacote de área antes de indexar.');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const result = validateSkillCatalog({ skillsDir, indexPath });
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[${error.code}] ${error.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Catálogo íntegro e fresco: ${result.catalog.entries.length} skills.`);
  }
} else {
  const catalog = discoverSkillCatalog(skillsDir);
  const output = renderSkillIndex(catalog);
  writeFileSync(indexPath, output, 'utf8');
  console.log(`Indexadas ${catalog.entries.length} skills em skills/_index.yaml.`);
  if (catalog.missingSkillFiles.length) {
    console.warn(`Atenção: ${catalog.missingSkillFiles.length} pasta(s) sem SKILL.md; rode npm run check:skills.`);
  }
}
