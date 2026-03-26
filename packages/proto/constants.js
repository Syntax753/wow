// Shared constants used across all services
// Single source of truth for tile characters, actions, directions, map types, and render layers

const TILE = {
  WALL: '#',
  FLOOR: '.',
  DOOR: '+',
  PLAYER: '@',
  CORRIDOR: ':',
  STAIRS_UP: '<',
  STAIRS_DOWN: '>',
  BUSH: '"',
  FLOWERS: '*',
  ALCOVE: '\u00ac',
  CANDLE: '\u00b0',
  RUBBLE: ',',
  COBWEB: '~',
  UNKNOWN: ' ',
};

const ACTION = {
  MOVE: 'move',
  BLOCKED: 'blocked',
  OPEN_DOOR: 'open_door',
  CLOSE_DOOR: 'close_door',
  STAIRS_UP: 'stairs_up',
  STAIRS_DOWN: 'stairs_down',
  WAIT: 'wait',
  NONE: 'none',
};

const DIRECTION = {
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
};

const MAP_TYPE = {
  DUNGEON: 'dungeon',
  NATURE: 'nature',
};

const LAYER = {
  BASE: 0,
  REVEALED: 5,
  FOV: 10,
  INTERACTABLES: 20,
  SPRITES: 30,
  PLAYERS: 100,
};

const ACTION_ID = {
  OPEN: 'open',
  CLOSE: 'close',
  WAIT: 'wait',
  STAIRS_DOWN: 'stairsDown',
  STAIRS_UP: 'stairsUp',
};

const PROXIMITY = {
  DOOR: 'door',
  OPENING: 'opening',
  FLOOR: 'floor',
  STAIRS_UP: 'stairsUp',
  STAIRS_DOWN: 'stairsDown',
};

const ROOM_DESCRIPTIONS = [
  'A damp, moldy stone chamber.',
  'A forgotten armory with rusted racks.',
  'A completely bare, perfectly square room.',
  'A room smelling faintly of ozone and old blood.',
  'A ruined shrine dedicated to an unknown deity.',
  'An opulent bedroom, now thick with dust.',
  'A collapsed library with burned pages.',
  'A strange room with a geometric mosaic floor.',
];

module.exports = {
  TILE,
  ACTION,
  DIRECTION,
  MAP_TYPE,
  LAYER,
  ACTION_ID,
  PROXIMITY,
  ROOM_DESCRIPTIONS,
};
