const grpc = require('@grpc/grpc-js');
const { WorldService, createLogger } = require('@wow/proto');

const log = createLogger('WorldService');
const PORT = process.env.WORLD_SERVICE_PORT || 50060;

// ── Authoritative world state (in-memory, per dungeon level) ──────────
// Each level is stored independently so multiple players can be on different levels.
const levelStates = new Map(); // level → { tiles, tileColors, rooms }
let revealedTilesPerPlayer = {};  // { [playerId]: Set of "x,y" coords }

// Active level accessors — delegates to per-level storage
let activeLevel = 0;

function getLevelState(level) {
  const lvl = level ?? activeLevel;
  if (!levelStates.has(lvl)) {
    levelStates.set(lvl, { tiles: {}, tileColors: {}, rooms: [] });
  }
  return levelStates.get(lvl);
}

// Backward-compatible globals that proxy to active level
// These are used throughout the file — we redefine them as getters
let worldTiles = {};
let worldTileColors = {};
let worldRooms = [];

function setActiveLevel(level) {
  activeLevel = level;
  const state = getLevelState(level);
  worldTiles = state.tiles;
  worldTileColors = state.tileColors;
  worldRooms = state.rooms;
}

function syncBackToLevel() {
  const state = getLevelState(activeLevel);
  state.tiles = worldTiles;
  state.tileColors = worldTileColors;
  state.rooms = worldRooms;
}

// ── MapType Configuration ────────────────────────────────────────────
const MAP_TYPES = {
  nature: {
    name: 'Nature',
    width: 120,   // max bounds — actual size computed dynamically
    height: 90,
    maxRooms: 3,
    minRoomSize: 8,
    maxRoomSize: 14,
    floorColor: '#4a7c59',
    wallColor: '#8B7355',
    corridorColor: '#6b8f5e',
    doorColor: '#c9a959',
    stairsUp: 0,
    stairsDown: 1,
    hasCorridors: false,
  },
  dungeon: {
    name: 'Dungeon',
    width: 120,   // max bounds
    height: 90,
    maxRooms: 12,
    minRoomSize: 4,
    maxRoomSize: 10,
    floorColor: '#374151',
    wallColor: '#6b7280',
    corridorColor: '#4b5563',
    doorColor: '#ca8a04',
    stairsUp: 2,
    stairsDown: 2,
    hasCorridors: true,
  },
};

// ── Deterministic tile color variation ─────────────────────────────────
// Uses prime-based hash of world coordinates to produce subtle tint shifts.
// Same (x,y) always produces the same variation, so revisiting rooms is consistent.
const VARIATION_RANGE = 18; // max +/- shift per RGB channel
const PRIME_X = 73856093;
const PRIME_Y = 19349663;
const PRIME_MIX = 83492791;

function _varyColor(hexColor, coord) {
  const [x, y] = coord.split(',').map(Number);
  // Hash world coordinates with primes — deterministic per tile
  const hash = Math.abs((x * PRIME_X) ^ (y * PRIME_Y) ^ ((x + y) * PRIME_MIX));
  // Extract 3 independent offsets from the hash for R, G, B
  const rOff = (hash % (VARIATION_RANGE * 2 + 1)) - VARIATION_RANGE;
  const gOff = (Math.floor(hash / 37) % (VARIATION_RANGE * 2 + 1)) - VARIATION_RANGE;
  const bOff = (Math.floor(hash / 1369) % (VARIATION_RANGE * 2 + 1)) - VARIATION_RANGE;
  // Parse base hex color and apply offsets, clamping to 0-255
  const r = Math.max(0, Math.min(255, parseInt(hexColor.slice(1, 3), 16) + rOff));
  const g = Math.max(0, Math.min(255, parseInt(hexColor.slice(3, 5), 16) + gOff));
  const b = Math.max(0, Math.min(255, parseInt(hexColor.slice(5, 7), 16) + bOff));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ── BSP Level Generation Classes ─────────────────────────────────────

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

/**
 * BSP tree node — represents a partitioned rectangular area.
 * Internal nodes have left/right children. Leaf nodes hold a Room.
 */
class BSPNode {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.left = null;    // BSPNode
    this.right = null;   // BSPNode
    this.room = null;    // Room (only on leaves)
    this.region = null;  // string — inherited by rooms
  }

  isLeaf() {
    return !this.left && !this.right;
  }

  /** Collect all rooms in this subtree */
  getRooms() {
    if (this.isLeaf()) return this.room ? [this.room] : [];
    return [...(this.left?.getRooms() || []), ...(this.right?.getRooms() || [])];
  }

  /** Get a random room from this subtree */
  getRandomRoom() {
    const rooms = this.getRooms();
    return rooms[Math.floor(Math.random() * rooms.length)] || null;
  }
}

/**
 * Represents a room within a BSP leaf partition.
 */
