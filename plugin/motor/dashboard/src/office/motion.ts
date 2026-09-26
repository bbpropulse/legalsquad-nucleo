import { CELL_H, CELL_W } from './palette.ts';

export interface Point { x: number; y: number }
export const SEAT_OFFSET = 70;
const WALK_SPEED = 125; // pixels do cenário por segundo, independente do zoom/FPS
const VISIT_PAUSE = 1000;

export function seatPosition(desk: Point): Point {
  return { x: desk.x, y: desk.y - SEAT_OFFSET };
}

/** Saída lateral e corredor à frente das mesas; nunca corta o tampo. */
export function visitRoute(from: Point, to?: Point): Point[] {
  const start = seatPosition(from);
  const aisleX = from.x + CELL_W / 2;
  const corridorY = from.y + CELL_H / 2 - 24;
  const route = [start, { x: aisleX, y: start.y }, { x: aisleX, y: corridorY }];
  if (to) {
    // A mesma lateral em todas as fileiras mantém o trajeto no corredor vertical.
    const targetAisle = to.x + CELL_W / 2;
    route.push(
      { x: targetAisle, y: corridorY },
      { x: targetAisle, y: to.y - SEAT_OFFSET },
      { x: to.x + 48, y: to.y - SEAT_OFFSET },
    );
  } else {
    route.push({ x: from.x, y: corridorY });
  }
  return route.filter((p, i) => !i || p.x !== route[i - 1].x || p.y !== route[i - 1].y);
}

/** Ida, breve parada e volta exata à mesa. Não altera o estado do agente. */
export function sampleVisit(route: Point[], elapsed: number, pauseMs = VISIT_PAUSE) {
  const lengths = route.slice(1).map((p, i) => Math.hypot(p.x - route[i].x, p.y - route[i].y));
  const distance = lengths.reduce((sum, length) => sum + length, 0);
  const legMs = distance / WALK_SPEED * 1000;
  const returning = elapsed >= legMs + pauseMs;
  const holding = elapsed >= legMs && !returning;
  const complete = elapsed >= legMs * 2 + pauseMs;
  let remaining = Math.max(0, Math.min(distance,
    returning ? distance - (elapsed - legMs - pauseMs) / 1000 * WALK_SPEED : elapsed / 1000 * WALK_SPEED));
  let position = { ...route[0] };
  let direction = 0;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i];
    if (remaining <= length && length > 0) {
      const a = route[i], b = route[i + 1];
      position = { x: a.x + (b.x - a.x) * remaining / length, y: a.y + (b.y - a.y) * remaining / length };
      direction = Math.sign(b.x - a.x) * (returning ? -1 : 1);
      break;
    }
    remaining -= length;
    position = { ...route[i + 1] };
  }
  return { ...position, direction, holding, returning, complete };
}
