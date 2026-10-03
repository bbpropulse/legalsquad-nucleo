import type { SquadState, Agent } from "@/types/state";

/**
 * Returns agents sorted by desk position (row first, then col).
 */
export function sortAgentsByDesk(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.desk.row !== b.desk.row) return a.desk.row - b.desk.row;
    return a.desk.col - b.desk.col;
  });
}

/**
 * Find agent by id.
 */
export function findAgent(state: SquadState, agentId: string): Agent | undefined {
  return state.agents.find((a) => a.id === agentId);
}

/**
 * Returns the currently working agent, if any (the first one).
 */
export function getWorkingAgent(state: SquadState): Agent | undefined {
  return state.agents.find((a) => a.status === "working");
}

/**
 * Returns ALL agents working right now. With fan-out (a parallel_group, or
 * item-level parallelism) more than one agent can be working simultaneously.
 */
export function getWorkingAgents(state: SquadState): Agent[] {
  return state.agents.filter((a) => a.status === "working");
}