class Room {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.region = null;
    this.description = ROOM_DESCRIPTIONS[Math.floor(Math.random() * ROOM_DESCRIPTIONS.length)];
  }

  center() {
    return {
      x: this.x + Math.floor(this.width / 2),
      y: this.y + Math.floor(this.height / 2),
    };
  }

  isWall(wx, wy) {
    if (wx < this.x || wx >= this.x + this.width) return false;
    if (wy < this.y || wy >= this.y + this.height) return false;
    return wx === this.x || wx === this.x + this.width - 1 ||
           wy === this.y || wy === this.y + this.height - 1;
  }

  randomInteriorPoint() {
    return {
      x: this.x + 1 + Math.floor(Math.random() * Math.max(1, this.width - 2)),
      y: this.y + 1 + Math.floor(Math.random() * Math.max(1, this.height - 2)),
    };
  }

  writeTiles(tiles) {
    for (let r = this.y; r < this.y + this.height; r++) {
      for (let c = this.x; c < this.x + this.width; c++) {
        if (r === this.y || r === this.y + this.height - 1 ||
            c === this.x || c === this.x + this.width - 1) {
          tiles[`${c},${r}`] = '#';
        } else {
          tiles[`${c},${r}`] = '.';
        }
      }
    }
  }

  toJSON() {
    return {
      x: this.x, y: this.y, width: this.width, height: this.height,
      description: this.description, region: this.region,
    };
  }
}

/**
 * Carves an L-shaped corridor between two rooms, placing doors where it crosses room walls.
 */
class Corridor {
  constructor(roomA, roomB) {
    this.roomA = roomA;
    this.roomB = roomB;
  }

  /**
   * @param {boolean} walled — if true, carve a 3-wide corridor with walls on sides.
   *                           if false, carve just floor tiles (open-air path).
   */
  carve(tiles, allRooms, corridorTiles, walled = true) {
    const a = this.roomA.randomInteriorPoint();
    const b = this.roomB.randomInteriorPoint();

    // Randomly choose horizontal-first or vertical-first
    const hFirst = Math.random() < 0.5;
    if (hFirst) {
      this._carveSegmentH(tiles, allRooms, a.x, b.x, a.y, corridorTiles, walled);
      this._carveSegmentV(tiles, allRooms, a.y, b.y, b.x, corridorTiles, walled);
    } else {
      this._carveSegmentV(tiles, allRooms, a.y, b.y, a.x, corridorTiles, walled);
      this._carveSegmentH(tiles, allRooms, a.x, b.x, b.y, corridorTiles, walled);
    }
  }

  _carveSegmentH(tiles, allRooms, x1, x2, y, corridorTiles, walled) {
    const step = x1 <= x2 ? 1 : -1;
    for (let x = x1; x !== x2 + step; x += step) {
      this._carveTile(tiles, allRooms, x, y, corridorTiles);
      if (walled) {
        // Walls on both sides of the corridor
        this._carveWall(tiles, allRooms, x, y - 1);
        this._carveWall(tiles, allRooms, x, y + 1);
      }
    }
  }

  _carveSegmentV(tiles, allRooms, y1, y2, x, corridorTiles, walled) {
    const step = y1 <= y2 ? 1 : -1;
    for (let y = y1; y !== y2 + step; y += step) {
      this._carveTile(tiles, allRooms, x, y, corridorTiles);
      if (walled) {
        // Walls on both sides of the corridor
        this._carveWall(tiles, allRooms, x - 1, y);
        this._carveWall(tiles, allRooms, x + 1, y);
      }
    }
  }

  /** Place a wall tile if the space is empty (don't overwrite floor, doors, or existing walls) */
  _carveWall(tiles, allRooms, x, y) {
    const key = `${x},${y}`;
    const existing = tiles[key];
    if (existing && existing !== ' ') return; // don't overwrite anything
    tiles[key] = '#';
  }

  _carveTile(tiles, allRooms, x, y, corridorTiles) {
    const key = `${x},${y}`;
    const existing = tiles[key];
    if (existing === '.' || existing === '+') return; // don't overwrite floor/doors

    // Check if this is a room wall
    for (const room of allRooms) {
      if (room.isWall(x, y)) {
        tiles[key] = '+'; // door where corridor meets room wall
        return;
      }
    }
    tiles[key] = '.'; // corridor floor
    if (corridorTiles) corridorTiles.push(key);
  }
}

/**
 * DungeonMap — binary tree (BSP) that partitions the level area.
 * Owns the tile grid, room list, and BSP tree.
 */
class DungeonMap {
  constructor(width, height, gridSize = 2) {
    this.width = width;
    this.height = height;
    this.gridSize = gridSize;
    this.tiles = {};
    this.tileColors = {};
    this.rooms = [];
    this.root = null; // BSPNode — root of the binary tree
    this.mapTypeConfig = null; // resolved MAP_TYPES entry
  }

