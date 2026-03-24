const crypto = require('crypto');
const { grpc, ActionService, GameService, createLogger } = require('@wow/proto');

const log = createLogger('ActionService');

const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'localhost:50062';
const gameClient = new GameService(GAME_SERVICE_URL, grpc.credentials.createInsecure());

function makeAsyncCall(client, method, serviceName) {
  return function(req, parentTrace) {
    return new Promise((resolve, reject) => {
      const callerIdentity = {
        traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
        spanId: crypto.randomUUID(),
      };
      client[method]({ ...req, trace: callerIdentity }, (err, response) => {
        if (err) {
          if (parentTrace) parentTrace.subSpans.push({ ...callerIdentity, serviceName, timeEnd: Date.now(), dataRet: JSON.stringify({ error: err.message }) });
          reject(err);
        } else {
          const childTrace = response.trace || { ...callerIdentity, serviceName };
          childTrace.timeEnd = Date.now();
          childTrace.dataRet = JSON.stringify({ ...response, trace: undefined });
          if (parentTrace) parentTrace.subSpans.push(childTrace);
          resolve(response);
        }
      });
    });
  };
}

const getKeymapAsync = makeAsyncCall(gameClient, 'GetKeymap', 'game-service');

const PORT = process.env.ACTION_SERVICE_PORT || '50055';

// Tile constants matching the wow frontend
const TILE = {
  WALL: '#',
  FLOOR: '.',
  DOOR: '+',
  PLAYER: '@',
  CORRIDOR: ':',
  UNKNOWN: ' ',
};

function getTileAt(tilesDict, x, y) {
  return tilesDict[`${x},${y}`] || TILE.UNKNOWN;
}

async function getAvailableActions(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'action-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  try {
    const { tilesJson, playerX, playerY } = call.request;
  
  let tilesDict;
  try { tilesDict = JSON.parse(tilesJson || "{}"); } catch { tilesDict = {}; }
  
  const keymapRes = await getKeymapAsync({}, trace);
  const keymap = JSON.parse(keymapRes.keymapJson || '{}');

  const actions = [];

  for (const [id, def] of Object.entries(keymap)) {
    if (!def.label) continue; // Display only actions with a UI label
    
    let enabled = true;
    
    // Evaluate proximity conditions
    if (def.actionOnProximity) {
      if (def.actionOnProximity === 'door') {
        const adjacent = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
        let nearDoor = false;
        for (const { dx, dy } of adjacent) {
          if (getTileAt(tilesDict, playerX + dx, playerY + dy) === '+') {
            nearDoor = true;
            break;
          }
        }
        enabled = nearDoor;
      } else if (def.actionOnProximity === 'opening') {
        // Check for closeable openings: adjacent floor tiles with 2+ wall neighbors (doorways)
        const adjacent = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
        let nearOpening = false;
        for (const { dx, dy } of adjacent) {
          const ax = playerX + dx, ay = playerY + dy;
          if (getTileAt(tilesDict, ax, ay) !== '.') continue;
          let wallCount = 0;
          if (getTileAt(tilesDict, ax, ay - 1) === '#') wallCount++;
          if (getTileAt(tilesDict, ax, ay + 1) === '#') wallCount++;
          if (getTileAt(tilesDict, ax - 1, ay) === '#') wallCount++;
          if (getTileAt(tilesDict, ax + 1, ay) === '#') wallCount++;
          if (wallCount >= 2) { nearOpening = true; break; }
        }
        enabled = nearOpening;
      } else if (def.actionOnProximity === 'floor') {
        const currentTile = getTileAt(tilesDict, playerX, playerY);
        enabled = (currentTile === '.' || currentTile === '@');
      } else {
        // Unknown proximity defaults to disabled or custom handling
        enabled = false;
      }
    }

    if (enabled) {
      actions.push({
        key: def.key,
        label: def.label,
        description: def.description,
        enabled: true
      });
    }
  }

    const overlay = {
      title: 'Available Actions',
      description: 'What would you like to do?',
      image: '',
      actions: actions
    };

    callback(null, { overlay, trace });
  } catch (err) {
    log.error('Error:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(ActionService.service, { getAvailableActions });
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
