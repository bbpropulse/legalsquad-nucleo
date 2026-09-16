// state.json structure — matches Pipeline Runner output
export interface AgentDesk {
  col: number;
  row: number;
}

export type AgentStatus =
  | "idle"
  | "working"
  | "delivering"
  | "done"
  | "checkpoint";

export interface Agent {
  id: string;
  name: string;
  icon: string;
  status: AgentStatus;
  /** Frase curta do que o agente está fazendo agora (ex.: "pesquisando STJ"). Opcional. */
  activity?: string;
  desk: AgentDesk;
}

/** Entrada do feed de atividades (derivada das mudanças de estado). */
export interface FeedEntry {
  id: string;
  at: number;
  kind: "step" | "handoff" | "status";
  text: string;
}

export interface Handoff {
  from: string;
  to: string;
  message: string;
  completedAt: string;
}

export type SquadStatus =
  | "idle"
  | "running"
  | "completed"
  | "checkpoint"
  | "failed";

export interface SquadState {
  squad: string;
  status: SquadStatus;
  step: {
    current: number;
    total: number;
    label: string;
  };
  agents: Agent[];
  handoff: Handoff | null;
  startedAt: string | null;
  updatedAt: string;
  /** Definido pelo runner ao concluir/abortar (também copiado para o histórico). */
  completedAt?: string;
  failedAt?: string;
}

// Squad metadata from squad.yaml
export interface SquadInfo {
  code: string;
  name: string;
  description: string;
  icon: string;
  agents: string[]; // agent file paths
}

/**
 * state.json existe mas não pôde ser lido (JSON quebrado ou fora do contrato).
 * É o oposto de "não existe": ali há um squad que provavelmente está rodando,
 * e o dashboard precisa dizer isso em vez de mostrá-lo como inativo.
 */
export interface SquadStateError {
  /** Motivo legível — qual campo quebrou. */
  reason: string;
  /** ISO de quando o servidor detectou. */
  at: string;
}

// WebSocket messages
export type WsMessage =
  | {
      type: "SNAPSHOT";
      squads: SquadInfo[];
      activeStates: Record<string, SquadState>;
      invalidStates: Record<string, SquadStateError>;
      /**
       * Desfechos recentes (janela de ~10s) cujo state.json vivo já foi
       * apagado. Vêm do mapa em MEMÓRIA do watcher (`recentFinishes`), nunca do
       * disco — scanStates continua lendo só estados vivos. O cliente aplica
       * cada entrada como se fosse SQUAD_FINISHED (mesmo relógio de exibição),
       * para a página recém-aberta e o polling verem o desfecho que antes era
       * só-WS. Ausente = nenhum desfecho dentro da janela.
       */
      finished?: { squad: string; state: SquadState }[];
    }
  | { type: "SQUAD_UPDATE"; squad: string; state: SquadState }
  | { type: "SQUAD_INVALID"; squad: string; error: SquadStateError }
  /**
   * O run ACABOU e o estado terminal vem junto, lido da cópia arquivada em
   * `output/{run_id}/state.json`. É um evento de transição, não de listagem: o
   * cliente mostra o desfecho e depois solta o squad. Recarregar a página não
   * ressuscita nenhum DO DISCO — o snapshot segue sem runs concluídos no
   * `activeStates`; desfechos com ≤10s chegam pelo campo `finished` acima, do
   * mapa em memória, e expiram sozinhos.
   */
  | { type: "SQUAD_FINISHED"; squad: string; state: SquadState }
  | { type: "SQUAD_INACTIVE"; squad: string };
