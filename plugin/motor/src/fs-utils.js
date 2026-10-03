// Utilidades de arquivo que mais de um módulo do motor precisa. Vivem aqui, num
// módulo-folha sem dependência interna, para init.js, update.js, deposito.js e
// motor-link.js compartilharem UMA implementação (a revisão de 14/09/2026
// achou quatro cópias do "mesma pasta é uma casa?" e três do "mesmo conteúdo?").

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** A pasta é uma casa LegalSquad? O marcador é o mesmo do roteador: `_legalsquad/`. */
export function ehCasaLegalSquad(dir) {
  return existsSync(join(dir, '_legalsquad'));
}

/**
 * A casa mais próxima subindo a partir de `dir` (ela mesma ou uma pasta acima),
 * ou null. É a regra do roteador ("quando uma pasta acima tem `_legalsquad/`,
 * ela é a raiz: uma pasta por escritório, com os casos dentro") aplicada à CLI:
 * rodar `npx legalsquad …` de dentro de `Processos/<caso>/autos/` age sobre o
 * escritório, como o git faz com o `.git` acima.
 */
export function raizDoProjeto(dir) {
  let atual = resolve(dir);
  for (;;) {
    if (ehCasaLegalSquad(atual)) return atual;
    const acima = dirname(atual);
    if (acima === atual) return null;
    atual = acima;
  }
}

export function sha256DoArquivo(caminho) {
  return createHash('sha256').update(readFileSync(caminho)).digest('hex');
}

/** Os dois existem e têm os mesmos bytes (síncrono; para laços grandes). */
export function mesmoConteudo(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

async function fileHash(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

// True only when both files exist and their contents are byte-identical. Used by
// update to skip rewriting (and backing up) files the user has not changed.
export async function filesIdentical(srcPath, destPath) {
  const destHash = await fileHash(destPath);
  if (destHash === null) return false; // dest missing: must copy
  return destHash === (await fileHash(srcPath));
}

/**
 * Guarda uma cópia do arquivo antes de sobrescrevê-lo: `.bak`, `.bak.2`, …
 * Um backup já idêntico ao atual é reaproveitado (não duplica); depois de 50,
 * cai num sufixo com timestamp. Devolve o caminho do backup ou null se não
 * havia o que preservar.
 */
export function backupSync(destPath) {
  let atual;
  try {
    atual = readFileSync(destPath);
  } catch {
    return null; // nada a preservar
  }
  const candidatos = [`${destPath}.bak`];
  for (let i = 2; i <= 50; i++) candidatos.push(`${destPath}.bak.${i}`);
  for (const candidato of candidatos) {
    let existente;
    try {
      existente = readFileSync(candidato);
    } catch {
      copyFileSync(destPath, candidato);
      return candidato;
    }
    if (existente.equals(atual)) return candidato;
  }
  const fallback = `${destPath}.bak.${Date.now()}`;
  copyFileSync(destPath, fallback);
  return fallback;
}
