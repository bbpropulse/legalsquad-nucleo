import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { OfficeScene } from "./OfficeScene";
import type { OfficeRoom } from "../lib/officeModel";

export function PhaserGame({
  rooms,
  onSelect,
}: {
  rooms: OfficeRoom[];
  onSelect: (code: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const latest = useRef({ rooms, onSelect, motionEnabled });
  latest.current = { rooms, onSelect, motionEnabled };

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setMotionEnabled(!preference.matches);
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      antialias: false,
      roundPixels: true,
      backgroundColor: "#101d1c",
      scene: [OfficeScene],
      scale: { mode: Phaser.Scale.NONE },
    });
    gameRef.current = game;
    // O snapshot pode chegar DURANTE o preload. Repassar o último estado ao
    // create da cena fecha a corrida que antes deixava o escritório vazio.
    game.events.on("officeReady", () => {
      const scene = game.scene.getScene("OfficeScene");
      scene.events.emit("motionControl", latest.current.motionEnabled);
      scene.events.emit("officeUpdate", latest.current.rooms);
    });
    game.events.on("selectSquad", (code: string) =>
      latest.current.onSelect(code),
    );
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) game.scale.resize(width, height);
    });
    resize.observe(container);
    return () => {
      resize.disconnect();
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = gameRef.current?.scene.getScene("OfficeScene");
    if (scene?.scene.isActive()) scene.events.emit("officeUpdate", rooms);
  }, [rooms]);

  useEffect(() => {
    const scene = gameRef.current?.scene.getScene("OfficeScene");
    if (scene?.scene.isActive()) scene.events.emit("motionControl", motionEnabled);
  }, [motionEnabled]);

  const camera = (action: string) =>
    gameRef.current?.scene
      .getScene("OfficeScene")
      ?.events.emit("cameraControl", action);
  return (
    <div className="game-wrapper">
      <div
        ref={containerRef}
        className="game-canvas"
        role="img"
        aria-label="Escritório virtual com os agentes dos squads. A lista ao lado apresenta suas atividades em texto."
      />
      <div className="camera-tools" aria-label="Controles do escritório">
        <span>Arraste para explorar</span>
        <button
          className="motion-toggle"
          onClick={() => setMotionEnabled((enabled) => !enabled)}
          title="Controla os movimentos do cenário. As atividades continuam sendo atualizadas."
        >
          {motionEnabled ? "Ⅱ Pausar animações" : "▶ Retomar animações"}
        </button>
        <button onClick={() => camera("out")} aria-label="Diminuir zoom">
          −
        </button>
        <button onClick={() => camera("in")} aria-label="Aumentar zoom">
          +
        </button>
        <button onClick={() => camera("fit")} aria-label="Enquadrar escritório">
          Enquadrar
        </button>
      </div>
    </div>
  );
}
