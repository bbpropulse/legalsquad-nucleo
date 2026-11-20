import type { Agent, SquadInfo, SquadState } from "../types/state";

export interface OfficeRoom {
  code: string;
  name: string;
  agents: Agent[];
  state: SquadState | null;
  error?: string;
}

/** Um agente cadastrado sem run é idle; só o state.json pode dizer que trabalha. */
export function officeRooms(
  squads: Map<string, SquadInfo>,
  states: Map<string, SquadState>,
  selected: string | null,
  errors: Map<string, { reason: string }>,
): OfficeRoom[] {
  const codes = new Set([...squads.keys(), ...states.keys(), ...errors.keys()]);
  return [...codes]
    .filter((code) => !selected || selected === code)
    .map((code) => {
      const info = squads.get(code);
      const state = states.get(code) ?? null;
      return {
        code,
        name: info?.name ?? code,
        agents: state?.agents ?? info?.roster ?? [],
        state,
        error: errors.get(code)?.reason,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Prévia explicitamente fictícia, apenas em memória; nunca grava em squads/. */
export function demoRooms(phase: number): OfficeRoom[] {
  const teams = [
    {
      code: "demo-producao",
      name: "Produção de peças",
      names: ["Paula Pesquisa", "Rafael Redação", "Rita Revisão"],
      activities: [
        "Consultando o acervo",
        "Preparando a minuta",
        "Conferindo a entrega",
      ],
    },
    {
      code: "demo-atendimento",
      name: "Atendimento e triagem",
      names: ["Ana Atendimento", "Caio Conferência", "Téo Triagem"],
      activities: [
        "Organizando documentos",
        "Conferindo informações",
        "Preparando o diagnóstico",
      ],
    },
  ];
  return teams.map((team, teamIndex) => {
    const step = (phase + teamIndex) % 4;
    const now = new Date().toISOString();
    const agents: Agent[] = team.names.map((name, i) => ({
      id: `${team.code}-${i}`,
      name,
      icon: "",
      desk: { col: i + 1, row: 1 },
      status:
        step === 3
          ? "checkpoint"
          : i === step || (step === 0 && i === 1)
            ? "working"
            : i < step
              ? "done"
              : "idle",
      activity: team.activities[i],
    }));
    const state: SquadState = {
      squad: team.code,
      status: step === 3 ? "checkpoint" : "running",
      step: {
        current: step + 1,
        total: 4,
        label: step === 3 ? "Aprovação do profissional" : team.activities[step],
      },
      agents,
      startedAt: null,
      updatedAt: now,
      handoff:
        step > 0 && step < 3
          ? {
              from: agents[step - 1].id,
              to: agents[step].id,
              message: "Material pronto para a próxima etapa",
              completedAt: now,
            }
          : null,
    };
    return { code: team.code, name: team.name, agents, state };
  });
}

export const agentStatusLabel = {
  idle: "Aguardando",
  working: "Trabalhando",
  delivering: "Entregando",
  done: "Concluído",
  checkpoint: "Sua aprovação",
} as const;
export const squadStatusLabel = {
  idle: "Aguardando execução",
  running: "Em andamento",
  checkpoint: "Aguardando aprovação",
  completed: "Concluído",
  failed: "Interrompido",
} as const;
