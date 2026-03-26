const grpc = require('@grpc/grpc-js');
const { RoomService, DiceService, createLogger } = require('@wow/proto');

const log = createLogger('RoomService');
const PORT = process.env.ROOM_PORT || 50056;

const DICE_HOST = process.env.DICE_HOST || 'localhost:50051';
const diceClient = new DiceService(
  DICE_HOST,
  grpc.credentials.createInsecure()
);

const ROOM_DESCRIPTIONS = [
  'A damp, moldy stone chamber.',
  'A forgotten armory with rusted racks.',
  'A completely bare, perfectly square room.',
  'A room smelling faintly of ozone and old blood.',
  'A ruined shrine dedicated to an unknown deity.',
  'An opulent bedroom, now thick with dust.',
  'A collapsed library with burned pages.',
  'A strange room with a geometric mosaic floor.'
];

const CORRIDOR_DESCRIPTIONS = [
  'A narrow, rough-hewn tunnel.',
  'A perfectly smooth hallway of black stone.',
  'A dusty corridor lined with empty alcoves.',
  'A passageway with water dripping from the ceiling.',
  'A hallway littered with old bones.'
];

function rollDiceAsync(diceArray, trace) {
  return new Promise((resolve, reject) => {
    diceClient.rollDice({ dice: diceArray, trace }, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}

// Normal distribution via Box-Muller transform.
// mode=5, 99% of values between 3 and 7 → σ ≈ 0.775
// Clamped to [3, 100] to allow rare large rooms.
const ROOM_DIM_MEAN = 5;
const ROOM_DIM_SIGMA = 0.775;

function rollRoomDimension() {
  // Box-Muller: two uniform randoms → one normal sample
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = Math.round(ROOM_DIM_MEAN + z * ROOM_DIM_SIGMA);
  return Math.max(3, Math.min(100, raw));
}

// Generate a room structure in local coordinates (origin 0,0).
// No world knowledge — just dimensions, tiles, doors, and a description.
async function generateRoom(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'room-service',
    data: JSON.stringify({ level: call.request.level }),
    subSpans: []
  };

  try {
    // Roll dimensions — normal distribution, mode=5, 99% between 3-7, max 100
    const width = rollRoomDimension();
    const height = rollRoomDimension();

    // Build local tile map
    const localTiles = {};
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
          localTiles[`${x},${y}`] = '#';
        } else {
          localTiles[`${x},${y}`] = '.';
        }
      }
    }

    // Determine door count: use requested count, or roll randomly
    const doors = [];
    let numDoors;
    if (call.request.doorCount > 0) {
      numDoors = call.request.doorCount;
    } else {
      numDoors = (await rollDiceAsync(['1d2'], trace)).grandTotal;
    }

    // Place doors spread across different walls, with minimum spacing of 2 tiles
    // between any two doors so each exit is clearly distinct.
    // Prefer distributing doors evenly: cycle through walls round-robin.
    const placedDoors = []; // [{x,y}] for distance checks
    const MIN_DOOR_DIST = 3; // minimum Manhattan distance between doors

    function tooCloseToExisting(dx, dy) {
      for (const d of placedDoors) {
        if (Math.abs(d.x - dx) + Math.abs(d.y - dy) < MIN_DOOR_DIST) return true;
      }
      return false;
    }

    // Build a shuffled wall order so doors spread across sides
    const wallOrder = [0, 1, 2, 3]; // N, S, W, E
    for (let k = wallOrder.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [wallOrder[k], wallOrder[j]] = [wallOrder[j], wallOrder[k]];
    }

    for (let i = 0; i < numDoors; i++) {
      let placed = false;
      // Try walls in round-robin order, starting from a cycled offset
      for (let w = 0; w < 4 && !placed; w++) {
        const side = wallOrder[(i + w) % 4];
        // Try up to 10 random positions on this wall
        for (let attempt = 0; attempt < 10 && !placed; attempt++) {
          let dx = 0, dy = 0;
          if (side === 0 && width > 2) { dx = Math.floor(Math.random() * (width - 2)) + 1; dy = 0; }
          else if (side === 1 && width > 2) { dx = Math.floor(Math.random() * (width - 2)) + 1; dy = height - 1; }
          else if (side === 2 && height > 2) { dx = 0; dy = Math.floor(Math.random() * (height - 2)) + 1; }
          else if (side === 3 && height > 2) { dx = width - 1; dy = Math.floor(Math.random() * (height - 2)) + 1; }
          else break;

          if (!tooCloseToExisting(dx, dy)) {
            placedDoors.push({ x: dx, y: dy });
            doors.push({ x: dx, y: dy });
            localTiles[`${dx},${dy}`] = '+';
            placed = true;
          }
        }
      }
    }

    // Roll for description
    const descRoll = await rollDiceAsync(['1d8'], trace);
    const descIndex = (descRoll.grandTotal - 1) % ROOM_DESCRIPTIONS.length;
    const description = ROOM_DESCRIPTIONS[descIndex];

    log.debug(`Generated room: ${width}x${height}, ${doors.length} doors`);

    callback(null, {
      width,
      height,
      description,
      doors,
      tilesJson: JSON.stringify(localTiles),
      trace
    });
  } catch (err) {
    log.error('Error generating room:', err.message);
    callback(err);
  }
}

// Generate a corridor structure in local coordinates.
// Returns length, direction, tiles, and description.
async function generateCorridor(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'room-service',
    data: JSON.stringify({ level: call.request.level }),
    subSpans: []
  };

  try {
    // Roll length
    const lenRoll = await rollDiceAsync(['1d6'], trace);
    const length = lenRoll.grandTotal + 2; // 3 to 8

    // Roll direction
    const dirRoll = await rollDiceAsync(['1d4'], trace);
    const directions = ['N', 'S', 'E', 'W'];
    const direction = directions[(dirRoll.grandTotal - 1) % 4];

    // Build local tile map — 3-wide corridor with walls on both sides.
    // Corridors are open passageways (edges in the graph) connecting rooms.
    // NO doors along the direction of travel — those belong on rooms.
    // Vertical (N/S): width=3, height=length — floor column at x=1
    // Horizontal (E/W): width=length, height=3 — floor row at y=1
    const localTiles = {};
    const isVertical = direction === 'N' || direction === 'S';
    const w = isVertical ? 3 : length;
    const h = isVertical ? length : 3;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isVertical) {
          localTiles[`${x},${y}`] = (x === 1) ? '.' : '#';
        } else {
          localTiles[`${x},${y}`] = (y === 1) ? '.' : '#';
        }
      }
    }

    // Open both ends of the corridor (floor, not doors or walls)
    // so it connects seamlessly to adjacent rooms/corridors
    if (isVertical) {
      localTiles[`1,0`] = '.';
      localTiles[`1,${h - 1}`] = '.';
    } else {
      localTiles[`0,1`] = '.';
      localTiles[`${w - 1},1`] = '.';
    }

    // Roll for description
    const descRoll = await rollDiceAsync(['1d5'], trace);
    const descIndex = (descRoll.grandTotal - 1) % CORRIDOR_DESCRIPTIONS.length;
    const description = CORRIDOR_DESCRIPTIONS[descIndex];

    log.debug(`Generated corridor: ${length} tiles ${direction} (${w}x${h})`);

    callback(null, {
      length,
      direction,
      description,
      tilesJson: JSON.stringify(localTiles),
      trace
    });
  } catch (err) {
    log.error('Error generating corridor:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(RoomService.service, { generateRoom, generateCorridor });
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