  /**
   * Generate a full level using BSP.
   * @param {number} requiredRooms - target number of rooms
   * @param {number} minRoomSize - minimum room dimension
   * @param {number} maxRoomSize - maximum room dimension
   * @param {string[]} regions - region types to assign to subtrees
   * @param {object} mapTypeConfig - resolved MAP_TYPES config (colors, stairs)
   */
  generate(requiredRooms, minRoomSize, maxRoomSize, regions, mapTypeConfig) {
    this.mapTypeConfig = mapTypeConfig || MAP_TYPES.dungeon;
    const originX = -Math.floor(this.width / 2);
    const originY = -Math.floor(this.height / 2);

    // Phase 1: Build BSP tree
    this.root = new BSPNode(originX, originY, this.width, this.height);
    this._splitBSP(this.root, requiredRooms, minRoomSize);

    // Phase 2: Place rooms in leaf nodes
    this._placeRooms(this.root, minRoomSize, maxRoomSize);

    // Phase 3: Snap to grid
    this._snapToGrid(minRoomSize);

    // Phase 3b: If no corridors (outdoor), fill entire area with floor first
    if (this.mapTypeConfig?.hasCorridors === false) {
      const originX = -Math.floor(this.width / 2);
      const originY = -Math.floor(this.height / 2);
      for (let y = originY; y < originY + this.height; y++) {
        for (let x = originX; x < originX + this.width; x++) {
          this.tiles[`${x},${y}`] = '.';
        }
      }
    }

    // Phase 4: Write room tiles (on top of floor for outdoor maps)
    for (const room of this.rooms) {
      room.writeTiles(this.tiles);
    }

    // Phase 5: Assign regions
    this._assignRegions(this.root, regions);

    // Phase 6: Connect siblings with corridors
    this._connectBSP(this.root);

    // Phase 6b: Ensure every room has at least one door or exit
    this._ensureRoomExits();

    // Phase 7: Apply tile colors from MapType
    this._applyColors();

    // Phase 8: Place staircases
    this._placeStairs();

    log.debug(`BSP generated: ${this.rooms.length} rooms in ${this.width}x${this.height} area`);
  }

  /** Ensure every room has at least one door or open exit on its perimeter */
  _ensureRoomExits() {
    for (const room of this.rooms) {
      const { x, y, width, height } = room;

      // Collect all wall positions and check for existing exits
      const wallPositions = [];
      let hasExit = false;

      for (let c = x + 1; c < x + width - 1; c++) {
        // Top wall
        const top = this.tiles[`${c},${y}`];
        if (top === '+' || top === '.') { hasExit = true; break; }
        wallPositions.push({ x: c, y: y });
        // Bottom wall
        const bot = this.tiles[`${c},${y + height - 1}`];
        if (bot === '+' || bot === '.') { hasExit = true; break; }
        wallPositions.push({ x: c, y: y + height - 1 });
      }

      if (!hasExit) {
        for (let r = y + 1; r < y + height - 1; r++) {
          // Left wall
          const left = this.tiles[`${x},${r}`];
          if (left === '+' || left === '.') { hasExit = true; break; }
          wallPositions.push({ x: x, y: r });
          // Right wall
          const right = this.tiles[`${x + width - 1},${r}`];
          if (right === '+' || right === '.') { hasExit = true; break; }
          wallPositions.push({ x: x + width - 1, y: r });
        }
      }

      if (hasExit || wallPositions.length === 0) continue;

      // No exit found — place a door on a random wall position
      const pos = wallPositions[Math.floor(Math.random() * wallPositions.length)];
      this.tiles[`${pos.x},${pos.y}`] = '+';
      log.debug(`Added missing door to room at ${x},${y}: door at ${pos.x},${pos.y}`);
    }
  }

  /** Apply MapType colors to all tiles with deterministic tint variation */
  _applyColors() {
    const cfg = this.mapTypeConfig;
    if (!cfg) return;

    for (const [coord, ch] of Object.entries(this.tiles)) {
      let baseColor = null;
      if (ch === '.' && cfg.floorColor) baseColor = cfg.floorColor;
      else if (ch === '#' && cfg.wallColor) baseColor = cfg.wallColor;
      else if (ch === '+' && cfg.doorColor) baseColor = cfg.doorColor;
      if (baseColor) this.tileColors[coord] = _varyColor(baseColor, coord);
    }

    // Corridor tiles get corridorColor (overrides floorColor for corridor paths)
    if (cfg.corridorColor) {
      for (const coord of (this._corridorTiles || [])) {
        if (this.tiles[coord] === '.') {
          this.tileColors[coord] = _varyColor(cfg.corridorColor, coord);
        }
      }
    }
  }

  /** Place staircase tiles in random rooms */
  _placeStairs() {
    const cfg = this.mapTypeConfig;
    const upCount = cfg.stairsUp || 0;
    const downCount = cfg.stairsDown || 0;

    // Shuffle rooms (skip room 0 — that's the spawn room)
    const candidates = this.rooms.length > 1 ? this.rooms.slice(1) : [...this.rooms];
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    let placed = 0;
    // Place up stairs (<)
    for (let i = 0; i < upCount && placed < candidates.length; i++, placed++) {
      const room = candidates[placed];
      const pt = room.randomInteriorPoint();
      this.tiles[`${pt.x},${pt.y}`] = '<';
      if (cfg.floorColor) this.tileColors[`${pt.x},${pt.y}`] = cfg.floorColor;
    }
    // Place down stairs (>)
    for (let i = 0; i < downCount && placed < candidates.length; i++, placed++) {
      const room = candidates[placed];
      const pt = room.randomInteriorPoint();
      this.tiles[`${pt.x},${pt.y}`] = '>';
      if (cfg.floorColor) this.tileColors[`${pt.x},${pt.y}`] = cfg.floorColor;
    }

    log.debug(`Placed stairs: ${upCount} up, ${downCount} down`);
  }

