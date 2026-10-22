import type { SquadState } from "@/types/state";

const SQUAD_STATUSES = new Set(["idle", "running", "completed", "checkpoint", "failed"]);
const AGENT_STATUSES = new Set(["idle", "working", "delivering", "done", "checkpoint"]);

export type StateValidation =
  | { ok: true; state: SquadState }
  | { ok: false; reason: string };

function fail(reason: string): StateValidation {
  return { ok: false, reason };
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Valida a forma COMPLETA do state.json e, quando reprova, diz POR QUÊ.
 *
 * state.json é conteúdo não confiável: o runner sanciona edição manual, e uma
 * escrita parcial produz um objeto estruturalmente plausível mas incompleto.
 * Descartar em silêncio faria um squad RODANDO aparecer como inativo — por isso
 * o motivo volta junto, para o servidor logar e a UI mostrar "estado ilegível"
 * em vez de "sem estado". As duas situações exigem ações opostas.
 *
 * Contrato único (lado do ESCRITOR): _legalsquad/core/state.schema.json,
 * gravado por scripts/squad-state.mjs. Mantenha os enums abaixo em sincronia.
 */
export function validateSquadState(data: unknown): StateValidation {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fail("state.json não é um objeto");
  }
  const d = data as Record<string, unknown>;

  if (!isStr(d.squad)) return fail("campo `squad` ausente ou não é string");

  if (!isStr(d.status) || !SQUAD_STATUSES.has(d.status)) {
    return fail(`campo \`status\` inválido (${JSON.stringify(d.status)})`);
  }

  const step = d.step as Record<string, unknown> | undefined;
  if (!step || typeof step !== "object") return fail("campo `step` ausente");
  if (typeof step.current !== "number") return fail("campo `step.current` não é número");
  if (typeof step.total !== "number") return fail("campo `step.total` não é número");
  if (!isStr(step.label)) return fail("campo `step.label` não é string");

  if (!Array.isArray(d.agents)) return fail("campo `agents` não é lista");
  for (let i = 0; i < d.agents.length; i++) {
    const a = d.agents[i];
    if (!a || typeof a !== "object") return fail(`agente ${i}: não é objeto`);
    const ag = a as Record<string, unknown>;
    if (!isStr(ag.id)) return fail(`agente ${i}: campo \`id\` não é string`);
    if (!isStr(ag.name)) return fail(`agente ${ag.id}: campo \`name\` não é string`);
    if (!isStr(ag.status) || !AGENT_STATUSES.has(ag.status)) {
      return fail(`agente ${ag.id}: \`status\` inválido (${JSON.stringify(ag.status)})`);
    }
    if (ag.activity !== undefined && !isStr(ag.activity)) {
      return fail(`agente ${ag.id}: \`activity\` não é string`);
    }
    const desk = ag.desk as Record<string, unknown> | undefined;
    if (!desk || typeof desk !== "object") return fail(`agente ${ag.id}: \`desk\` ausente`);
    if (typeof desk.col !== "number" || typeof desk.row !== "number") {
      return fail(`agente ${ag.id}: \`desk.col\`/\`desk.row\` não são números`);
    }
  }

  // `handoff` era o buraco da validação anterior: um `message` não-string chega
  // à cena Phaser (shortMessage faz .trim()) e derruba o render inteiro.
  const handoff = d.handoff;
  if (handoff !== null && handoff !== undefined) {
    if (typeof handoff !== "object" || Array.isArray(handoff)) {
      return fail("campo `handoff` não é objeto nem null");
    }
    const h = handoff as Record<string, unknown>;
    for (const field of ["from", "to", "message", "completedAt"]) {
      if (!isStr(h[field])) return fail(`campo \`handoff.${field}\` ausente ou não é string`);
    }
  }

  if (d.startedAt !== null && d.startedAt !== undefined && !isStr(d.startedAt)) {
    return fail("campo `startedAt` não é string nem null");
  }
  // `updatedAt` é o que permite detectar execução morta — sem ele o dashboard
  // não consegue distinguir "rodando" de "sessão caiu".
  if (!isStr(d.updatedAt)) return fail("campo `updatedAt` ausente ou não é string");

  return { ok: true, state: data as SquadState };
}

/** Açúcar para os pontos que só precisam do sim/não. */
export function isValidState(data: unknown): data is SquadState {
  return validateSquadState(data).ok;
}
