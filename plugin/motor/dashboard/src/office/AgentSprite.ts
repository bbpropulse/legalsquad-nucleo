import type Phaser from 'phaser';
import { avatarKeys, DESK_KEYS, FURNITURE_KEYS, type CharacterName } from './assetKeys.ts';
import { COLORS } from './palette.ts';
import { sampleVisit, seatPosition, visitRoute, type Point } from './motion.ts';
import type { Agent, AgentStatus } from '@/types/state';

const AVATAR_SCALE = 0.8;
const COFFEE_PAUSE = 2600;
const STATUS_COLORS: Record<AgentStatus, number> = {
  idle: COLORS.statusIdle, working: COLORS.statusWorking, done: COLORS.statusDone,
  checkpoint: COLORS.statusCheckpoint, delivering: COLORS.statusWorking,
};
const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'aguardando', working: 'trabalhando', done: 'concluído',
  checkpoint: 'aprovação', delivering: 'entregando',
};

export class AgentSprite {
  private x: number;
  private y: number;
  private agent: Agent;
  private deskTable: Phaser.GameObjects.Image;
  private desk: Phaser.GameObjects.Image;
  private coffeeMug: Phaser.GameObjects.Image;
  private steam: Phaser.GameObjects.Graphics;
  private person: Phaser.GameObjects.Container;
  private feet: Phaser.GameObjects.Graphics;
  private shadow: Phaser.GameObjects.Graphics;
  private folder: Phaser.GameObjects.Graphics;
  private coffeeBreak: Phaser.GameObjects.Container;
  private coffeeSteam: Phaser.GameObjects.Graphics;
  private torso: Phaser.GameObjects.Image;
  private avatar: Phaser.GameObjects.Image;
  private glow: Phaser.GameObjects.Graphics;
  private nameText: Phaser.GameObjects.Text;
  private badgeBg: Phaser.GameObjects.Graphics;
  private statusDot: Phaser.GameObjects.Graphics;
  private statusText: Phaser.GameObjects.Text;
  private activityBg: Phaser.GameObjects.Graphics;
  private activityText: Phaser.GameObjects.Text;
  private characterName: CharacterName;
  private deskVariant: 'black' | 'white';
  private avatarDisplayH: number;
  private rhythm: number;
  private waveRemaining = 0;
  private visit?: { route: Point[]; elapsed: number; recipient?: AgentSprite; greeted: boolean };
  private pendingRecipient?: AgentSprite;

