// Extensão explícita de propósito: como validateState.ts, este módulo é
// carregado direto pelo node em tests/dashboard.test.js — sem bundler e sem o
// alias `@/` (que só o vite resolve). Por isso ele também não importa a store:
// recebe o que precisa dela via DispatchTarget.
import type {
  SquadInfo,
  SquadState,
  SquadStateError,
  WsMessage,
} from "../types/state.ts";

/**
 * Quanto tempo o painel segura um run concluído antes de soltá-lo.
 *
 * É tempo de EXIBIÇÃO, não de entrega: quando este relógio começa, o estado
 * terminal já chegou e já está na store. Errar para mais ou para menos muda só
 * quanto o desfecho fica na tela — nada se perde. É a diferença para a espera de
 * 10s que existia no runner, que era load-bearing: lá, disparar cedo demais
 * significava o usuário nunca ver que o run terminou.
 */
export const FINISHED_DWELL_MS = 10000;

/**
 * O que o dispatcher precisa da store — a interface de useSquadStore reduzida.
 * As duas leituras (`getSquadState`/`isSquadInvalid`) são consultadas na hora em
 * que o relógio de exibição DISPARA, não na hora em que foi armado: são o que
 * permite ao disparo verificar se o mundo ainda é o mesmo.
 */
export interface DispatchTarget {
  setSnapshot(
    squads: SquadInfo[],
    activeStates: Record<string, SquadState>,
    invalidStates?: Record<string, SquadStateError>,
  ): void;
  updateSquadState(squad: string, state: SquadState): void;
  setSquadInvalid(squad: string, error: SquadStateError): void;
  setSquadInactive(squad: string): void;
  /** Estado ATUAL do squad na store (undefined se não está em activeStates). */
  getSquadState(squad: string): SquadState | undefined;
  /** O squad está marcado como "state.json ilegível"? */
  isSquadInvalid(squad: string): boolean;
}

export interface SocketDispatcher {
  dispatch(msg: WsMessage): void;
  /** Cancela todos os relógios pendentes e passa a ignorar mensagens. */
  dispose(): void;
}

export function createSocketDispatcher(target: DispatchTarget): SocketDispatcher {
  let disposed = false;
  const dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelDwell(squad: string) {
    const timer = dwellTimers.get(squad);
    if (timer === undefined) return;
    clearTimeout(timer);
    dwellTimers.delete(squad);
  }

  // Aplica um desfecho (SQUAD_FINISHED, ou entrada `finished` de um SNAPSHOT) e
  // arma o relógio de exibição. O desfecho entra em activeStates como qualquer
  // outro estado — é o que faz o badge, o rodapé e a cena mostrarem o run
  // terminado sem nenhum componente novo. O que o distingue é o prazo de
  // validade: um run concluído fica na tela pela transição e sai; nunca vira
  // item fixo da lista de ativos.
  function armFinished(squad: string, state: SquadState) {
    target.updateSquadState(squad, state);
    cancelDwell(squad);
    dwellTimers.set(
      squad,
      setTimeout(() => {
        dwellTimers.delete(squad);
        if (disposed) return;
        // Cinto-e-suspensório: só solta o squad se o que está na tela AINDA é o
        // desfecho que armou ESTE relógio. Um relógio atrasado (um cancelDwell
        // esquecido em algum caminho futuro) nunca pode arrancar um run vivo da
        // tela nem apagar o marcador de "ilegível" — que o watcher promete
        // jamais sumir em silêncio. Perder estado real é pior em espécie do que
        // segurar um concluído por tempo demais.
        if (target.isSquadInvalid(squad)) return;
        const current = target.getSquadState(squad);
        if (current === undefined) return; // já saiu por outro caminho
        // SquadState não carrega run_id; status + updatedAt são a identidade
        // prática do desfecho (um run novo muda os dois; o mesmo desfecho
        // re-entregue pelo polling mantém ambos).
        if (current.status !== state.status || current.updatedAt !== state.updatedAt) {
          return;
        }
        target.setSquadInactive(squad);
      }, FINISHED_DWELL_MS),
    );
  }

  function dispatch(msg: WsMessage) {
    if (disposed) return;
    switch (msg.type) {
      case "SNAPSHOT": {
        // Um snapshot que lista o squad como vivo (ou ilegível) invalida o
        // relógio pendente: ele foi armado num mundo anterior à reconexão e,
        // aos 10s, arrancaria da tela o run novo que o snapshot acabou de
        // trazer. Relógios de squads ausentes do snapshot podem continuar — a
        // store já os soltou (substituição integral) e o disparo é inofensivo.
        for (const squad of [...dwellTimers.keys()]) {
          if (
            msg.activeStates[squad] !== undefined ||
            msg.invalidStates?.[squad] !== undefined
          ) {
            cancelDwell(squad);
          }
        }
        target.setSnapshot(msg.squads, msg.activeStates, msg.invalidStates);
        // Desfechos ≤10s cujo state.json já saiu do disco viajam no campo
        // `finished` (mapa em memória do watcher). Aplicar cada um como
        // SQUAD_FINISHED dá à página recém-aberta e ao polling a mesma janela
        // de exibição do caminho WS.
        for (const f of msg.finished ?? []) {
          // Nunca por cima de um run vivo/ilegível listado no MESMO snapshot —
          // o servidor já filtra, mas pintar um run vivo de concluído é o erro
          // que este painel existe para não cometer.
          if (msg.activeStates[f.squad] !== undefined) continue;
          if (msg.invalidStates?.[f.squad] !== undefined) continue;
          armFinished(f.squad, f.state);
        }
        break;
      }
      case "SQUAD_UPDATE":
        // Um run NOVO começando dentro da janela de exibição do anterior: o
        // relógio pendente arrancaria da tela uma execução que está viva.
        cancelDwell(msg.squad);
        target.updateSquadState(msg.squad, msg.state);
        break;
      case "SQUAD_INVALID":
        // "Ilegível" quase sempre é um run NOVO escrevendo state.json. Sem o
        // cancel, o relógio do desfecho anterior apagaria o marcador em
        // silêncio — o exato sumiço que o watcher promete nunca produzir.
        cancelDwell(msg.squad);
        target.setSquadInvalid(msg.squad, msg.error);
        break;
      case "SQUAD_FINISHED":
        armFinished(msg.squad, msg.state);
        break;
      case "SQUAD_INACTIVE":
        cancelDwell(msg.squad);
        target.setSquadInactive(msg.squad);
        break;
    }
  }

  return {
    dispatch,
    dispose() {
      disposed = true;
      for (const timer of dwellTimers.values()) clearTimeout(timer);
      dwellTimers.clear();
    },
  };
}
