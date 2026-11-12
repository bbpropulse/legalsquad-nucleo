// Extensão explícita de propósito: como finalRunState.ts, este módulo é
// carregado direto pelo node em tests/dashboard.test.js — sem bundler.
import type { SquadState } from "../types/state.ts";

/**
 * Memória curta de desfechos — o que devolve ao SNAPSHOT a janela de exibição
 * que o apagamento imediato do state.json tirou dele.
 *
 * O snapshot só lê state.json VIVOS do disco e o runner apaga o arquivo no
 * mesmo instante em que arquiva o run; o desfecho vira evento só-WS
 * (SQUAD_FINISHED). Quem abre a página um segundo depois — ou está no polling,
 * que só recebe snapshots — nunca vê o run terminar; antes do apagamento
 * imediato, o terminal ficava ~10s visível para todo mundo.
 *
 * A exclusão do DISCO é design documentado ("recarregar não ressuscita do
 * disco") e fica intacta: este mapa vive em MEMÓRIA, expira sozinho na janela
 * e morre com o dev server. scanStates continua não sabendo que ele existe.
 */
export const FINISHED_SNAPSHOT_WINDOW_MS = 10_000;

export interface FinishedEntry {
  squad: string;
  state: SquadState;
}

export interface RecentFinishes {
  /** Guarda o desfecho do squad até a janela expirar (regravar reinicia o prazo). */
  remember(squad: string, state: SquadState): void;
  /** Um run novo (state.json vivo válido) supera o desfecho — esquece na hora. */
  forget(squad: string): void;
  /**
   * Entradas ainda dentro da janela, para o campo `finished` do SNAPSHOT.
   * `alive` são os squads que o scan já lista (vivos ou ilegíveis): um desfecho
   * em memória NUNCA compete com um estado real. O filtro existe além do
   * `forget` porque os dois caminhos correm — o scan lê o disco na hora, o
   * forget depende de o watcher já ter processado o add do run novo.
   * Entradas expiradas são podadas na passada.
   */
  snapshotEntries(alive?: ReadonlySet<string>): FinishedEntry[];
}

export function createRecentFinishes(
  windowMs: number = FINISHED_SNAPSHOT_WINDOW_MS,
  now: () => number = Date.now,
): RecentFinishes {
  const entries = new Map<string, { state: SquadState; expiresAt: number }>();
  return {
    remember(squad, state) {
      entries.set(squad, { state, expiresAt: now() + windowMs });
    },
    forget(squad) {
      entries.delete(squad);
    },
    snapshotEntries(alive = new Set<string>()) {
      const t = now();
      const out: FinishedEntry[] = [];
      for (const [squad, entry] of entries) {
        if (entry.expiresAt <= t) {
          entries.delete(squad); // prune — deletar durante o for..of de Map é seguro
          continue;
        }
        if (alive.has(squad)) continue;
        out.push({ squad, state: entry.state });
      }
      return out;
    },
  };
}