  constructor(scene: Phaser.Scene, x: number, y: number, characterName: CharacterName,
    deskVariant: 'black' | 'white', agent: Agent) {
    this.x = x;
    this.y = y;
    this.agent = agent;
    this.characterName = characterName;
    this.deskVariant = deskVariant;
    // Cada pessoa tem seu ritmo, sem uma sala inteira se mover em sincronia.
    this.rhythm = [...agent.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 7000;
    const seat = seatPosition({ x, y });
    this.glow = scene.add.graphics().setPosition(x, seat.y).setDepth(y - 2);
    this.shadow = scene.add.graphics();
    this.feet = scene.add.graphics();
    this.avatar = scene.add.image(0, 0, avatarKeys(characterName).talk).setScale(AVATAR_SCALE);
    this.avatarDisplayH = this.avatar.displayHeight;
    this.torso = scene.add.image(0, 0, avatarKeys(characterName).talk).setScale(AVATAR_SCALE);
    const neck = Math.floor(this.torso.height * 0.74);
    this.torso.setCrop(0, neck, this.torso.width, this.torso.height - neck).setVisible(false);
    const hand = scene.add.graphics().fillStyle(0xc39170).fillRect(5, 2, 12, 5);
    const cup = scene.add.image(16, 0, FURNITURE_KEYS.coffeeMug).setScale(1.4);
    this.coffeeSteam = scene.add.graphics().setPosition(16, -9);
    this.coffeeBreak = scene.add.container(0, 14, [hand, cup, this.coffeeSteam]).setVisible(false);
    this.folder = scene.add.graphics().setVisible(false);
    this.folder.fillStyle(0xb88c45).fillRect(11, 7, 19, 16);
    this.folder.fillStyle(0xf4e4b9).fillRect(13, 5, 14, 15);
    this.folder.fillStyle(0xd3ae69).fillRect(11, 10, 19, 14);
    this.folder.lineStyle(1, 0x70532f).strokeRect(11, 10, 19, 14);
    this.person = scene.add.container(seat.x, seat.y,
      [this.shadow, this.feet, this.torso, this.avatar, this.folder, this.coffeeBreak]).setDepth(y);
    this.deskTable = scene.add.image(x, y, FURNITURE_KEYS.deskWood)
      .setScale(1.3).setDepth(y + 1);
    this.desk = scene.add.image(x, y - 30, this.monitorKey(false)).setScale(1.3).setDepth(y + 2);
    this.coffeeMug = scene.add.image(x + 42, y + 8, FURNITURE_KEYS.coffeeMug)
      .setOrigin(0.5, 1).setScale(1.4).setDepth(y + 3);
    this.steam = scene.add.graphics().setPosition(x + 42, y - 9).setDepth(y + 4);
    const labelY = y - 140;
    this.badgeBg = scene.add.graphics().setDepth(100000);
    this.nameText = scene.add.text(x, labelY + 5, agent.name, {
      fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#ffffff', align: 'center', stroke: '#000000', strokeThickness: 4, resolution: 2,
    }).setOrigin(0.5, 0).setDepth(100001);
    this.statusDot = scene.add.graphics().setDepth(100001);
    this.statusText = scene.add.text(x, labelY + 24, '', {
      fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: '13px', fontStyle: 'bold',
      align: 'center', stroke: '#000000', strokeThickness: 3, resolution: 2,
    }).setOrigin(0.5, 0).setDepth(100001);
    this.activityBg = scene.add.graphics().setDepth(100002).setVisible(false);
    this.activityText = scene.add.text(x, labelY - 6, '', {
      fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: '12px', fontStyle: 'italic',
      color: '#dfeaff', align: 'center', stroke: '#000000', strokeThickness: 3, resolution: 2,
    }).setOrigin(0.5, 1).setDepth(100003).setVisible(false);
    this.update(agent);
    this.animate(0, 0);
  }

  update(agent: Agent): void {
    this.agent = agent;
    // O estado real tem prioridade, inclusive com as animações pausadas:
    // recebeu trabalho, senta imediatamente e abandona passeio/entrega pendente.
    if (!this.canTakeBreak()) this.returnToDesk();
    this.updatePortrait();
    this.nameText.setText(agent.name);
    this.statusText.setText(STATUS_LABELS[agent.status])
      .setColor('#' + STATUS_COLORS[agent.status].toString(16).padStart(6, '0'));
    const width = Math.max(this.nameText.width, this.statusText.width + 18) + 20;
    this.badgeBg.clear().fillStyle(0x142c29, 0.95)
      .fillRoundedRect(this.x - width / 2, this.y - 140, width, 44, 5)
      .lineStyle(1, 0xb89c60, 0.4).strokeRoundedRect(this.x - width / 2, this.y - 140, width, 44, 5);
    this.statusDot.clear().fillStyle(STATUS_COLORS[agent.status])
      .fillCircle(this.x - Math.max(this.statusText.width, 24) / 2 - 5,
        this.statusText.y + this.statusText.height / 2, 3);
    this.desk.setTexture(this.monitorKey(false));
    this.glow.clear().fillStyle(STATUS_COLORS[agent.status], 0.5).fillCircle(0, 0, 30)
      .setVisible(this.isWorking() || agent.status === 'checkpoint');
    this.setActivity();
  }

  private isWorking(): boolean {
    return this.agent.status === 'working' || this.agent.status === 'delivering';
  }

  private canTakeBreak(): boolean {
    return this.agent.status === 'idle' || this.agent.status === 'done';
  }

  private returnToDesk(): void {
    this.visit = undefined;
    this.pendingRecipient = undefined;
    this.waveRemaining = 0;
    const seat = seatPosition({ x: this.x, y: this.y });
    this.person.setPosition(seat.x, seat.y).setDepth(this.y);
    this.avatar.setTexture(avatarKeys(this.characterName).talk)
      .setScale(this.avatarDisplayH / this.avatar.height)
      .setPosition(0, 0).setAngle(0).setFlipX(false).setAlpha(1);
    this.feet.clear().setVisible(false);
    this.shadow.clear().setVisible(false);
    this.folder.setVisible(false);
    this.coffeeBreak.setVisible(false);
    this.coffeeMug.setVisible(true);
    this.steam.clear();
    this.glow.setPosition(seat.x, seat.y).setDepth(this.y - 2);
  }

  private updatePortrait(): void {
    this.torso.setVisible(this.isWorking());
    if (this.isWorking()) {
      // Cabeça e tronco usam o mesmo retrato; só a parte superior se move.
      this.avatar.setCrop(0, 0, this.avatar.width, Math.floor(this.avatar.height * 0.74));
    } else {
      this.avatar.setCrop();
    }
  }

  private monitorKey(alternate: boolean): string {
    if (this.deskVariant === 'black')
      return this.isWorking() ? (alternate ? DESK_KEYS.blackCodingAlt : DESK_KEYS.blackCoding) : DESK_KEYS.blackIdle;
    return this.isWorking() ? (alternate ? DESK_KEYS.whiteCodingAlt : DESK_KEYS.whiteCoding) : DESK_KEYS.whiteIdle;
  }

  get isWalking(): boolean { return !!this.visit; }
  get canStroll(): boolean {
    return !this.visit && !this.waveRemaining && this.canTakeBreak();
  }

  stroll(): void {
    if (this.canStroll) this.visit = { route: visitRoute({ x: this.x, y: this.y }), elapsed: 0, greeted: false };
  }

  deliverTo(recipient: AgentSprite): void {
    if (!this.canTakeBreak() || recipient === this) return;
    // Uma atualização rápida substitui a entrega pendente, sem teletransportar a pessoa.
    if (this.visit) { this.pendingRecipient = recipient; return; }
    this.visit = { route: visitRoute({ x: this.x, y: this.y }, { x: recipient.x, y: recipient.y }), elapsed: 0, recipient, greeted: false };
  }

  playCelebration(): void {
    if (this.canTakeBreak()) this.waveRemaining = 2000;
  }

  /** Um único relógio da cena permite pausar passos, expressões e efeitos juntos. */
  animate(time: number, delta: number): void {
    const rhythm = time + this.rhythm;
    const keys = avatarKeys(this.characterName);
    let walking = false, holding = false, direction = 0, carrying = false, drinking = false;
    if (this.visit) {
      const visit = this.visit;
      visit.elapsed += delta;
      const pose = sampleVisit(visit.route, visit.elapsed, visit.recipient ? 1000 : COFFEE_PAUSE);
      this.person.setPosition(pose.x, pose.y).setDepth(pose.y + 70);
      walking = !pose.holding && !pose.complete;
      holding = pose.holding;
      direction = pose.direction;
      carrying = !!visit.recipient && !pose.returning;
      drinking = !visit.recipient;
      if (holding && !visit.greeted) {
        visit.greeted = true;
        if (visit.recipient?.canTakeBreak()) visit.recipient.waveRemaining = 1000;
      }
      if (pose.complete) {
        this.visit = undefined;
        drinking = false;
        const recipient = this.pendingRecipient;
        this.pendingRecipient = undefined;
        if (recipient) this.deliverTo(recipient);
      }
    }
    const stride = Math.sin(rhythm / 95);
    this.waveRemaining = Math.max(0, this.waveRemaining - delta);
    const waving = this.canTakeBreak() && ((holding && carrying) || this.waveRemaining > 0);
    const frame = waving ? (Math.floor(rhythm / 220) % 2 ? keys.wave1 : keys.wave2)
      : rhythm % (this.isWorking() ? 1700 : 3800) < 150 ? keys.blink : keys.talk;
    if (this.avatar.texture.key !== frame) {
      this.avatar.setTexture(frame).setScale(this.avatarDisplayH / this.avatar.height);
      this.updatePortrait();
    }
    this.avatar.setPosition(0, walking ? -Math.abs(stride) * 4
      : waving ? -Math.abs(Math.sin(rhythm / 160)) * 3
      : this.isWorking() ? Math.sin(rhythm / 340) * 0.8
      : this.canTakeBreak() ? Math.sin(rhythm / 650) * 0.7 : 0);
    this.avatar.setAngle(walking ? stride * 3 : this.isWorking() ? Math.sin(rhythm / 560) * 1.2 : 0);
    this.avatar.setFlipX(walking && direction < 0).setAlpha(this.agent.status === 'idle' ? 0.9 : 1);
    this.feet.clear().setVisible(!!this.visit);
    this.shadow.clear().setVisible(!!this.visit);
    if (this.visit) {
      const bottom = this.avatarDisplayH / 2 - 2;
      // Completa os retratos existentes com pernas em pixel art durante a caminhada.
      this.shadow.fillStyle(0x14221d, 0.22).fillEllipse(0, bottom + 15, 34, 9);
      for (const side of [-1, 1]) {
        const step = walking ? stride * side * 4 : 0;
        this.feet.fillStyle(0x28343b).fillRect(side * 7 - 4, bottom, 8, 11 + step);
        this.feet.fillStyle(0x151d23).fillRect(side * 7 - 5, bottom + 9 + step, 11, 5);
      }
    }
    this.folder.setVisible(carrying).setY(this.avatar.y);
    this.coffeeBreak.setVisible(drinking);
    this.coffeeMug.setVisible(!drinking);
    this.coffeeSteam.clear();
    if (drinking) {
      const sip = holding ? Math.max(0, Math.sin(rhythm / 480)) : 0;
      this.coffeeBreak.setY(14 - sip * 12 + this.avatar.y);
      if (holding) this.drawSteam(this.coffeeSteam, rhythm);
    }
    this.glow.setPosition(this.person.x, this.person.y).setDepth(this.person.depth - 2)
      .setScale(0.9 + Math.sin(rhythm / 550) * 0.2).setAlpha(0.28 + Math.sin(rhythm / 550) * 0.12);
    const monitor = this.monitorKey(Math.floor(rhythm / 360) % 2 === 0);
    if (this.desk.texture.key !== monitor) this.desk.setTexture(monitor);
    this.steam.clear();
    if (this.canTakeBreak() && !drinking) this.drawSteam(this.steam, rhythm);
  }

  private drawSteam(graphics: Phaser.GameObjects.Graphics, time: number): void {
    for (let i = 0; i < 3; i++) {
      const rise = ((time + i * 600) % 1800) / 1800;
      graphics.fillStyle(0xf5e7ce, (1 - rise) * 0.5)
        .fillRect(Math.sin(rise * 6 + i) * 3, -rise * 18, 2, 4);
    }
  }

  private setActivity(): void {
    const text = this.agent.activity?.trim();
    const visible = this.isWorking() && !!text;
    this.activityBg.setVisible(visible);
    this.activityText.setVisible(visible);
    if (!visible || !text) return;
    this.activityText.setText(text.length > 28 ? text.slice(0, 27) + '…' : text);
    const w = this.activityText.width + 16, h = this.activityText.height + 8;
    const bx = this.x - w / 2, by = this.activityText.y - this.activityText.height - 4;
    this.activityBg.clear().fillStyle(0x16324a, 0.95).fillRoundedRect(bx, by, w, h, 6)
      .lineStyle(1, COLORS.statusWorking, 0.7).strokeRoundedRect(bx, by, w, h, 6)
      .fillStyle(0x16324a, 0.95)
      .fillTriangle(this.x - 5, by + h - 1, this.x + 5, by + h - 1, this.x, by + h + 6);
  }

  destroy(): void {
    this.visit = undefined;
    this.pendingRecipient = undefined;
    for (const object of [this.deskTable, this.desk, this.coffeeMug, this.steam,
      this.person, this.glow, this.nameText, this.badgeBg, this.statusDot,
      this.statusText, this.activityBg, this.activityText]) object.destroy();
  }
}
