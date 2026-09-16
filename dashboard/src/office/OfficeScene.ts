import Phaser from 'phaser';
import {
  CHARACTER_NAMES, MALE_CHARACTERS, FEMALE_CHARACTERS, avatarKeys, avatarPath,
  DESK_PATHS,
  FURNITURE_PATHS,
  type CharacterName,
} from './assetKeys';
import { CELL_W, CELL_H, MARGIN, WALL_H } from './palette';
import { RoomBuilder } from './RoomBuilder';
import { AgentSprite } from './AgentSprite';
import type { SquadState, SquadStatus, Agent } from '@/types/state';

// Real agents (from the runner's state.json) have no gender, so characters are
// assigned by index for stable variety, alternating between the two pools.
function assignCharacters(agents: Agent[]): Map<string, CharacterName> {
  const assignments = new Map<string, CharacterName>();

  agents.forEach((agent, i) => {
    const pool = i % 2 === 0 ? FEMALE_CHARACTERS : MALE_CHARACTERS;
    assignments.set(agent.id, pool[Math.floor(i / 2) % pool.length]);
  });

  return assignments;
}

// Sem agentes de demonstração: um escritório movimentado com "Researcher",
// "Writer" e um agente em aprovação, renderizado quando NÃO há estado, é dado
// inventado apresentado como real — e, junto com um state.json ilegível, faz o
// usuário acreditar que há trabalho acontecendo. Sem estado, escritório vazio.
export class OfficeScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private roomBuilder!: RoomBuilder;
  // A cena já foi montada ao menos uma vez? (com zero agentes não dá para inferir
  // isso do tamanho de agentSprites)
  private built = false;
  // Identity of the currently-rendered squad (squad code + agent-id set). When it
  // changes we do a full rebuild; otherwise we update sprites in place (no flicker).
  private currentKey: string | null = null;
  private lastHandoffKey: string | null = null;
  // Last squad status seen — used to fire the celebration once on completion.
  private lastStatus: SquadStatus | null = null;

  constructor() {
    super({ key: 'OfficeScene' });
  }

  preload(): void {
    for (const [key, path] of Object.entries(DESK_PATHS)) {
      this.load.image(key, path);
    }
    for (const name of CHARACTER_NAMES) {
      const keys = avatarKeys(name);
      this.load.image(keys.blink, avatarPath(name, 'blink'));
      this.load.image(keys.talk, avatarPath(name, 'talk'));
      this.load.image(keys.wave1, avatarPath(name, 'wave1'));
      this.load.image(keys.wave2, avatarPath(name, 'wave2'));
    }
    for (const [key, path] of Object.entries(FURNITURE_PATHS)) {
      this.load.image(key, path);
    }
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      console.error('Failed to load asset:', file.key, file.url);
    });
  }

  create(): void {
    this.textures.list && Object.values(this.textures.list).forEach((tex) => {
      if (tex.key !== '__DEFAULT' && tex.key !== '__MISSING') {
        tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
    });

    this.roomBuilder = new RoomBuilder(this);

    this.events.on('stateUpdate', (state: SquadState | null) => {
      this.onStateUpdate(state);
    });

    // Initial render goes through the normal path so currentKey is seeded.
    this.onStateUpdate(null);
  }

  private onStateUpdate(state: SquadState | null): void {
    const agents = state?.agents ?? [];
    const squad = state?.squad ?? '__vazio__';
    const key = `${squad}|${agents.map((a) => a.id).sort().join(',')}`;

    if (key !== this.currentKey || !this.built) {
      // Squad/agent set changed → full rebuild
      this.currentKey = key;
      this.lastHandoffKey = null;
      this.lastStatus = null;
      this.rebuildScene(agents);
    } else {
      // Same squad → update sprites in place (smooth, no flicker)
      const byId = new Map(agents.map((a) => [a.id, a]));
      for (const [id, sprite] of this.agentSprites) {
        const agent = byId.get(id);
        if (agent) sprite.update(agent);
      }
    }

    // Handoff animation — fires once per new handoff (keyed by from→to + time)
    if (state?.handoff) {
      const h = state.handoff;
      const handoffKey = `${h.from}->${h.to}@${h.completedAt}`;
      if (handoffKey !== this.lastHandoffKey) {
        this.lastHandoffKey = handoffKey;
        this.playHandoff(h.from, h.to, h.message);
      }
    }

    // Celebration — fires once when the squad transitions into "completed".
    const status = state?.status ?? null;
    if (status === 'completed' && this.lastStatus !== 'completed') {
      for (const sprite of this.agentSprites.values()) {
        sprite.playCelebration();
      }
    }
    this.lastStatus = status;
  }

  private rebuildScene(agentsInput: Agent[]): void {
    this.built = true;
    if (agentsInput.length === 0) {
      this.renderEmptyOffice();
      return;
    }

    // Auto-assign desk positions if all agents are at the same spot (default 1,1)
    let agents = agentsInput;
    const allSameDesk = agents.length > 1 &&
      agents.every((a) => a.desk.col === agents[0].desk.col && a.desk.row === agents[0].desk.row);
    if (allSameDesk) {
      const cols = Math.min(agents.length, 3);
      agents = agents.map((a, i) => ({
        ...a,
        desk: { col: (i % cols) + 1, row: Math.floor(i / cols) + 1 },
      }));
    }

    let maxCol = 0, maxRow = 0;
    for (const agent of agents) {
      maxCol = Math.max(maxCol, agent.desk.col);
      maxRow = Math.max(maxRow, agent.desk.row);
    }

    const cellW = CELL_W + 64;
    const cellH = CELL_H + 80;

    const roomW = Math.max(maxCol * cellW + MARGIN * 2, 580);
    const loungeSpace = CELL_H + 48;
    const roomH = maxRow * cellH + MARGIN * 2 + WALL_H + loungeSpace;

    this.clearScene();
    this.roomBuilder.build(roomW, roomH);

    const characterMap = assignCharacters(agents);

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const x = (agent.desk.col - 1) * cellW + MARGIN + cellW / 2;
      const y = (agent.desk.row - 1) * cellH + MARGIN + WALL_H + cellH / 2;
      const characterName = characterMap.get(agent.id)!;
      const deskVariant = i % 2 === 0 ? 'black' : 'white';
      const agentSprite = new AgentSprite(this, x, y, characterName, deskVariant, agent);
      this.agentSprites.set(agent.id, agentSprite);
    }

    this.fitCamera(roomW, roomH);
  }

  // Estado vazio explícito: sala montada, nenhuma mesa ocupada e um aviso do
  // porquê. É o oposto do escritório de demonstração — não sugere atividade.
  private renderEmptyOffice(): void {
    this.clearScene();

    const roomW = 580;
    const roomH = (CELL_H + 80) + MARGIN * 2 + WALL_H + CELL_H + 48;
    this.roomBuilder.build(roomW, roomH);

    this.add
      .text(
        roomW / 2,
        roomH / 2,
        'Nenhum squad ativo\nSelecione um squad com execução em andamento',
        {
          fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
          fontSize: '16px',
          color: '#ffffff',
          backgroundColor: '#2a2440',
          padding: { x: 12, y: 8 },
          align: 'center',
          stroke: '#000000',
          strokeThickness: 2,
          resolution: 2,
        }
      )
      .setOrigin(0.5)
      .setDepth(900);

    this.fitCamera(roomW, roomH);
  }

  private fitCamera(roomW: number, roomH: number): void {
    const cam = this.cameras.main;
    const scaleX = cam.width / (roomW + 32);
    const scaleY = cam.height / (roomH + 32);
    const zoom = Math.min(scaleX, scaleY, 2);
    cam.setZoom(zoom);
    cam.centerOn(roomW / 2, roomH / 2);
  }

  // A "page" slides from the sender's desk to the receiver's, with the handoff
  // message popping at the destination — shows the agents handing work over.
  private playHandoff(fromId: string, toId: string, message: string): void {
    const from = this.agentSprites.get(fromId)?.getPosition();
    const to = this.agentSprites.get(toId)?.getPosition();
    if (!from || !to) return;

    const sx = from.x, sy = from.y - 30, tx = to.x, ty = to.y - 30;

    const page = this.add.graphics().setDepth(960);
    this.drawPage(page);
    page.setPosition(sx, sy).setScale(0.9);
    this.tweens.add({
      targets: page,
      x: tx, y: ty,
      duration: 900, ease: 'Sine.easeInOut',
      onComplete: () => {
        this.tweens.add({
          targets: page, alpha: 0, scale: 1.35, duration: 350,
          onComplete: () => page.destroy(),
        });
      },
    });

    if (message) {
      const label = this.add.text(tx, ty - 60, this.shortMessage(message), {
        fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
        fontSize: '12px', color: '#ffffff', backgroundColor: '#2a2440',
        padding: { x: 6, y: 3 }, align: 'center', stroke: '#000000', strokeThickness: 2,
        resolution: 2,
      }).setOrigin(0.5, 1).setDepth(961).setAlpha(0);
      this.tweens.add({
        targets: label, alpha: 1, duration: 300, delay: 650, hold: 1900, yoyo: true,
        onComplete: () => label.destroy(),
      });
    }
  }

  private drawPage(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-11, -14, 22, 28, 3);
    g.lineStyle(1, 0xc9b27a, 1);
    g.strokeRoundedRect(-11, -14, 22, 28, 3);
    g.lineStyle(1, 0x9a9a9a, 1);
    g.beginPath();
    for (const ly of [-6, 0, 6]) { g.moveTo(-6, ly); g.lineTo(6, ly); }
    g.strokePath();
  }

  private shortMessage(message: string): string {
    const m = message.trim();
    return m.length > 44 ? m.slice(0, 43) + '…' : m;
  }

  private clearScene(): void {
    for (const sprite of this.agentSprites.values()) {
      sprite.destroy();
    }
    this.agentSprites.clear();
    this.children.removeAll(true);
  }
}