  /**
   * Recursively split BSP node until we have enough leaves for requiredRooms.
   */
  _splitBSP(node, requiredRooms, minRoomSize) {
    const leaves = this._getLeaves(this.root);
    if (leaves.length >= requiredRooms) return;

    const minPartition = minRoomSize + 4; // room + walls + margin

    // Can't split if too small on both axes
    if (node.w < minPartition * 2 && node.h < minPartition * 2) return;

    // Choose split axis: prefer splitting the longer dimension
    let splitVertical;
    if (node.w < minPartition * 2) {
      splitVertical = false; // can only split horizontally
    } else if (node.h < minPartition * 2) {
      splitVertical = true;  // can only split vertically
    } else if (node.w > node.h * 1.25) {
      splitVertical = true;
    } else if (node.h > node.w * 1.25) {
      splitVertical = false;
    } else {
      splitVertical = Math.random() < 0.5;
    }

    // Split position: 40-60% of the axis
    const axis = splitVertical ? node.w : node.h;
    const min = Math.floor(axis * 0.4);
    const max = Math.floor(axis * 0.6);
    const split = min + Math.floor(Math.random() * (max - min + 1));

    if (split < minPartition || axis - split < minPartition) return;

    if (splitVertical) {
      node.left = new BSPNode(node.x, node.y, split, node.h);
      node.right = new BSPNode(node.x + split, node.y, node.w - split, node.h);
    } else {
      node.left = new BSPNode(node.x, node.y, node.w, split);
      node.right = new BSPNode(node.x, node.y + split, node.w, node.h - split);
    }

    // Recurse into children
    this._splitBSP(node.left, requiredRooms, minRoomSize);
    this._splitBSP(node.right, requiredRooms, minRoomSize);

    // If we still need more leaves, split the largest ones
    const currentLeaves = this._getLeaves(this.root);
    if (currentLeaves.length < requiredRooms) {
      // Sort by area descending and try splitting more
      currentLeaves.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      for (const leaf of currentLeaves) {
        if (this._getLeaves(this.root).length >= requiredRooms) break;
        if (leaf.isLeaf()) {
          this._splitBSP(leaf, requiredRooms, minRoomSize);
        }
      }
    }
  }

  /** Collect all leaf nodes from the BSP tree */
  _getLeaves(node) {
    if (!node) return [];
    if (node.isLeaf()) return [node];
    return [...this._getLeaves(node.left), ...this._getLeaves(node.right)];
  }

  /**
   * Place a room inside each leaf partition.
   */
  _placeRooms(node, minRoomSize, maxRoomSize) {
    if (!node) return;
    if (node.isLeaf()) {
      const maxW = Math.min(maxRoomSize, node.w - 2);
      const maxH = Math.min(maxRoomSize, node.h - 2);
      if (maxW < minRoomSize || maxH < minRoomSize) return; // partition too small

      const rw = minRoomSize + Math.floor(Math.random() * (maxW - minRoomSize + 1));
      const rh = minRoomSize + Math.floor(Math.random() * (maxH - minRoomSize + 1));
      const rx = node.x + 1 + Math.floor(Math.random() * (node.w - rw - 1));
      const ry = node.y + 1 + Math.floor(Math.random() * (node.h - rh - 1));

      const room = new Room(rx, ry, rw, rh);
      node.room = room;
      this.rooms.push(room);
      return;
    }
    this._placeRooms(node.left, minRoomSize, maxRoomSize);
    this._placeRooms(node.right, minRoomSize, maxRoomSize);
  }

  /**
   * Snap all room positions and dimensions to grid boundaries.
   */
  _snapToGrid(minRoomSize) {
    const g = this.gridSize;
    if (g <= 1) return;

    for (const room of this.rooms) {
      room.x = Math.round(room.x / g) * g;
      room.y = Math.round(room.y / g) * g;
      room.width = Math.max(minRoomSize, Math.round(room.width / g) * g);
      room.height = Math.max(minRoomSize, Math.round(room.height / g) * g);
    }

    // Verify no overlaps after snapping — shrink overlapping rooms
    for (let i = 0; i < this.rooms.length; i++) {
      for (let j = i + 1; j < this.rooms.length; j++) {
        const a = this.rooms[i];
        const b = this.rooms[j];
        if (a.x < b.x + b.width && a.x + a.width > b.x &&
            a.y < b.y + b.height && a.y + a.height > b.y) {
          // Overlap — shrink the smaller room
          const target = (a.width * a.height < b.width * b.height) ? a : b;
          target.width = Math.max(minRoomSize, target.width - g);
          target.height = Math.max(minRoomSize, target.height - g);
        }
      }
    }
  }

