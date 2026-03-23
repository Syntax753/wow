const grpc = require('@grpc/grpc-js');
const { RoomService, DiceService } = require('@wow/proto');

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
    // Roll dimensions
    const wRoll = await rollDiceAsync(['2d4'], trace);
    const width = wRoll.grandTotal + 1; // 3 to 9

    const hRoll = await rollDiceAsync(['2d4'], trace);
    const height = hRoll.grandTotal + 1; // 3 to 9

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

    // Roll for 1-2 structural doors on random walls
    const doors = [];
    const numDoors = (await rollDiceAsync(['1d2'], trace)).grandTotal;
    for (let i = 0; i < numDoors; i++) {
      const sRoll = await rollDiceAsync(['1d4'], trace);
      const side = sRoll.grandTotal - 1;
      let dx = 0, dy = 0;
      if (side === 0 && width > 2) { dx = Math.floor(Math.random() * (width - 2)) + 1; dy = 0; }
      else if (side === 1 && width > 2) { dx = Math.floor(Math.random() * (width - 2)) + 1; dy = height - 1; }
      else if (side === 2 && height > 2) { dx = 0; dy = Math.floor(Math.random() * (height - 2)) + 1; }
      else if (side === 3 && height > 2) { dx = width - 1; dy = Math.floor(Math.random() * (height - 2)) + 1; }
      else continue;

      const isDup = doors.some(d => d.x === dx && d.y === dy);
      if (!isDup) {
        doors.push({ x: dx, y: dy });
        localTiles[`${dx},${dy}`] = '+';
      }
    }

    // Roll for description
    const descRoll = await rollDiceAsync(['1d8'], trace);
    const descIndex = (descRoll.grandTotal - 1) % ROOM_DESCRIPTIONS.length;
    const description = ROOM_DESCRIPTIONS[descIndex];

    console.log(`[RoomService] Generated room: ${width}x${height}, ${doors.length} doors`);

    callback(null, {
      width,
      height,
      description,
      doors,
      tilesJson: JSON.stringify(localTiles),
      trace
    });
  } catch (err) {
    console.error('[RoomService] Error generating room:', err.message);
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

    // Build local tile map — 3-wide corridor with walls on both sides
    // and a door at the far end for further exploration.
    // Vertical (N/S): width=3, height=length — floor column at x=1
    // Horizontal (E/W): width=length, height=3 — floor row at y=1
    const localTiles = {};
    const isVertical = direction === 'N' || direction === 'S';
    const w = isVertical ? 3 : length;
    const h = isVertical ? length : 3;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isVertical) {
          // Vertical corridor: walls at x=0 and x=2, floor at x=1
          localTiles[`${x},${y}`] = (x === 1) ? '.' : '#';
        } else {
          // Horizontal corridor: walls at y=0 and y=2, floor at y=1
          localTiles[`${x},${y}`] = (y === 1) ? '.' : '#';
        }
      }
    }

    // Place a door at the far end of the corridor
    if (isVertical) {
      if (direction === 'N') {
        localTiles[`1,0`] = '+';  // Door at top
      } else {
        localTiles[`1,${h - 1}`] = '+';  // Door at bottom
      }
    } else {
      if (direction === 'W') {
        localTiles[`0,1`] = '+';  // Door at left
      } else {
        localTiles[`${w - 1},1`] = '+';  // Door at right
      }
    }

    // Roll for description
    const descRoll = await rollDiceAsync(['1d5'], trace);
    const descIndex = (descRoll.grandTotal - 1) % CORRIDOR_DESCRIPTIONS.length;
    const description = CORRIDOR_DESCRIPTIONS[descIndex];

    console.log(`[RoomService] Generated corridor: ${length} tiles ${direction} (${w}x${h})`);

    callback(null, {
      length,
      direction,
      description,
      tilesJson: JSON.stringify(localTiles),
      trace
    });
  } catch (err) {
    console.error('[RoomService] Error generating corridor:', err.message);
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
        console.error('[RoomService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[RoomService] Running on port ${port}`);
    }
  );
}

main();
