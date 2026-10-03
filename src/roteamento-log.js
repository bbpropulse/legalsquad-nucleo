// O registro do roteamento por CÓDIGO (`_legalsquad/logs/roteamento.jsonl`).
//
// O chefe-roteador anexa ali uma linha por decisão (`{ts, categoria, rota, justificativa}`), mas é
// prosa executada pelo modelo: no teste de ponta a ponta de 30/09/2026 o log tinha as duas
// decisões e nenhuma dizia qual squad o seletor criou, nem que o modelo recusado não foi
// descartado (o squad `peticao-inicial` ficou órfão na pasta). O auditor das premissas
// (scripts/auditar-run.mjs, A1 e A3) precisa ligar a decisão ao squad e ver a recusa. Quem cria e
// quem descarta é o `squad-modelo`; é ele que grava, com a mesma forma e sem dado do caso: o id do
// modelo, o code do squad e a área.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const ARQUIVO_DE_ROTEAMENTO = join('_legalsquad', 'logs', 'roteamento.jsonl');

/** Anexa uma decisão de roteamento. Best-effort, como o log do roteador: nunca derruba o comando. */
export function registrarRoteamento(cwd, entrada, { agora = () => new Date().toISOString() } = {}) {
  try {
    mkdirSync(join(cwd, '_legalsquad', 'logs'), { recursive: true });
    const linha = { ts: agora(), origem: 'codigo', ...Object.fromEntries(Object.entries(entrada || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
    appendFileSync(join(cwd, ARQUIVO_DE_ROTEAMENTO), `${JSON.stringify(linha)}\n`);
    return true;
  } catch {
    return false;
  }
}
