// Estado do cache do sync (SPEC §9.2, passo 1): o que está instalado e em que
// versão.
//
// Arquivo pequeno, responsabilidade grande — ele decide o que o próximo sync vai
// considerar em dia. Errar aqui não dá erro: dá silêncio. Por isso toda leitura
// é fail-closed e toda gravação é atômica.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Dentro de `acervo/_packs/`, a única subárvore de `acervo/` que o sync gerencia. */
export const CAMINHO_ESTADO = join('acervo', '_packs', '_manifest.json');

/**
 * Lê o estado. Ausente devolve vazio com `novo: true` — nunca ter sincronizado é
 * o começo normal, não falha.
 *
 * **Ilegível LANÇA.** Tratar corrompido como vazio faria o sync rebaixar tudo:
 * baixaria o corpus inteiro de novo E perderia o rastro do que já está no disco,
 * deixando arquivos instalados que o estado não conhece. É o mesmo princípio que
 * o motor aplica em toda parte — "não sei ler" nunca se apresenta como "não
 * existe".
 */
export function lerEstado(rootDir) {
  const caminho = join(rootDir, CAMINHO_ESTADO);
  if (!existsSync(caminho)) return { packs: {}, sincronizado_em: null, novo: true };

  let bruto;
  try {
    bruto = JSON.parse(readFileSync(caminho, 'utf8'));
  } catch (erro) {
    throw new Error(
      `acervo-estado: ${caminho} ilegível — ${erro.message}. Não trato como vazio: isso mandaria o `
        + 'sync rebaixar tudo e perder o rastro do que já está instalado. Corrija ou apague o arquivo '
        + 'conscientemente.',
      { cause: erro }
    );
  }

  // JSON válido não é estado válido. Um `packs` que veio como lista faria o
  // `pack_id in packs` do planejador responder besteira, em silêncio.
  const packs = bruto?.packs;
  if (!packs || typeof packs !== 'object' || Array.isArray(packs)) {
    throw new Error(
      `acervo-estado: ${caminho} sem \`packs\` como objeto (veio ${Array.isArray(packs) ? 'lista' : typeof packs}) — `
        + 'estado inválido é recusado, não adivinhado.'
    );
  }

  return { packs, sincronizado_em: bruto.sincronizado_em ?? null, novo: false };
}

/**
 * Grava o estado atomicamente: temporário + rename. Estado meio-escrito é pior
 * que estado antigo — o antigo pelo menos é consistente.
 */
export function gravarEstado(rootDir, estado, extras = {}) {
  const caminho = join(rootDir, CAMINHO_ESTADO);
  const temporario = `${caminho}.tmp`;
  mkdirSync(dirname(caminho), { recursive: true });

  const conteudo = {
    packs: estado?.packs || {},
    // Sem carimbo de tempo não há "desatualizado há N dias" (§9.4).
    sincronizado_em: extras.sincronizadoEm ?? estado?.sincronizado_em ?? null,
  };

  try {
    writeFileSync(temporario, `${JSON.stringify(conteudo, null, 2)}\n`);
    renameSync(temporario, caminho);
  } catch (erro) {
    rmSync(temporario, { force: true });
    throw new Error(`acervo-estado: falha ao gravar ${caminho} — ${erro.message}`, { cause: erro });
  }
  return caminho;
}
