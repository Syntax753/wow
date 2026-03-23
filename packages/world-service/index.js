const grpc = require('@grpc/grpc-js');
const { WorldService } = require('@wow/proto');

const PORT = process.env.WORLD_SERVICE_PORT || 50060;

// ── Authoritative world state (in-memory) ──────────────────────────────
let worldTiles = {};   // {"x,y": char}
let worldRooms = [];   // [{x, y, width, height, description}]

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

// Write room tiles into worldTiles
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
    const { structureType, width, height, description, anchorX, anchorY, direction } = call.request;
    const doors = call.request.doors || [];

    // Parse the local tile layout from the generator
    let localTiles;
    try { localTiles = JSON.parse(call.request.tilesJson || '{}'); } catch { localTiles = {}; }

    // Detect which direction to grow
    const forced = detectForcedDirection(anchorX, anchorY);

    let fitSuccess = false;
    let originX = 0, originY = 0;

    if (structureType === 'corridor') {
      // Corridor placement
      const dir = forced || direction || 'N';
      let rx = anchorX, ry = anchorY;
      const length = (dir === 'E' || dir === 'W') ? width : height;
      let w = 1, h = 1;

      if (dir === 'N') { ry = anchorY - length + 1; w = 1; h = length; }
      else if (dir === 'S') { ry = anchorY; w = 1; h = length; }
      else if (dir === 'W') { rx = anchorX - length + 1; w = length; h = 1; }
      else if (dir === 'E') { rx = anchorX; w = length; h = 1; }

      if (canFit('corridor', rx, ry, w, h, anchorX, anchorY)) {
        fitSuccess = true;
        originX = rx;
        originY = ry;
        writeCorridorTiles(rx, ry, dir, length);
        console.log(`[WorldService] Corridor placed: ${length} tiles ${dir} at ${rx},${ry}`);
      } else {
        console.log(`[WorldService] Corridor placement failed at anchor ${anchorX},${anchorY}`);
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
          worldRooms.push({ x: rx, y: ry, width, height, description });
          console.log(`[WorldService] Room placed: ${width}x${height} at ${rx},${ry}`);
          break;
        }
      }

      if (!fitSuccess) {
        console.log(`[WorldService] Room placement failed after 5 attempts at anchor ${anchorX},${anchorY}`);
      }
    }

    callback(null, {
      fitSuccess,
      originX,
      originY,
      tilesJson: JSON.stringify(worldTiles),
      roomsJson: JSON.stringify(worldRooms),
      trace
    });
  } catch (err) {
    console.error('[WorldService] Error placing structure:', err.message);
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

  callback(null, {
    tilesJson: JSON.stringify(worldTiles),
    roomsJson: JSON.stringify(worldRooms),
    trace
  });
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
    worldRooms = [];

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

    console.log(`[WorldService] World initialized: ${width}x${height} room at ${rx},${ry}, player at ${playerX},${playerY}`);

    callback(null, {
      tilesJson: JSON.stringify(worldTiles),
      roomsJson: JSON.stringify(worldRooms),
      playerX,
      playerY,
      trace
    });
  } catch (err) {
    console.error('[WorldService] Error initializing world:', err.message);
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

  worldTiles = {};
  worldRooms = [];
  console.log('[WorldService] World state reset');

  callback(null, { success: true, trace });
}

// ── Server bootstrap ───────────────────────────────────────────────────
function main() {
  const server = new grpc.Server();
  server.addService(WorldService.service, {
    placeStructure,
    getWorldState,
    initWorld,
    resetWorld
  });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[WorldService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[WorldService] Running on port ${port}`);
    }
  );
}

main();
