import Phaser from 'phaser';
import { avatarKeys, DESK_KEYS, FURNITURE_KEYS, type CharacterName } from './assetKeys';
import { COLORS } from './palette';
import type { Agent, AgentStatus } from '@/types/state';

// Avatar display scale — characters should be prominent at desk
const AVATAR_SCALE = 0.8;

// Status → badge color mapping
const STATUS_COLORS: Record<AgentStatus, number> = {
  idle: COLORS.statusIdle,
  working: COLORS.statusWorking,
  done: COLORS.statusDone,
  checkpoint: COLORS.statusCheckpoint,
  delivering: COLORS.statusWorking,
};

// Status → display label (PT — clareza para o usuário advogado)
const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'aguardando',
  working: 'trabalhando',
  done: 'concluído',
  checkpoint: 'aprovação',
  delivering: 'entregando',
};

export class AgentSprite {
  private scene: Phaser.Scene;
  private x: number;
  private y: number;
  private agent: Agent;
  private deskTable: Phaser.GameObjects.Image;
  private deskShadow: Phaser.GameObjects.Graphics;
  private desk: Phaser.GameObjects.Image;
  private coffeeMug: Phaser.GameObjects.Image;
  private avatar: Phaser.GameObjects.Image;
  private glow: Phaser.GameObjects.Graphics;
  private glowTween?: Phaser.Tweens.Tween;
  private nameText: Phaser.GameObjects.Text;
  private badgeBg: Phaser.GameObjects.Graphics;
  private statusDot: Phaser.GameObjects.Graphics;
  private statusText: Phaser.GameObjects.Text;
  private activityBg: Phaser.GameObjects.Graphics;
  private activityText: Phaser.GameObjects.Text;
  private animTimer?: Phaser.Time.TimerEvent;
  private characterName: CharacterName;
  private deskVariant: 'black' | 'white';
  private avatarDisplayH: number = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    characterName: CharacterName,
    deskVariant: 'black' | 'white',
    agent: Agent,
  ) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.agent = agent;
    this.characterName = characterName;
    this.deskVariant = deskVariant;

    // Activity glow — pulsing aura BEHIND the avatar (depth y-2). Conveys "this
    // agent is active right now" without recreating sprites on each update.
    this.glow = scene.add.graphics().setPosition(x, y - 70).setDepth(y - 2).setVisible(false);

    // Avatar — positioned further behind the desk so head/torso is clearly visible
    const avatarKey = avatarKeys(characterName).talk;
    this.avatar = scene.add.image(x, y - 70, avatarKey)
      .setOrigin(0.5, 0.5)
      .setScale(AVATAR_SCALE)
      .setDepth(y);
    this.avatarDisplayH = this.avatar.displayHeight;

    // Desk table surface — renders IN FRONT of avatar (covers lower body)
    this.deskTable = scene.add.image(x, y, FURNITURE_KEYS.deskWood)
      .setOrigin(0.5, 0.5).setScale(1.3).setDepth(y + 1);

    // Monitor — screen-facing, sits on desk surface
    this.desk = scene.add.image(x, y - 30, this.getDeskKey())
      .setOrigin(0.5, 0.5).setScale(1.3).setDepth(y + 2);

    // Coffee mug — right side of desk, away from monitor
    this.coffeeMug = scene.add.image(x + 42, y + 8, 'furniture_coffee_mug')
      .setOrigin(0.5, 1).setScale(1.4).setDepth(y + 3);

    // Shadow (unused graphics object kept for destroy() compatibility)
    this.deskShadow = scene.add.graphics();
    this.deskShadow.setDepth(y - 1);

    const labelY = y - 140;

    this.badgeBg = scene.add.graphics();

    this.nameText = scene.add.text(x, labelY + 5, agent.name, {
      fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
      fontSize: '16px', fontStyle: 'bold', color: '#ffffff', align: 'center',
      stroke: '#000000', strokeThickness: 4, resolution: 2,
    }).setOrigin(0.5, 0);
    this.nameText.setDepth(901);

    this.statusDot = scene.add.graphics();

    this.statusText = scene.add.text(x, labelY + 24, STATUS_LABELS[agent.status], {
      fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
      fontSize: '13px', fontStyle: 'bold', color: this.getStatusHexColor(agent.status),
      align: 'center', stroke: '#000000', strokeThickness: 3, resolution: 2,
    }).setOrigin(0.5, 0);
    this.statusText.setDepth(901);

    this.drawLabelBackground(x, labelY);
    this.redrawStatusDot(agent.status);

    // Activity bubble — "what is this agent doing right now" (above the name badge)
    this.activityBg = scene.add.graphics().setDepth(902).setVisible(false);
    this.activityText = scene.add.text(x, labelY - 6, '', {
      fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
      fontSize: '12px', fontStyle: 'italic', color: '#dfeaff', align: 'center',
      stroke: '#000000', strokeThickness: 3, resolution: 2,
    }).setOrigin(0.5, 1).setDepth(903).setVisible(false);

    this.applyStatus(agent.status);
    this.setActivity(agent);
  }

  // Incremental update — no sprite recreation. Only re-applies what changed.
  update(agent: Agent): void {
    if (agent.status !== this.agent.status) {
      this.statusText.setText(STATUS_LABELS[agent.status]);
      this.statusText.setColor(this.getStatusHexColor(agent.status));
      this.redrawStatusDot(agent.status);
      this.applyStatus(agent.status);
    }
    if (agent.name !== this.agent.name) {
      this.nameText.setText(agent.name);
    }
    this.setActivity(agent);
    this.agent = agent;
  }

  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private getStatusHexColor(status: AgentStatus): string {
    const num = STATUS_COLORS[status] ?? COLORS.statusIdle;
    return '#' + num.toString(16).padStart(6, '0');
  }

  private getDeskKey(): string {
    return this.deskVariant === 'black' ? DESK_KEYS.blackCoding : DESK_KEYS.whiteCoding;
  }

  private drawLabelBackground(x: number, labelY: number): void {
    const nameW = Math.max(this.nameText.width, this.statusText.width + 18);
    const bgW = nameW + 20;
    const bgH = 44;
    this.badgeBg.fillStyle(0x1a1225, 0.95);
    this.badgeBg.fillRoundedRect(x - bgW / 2, labelY, bgW, bgH, 5);
    this.badgeBg.lineStyle(1, 0x6a5a80, 0.4);
    this.badgeBg.strokeRoundedRect(x - bgW / 2, labelY, bgW, bgH, 4);
    this.badgeBg.setDepth(900);
  }

  private redrawStatusDot(status: AgentStatus): void {
    const dotColor = STATUS_COLORS[status] ?? COLORS.statusIdle;
    const textW = Math.max(this.statusText.width, 24);
    this.statusDot.clear();
    this.statusDot.fillStyle(dotColor, 1);
    this.statusDot.fillCircle(this.x - textW / 2 - 5, this.statusText.y + this.statusText.height / 2, 3);
    this.statusDot.setDepth(901);
  }

  private setAvatarFrame(key: string): void {
    this.avatar.setTexture(key);
    this.avatar.setScale(this.avatarDisplayH / this.avatar.height);
  }

  // Drives the avatar animation + glow per status — the heart of "claro com charme".
  private applyStatus(status: AgentStatus): void {
    this.animTimer?.remove();
    this.animTimer = undefined;
    const keys = avatarKeys(this.characterName);

    if (status === 'working' || status === 'delivering') {
      // Active: quick talk↔blink cycle (looks like typing) + blue pulsing glow
      let frame = 0;
      this.animTimer = this.scene.time.addEvent({
        delay: 420, loop: true,
        callback: () => { frame = (frame + 1) % 2; this.setAvatarFrame(frame === 0 ? keys.talk : keys.blink); },
      });
      this.avatar.setAlpha(1);
      this.setGlow(COLORS.statusWorking);
    } else if (status === 'checkpoint') {
      // Waiting for the human: still, but pulsing amber to draw the eye
      this.setAvatarFrame(keys.talk);
      this.avatar.setAlpha(1);
      this.setGlow(COLORS.statusCheckpoint);
    } else if (status === 'done') {
      // Finished: calm and content, no pulse
      this.setAvatarFrame(keys.talk);
      this.avatar.setAlpha(1);
      this.setGlow(null);
    } else {
      // idle: mostly still, an occasional blink; slightly dimmed to read as inactive
      this.setAvatarFrame(keys.blink);
      this.avatar.setAlpha(0.82);
      let on = false;
      this.animTimer = this.scene.time.addEvent({
        delay: 2600, loop: true,
        callback: () => { on = !on; this.setAvatarFrame(on ? keys.talk : keys.blink); },
      });
      this.setGlow(null);
    }
  }

  // Shows a small bubble with the agent's current activity, only while active.
  private setActivity(agent: Agent): void {
    const active = agent.status === 'working' || agent.status === 'delivering';
    const text = agent.activity?.trim();
    if (!active || !text) {
      this.activityBg.setVisible(false);
      this.activityText.setVisible(false);
      return;
    }
    this.activityText.setText(this.shortActivity(text)).setVisible(true);
    const w = this.activityText.width + 16;
    const h = this.activityText.height + 8;
    const bx = this.x - w / 2;
    const by = this.activityText.y - this.activityText.height - 4;
    this.activityBg.clear();
    this.activityBg.fillStyle(0x16324a, 0.95);
    this.activityBg.fillRoundedRect(bx, by, w, h, 6);
    this.activityBg.lineStyle(1, COLORS.statusWorking, 0.7);
    this.activityBg.strokeRoundedRect(bx, by, w, h, 6);
    this.activityBg.fillStyle(0x16324a, 0.95);
    this.activityBg.fillTriangle(this.x - 5, by + h - 1, this.x + 5, by + h - 1, this.x, by + h + 6);
    this.activityBg.setVisible(true);
  }

  private shortActivity(text: string): string {
    return text.length > 28 ? text.slice(0, 27) + '…' : text;
  }

  // One-shot wave when the squad finishes — the team celebrates (charm).
  playCelebration(): void {
    const keys = avatarKeys(this.characterName);
    this.animTimer?.remove();
    let n = 0;
    this.animTimer = this.scene.time.addEvent({
      delay: 260, loop: true,
      callback: () => {
        this.setAvatarFrame(n % 2 === 0 ? keys.wave1 : keys.wave2);
        n++;
        if (n >= 8) {
          this.animTimer?.remove();
          this.applyStatus(this.agent.status);
        }
      },
    });
  }

  private setGlow(color: number | null): void {
    this.glowTween?.remove();
    this.glowTween = undefined;
    this.glow.clear();
    if (color === null) {
      this.glow.setVisible(false);
      return;
    }
    this.glow.setVisible(true);
    this.glow.fillStyle(color, 0.5);
    this.glow.fillCircle(0, 0, 30);
    this.glow.setScale(0.8).setAlpha(0.4);
    this.glowTween = this.scene.tweens.add({
      targets: this.glow,
      scale: { from: 0.75, to: 1.25 },
      alpha: { from: 0.45, to: 0.12 },
      duration: 950, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  destroy(): void {
    this.animTimer?.remove();
    this.glowTween?.remove();
    this.deskTable.destroy();
    this.deskShadow.destroy();
    this.desk.destroy();
    this.coffeeMug.destroy();
    this.avatar.destroy();
    this.glow.destroy();
    this.nameText.destroy();
    this.badgeBg.destroy();
    this.statusDot.destroy();
    this.statusText.destroy();
    this.activityBg.destroy();
    this.activityText.destroy();
  }
}
