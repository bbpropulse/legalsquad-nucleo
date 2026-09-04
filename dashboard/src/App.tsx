import { useSquadSocket } from "@/hooks/useSquadSocket";
import { SquadSelector } from "@/components/SquadSelector";
import { PhaserGame } from "@/office/PhaserGame";
import { StatusBar } from "@/components/StatusBar";
import { ActivityFeed } from "@/components/ActivityFeed";
import { CheckpointBanner } from "@/components/CheckpointBanner";

export function App() {
  useSquadSocket();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          height: 40,
          minHeight: 40,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-sidebar)",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 0.5,
        }}
      >
        legalsquad Dashboard
      </header>

      {/* Main content */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <SquadSelector />
        <div style={{ position: "relative", flex: 1, display: "flex", overflow: "hidden" }}>
          <PhaserGame />
          <CheckpointBanner />
        </div>
        <ActivityFeed />
      </div>

      {/* Footer */}
      <StatusBar />
    </div>
  );
}
