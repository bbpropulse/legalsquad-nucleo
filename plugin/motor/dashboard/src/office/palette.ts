// Cores dos estados e materiais do escritório; dimensões em pixels da cena.

export const COLORS = {
  // Status badge dots
  statusIdle: 0x97aea7,
  statusWorking: 0x92c9b5,
  statusDone: 0xa3bd79,
  statusCheckpoint: 0xdfbb77,

  // Name badge
  nameCardBg: 0x14141c,
  nameCardText: 0xffffff,

  // Background
  background: 0x1a1420,

  // Floor fill (warm wood)
  floor: 0xc8ac86,
  floorAlt: 0xbca07a,

  // Wall fill
  wall: 0xe6dace,
  wallTrim: 0xa89888,
} as const;

// Layout constants
export const TILE = 32; // Base tile size in pixels
export const CELL_W = 180; // mesa, identificação e intervalo lateral
export const CELL_H = 176; // fileira com avatar e balão de atividade
export const MARGIN = 3 * TILE; // 96px — room edge margin (more breathing room)
export const WALL_H = 3 * TILE; // 96px — wall strip height (taller for decorations)
