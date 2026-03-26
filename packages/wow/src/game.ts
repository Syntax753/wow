// Game state types and map rendering logic

export const TILE = {
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
  UNKNOWN: ' ',
} as const;

export interface Position {
  x: number;
  y: number;
}

export interface Room {
  x: number;
  y: number;
  width: number;
  height: number;
  description: string;
  doors: Position[];
}

export interface Corridor {
  tiles: Position[];
  direction: string;
  description: string;
}

export interface Enemy {
  id: string;
  type: string;
  char: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export interface GameState {
  tiles: Record<string, string>;
  player: Position;
  rooms: Room[];
  corridors: Corridor[];
  enemies: Enemy[];
  level: number;
  messages: LogEntry[];
  exploredDoors: Set<string>;
}

export interface LogEntry {
  text: string;
  type: 'info' | 'action' | 'discovery' | 'combat' | 'system';
  source?: string;
  timestamp: number;
}

export function createInitialState(): GameState {
  return {
    tiles: {},
    player: { x: 0, y: 0 },
    rooms: [],
    corridors: [],
    enemies: [],
    level: 1,
    messages: [
      {
        text: 'The darkness surrounds you. A dungeon is forming...',
        type: 'system',
        timestamp: Date.now(),
      },
    ],
    exploredDoors: new Set(),
  };
}

function placeRoom(
  tiles: Record<string, string>,
  x: number,
  y: number,
  width: number,
  height: number
): Room {
  const room: Room = { x, y, width, height, description: '', doors: [] };

  for (let ry = y; ry < y + height; ry++) {
    for (let rx = x; rx < x + width; rx++) {
      if (ry === y || ry === y + height - 1 || rx === x || rx === x + width - 1) {
        tiles[`${rx},${ry}`] = TILE.WALL;
      } else {
        tiles[`${rx},${ry}`] = TILE.FLOOR;
      }
    }
  }
  return room;
}

export function movePlayer(
  state: GameState,
  dx: number,
  dy: number
): { state: GameState; hitDoor: Position | null } {
  const newX = state.player.x + dx;
  const newY = state.player.y + dy;

  const targetTile = state.tiles[`${newX},${newY}`] || TILE.UNKNOWN;

  // Can't walk through walls or unknown space
  if (targetTile === TILE.WALL || targetTile === TILE.UNKNOWN) {
    return { state, hitDoor: null };
  }

  // Check if stepping onto a door
  let hitDoor: Position | null = null;
  if (targetTile === TILE.DOOR || targetTile === '+') {
    hitDoor = { x: newX, y: newY };
  }

  // Move player — no tile mutation needed; player.x/y is the source of truth
  return {
    state: {
      ...state,
      player: { x: newX, y: newY },
    },
    hitDoor,
  };
}

export function addRoom(
  state: GameState,
  doorPos: Position,
  width: number,
  height: number,
  description: string,
  doors?: { x: number; y: number }[],
  originX?: number,
  originY?: number,
  newTilesStr?: string
): GameState {
  // Always start from current map state — merge returned tiles ON TOP so existing explored tiles are preserved
  let newTiles = { ...state.tiles };

  if (newTilesStr) {
    try {
      const returned = JSON.parse(newTilesStr) as Record<string, string>;
      // Merge returned tiles over current state (new beats old for structural accuracy)
      newTiles = { ...newTiles, ...returned };
    } catch (e) {
      console.error('Failed to parse newTiles JSON', e);
    }
  }

  let roomX: number, roomY: number;
  let direction: string | undefined;

  if (originX !== undefined && originY !== undefined) {
    roomX = originX;
    roomY = originY;
  } else {
    // Legacy fallback
    direction = 'N';
    for (const room of state.rooms) {
      if (doorPos.y === room.y) direction = 'N';
      else if (doorPos.y === room.y + room.height - 1) direction = 'S';
      else if (doorPos.x === room.x) direction = 'W';
      else if (doorPos.x === room.x + room.width - 1) direction = 'E';
    }

    const corridorLength = 3;
    switch (direction) {
      case 'N':
        roomX = doorPos.x - Math.floor(width / 2);
        roomY = doorPos.y - corridorLength - height;
        for (let i = 1; i <= corridorLength; i++) {
          newTiles[`${doorPos.x},${doorPos.y - i}`] = TILE.CORRIDOR;
        }
        break;
      case 'S':
        roomX = doorPos.x - Math.floor(width / 2);
        roomY = doorPos.y + corridorLength + 1;
        for (let i = 1; i <= corridorLength; i++) {
          newTiles[`${doorPos.x},${doorPos.y + i}`] = TILE.CORRIDOR;
        }
        break;
      case 'E':
        roomX = doorPos.x + corridorLength + 1;
        roomY = doorPos.y - Math.floor(height / 2);
        for (let i = 1; i <= corridorLength; i++) {
          newTiles[`${doorPos.x + i},${doorPos.y}`] = TILE.CORRIDOR;
        }
        break;
      case 'W':
        roomX = doorPos.x - corridorLength - width;
        roomY = doorPos.y - Math.floor(height / 2);
        for (let i = 1; i <= corridorLength; i++) {
          newTiles[`${doorPos.x - i},${doorPos.y}`] = TILE.CORRIDOR;
        }
        break;
      default:
        roomX = doorPos.x;
        roomY = doorPos.y - height - 2;
    }

    roomX = roomX;
    roomY = roomY;
  }

  let newRoom: Room;
  if (newTilesStr && originX !== undefined && originY !== undefined) {
    newRoom = {
      x: roomX, y: roomY, width, height, description,
      doors: doors ? doors.map(d => ({ x: roomX + d.x, y: roomY + d.y })) : []
    };
  } else {
    newRoom = placeRoom(newTiles, roomX, roomY, width, height);
    newRoom.description = description;

    if (originX === undefined) {
      const revDoor = getReverseDoorPosition(direction || 'N', roomX, roomY, width, height, doorPos);
      if (revDoor) {
        newTiles[`${revDoor.x},${revDoor.y}`] = TILE.DOOR;
        newRoom.doors.push(revDoor);
      }
    }

    // Iterate over incoming doors from API and place them
    if (doors) {
      for (const d of doors) {
        const dbX = roomX + d.x;
        const dbY = roomY + d.y;
        
        if (newTiles[`${dbX},${dbY}`] === TILE.WALL) {
          newTiles[`${dbX},${dbY}`] = TILE.DOOR;
          newRoom.doors.push({ x: dbX, y: dbY });
        }
      }
    }
  }

  // Restore player
  newTiles[`${state.player.x},${state.player.y}`] = TILE.PLAYER;

  return {
    ...state,
    tiles: newTiles,
    rooms: [...state.rooms, newRoom],
  };
}

function getReverseDoorPosition(
  direction: string,
  roomX: number,
  roomY: number,
  width: number,
  height: number,
  _doorPos: Position,
): Position | null {
  switch (direction) {
    case 'N':
      return { x: roomX + Math.floor(width / 2), y: roomY + height - 1 };
    case 'S':
      return { x: roomX + Math.floor(width / 2), y: roomY };
    case 'E':
      return { x: roomX, y: roomY + Math.floor(height / 2) };
    case 'W':
      return { x: roomX + width - 1, y: roomY + Math.floor(height / 2) };
    default:
      return null;
  }
}

export function renderMap(_tiles: Record<string, string>): string {
  // Infinite map representation isn't meaningful to serialize explicitly, return empty
  return '';
}

export function getTileClass(ch: string): string {
  switch (ch) {
    case TILE.WALL: return 'ch-wall';
    case TILE.FLOOR: return 'ch-floor';
    case TILE.DOOR: return 'ch-door';
    case TILE.PLAYER: return 'ch-player';
    case TILE.CORRIDOR: return 'ch-corridor';
    case TILE.STAIRS_UP: return 'ch-stairs';
    case TILE.STAIRS_DOWN: return 'ch-stairs';
    case TILE.BUSH: return 'ch-bush';
    case TILE.FLOWERS: return 'ch-flowers';
    case TILE.ALCOVE: return 'ch-alcove';
    case TILE.CANDLE: return 'ch-candle';
    default: return 'ch-unknown';
  }
}

/** Serialize the game state — world-service owns tiles/rooms, so we only send player info */
export function serializeWorldState(state: GameState) {
  return {
    level: state.level,
    playerX: state.player.x,
    playerY: state.player.y,
    currentEnemiesJson: JSON.stringify(state.enemies),
  };
}
