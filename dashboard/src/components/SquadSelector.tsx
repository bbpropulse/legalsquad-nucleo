import { squadStatusLabel, type OfficeRoom } from "@/lib/officeModel";

export function SquadSelector({
  rooms,
  selected,
  onSelect,
}: {
  rooms: OfficeRoom[];
  selected: string | null;
  onSelect: (code: string | null) => void;
}) {
  const sorted = [...rooms].sort(
    (a, b) =>
      Number(!!b.state) - Number(!!a.state) ||
      a.name.localeCompare(b.name, "pt-BR"),
  );
  return (
    <aside className="squad-sidebar" aria-label="Squads do escritório">
      <div className="sidebar-title">
        WORKSPACE <span>01</span>
      </div>
      <button
        className={`overview-button ${selected === null ? "selected" : ""}`}
        onClick={() => onSelect(null)}
        aria-pressed={selected === null}
      >
        <span aria-hidden="true">▦</span> Visão do escritório{" "}
        <span className="count">{rooms.length}</span>
      </button>
      <div className="section-label">
        SUAS EQUIPES <span>{rooms.length.toString().padStart(2, "0")}</span>
      </div>
      <nav className="squad-list">
        {sorted.length === 0 && (
          <p className="sidebar-empty">
            O escritório está pronto para receber suas equipes.
          </p>
        )}
        {sorted.map((room, i) => {
          const status = room.error ? "failed" : (room.state?.status ?? "idle");
          return (
            <button
              key={room.code}
              className={`squad-button ${selected === room.code ? "selected" : ""}`}
              onClick={() => onSelect(room.code)}
              aria-pressed={selected === room.code}
            >
              <span className="squad-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="squad-info">
                <strong>{room.name}</strong>
                <small>
                  <i className={`status-dot ${status}`} />
                  {room.error ? "Estado ilegível" : squadStatusLabel[status]}
                </small>
                <span>
                  {room.agents.length} agentes
                  {room.state?.step.total
                    ? ` · Etapa ${room.state.step.current}/${room.state.step.total}`
                    : ""}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-note">
        <span>◇</span>
        <strong>Você continua no comando.</strong>
        <p>
          Quando uma equipe precisar de aprovação, continue a conversa na sua
          IDE.
        </p>
      </div>
      <div className="sidebar-footer">
        <span className="status-dot done" /> Motor LegalSquad <span>↗</span>
      </div>
    </aside>
  );
}
