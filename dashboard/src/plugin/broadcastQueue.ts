/**
 * Fila de serialização POR CHAVE — a ordem de emissão segue a ordem dos eventos.
 *
 * Os handlers do watcher são assíncronos (readFile do state.json, squad.yaml
 * para resolver o code, estado arquivado do desfecho) e, soltos, correm entre
 * si: um stall numa leitura faz o SQUAD_FINISHED do run velho ser emitido
 * DEPOIS do primeiro SQUAD_UPDATE do run novo. A janela é estreita — exige
 * >300ms de atraso numa leitura, porque o awaitWriteFinish do chokidar já
 * segura o add/change por ~300ms — mas o efeito é pior em espécie: um run vivo
 * pintado de concluído e removido pelo relógio de exibição do cliente.
 *
 * A corrente de promises por chave garante que os broadcasts de um mesmo squad
 * saem na ordem em que o fs emitiu os eventos. Por chave, não global: squads
 * diferentes não se bloqueiam.
 */
export interface KeyedQueue {
  /**
   * Agenda `task` para depois de tudo que já foi agendado para `key`. A promise
   * devolvida resolve quando a task termina e NUNCA rejeita — erros vão para o
   * `onError` da fila.
   */
  enqueue(key: string, task: () => Promise<void> | void): Promise<void>;
  /** Chaves com corrente ainda ativa (as entradas somem quando esvaziam). */
  readonly size: number;
}

export function createKeyedQueue(
  onError: (key: string, err: unknown) => void = () => {},
): KeyedQueue {
  const chains = new Map<string, Promise<void>>();
  return {
    enqueue(key, task) {
      const prev = chains.get(key) ?? Promise.resolve();
      // O .catch é o cinto de segurança da corrente: hoje cada task engole os
      // próprios erros (é inerte), mas uma rejeição esquecida num refactor não
      // pode custar todos os broadcasts seguintes do squad.
      const next = prev.then(() => task()).catch((err) => onError(key, err));
      chains.set(key, next);
      // GC: se esta task ainda é a cauda quando termina, a corrente esvaziou —
      // solta a entrada para o Map não crescer com o dia de trabalho.
      return next.then(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    },
    get size() {
      return chains.size;
    },
  };
}
