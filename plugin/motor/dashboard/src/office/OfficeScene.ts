import Phaser from "phaser";
import {
  CHARACTER_NAMES,
  MALE_CHARACTERS,
  FEMALE_CHARACTERS,
  avatarKeys,
  avatarPath,
  DESK_PATHS,
  FURNITURE_PATHS,
} from "./assetKeys";
import { CELL_W, CELL_H, MARGIN, WALL_H } from "./palette";
import { RoomBuilder } from "./RoomBuilder";
import { AgentSprite } from "./AgentSprite";
import { squadStatusLabel, type OfficeRoom } from "../lib/officeModel";

const GAP = 64,
  TITLE_H = 50;

export class OfficeScene extends Phaser.Scene {
  private sprites = new Map<string, AgentSprite>();
  private roomLabels = new Map<string, Phaser.GameObjects.Text>();
  private handoffs = new Map<string, string>();
  private statuses = new Map<string, string>();
  private teams = new Map<string, { agents: AgentSprite[]; nextStroll: number; cursor: number }>();
  private motionEnabled = true;
  private motionTime = 0;
  private layoutKey = "";
  private worldWidth = 720;
  private worldHeight = 640;

  constructor() {
    super({ key: "OfficeScene" });
  }

  preload(): void {
    for (const [key, path] of Object.entries({
      ...DESK_PATHS,
      ...FURNITURE_PATHS,
    }))
      this.load.image(key, path);
    for (const name of CHARACTER_NAMES) {
      const keys = avatarKeys(name);
      for (const pose of ["blink", "talk", "wave1", "wave2"] as const)
        this.load.image(keys[pose], avatarPath(name, pose));
    }
  }