  /**
   * Assign regions to BSP subtrees at depth 1-2, rooms inherit.
   */
  _assignRegions(node, regions) {
    if (!regions || regions.length === 0) return;

    // Shuffle regions
    const shuffled = [...regions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Collect nodes at depth 1-2 that have rooms beneath them
    const subtrees = [];
    this._collectSubtrees(node, 0, subtrees);

    // Assign regions round-robin
    for (let i = 0; i < subtrees.length; i++) {
      const region = shuffled[i % shuffled.length];
      this._applyRegion(subtrees[i], region);
    }
  }

  _collectSubtrees(node, depth, result) {
    if (!node) return;
    // Target depth 1-2 for region assignment
    if (depth >= 1 && depth <= 2 && node.getRooms().length > 0) {
      result.push(node);
      return; // don't recurse deeper for assignment
    }
    this._collectSubtrees(node.left, depth + 1, result);
    this._collectSubtrees(node.right, depth + 1, result);
  }

  _applyRegion(node, region) {
    if (!node) return;
    node.region = region;
    if (node.room) node.room.region = region;
    this._applyRegion(node.left, region);
    this._applyRegion(node.right, region);
  }

  /**
   * Connect BSP siblings — this defines which rooms have corridors.
   * Recurse bottom-up: connect children first, then connect left↔right.
   */
  _connectBSP(node) {
    if (!node || node.isLeaf()) return;
    if (!this._corridorTiles) this._corridorTiles = [];

    // Connect children's subtrees first
    this._connectBSP(node.left);
    this._connectBSP(node.right);

    // Connect a room from left subtree to a room from right subtree
    const roomA = node.left.getRandomRoom();
    const roomB = node.right.getRandomRoom();
    if (roomA && roomB) {
      const walled = this.mapTypeConfig?.hasCorridors !== false;
      const corridor = new Corridor(roomA, roomB);
      corridor.carve(this.tiles, this.rooms, this._corridorTiles, walled);
    }
  }
}

function getPlayerRevealed(playerId) {
  const id = playerId || 'default';
  if (!revealedTilesPerPlayer[id]) revealedTilesPerPlayer[id] = new Set();
  return revealedTilesPerPlayer[id];
}

// ── Collision detection ────────────────────────────────────────────────
// Extracted from room-service. Corridors use relaxed rules: they can
// cross existing floor tiles (creating intersections) but not doors.
function canFit(structureType, x, y, w, h, anchorX, anchorY) {
  if (Object.keys(worldTiles).length === 0) return true;

  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (c === anchorX && r === anchorY) continue;

      const t = worldTiles[`${c},${r}`] || ' ';

      if (structureType === 'corridor') {
        // Corridors can cross existing floor tiles (intersection)
        // but cannot cross doors
        if (t === '+') return false;
      } else {
        // Rooms: existing floor or door = collision
        if (t === '.' || t === '+') return false;
      }
    }
  }
  return true;
}

// ── Direction detection ────────────────────────────────────────────────
// Determines which direction a new structure should grow from an anchor
// by checking which side has existing floor tiles.
function detectForcedDirection(anchorX, anchorY) {
  if (Object.keys(worldTiles).length === 0) return null;
  if (anchorX === undefined || anchorY === undefined) return null;

  if (worldTiles[`${anchorX - 1},${anchorY}`] === '.') return 'E'; // Floor to West → grow East
  if (worldTiles[`${anchorX + 1},${anchorY}`] === '.') return 'W'; // Floor to East → grow West
  if (worldTiles[`${anchorX},${anchorY - 1}`] === '.') return 'S'; // Floor to North → grow South
  if (worldTiles[`${anchorX},${anchorY + 1}`] === '.') return 'N'; // Floor to South → grow North
  return null;
}

// Map direction strings to wall indices used by room placement
function dirToWall(dir) {
  switch (dir) {
    case 'N': return 0;
    case 'S': return 1;
    case 'W': return 2;
    case 'E': return 3;
    default: return -1;
  }
}

// ── Structure placement ────────────────────────────────────────────────
// Tries up to 5 random placements for a room structure around the anchor.
function tryPlaceRoom(width, height, anchorX, anchorY, wall) {
  let rx, ry;
  if (wall === 0) {
    // Grow North: anchor is on South wall of new room
    ry = anchorY - height + 1;
    rx = anchorX - Math.floor(Math.random() * (width - 2)) - 1;
  } else if (wall === 1) {
    // Grow South: anchor is on North wall of new room
    ry = anchorY;
    rx = anchorX - Math.floor(Math.random() * (width - 2)) - 1;
  } else if (wall === 2) {
    // Grow West: anchor is on East wall of new room
    rx = anchorX - width + 1;
    ry = anchorY - Math.floor(Math.random() * (height - 2)) - 1;
  } else {
    // Grow East: anchor is on West wall of new room
    rx = anchorX;
    ry = anchorY - Math.floor(Math.random() * (height - 2)) - 1;
  }
  return { rx, ry };
}

