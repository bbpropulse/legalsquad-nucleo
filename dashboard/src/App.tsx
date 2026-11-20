import { useEffect, useMemo, useState } from "react";
import { useSquadSocket } from "@/hooks/useSquadSocket";
import { useSquadStore } from "@/store/useSquadStore";
import { SquadSelector } from "@/components/SquadSelector";
import { PhaserGame } from "@/office/PhaserGame";
import { StatusBar } from "@/components/StatusBar";
import { ActivityFeed } from "@/components/ActivityFeed";
import { CheckpointBanner } from "@/components/CheckpointBanner";
import { demoRooms, officeRooms } from "@/lib/officeModel";

export function App() {
  useSquadSocket();
  const {
    squads,
    activeStates,
    invalidStates,
    selectedSquad,
    isConnected,
    selectSquad,
  } = useSquadStore();
  const [demo, setDemo] = useState(false);
  const [demoSelected, setDemoSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    if (!demo) return;
    const timer = setInterval(() => setPhase((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [demo]);
  const realRooms = useMemo(
    () => officeRooms(squads, activeStates, null, invalidStates),
    [squads, activeStates, invalidStates],
  );
  const preview = useMemo(() => demoRooms(phase), [phase]);
  const allRooms = demo ? preview : realRooms;
  const selection = demo ? demoSelected : selectedSquad;
  const rooms = allRooms.filter((r) => !selection || r.code === selection);
  const working = allRooms
    .flatMap((r) => r.agents)
    .filter((a) => a.status === "working" || a.status === "delivering").length;
  const approvals = allRooms.filter(
    (r) => r.state?.status === "checkpoint",
  ).length;
  const select = (code: string | null) =>
    demo ? setDemoSelected(code) : selectSquad(code);
  const selectedRoom = allRooms.find((r) => r.code === selection);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⚖
          </span>
          <div>
            <strong>
              LegalSquad<span className="brand-period">.</span>
            </strong>
            <small>SEU ESCRITÓRIO, EM MOVIMENTO</small>
          </div>
        </div>
        <div className="header-right">
          <span className={`connection-pill ${isConnected ? "connected" : ""}`}>
            <i />
            {isConnected ? "Conectado ao escritório" : "Reconectando…"}
          </span>
          <span className="local-label">LOCAL · PRIVADO</span>
        </div>
      </header>
      {demo && (
        <div className="demo-banner">
          <span>
            <strong>Demonstração</strong> · Squads e atividades fictícios,
            apenas para conhecer o escritório.
          </span>
          <button onClick={() => setDemo(false)}>
            Voltar ao meu escritório ↗
          </button>
        </div>
      )}
      <main className="workspace">
        <SquadSelector
          rooms={allRooms}
          selected={selection}
          onSelect={select}
        />
        <section
          className={`office-panel ${expanded ? "expanded" : ""}`}
          aria-label="Escritório"
        >
          <div className="office-heading">
            <div>
              <div className="eyebrow">
                ESCRITÓRIO VIRTUAL{" "}
                <span>/ {selectedRoom ? "SQUAD" : "VISÃO GERAL"}</span>
              </div>
              <h1>{selectedRoom?.name ?? "O trabalho ganha vida."}</h1>
              <p>
                {selectedRoom
                  ? "Acompanhe cada agente e a próxima etapa da equipe."
                  : "Um lugar para acompanhar suas equipes, da pesquisa à entrega."}
              </p>
            </div>
            {!demo && (
              <button
                className="text-button"
                onClick={() => {
                  setDemo(true);
                  setDemoSelected(null);
                }}
              >
                Ver demonstração ↗
              </button>
            )}
          </div>
          <div className="office-metrics">
            <span>
              <b>{allRooms.length.toString().padStart(2, "0")}</b> squads no
              escritório
            </span>
            <span>
              <i className="status-dot working" />
              <b>{working.toString().padStart(2, "0")}</b> agentes trabalhando
            </span>
            <span>
              <i className="status-dot checkpoint" />
              <b>{approvals.toString().padStart(2, "0")}</b> aguardando
              aprovação
            </span>
          </div>
          <div className="office-stage">
            <button
              className="expand-office"
              onClick={() => setExpanded((value) => !value)}
              aria-pressed={expanded}
              aria-label={
                expanded ? "Recolher escritório" : "Ampliar escritório"
              }
            >
              {expanded ? "↙ Recolher · Esc" : "↗ Ampliar"}
            </button>
            <div className="stage-label">
              <span className="status-dot" />{" "}
              {demo ? "DEMONSTRAÇÃO · DADOS FICTÍCIOS" : "ANDAR 01 · OPERAÇÃO"}
            </div>
            <PhaserGame rooms={rooms} onSelect={(code) => select(code)} />
            {!demo && <CheckpointBanner />}
            {!demo && allRooms.length === 0 && (
              <div className="empty-office">
                <span className="empty-symbol">⚖</span>
                <h2>Seu próximo squad começa aqui.</h2>
                <p>
                  Os squads deste projeto aparecerão no escritório assim que
                  forem criados. Durante a execução, você verá cada agente
                  trabalhando.
                </p>
                <code>/legalsquad crie um squad para…</code>
                <button
                  className="primary-button"
                  onClick={() => setDemo(true)}
                >
                  Conhecer o escritório <span>→</span>
                </button>
              </div>
            )}
            {!isConnected && !demo && (
              <div className="connection-warning" role="status">
                Conexão interrompida. Exibindo a última leitura; aguardando
                reconexão.
              </div>
            )}
          </div>
          <div className="office-legend">
            <span>
              <i className="status-dot working" /> Trabalhando
            </span>
            <span>
              <i className="status-dot checkpoint" /> Sua aprovação
            </span>
            <span>
              <i className="status-dot done" /> Concluído
            </span>
            <span>
              <i className="status-dot idle" /> Aguardando
            </span>
            <small>Clique no nome de um squad para entrar na sala</small>
          </div>
        </section>
        <ActivityFeed rooms={rooms} demo={demo} />
      </main>
      {demo ? (
        <footer className="demo-footer">
          Modo de demonstração · Nenhuma execução real iniciada{" "}
          <span>
            Os agentes simulam pesquisa, redação, revisão e aprovação.
          </span>
        </footer>
      ) : (
        <StatusBar />
      )}
    </div>
  );
}
