const grpc = require('@grpc/grpc-js');
const { InputService } = require('@wow/proto');

const PORT = process.env.INPUT_SERVICE_PORT || 50061;

const TILE_WALL = '#';
const TILE_FLOOR = '.';
const TILE_DOOR = '+';
const TILE_UNKNOWN = ' ';

// Map keys to movement deltas
const MOVE_KEYS = {
  // Numpad Support
  '8': { dx: 0, dy: -1 }, // North
  '2': { dx: 0, dy: 1 },  // South
  '4': { dx: -1, dy: 0 }, // West
  '6': { dx: 1, dy: 0 },  // East
  '7': { dx: -1, dy: -1 }, // NorthWest
  '9': { dx: 1, dy: -1 },  // NorthEast
  '1': { dx: -1, dy: 1 },  // SouthWest
  '3': { dx: 1, dy: 1 },   // SouthEast
};

function processInput(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'input-service',
    data: JSON.stringify({ key: call.request.key, px: call.request.playerX, py: call.request.playerY }),
    subSpans: []
  };

  try {
    const { key, playerX: px, playerY: py, tilesJson } = call.request;

    let tiles;
    try { tiles = JSON.parse(tilesJson || '{}'); } catch { tiles = {}; }

    function getTile(x, y) {
      return tiles[`${x},${y}`] || TILE_UNKNOWN;
    }

    // Movement keys
    const move = MOVE_KEYS[key];
    if (move) {
      const newX = px + move.dx;
      const newY = py + move.dy;
      const target = getTile(newX, newY);

      if (target === TILE_WALL) {
        callback(null, {
          newX: px, newY: py,
          action: 'blocked',
          message: 'Ouch!',
          positionChanged: false,
          trace
        });
        return;
      }

      if (target === TILE_UNKNOWN) {
        callback(null, {
          newX: px, newY: py,
          action: 'blocked',
          message: '',
          positionChanged: false,
          trace
        });
        return;
      }

      if (target === TILE_DOOR) {
        // Step onto the door tile and trigger open_door action
        callback(null, {
          newX: newX, newY: newY,
          action: 'open_door',
          message: 'You push the door open and peer into the darkness...',
          doorX: newX, doorY: newY,
          positionChanged: true,
          trace
        });
        return;
      }

      // Valid floor tile — move there
      callback(null, {
        newX: newX, newY: newY,
        action: 'move',
        message: '',
        positionChanged: true,
        trace
      });
      return;
    }

    // 'o' key — open adjacent door
    if (key === 'o' || key === 'O') {
      const adjacent = [
        { x: px, y: py - 1 },
        { x: px, y: py + 1 },
        { x: px - 1, y: py },
        { x: px + 1, y: py },
      ];

      for (const pos of adjacent) {
        if (getTile(pos.x, pos.y) === TILE_DOOR) {
          // Step onto the door
          callback(null, {
            newX: pos.x, newY: pos.y,
            action: 'open_door',
            message: 'You push the door open and peer into the darkness...',
            doorX: pos.x, doorY: pos.y,
            positionChanged: true,
            trace
          });
          return;
        }
      }

      callback(null, {
        newX: px, newY: py,
        action: 'none',
        message: 'There is no door nearby.',
        positionChanged: false,
        trace
      });
      return;
    }

    // '.' or '5' key — wait
    if (key === '.' || key === '5') {
      callback(null, {
        newX: px, newY: py,
        action: 'wait',
        message: 'You wait...',
        positionChanged: false,
        trace
      });
      return;
    }

    // Unrecognized key
    callback(null, {
      newX: px, newY: py,
      action: 'none',
      message: '',
      positionChanged: false,
      trace
    });

  } catch (err) {
    console.error('[InputService] Error processing input:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(InputService.service, { processInput });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[InputService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[InputService] Running on port ${port}`);
    }
  );
}

main();
