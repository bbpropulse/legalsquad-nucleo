// Onde estão os autos de um squad: a pergunta que quatro lugares respondiam cada
// um do seu jeito. O hook de redação lia `caso.json` (autos por referência: uma
// pasta por escritório, casos dentro); o indexador, o sumário do caso e a
// reabertura de run só olhavam `squads/<nome>/autos/`. Resultado medido na
// revisão de 20/09/2026: no desenho por referência, `sumario-autos status` saía
// com código 1 (sem rota no runner) e `squad-state reabrir` pulava em silêncio a
// guarda "fato novo é run novo", porque não achava índice nenhum.
//
// Módulo de leitura de disco (existsSync, readFileSync, statSync) e de caminho.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo
// `scripts/sync-blocos.mjs` para os scripts distribuídos (indexar-autos,
// sumario-autos, squad-state e, desde a medição de 24/09/2026, squad-path e
// empacotar) e para o hook de redação, em raiz e templates.
// Cada cópia importa `existsSync`, `readFileSync`, `statSync` de `node:fs` e
// `basename`, `dirname`, `join`, `resolve` de `node:path`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// >>> autos-path:begin
/**
 * Pasta de autos de um squad: `squads/<nome>/autos/` (copiados para o squad) ou,
 * por referência, a pasta do caso que `squads/<nome>/caso.json` aponta
 * (`{"autos": "Processos/<caso>/autos"}` ou `{"pasta": "Processos/<caso>"}`,
 * relativo à raiz do projeto, a pasta acima de `squads/`). A cópia local com
 * `_index.yaml` vence a referência; sem `caso.json`, fica a do squad.
 */
function pastaDeAutos(squadDir) {
  const noSquad = join(squadDir, 'autos');
  if (existsSync(join(noSquad, '_index.yaml'))) return noSquad;
  try {
    const caso = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8'));
    const raiz = dirname(dirname(squadDir));
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (autos) return resolve(raiz, autos);
  } catch { /* sem caso.json, ou ilegível: fica o do squad */ }
  return noSquad;
}

/**
 * Aceita `squads/<nome>` (com `autos/` dentro ou `caso.json` apontando o caso), a
 * pasta do caso (com `autos/` dentro) ou o caminho direto de `autos/`.
 * Devolve `{ dir, erro }`; `dir` é absoluto.
 */
function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const dir = pastaDeAutos(abs);
  if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, erro: null };
  if (existsSync(join(abs, 'caso.json'))) return { dir: null, erro: `${entrada}/caso.json aponta ${dir}, que não existe: confira o caminho (relativo à raiz do projeto, a pasta acima de squads/)` };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/; crie ${entrada}/autos/ e coloque nela os PDFs e documentos do caso, ou grave ${entrada}/caso.json apontando a pasta do caso` };
}
// <<< autos-path:end

export { pastaDeAutos, resolverAutos };