// Write room tiles into worldTiles, ensuring at least one door
function writeRoomTiles(rx, ry, width, height, doors) {
  for (let r = ry; r < ry + height; r++) {
    for (let c = rx; c < rx + width; c++) {
      if (r === ry || r === ry + height - 1 || c === rx || c === rx + width - 1) {
        worldTiles[`${c},${r}`] = worldTiles[`${c},${r}`] === '+' ? '+' : '#';
      } else {
        worldTiles[`${c},${r}`] = '.';
      }
    }
  }
  // Write doors
  for (const d of doors) {
    worldTiles[`${rx + d.x},${ry + d.y}`] = '+';
  }
  // Safety: if no doors were placed, add one on a random wall
  if (!doors || doors.length === 0) {
    if (width > 2) {
      const dx = Math.floor(Math.random() * (width - 2)) + 1;
      worldTiles[`${rx + dx},${ry}`] = '+';
    } else if (height > 2) {
      const dy = Math.floor(Math.random() * (height - 2)) + 1;
      worldTiles[`${rx},${ry + dy}`] = '+';
    }
  }
}

// Write corridor tiles into worldTiles
function writeCorridorTiles(rx, ry, direction, length) {
  const w = (direction === 'E' || direction === 'W') ? length : 1;
  const h = (direction === 'N' || direction === 'S') ? length : 1;
  for (let r = ry; r < ry + h; r++) {
    for (let c = rx; c < rx + w; c++) {
      worldTiles[`${c},${r}`] = '.';
    }
  }
}

// ── RPC: PlaceStructure ────────────────────────────────────────────────
function placeStructure(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: JSON.stringify({
      structureType: call.request.structureType,
      anchorX: call.request.anchorX,
      anchorY: call.request.anchorY
    }),
    subSpans: []
  };

  try {
    setActiveLevel(call.request.dungeonLevel || activeLevel);
    const { structureType, width, height, description, anchorX, anchorY, direction } = call.request;
    const doors = call.request.doors || [];

    // Parse the local tile layout from the generator
    let localTiles;
    try { localTiles = JSON.parse(call.request.tilesJson || '{}'); } catch { localTiles = {}; }

    // Detect which direction to grow
    const forced = detectForcedDirection(anchorX, anchorY);

    let fitSuccess = false;
    let originX = 0, originY = 0;
    let actualDir = '';

    if (structureType === 'corridor') {
      // Corridor placement — rebuild tiles based on actual direction
      // The generator may have rolled a random direction, but we override
      // based on anchor context (forced direction).
      const dir = forced || direction || 'N';
      const isVertical = dir === 'N' || dir === 'S';
      const corridorLength = Math.max(width, height); // length is always the larger dim

      // Recalculate actual dimensions based on the placement direction
      const actualW = isVertical ? 3 : corridorLength;
      const actualH = isVertical ? corridorLength : 3;

      // Rebuild local tiles for the actual direction
      // Corridors are open passageways — no doors at ends
      const corrTiles = {};
      for (let y = 0; y < actualH; y++) {
        for (let x = 0; x < actualW; x++) {
          if (isVertical) {
            corrTiles[`${x},${y}`] = (x === 1) ? '.' : '#';
          } else {
            corrTiles[`${x},${y}`] = (y === 1) ? '.' : '#';
          }
        }
      }
      // Open both ends (floor, not doors)
      if (isVertical) {
        corrTiles[`1,0`] = '.';
        corrTiles[`1,${actualH - 1}`] = '.';
      } else {
        corrTiles[`0,1`] = '.';
        corrTiles[`${actualW - 1},1`] = '.';
      }

      // Position the corridor so the anchor aligns with the floor center
      let rx, ry;
      if (dir === 'N') {
        rx = anchorX - 1;
        ry = anchorY - actualH + 1;
      } else if (dir === 'S') {
        rx = anchorX - 1;
        ry = anchorY;
      } else if (dir === 'W') {
        rx = anchorX - actualW + 1;
        ry = anchorY - 1;
      } else {
        rx = anchorX;
        ry = anchorY - 1;
      }

      if (canFit('corridor', rx, ry, actualW, actualH, anchorX, anchorY)) {
        fitSuccess = true;
        originX = rx;
        originY = ry;
        actualDir = dir;
        // Write rebuilt tiles to world coordinates
        for (const [coord, ch] of Object.entries(corrTiles)) {
          const [lx, ly] = coord.split(',').map(Number);
          const wx = rx + lx;
          const wy = ry + ly;
          if (wx === anchorX && wy === anchorY) continue;
          const existing = worldTiles[`${wx},${wy}`] || ' ';
          if (existing === '.' || existing === '+') continue;
          worldTiles[`${wx},${wy}`] = ch;
        }
        // Convert anchor door to floor (door has been opened)
        worldTiles[`${anchorX},${anchorY}`] = '.';
        log.debug(`Corridor placed: ${actualW}x${actualH} ${dir} at ${rx},${ry}`);
      } else {
        log.debug(`Corridor placement failed at anchor ${anchorX},${anchorY}`);
      }
    } else {
      // Room placement — try up to 5 positions
      const wall = forced ? dirToWall(forced) : -1;

      for (let attempt = 0; attempt < 5; attempt++) {
        const w = wall === -1 ? Math.floor(Math.random() * 4) : wall;
        const { rx, ry } = tryPlaceRoom(width, height, anchorX, anchorY, w);

        if (canFit('room', rx, ry, width, height, anchorX, anchorY)) {
          fitSuccess = true;
          originX = rx;
          originY = ry;

          // Build door list: anchor door + generator doors offset to world coords
          const worldDoors = [{ x: anchorX - rx, y: anchorY - ry }];
          for (const d of doors) {
            const isDup = worldDoors.some(wd => wd.x === d.x && wd.y === d.y);
            if (!isDup) worldDoors.push(d);
          }

          writeRoomTiles(rx, ry, width, height, worldDoors);
          // Convert anchor door to floor (door has been opened)
          worldTiles[`${anchorX},${anchorY}`] = '.';
          worldRooms.push({ x: rx, y: ry, width, height, description });
          log.debug(`Room placed: ${width}x${height} at ${rx},${ry}`);
          break;
        }
      }

      if (!fitSuccess) {
        log.debug(`Room placement failed after 5 attempts at anchor ${anchorX},${anchorY}`);
      }
    }

    syncBackToLevel();
    callback(null, {
      fitSuccess,
      originX,
      originY,
      tilesJson: JSON.stringify(worldTiles),
      roomsJson: JSON.stringify(worldRooms),
      trace,
      actualDirection: actualDir
    });
  } catch (err) {
    log.error('Error placing structure:', err.message);
    callback(err);
  }
}

