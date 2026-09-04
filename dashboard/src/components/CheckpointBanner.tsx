import { useSquadStore } from "@/store/useSquadStore";

// Faixa de destaque sobre o escritório quando o squad pausa para aprovação.
// Charme + clareza: deixa óbvio que a equipe está esperando o(a) profissional.
export function CheckpointBanner() {
  const selectedSquad = useSquadStore((s) => s.selectedSquad);
  const state = useSquadStore((s) =>
    s.selectedSquad ? s.activeStates.get(s.selectedSquad) : undefined
  );

  if (!selectedSquad || state?.status !== "checkpoint") return null;

  const label = state.step.label?.trim();

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderRadius: 8,
        background: "rgba(20, 20, 34, 0.92)",
        border: "1px solid var(--accent-amber)",
        color: "var(--text-primary)",
        fontSize: 14,
        fontWeight: 600,
        letterSpacing: 0.3,
        maxWidth: "80%",
        animation: "checkpoint-glow 2.4s ease-in-out infinite",
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1 }}>⏸</span>
      <span>
        Aguardando sua aprovação
        {label ? (
          <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}> — {label}</span>
        ) : null}
      </span>
    </div>
  );
}
