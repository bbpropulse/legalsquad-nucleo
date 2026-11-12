import Phaser from "phaser";
import { COLORS, TILE, MARGIN, WALL_H } from "./palette";
import { FURNITURE_KEYS as F } from "./assetKeys";

/** Escritório jurídico: madeira, biblioteca, brasão e sala de atendimento. */
export class RoomBuilder {
  constructor(private scene: Phaser.Scene) {}

  build(w: number, h: number, ox = 0, oy = 0): void {
    const s = this.scene;
    const start = s.children.length;
    const g = s.add.graphics().setDepth(-2);
    g.fillStyle(0x050b0c, 0.45).fillRect(10, 12, w, h);
    g.fillStyle(COLORS.floor).fillRect(0, WALL_H, w, h - WALL_H);
    // Tábuas escalonadas mantêm a leitura de blocos do cenário.
    for (let y = WALL_H; y < h; y += TILE / 2) {
      for (let x = 0; x < w; x += TILE * 3) {
        g.fillStyle(
          (y / (TILE / 2) + x / (TILE * 3)) % 3 === 0 ? 0xb89b72 : 0xc7ab82,
        );
        g.fillRect(
          x,
          y,
          Math.min(TILE * 3, w - x) - 1,
          Math.min(TILE / 2, h - y) - 1,
        );
      }
    }
    g.fillStyle(0x233d37).fillRect(0, 0, w, WALL_H);
    g.fillStyle(0x2e4a40).fillRect(0, 0, w, WALL_H / 3);
    g.fillStyle(0x9b8050).fillRect(0, WALL_H - 6, w, 4);
    g.fillStyle(0x000000, 0.13).fillRect(0, WALL_H, w, 10);
    g.lineStyle(4, 0x526451).strokeRect(0, 0, w, h);

    const item = (x: number, y: number, key: string, scale = 1) =>
      s.add.image(x, y, key).setOrigin(0.5, 1).setScale(scale).setDepth(y + oy);
    item(w * 0.12, WALL_H, F.blindsLargeWhite, 1.5);
    item(w * 0.88, WALL_H, F.blindsLargeWhite, 1.5);
    item(w * 0.3, WALL_H + TILE, F.bookshelf, 1.1);
    item(w * 0.7, WALL_H + TILE, F.bookshelf, 1.1);
    item(w / 2, WALL_H * 0.42, F.clock, 0.8);
    // Placa de identificação, desenhada na mesma grade do mobiliário.
    const sign = s.add.graphics().setDepth(0);
    sign.fillStyle(0x162c27).fillRect(w / 2 - 65, WALL_H * 0.48, 130, 38);
    sign.lineStyle(1, 0xc6a562).strokeRect(w / 2 - 65, WALL_H * 0.48, 130, 38);
    s.add
      .text(w / 2, WALL_H * 0.65, "L E G A L S Q U A D", {
        fontFamily: "Georgia, serif",
        fontSize: "10px",
        color: "#e4cca0",
      })
      .setOrigin(0.5)
      .setDepth(1);
    s.add
      .text(w / 2, WALL_H * 0.82, "ESCRITÓRIO DE ADVOCACIA", {
        fontFamily: "Arial",
        fontSize: "6px",
        color: "#c8b789",
      })
      .setOrigin(0.5)
      .setDepth(1);
    item(MARGIN / 2, WALL_H + TILE * 2, F.monstera, 1.2);
    item(w - MARGIN / 2, WALL_H + TILE * 2, F.waterCooler, 1.3);

    const receptionY = h - TILE * 2;
    // Faixa de recepção separada da última fileira de mesas.
    g.lineStyle(1, 0x806e52, 0.35).lineBetween(
      MARGIN,
      h - TILE * 5,
      w - MARGIN,
      h - TILE * 5,
    );
    s.add
      .text(w / 2, h - TILE * 4.65, "RECEPÇÃO  ·  SALA DE REUNIÃO", {
        fontFamily: "Arial",
        fontSize: "9px",
        color: "#655137",
      })
      .setOrigin(0.5)
      .setDepth(0);
    s.add
      .image(w / 2, receptionY, F.fancyRugWide)
      .setScale(0.6, 0.4)
      .setDepth(-1);
    item(w / 2, receptionY, F.couchTanDown, 1.4);
    item(w / 2 - TILE * 3, receptionY + TILE / 2, F.armchairTanDown, 1.4);
    item(w / 2 + TILE * 3, receptionY + TILE / 2, F.armchairTanDown, 1.4);
    item(w / 2, receptionY + TILE, F.coffeeTable, 1.2);
    item(w / 2 + TILE / 3, receptionY + TILE * 0.8, F.coffeeMugBlue, 0.9);
    item(MARGIN / 2, h - TILE / 2, F.plant3, 1.5);
    item(w - MARGIN / 2, h - TILE / 2, F.plantPoof, 1.5);

    for (const object of s.children.list.slice(start)) {
      const positioned = object as Phaser.GameObjects.Image;
      positioned.x += ox;
      positioned.y += oy;
    }
  }
}