// ── RPC: GetWorldState ─────────────────────────────────────────────────
function getWorldState(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: '',
    subSpans: []
  };

  const playerId = call.request.playerId || 'default';
  const dungeonLevel = call.request.dungeonLevel || 0;
  setActiveLevel(dungeonLevel);
  const revealed = getPlayerRevealed(playerId);
  callback(null, {
    tilesJson: JSON.stringify(worldTiles),
    roomsJson: JSON.stringify(worldRooms),
    revealedJson: JSON.stringify([...revealed]),
    tileColorsJson: JSON.stringify(worldTileColors),
    trace
  });
}

// ── RPC: RevealTiles ──────────────────────────────────────────────────
// Merges currently visible coords into the persistent revealed set.
function revealTiles(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: '',
    subSpans: []
  };

  try {
    const playerId = call.request.playerId || 'default';
    const revealed = getPlayerRevealed(playerId);
    const visibleCoords = JSON.parse(call.request.visibleCoordsJson || '[]');
    for (const coord of visibleCoords) {
      revealed.add(coord);
    }

    callback(null, {
      revealedJson: JSON.stringify([...revealed]),
      trace
    });
  } catch (err) {
    log.error('Error revealing tiles:', err.message);
    callback(err);
  }
}

// ── RPC: InitWorld ─────────────────────────────────────────────────────
// Creates the starter room centered at 0,0
function initWorld(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: JSON.stringify({ width: call.request.width, height: call.request.height }),
    subSpans: []
  };

  try {
    const { width, height, description } = call.request;
    const doors = call.request.doors || [];

    // Parse local tile layout from the generator
    let localTiles;
    try { localTiles = JSON.parse(call.request.tilesJson || '{}'); } catch { localTiles = {}; }

    // Center the room at 0,0
    const rx = -Math.floor(width / 2);
    const ry = -Math.floor(height / 2);

    // Clear world state
    worldTiles = {};
    worldTileColors = {};
    worldRooms = [];
    revealedTilesPerPlayer = {};

    // Write tiles from local coords to world coords
    for (const [coord, ch] of Object.entries(localTiles)) {
      const [lx, ly] = coord.split(',').map(Number);
      worldTiles[`${rx + lx},${ry + ly}`] = ch;
    }

    // Write doors into world coords (they should already be in local tiles, but ensure '+')
    for (const d of doors) {
      worldTiles[`${rx + d.x},${ry + d.y}`] = '+';
    }

    worldRooms.push({ x: rx, y: ry, width, height, description });

    const playerX = 0;
    const playerY = 0;

    log.debug(`World initialized: ${width}x${height} room at ${rx},${ry}, player at ${playerX},${playerY}`);

    callback(null, {
      tilesJson: JSON.stringify(worldTiles),
      roomsJson: JSON.stringify(worldRooms),
      playerX,
      playerY,
      trace
    });
  } catch (err) {
    log.error('Error initializing world:', err.message);
    callback(err);
  }
}

