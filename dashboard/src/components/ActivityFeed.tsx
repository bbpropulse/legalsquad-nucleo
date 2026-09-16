import { useSquadStore, EMPTY_FEED } from "@/store/useSquadStore";
import type { FeedEntry } from "@/types/state";

function kindColor(kind: FeedEntry["kind"]): string {
  if (kind === "handoff") return "var(--accent-green)";
  if (kind === "status") return "var(--accent-amber)";
  return "var(--accent-cyan)";
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Right rail: live timeline of pipeline events (steps, handoffs, checkpoints).
export function ActivityFeed() {
  const selectedSquad = useSquadStore((s) => s.selectedSquad);
  const feed = useSquadStore((s) =>
    (s.selectedSquad ? s.feed.get(s.selectedSquad) : undefined) ?? EMPTY_FEED
  );

  if (!selectedSquad) return null;

  return (
    <aside
      style={{
        width: 240,
        minWidth: 240,
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-sidebar)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.5,
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        ATIVIDADE
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {feed.length === 0 ? (
          <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-secondary)" }}>
            Aguardando atividade…
          </div>
        ) : (
          feed.map((e) => (
            <div
              key={e.id}
              style={{
                padding: "6px 14px 6px 12px",
                borderLeft: `2px solid ${kindColor(e.kind)}`,
                marginBottom: 2,
              }}
            >
              <div style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-primary)" }}>{e.text}</div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 2 }}>{clock(e.at)}</div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
