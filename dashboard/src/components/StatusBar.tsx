import { useEffect, useState } from "react";
import { useSquadStore } from "@/store/useSquadStore";
import { formatElapsed } from "@/lib/formatTime";
import { formatStaleAge, staleFor } from "@/lib/freshness";
import { getWorkingAgents } from "@/lib/normalizeState";
import { ProgressBar } from "./ProgressBar";

const FRESHNESS_TICK_MS = 15000;

export function StatusBar() {
  const selectedSquad = useSquadStore((s) => s.selectedSquad);
  const state = useSquadStore((s) =>
    s.selectedSquad ? s.activeStates.get(s.selectedSquad) : undefined
  );
  const invalid = useSquadStore((s) =>
    s.selectedSquad ? s.invalidStates.get(s.selectedSquad) : undefined
  );
  const isConnected = useSquadStore((s) => s.isConnected);

  // Elapsed timer
  const [elapsed, setElapsed] = useState(0);
  // Relógio de parede próprio para o aviso de frescor: sem ele, um estado que
  // parou de ser atualizado nunca redispararia render e ficaria "running" eterno.
  const [now, setNow] = useState(() => Date.now());

  const startedAt = state?.startedAt;
  // When the run is terminal (completed/failed) the runner keeps startedAt and sets
  // completedAt/failedAt — freeze elapsed at the real duration instead of ticking on.
  const endAt = state?.completedAt ?? state?.failedAt ?? null;

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    const startTime = new Date(startedAt).getTime();
    if (endAt) {
      setElapsed(new Date(endAt).getTime() - startTime); // frozen final duration
      return;
    }
    const tick = () => setElapsed(Date.now() - startTime);
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt, endAt]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (!selectedSquad || (!state && !invalid)) {
    return (
      <footer style={footerStyle}>
        <span style={{ color: "var(--text-secondary)" }}>
          Selecione um squad ativo para acompanhar
        </span>
        <ConnectionDot connected={isConnected} />
      </footer>
    );
  }

  // "Não sei ler" ≠ "não existe": o state.json está lá, mas quebrado. Sem este
  // aviso o squad apareceria como inativo e o usuário não saberia de nada.
  if (!state) {
    return (
      <footer style={{ ...footerStyle, background: "var(--accent-red)", color: "#fff" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ⚠ Estado ilegível — o state.json existe mas não pôde ser lido: {invalid?.reason}
        </span>
        <ConnectionDot connected={isConnected} />
      </footer>
    );
  }

  // Execução parada de verdade vs. execução morta: o runner reescreve updatedAt a
  // cada passo, então silêncio prolongado em "running" sinaliza sessão caída.
  const staleAge = state.status === "running" ? staleFor(state.updatedAt, now) : null;

  return (
    <footer style={footerStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flex: 1, minWidth: 0 }}>
        <span>
          Passo {state.step.current}/{state.step.total}
          {state.step.label ? ` — ${state.step.label}` : ""}
        </span>
        <ProgressBar current={state.step.current} total={state.step.total} />
        {state.startedAt && (
          <span style={{ color: staleAge ? "var(--accent-red)" : "var(--text-secondary)" }}>
            {formatElapsed(elapsed)}
          </span>
        )}
        {staleAge !== null && (
          <span
            title="O runner grava updatedAt a cada passo; este silêncio sugere que a sessão caiu."
            style={{
              color: "var(--accent-red)",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            ⚠ sem atualização há {formatStaleAge(staleAge)}
          </span>
        )}
        {invalid && (
          <span
            title={invalid.reason}
            style={{
              color: "var(--accent-red)",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            ⚠ estado ilegível (mostrando a última leitura boa)
          </span>
        )}
        {getWorkingAgents(state).length > 1 && (
          <span
            title="Agentes trabalhando em paralelo (fan-out)"
            style={{
              color: "var(--accent-cyan)",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            ⚡ {getWorkingAgents(state).length} em paralelo
          </span>
        )}
        {state.handoff && (
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-secondary)",
              fontSize: 12,
            }}
            title={`${state.handoff.from} → ${state.handoff.to}: ${state.handoff.message}`}
          >
            {state.handoff.from} → {state.handoff.to}: {state.handoff.message}
          </span>
        )}
      </div>
      <ConnectionDot connected={isConnected} />
    </footer>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? "Connected" : "Disconnected"}
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: connected ? "var(--accent-green)" : "var(--accent-red)",
        flexShrink: 0,
      }}
    />
  );
}

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 16px",
  borderTop: "1px solid var(--border)",
  background: "var(--bg-sidebar)",
  fontSize: 13,
  height: 40,
  minHeight: 40,
};
