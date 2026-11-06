// Os hooks do projeto num lugar que não depende da IDE: `_legalsquad/hooks/`.
//
// Auditoria de 10/10/2026 (revisoes/COMPAT-CODEX-ANTIGRAVITY.md, lacuna 1): o
// `squad-state` procurava o `verifica-citacoes.mjs` só em `.claude/hooks/` e
// `.codex/hooks/`. Num projeto só com Antigravity (ou com qualquer IDE sem pasta
// de hooks), `citacoes-pendentes`, `review-verdict --citacoes` e `manifesto-final`
// morriam com "hook não encontrado", e o run parava no cartório.
//
// O init e o update copiam aqui os três hooks que o código do run chama pela CLI
// (`--citacoes`, `--check`, `--persuasao-previa`), da mesma fonte que vai ao
// `.claude/hooks/`. São arquivos do motor, como `_legalsquad/core/`: regravados
// sem `.bak` quando mudam. Os hooks não dependem de onde estão (sem import, raiz
// achada pelo arquivo que recebem), e `_legalsquad/hooks/x.mjs` fica a dois níveis
// da raiz, como `.claude/hooks/x.mjs`. Os caminhos antigos continuam valendo: o
// `squad-state` procura nos três lugares.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mesmoConteudo } from './fs-utils.js';

const FONTE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'ide-templates', 'claude-code', '.claude', 'hooks');

export const PASTA_DOS_HOOKS_NEUTROS = join('_legalsquad', 'hooks');
export const HOOKS_NEUTROS = ['verifica-citacoes.mjs', 'verifica-redacao.mjs', 'guarda-memoria.mjs'];

/** Copia os hooks neutros para `<raiz>/_legalsquad/hooks/`. Devolve os nomes gravados agora. */
export function instalarHooksNeutros(raiz) {
  const destino = join(raiz, PASTA_DOS_HOOKS_NEUTROS);
  const gravados = [];
  for (const nome of HOOKS_NEUTROS) {
    const origem = join(FONTE, nome);
    if (!existsSync(origem)) continue;
    const alvo = join(destino, nome);
    if (mesmoConteudo(origem, alvo)) continue;
    mkdirSync(dirname(alvo), { recursive: true });
    copyFileSync(origem, alvo);
    gravados.push(nome);
  }
  return gravados;
}
