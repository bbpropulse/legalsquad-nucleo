import { create } from "zustand";
import type { SquadInfo, SquadState, SquadStateError, FeedEntry } from "@/types/state";

const FEED_CAP = 40;

/** Stable empty feed so selectors don't trigger re-renders for squads with no events. */
export const EMPTY_FEED: readonly FeedEntry[] = [];

// Derives feed events by diffing the previous vs next state of a squad.
function deriveFeed(prev: SquadState | undefined, next: SquadState): FeedEntry[] {
  if (!prev) return []; // first time we see the squad — don't spam the feed
  const out: FeedEntry[] = [];
  const at = Date.now();
  let seq = 0;
  const mk = (kind: FeedEntry["kind"], text: string): FeedEntry => ({
    id: `${at}-${seq++}`,
    at,
    kind,
    text,
  });
  const nameOf = (id: string) => next.agents.find((a) => a.id === id)?.name ?? id;

  if (prev.step?.current !== next.step?.current || prev.step?.label !== next.step?.label) {
    out.push(mk("step", `Passo ${next.step?.current ?? "?"}/${next.step?.total ?? "?"} — ${next.step?.label ?? ""}`));
  }

  const h = next.handoff;
  if (h) {
    const changed = !prev.handoff ||
      prev.handoff.completedAt !== h.completedAt ||
      prev.handoff.from !== h.from ||
      prev.handoff.to !== h.to;
    if (changed) out.push(mk("handoff", `${nameOf(h.from)} → ${nameOf(h.to)}: ${h.message}`));
  }

  if (prev.status !== next.status && next.status === "checkpoint") {
    out.push(mk("status", "Aguardando sua aprovação (checkpoint)"));
  }
  return out;
}

// Prepends derived entries to ONE squad's feed (immutably, capped). Returns the
// same Map reference when there is nothing to add, so selectors don't churn.
function pushFeed(
  feed: Map<string, FeedEntry[]>,
  squad: string,
  entries: FeedEntry[]
): Map<string, FeedEntry[]> {
  if (entries.length === 0) return feed;
  const next = new Map(feed);
  const current = next.get(squad) ?? [];
  next.set(squad, [...entries, ...current].slice(0, FEED_CAP));
  return next;
}

interface SquadStore {
  squads: Map<string, SquadInfo>;
  activeStates: Map<string, SquadState>;
  /**
   * Squads cujo state.json existe mas não pôde ser lido. Fica SEPARADO de
   * activeStates justamente para a UI distinguir "sem estado" de "estado
   * ilegível" — o segundo quase sempre é um squad rodando com arquivo quebrado.
   */
  invalidStates: Map<string, SquadStateError>;
  selectedSquad: string | null;
  isConnected: boolean;
  // Feed is PER-SQUAD so events from background squads never bleed into the
  // selected squad's timeline (and switching squads shows the right history).
  feed: Map<string, FeedEntry[]>;

  selectSquad: (name: string | null) => void;
  setConnected: (connected: boolean) => void;
  setSnapshot: (
    squads: SquadInfo[],
    activeStates: Record<string, SquadState>,
    invalidStates?: Record<string, SquadStateError>
  ) => void;
  setSquadActive: (squad: string, state: SquadState) => void;
  updateSquadState: (squad: string, state: SquadState) => void;
  setSquadInvalid: (squad: string, error: SquadStateError) => void;
  setSquadInactive: (squad: string) => void;
}

/** Remove a marca de "ilegível" (a leitura voltou a funcionar). Preserva a referência quando não havia marca. */
function clearInvalid(
  invalid: Map<string, SquadStateError>,
  squad: string
): Map<string, SquadStateError> {
  if (!invalid.has(squad)) return invalid;
  const next = new Map(invalid);
  next.delete(squad);
  return next;
}

export const useSquadStore = create<SquadStore>((set) => ({
  squads: new Map(),
  activeStates: new Map(),
  invalidStates: new Map(),
  selectedSquad: null,
  isConnected: false,
  feed: new Map(),

  selectSquad: (name) => set({ selectedSquad: name }),

  setConnected: (connected) => set({ isConnected: connected }),

  // Replaces the snapshot but STILL derives feed per squad (vs the previous
  // state) — this is what runs in the HTTP polling fallback, where only
  // snapshots arrive. Without it the activity feed would never populate offline.
  setSnapshot: (squads, activeStates, invalidStates) =>
    set((prev) => {
      const nextStates = new Map(Object.entries(activeStates));
      let feed = prev.feed;
      for (const [squad, state] of nextStates) {
        feed = pushFeed(feed, squad, deriveFeed(prev.activeStates.get(squad), state));
      }
      // Reconcile removals. The HTTP polling fallback only ever sends snapshots
      // (never SQUAD_INACTIVE), so a squad that finished/aborted just disappears
      // from the snapshot — drop its stale feed (no unbounded growth) and clear
      // an orphaned selection, mirroring setSquadInactive's WebSocket cleanup.
      const nextInvalid = new Map(Object.entries(invalidStates ?? {}));
      let pruned = false;
      const reconciled = new Map(feed);
      for (const squad of reconciled.keys()) {
        // Estado ilegível não é sumiço: o histórico continua valendo enquanto o
        // usuário investiga o arquivo quebrado.
        if (!nextStates.has(squad) && !nextInvalid.has(squad)) {
          reconciled.delete(squad);
          pruned = true;
        }
      }
      // Um squad com estado ilegível continua selecionável: é onde o usuário lê
      // o aviso. Só perde a seleção quem sumiu de verdade.
      const selectedSquad =
        prev.selectedSquad &&
        !nextStates.has(prev.selectedSquad) &&
        !nextInvalid.has(prev.selectedSquad)
          ? null
          : prev.selectedSquad;
      return {
        squads: new Map(squads.map((s) => [s.code, s])),
        activeStates: nextStates,
        invalidStates: nextInvalid,
        feed: pruned ? reconciled : feed,
        selectedSquad,
      };
    }),

  setSquadActive: (squad, state) =>
    set((prev) => ({
      activeStates: new Map(prev.activeStates).set(squad, state),
      invalidStates: clearInvalid(prev.invalidStates, squad),
      feed: pushFeed(prev.feed, squad, deriveFeed(prev.activeStates.get(squad), state)),
    })),

  updateSquadState: (squad, state) =>
    set((prev) => ({
      activeStates: new Map(prev.activeStates).set(squad, state),
      invalidStates: clearInvalid(prev.invalidStates, squad),
      feed: pushFeed(prev.feed, squad, deriveFeed(prev.activeStates.get(squad), state)),
    })),

  // Mantém o último estado bom em activeStates de propósito: o usuário continua
  // vendo onde a execução parou, agora com o aviso de que o arquivo quebrou.
  setSquadInvalid: (squad, error) =>
    set((prev) => ({
      invalidStates: new Map(prev.invalidStates).set(squad, error),
    })),

  setSquadInactive: (squad) =>
    set((prev) => {
      const next = new Map(prev.activeStates);
      next.delete(squad);
      const feed = new Map(prev.feed);
      feed.delete(squad);
      return {
        invalidStates: clearInvalid(prev.invalidStates, squad),
        activeStates: next,
        feed,
        selectedSquad: prev.selectedSquad === squad ? null : prev.selectedSquad,
      };
    }),
}));