// ── RPC: ResetWorld ────────────────────────────────────────────────────
function resetWorld(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: '',
    subSpans: []
  };

  const dungeonLevel = call.request.dungeonLevel;
  if (dungeonLevel !== undefined && dungeonLevel >= 0) {
    // Reset specific level
    levelStates.delete(dungeonLevel);
    setActiveLevel(dungeonLevel);
    log.debug(`Level ${dungeonLevel} state reset`);
  } else {
    // Reset all levels
    levelStates.clear();
    worldTiles = {};
    worldTileColors = {};
    worldRooms = [];
    revealedTilesPerPlayer = {};
    activeLevel = 0;
    log.debug('All world state reset');
  }

  callback(null, { success: true, trace });
}

// ── RPC: SetTile ──────────────────────────────────────────────────────
// Directly set a single tile (e.g. convert door '+' to floor '.' or vice versa)
function setTile(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: JSON.stringify({ x: call.request.x, y: call.request.y, tile: call.request.tileChar }),
    subSpans: []
  };

  setActiveLevel(call.request.dungeonLevel || activeLevel);
  const { x, y, tileChar } = call.request;
  worldTiles[`${x},${y}`] = tileChar;
  syncBackToLevel();
  log.debug(`SetTile: (${x},${y}) = '${tileChar}'`);

  callback(null, {
    success: true,
    tilesJson: JSON.stringify(worldTiles),
    roomsJson: JSON.stringify(worldRooms),
    trace
  });
}

// ── RPC: GenerateLevel ────────────────────────────────────────────────
// BSP-based level generation. World-service is authoritative.
function generateLevel(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'world-service',
    data: JSON.stringify({
      width: call.request.width,
      height: call.request.height,
      requiredRooms: call.request.requiredRooms,
    }),
    subSpans: []
  };

  try {
    // Resolve MapType config
    const mapTypeName = call.request.mapType || 'dungeon';
    const mapTypeConfig = MAP_TYPES[mapTypeName] || MAP_TYPES.dungeon;

    // MapType provides defaults; explicit request params override
    const requiredRooms = call.request.requiredRooms || mapTypeConfig.maxRooms || 12;
    const minRoomSize = call.request.minRoomSize || mapTypeConfig.minRoomSize || 4;
    const maxRoomSize = call.request.maxRoomSize || mapTypeConfig.maxRoomSize || 10;

    // Dynamic map size: scale with room count and room size for compact layouts
    // Formula: sqrt(rooms) * avgRoomSize * padding
    const avgRoomSize = Math.floor((minRoomSize + maxRoomSize) / 2);
    const roomsPerSide = Math.ceil(Math.sqrt(requiredRooms));
    const dynamicSize = roomsPerSide * (avgRoomSize + 4); // +4 for walls + corridor margin
    const maxWidth = mapTypeConfig.width || 200;
    const maxHeight = mapTypeConfig.height || 200;
    const width = call.request.width || Math.min(dynamicSize, maxWidth);
    const height = call.request.height || Math.min(Math.floor(dynamicSize * 0.75), maxHeight);
    const gridSize = call.request.gridSize || 2;
    const maxPlayers = call.request.maxPlayers || 4;
    let regions = [];
    try { regions = JSON.parse(call.request.regionsJson || '[]'); } catch {}

    // Set active level from request
    const dungeonLevel = call.request.dungeonLevel || 0;
    setActiveLevel(dungeonLevel);

    // Clear this level's state
    worldTiles = {};
    worldTileColors = {};
    worldRooms = [];

    // Generate via BSP
    const dungeon = new DungeonMap(width, height, gridSize);
    dungeon.generate(requiredRooms, minRoomSize, maxRoomSize, regions, mapTypeConfig);

    // Copy to authoritative state
    worldTiles = dungeon.tiles;
    worldTileColors = dungeon.tileColors;
    worldRooms = dungeon.rooms.map(r => r.toJSON());
    syncBackToLevel();

    // Build spawn positions from first N rooms
    const spawnPositions = [];
    for (let i = 0; i < Math.min(maxPlayers, dungeon.rooms.length); i++) {
      spawnPositions.push(dungeon.rooms[i].center());
    }
    while (spawnPositions.length < maxPlayers) {
      spawnPositions.push(spawnPositions[0] || { x: 0, y: 0 });
    }

    const playerX = spawnPositions[0]?.x || 0;
    const playerY = spawnPositions[0]?.y || 0;

    log.debug(`Level generated: ${dungeon.rooms.length} rooms, ${width}x${height}, player at (${playerX},${playerY})`);

    callback(null, {
      success: true,
      tilesJson: JSON.stringify(worldTiles),
      roomsJson: JSON.stringify(worldRooms),
      playerX,
      playerY,
      spawnPositionsJson: JSON.stringify(spawnPositions),
      trace,
    });
  } catch (err) {
    log.error('Error generating level:', err.message);
    callback(err);
  }
}

// ── Server bootstrap ───────────────────────────────────────────────────
function main() {
  const server = new grpc.Server();
  server.addService(WorldService.service, {
    placeStructure,
    getWorldState,
    initWorld,
    resetWorld,
    revealTiles,
    setTile,
    generateLevel,
  });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        log.error('Failed to start:', err);
        process.exit(1);
      }
      log.info(`Running on port ${port}`);
    }
  );
}

main();
