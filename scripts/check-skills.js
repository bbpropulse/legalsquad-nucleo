#!/usr/bin/env node
// Gate determinístico do catálogo de skills: estrutura, nomes, referências,
// lifecycle, grafo semântico, manifesto de integração e frescor do índice.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkillCatalog } from '../src/skill-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, '..', 'skills');

// skills/ só existe quando um pacote de área foi baixado por cima do core
// (dea4579: "zerar a materia juridica de area no nucleo do motor"). Um
// checkout puro do core não tem área nenhuma instalada — não é erro, é o
// estado normal do repositório de desenvolvimento, e o gate precisa dizer
// isso em vez de travar em ENOENT.
if (!existsSync(skillsDir)) {
  console.log('Catálogo de skills: nenhuma área instalada em skills/ — checagem não aplicável.');
} else {
  const result = validateSkillCatalog({ skillsDir });

  if (!result.ok) {
    console.error(`Catálogo de skills inválido (${result.errors.length} problema(s)):`);
    for (const error of result.errors) {
      console.error(`  - [${error.code}] ${error.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Catálogo de skills íntegro: ${result.catalog.entries.length} skills; índice fresco; grafo válido.`);
  }
}
