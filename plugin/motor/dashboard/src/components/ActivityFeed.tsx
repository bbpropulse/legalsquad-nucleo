import { useEffect, useState } from "react";
import { useSquadStore } from "@/store/useSquadStore";
import { staleFor, formatStaleAge } from "@/lib/freshness";
import {
  agentStatusLabel,
  squadStatusLabel,
  type OfficeRoom,
} from "@/lib/officeModel";

export function ActivityFeed({
  rooms,
  demo,
}: {
  rooms: OfficeRoom[];
  demo: boolean;
}) {
  const feeds = useSquadStore((s) => s.feed);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const events = demo
    ? []
    : rooms
        .flatMap((room) =>
          (feeds.get(room.code) ?? []).map((event) => ({
            ...event,
            squad: room.name,
            key: `${room.code}/${event.id}`,
          })),
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 20);
  return (
    <aside className="activity-sidebar" aria-label="Atividade dos agentes">
      <div className="activity-title">
        <h2>Em foco</h2>
        <span>{demo ? "PRÉVIA" : "ATIVIDADE"}</span>
      </div>
      <div className="activity-scroll">
        {rooms.length === 0 && (
          <div className="activity-empty">
            <span>◎</span>
            <h3>Pronto para acompanhar</h3>
            <p>As atividades e os repasses entre agentes aparecerão aqui.</p>
          </div>
        )}
        {rooms.map((room) => (
          <section className="team-activity" key={room.code}>
            <h3>{room.name}</h3>
            {room.error && (
              <p className="state-error" role="status">
                Estado ilegível: {room.error}
              </p>
            )}
            {!demo &&
              room.state?.status === "running" &&
              staleFor(room.state.updatedAt, now) !== null && (
                <p className="state-error">
                  Sem atualização há{" "}
                  {formatStaleAge(staleFor(room.state.updatedAt, now)!)}.
                  Confira a execução na IDE.
                </p>
              )}
            <div
              className={`current-step ${room.state?.status === "checkpoint" ? "needs-approval" : ""}`}
            >
              <span>
                {room.state
                  ? squadStatusLabel[room.state.status]
                  : "Equipe disponível"}
              </span>
              <strong>
                {room.state?.step.label || "Aguardando uma nova execução"}
              </strong>
              {room.state?.status === "checkpoint" && (
                <p>Aprove pela conversa na sua IDE.</p>
              )}
              {!!room.state?.step.total && (
                <div className="step-track">
                  <i
                    style={{
                      width: `${Math.min(100, (room.state.step.current / room.state.step.total) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
            <div className="agent-list">
              {room.agents.map((agent) => (
                <div className={`agent-row ${agent.status}`} key={agent.id}>
                  <span className="agent-initials" aria-hidden="true">
                    {agent.name
                      .split(" ")
                      .map((s) => s[0])
                      .slice(0, 2)
                      .join("")}
                  </span>
                  <div>
                    <strong>{agent.name}</strong>
                    <small>
                      {agent.activity &&
                      (agent.status === "working" ||
                        agent.status === "delivering")
                        ? agent.activity
                        : agentStatusLabel[agent.status]}
                    </small>
                  </div>
                  <i
                    className={`status-dot ${agent.status}`}
                    title={agentStatusLabel[agent.status]}
                  />
                </div>
              ))}
            </div>
            {room.state?.handoff && (
              <div className="handoff-note">
                <span>↗ REPASSE</span>
                <p>{room.state.handoff.message}</p>
              </div>
            )}
          </section>
        ))}
        <div className="timeline-title">ÚLTIMOS MOVIMENTOS</div>
        {events.length ? (
          events.map((event) => (
            <div className="timeline-event" key={event.key}>
              <i
                className={`status-dot ${event.kind === "status" ? "checkpoint" : "working"}`}
              />
              <div>
                <p>{event.text}</p>
                <small>
                  {new Date(event.at).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                  {rooms.length > 1 ? ` · ${event.squad}` : ""}
                </small>
              </div>
            </div>
          ))
        ) : (
          <p className="timeline-empty">
            {demo
              ? "Esta prévia simula as mudanças de etapa a cada 5 segundos."
              : "Os próximos movimentos da execução serão registrados aqui enquanto o painel estiver aberto."}
          </p>
        )}
      </div>
    </aside>
  );
}