  create(): void {
    Object.values(this.textures.list).forEach((texture) =>
      texture.setFilter(Phaser.Textures.FilterMode.NEAREST),
    );
    this.events.on("officeUpdate", (rooms: OfficeRoom[]) =>
      this.updateOffice(rooms),
    );
    this.events.on("cameraControl", (action: string) => {
      if (action === "fit") this.fitCamera();
      else this.zoomBy(action === "in" ? 1.2 : 1 / 1.2);
    });
    this.events.on("motionControl", (enabled: boolean) => {
      this.motionEnabled = enabled;
    });
    this.input.on(
      "wheel",
      (_p: unknown, _o: unknown, _dx: number, dy: number) =>
        this.zoomBy(dy > 0 ? 0.9 : 1.1),
    );
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      const camera = this.cameras.main;
      camera.scrollX -= (pointer.x - pointer.prevPosition.x) / camera.zoom;
      camera.scrollY -= (pointer.y - pointer.prevPosition.y) / camera.zoom;
    });
    this.scale.on("resize", this.fitCamera, this);
    this.events.once("shutdown", () => {
      this.scale.off("resize", this.fitCamera, this);
      for (const sprite of this.sprites.values()) sprite.destroy();
      this.sprites.clear();
      this.teams.clear();
    });
    this.updateOffice([]);
    this.game.events.emit("officeReady");
  }

  update(_time: number, delta: number): void {
    if (!this.motionEnabled) return;
    // Retomar uma aba em segundo plano não deve saltar um trajeto inteiro.
    const step = Math.min(delta, 100);
    this.motionTime += step;
    for (const sprite of this.sprites.values()) sprite.animate(this.motionTime, step);
    for (const [code, team] of this.teams) {
      if (this.motionTime < team.nextStroll || team.agents.some((a) => a.isWalking)) continue;
      team.nextStroll = this.motionTime + 3500;
      if (this.statuses.get(code) === "checkpoint" || this.statuses.get(code) === "error") continue;
      for (let n = 0; n < team.agents.length; n++) {
        const index = (team.cursor + n) % team.agents.length;
        if (!team.agents[index].canStroll) continue;
        team.agents[index].stroll();
        team.cursor = index + 1;
        break;
      }
    }
  }

  private updateOffice(rooms: OfficeRoom[]): void {
    // Nomes/posições fazem parte da geometria; atividade muda sem remontar a sala.
    const key = JSON.stringify(
      rooms.map((r) => [
        r.code,
        r.name,
        r.agents.map((a) => [a.id, a.name, a.desk]),
      ]),
    );
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.rebuild(rooms);
    }
    for (const room of rooms) {
      this.roomLabels
        .get(room.code)
        ?.setText(
          room.error
            ? "⚠ Estado ilegível"
            : room.state
              ? squadStatusLabel[room.state.status]
              : "Equipe disponível · sem execução",
        );
      for (const agent of room.agents)
        this.sprites.get(`${room.code}/${agent.id}`)?.update(agent);
      const handoff = room.state?.handoff;
      const handoffKey = handoff
        ? `${handoff.from}/${handoff.to}/${handoff.completedAt}`
        : "";
      if (handoff && this.handoffs.get(room.code) !== handoffKey) {
        this.playHandoff(room.code, handoff.from, handoff.to);
      }
      this.handoffs.set(room.code, handoffKey);
      if (
        room.state?.status === "completed" &&
        this.statuses.get(room.code) !== "completed"
      ) {
        for (const a of room.agents)
          this.sprites.get(`${room.code}/${a.id}`)?.playCelebration();
      }
      this.statuses.set(room.code, room.error ? "error" : room.state?.status ?? "idle");
    }
  }

  private rebuild(rooms: OfficeRoom[]): void {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.roomLabels.clear();
    this.handoffs.clear();
    this.statuses.clear();
    this.teams.clear();
    this.tweens.killAll();
    this.children.removeAll(true);
    const builder = new RoomBuilder(this);
    const deskColumns =
      rooms.length === 1
        ? Math.min(
            5,
            Math.max(3, Math.ceil(Math.sqrt(rooms[0].agents.length * 1.5))),
          )
        : 3;
    const roomWidth = MARGIN * 2 + CELL_W * deskColumns;
    const roomHeight = (r: OfficeRoom) =>
      WALL_H +
      MARGIN +
      Math.max(1, Math.ceil(r.agents.length / deskColumns)) * CELL_H +
      200;
    const columns = rooms.length > 1 ? 2 : 1;
    let y = 0;
    for (let i = 0; i < rooms.length; i += columns) {
      const row = rooms.slice(i, i + columns);
      const rowHeight = Math.max(...row.map(roomHeight));
      row.forEach((room, col) => {
        const x = col * (roomWidth + GAP);
        builder.build(roomWidth, rowHeight, x, y + TITLE_H);
        const title = this.add
          .text(x + 8, y, room.name, {
            fontFamily: "Georgia, serif",
            fontSize: "23px",
            color: "#eee7d8",
          })
          .setDepth(100000);
        title
          .setInteractive({ useHandCursor: true })
          .on("pointerup", (pointer: Phaser.Input.Pointer) => {
            if (
              Phaser.Math.Distance.Between(
                pointer.downX,
                pointer.downY,
                pointer.x,
                pointer.y,
              ) < 8
            )
              this.game.events.emit("selectSquad", room.code);
          });
        const subtitle = this.add
          .text(x + 8, y + 29, "", {
            fontFamily: "Arial",
            fontSize: "12px",
            color: "#aebdb4",
          })
          .setDepth(100000);
        this.roomLabels.set(room.code, subtitle);
        const team = { agents: [] as AgentSprite[], nextStroll: this.motionTime + 1500 + (i + col) * 1300, cursor: 0 };
        this.teams.set(room.code, team);
        room.agents.forEach((agent, n) => {
          const pool = n % 2 === 0 ? FEMALE_CHARACTERS : MALE_CHARACTERS;
          // Compactar os desks evita posições esparsas empurrarem a equipe para fora da sala.
          const px = x + MARGIN + ((n % deskColumns) + 0.5) * CELL_W;
          const py =
            y +
            TITLE_H +
            WALL_H +
            MARGIN +
            Math.floor(n / deskColumns) * CELL_H +
            CELL_H / 2;
          this.sprites.set(
            `${room.code}/${agent.id}`,
            new AgentSprite(
              this,
              px,
              py,
              pool[Math.floor(n / 2) % pool.length],
              n % 2 === 0 ? "black" : "white",
              agent,
            ),
          );
          team.agents.push(this.sprites.get(`${room.code}/${agent.id}`)!);
        });
        if (!room.agents.length)
          this.add
            .text(
              x + roomWidth / 2,
              y + TITLE_H + WALL_H + 140,
              "Aguardando cadastro dos agentes",
              { fontFamily: "Arial", fontSize: "17px", color: "#4b493b" },
            )
            .setOrigin(0.5)
            .setDepth(100000);
      });
      y += TITLE_H + rowHeight + GAP;
    }
    if (!rooms.length) builder.build(roomWidth, 600);
    this.worldWidth = columns * roomWidth + (columns - 1) * GAP;
    this.worldHeight = rooms.length ? y - GAP : 600;
    this.fitCamera();
  }

  private fitCamera(): void {
    const camera = this.cameras.main;
    camera.setZoom(
      Math.min(
        camera.width / (this.worldWidth + 64),
        camera.height / (this.worldHeight + 64),
        1.4,
      ),
    );
    camera.centerOn(this.worldWidth / 2, this.worldHeight / 2);
  }

  private zoomBy(factor: number): void {
    this.cameras.main.setZoom(
      Phaser.Math.Clamp(this.cameras.main.zoom * factor, 0.12, 2.5),
    );
  }

  private playHandoff(code: string, fromId: string, toId: string): void {
    const from = this.sprites.get(`${code}/${fromId}`);
    const to = this.sprites.get(`${code}/${toId}`);
    if (!from || !to) return;
    from.deliverTo(to);
  }
}
