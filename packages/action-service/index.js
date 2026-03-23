const { grpc, ActionService } = require('@wow/proto');

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

function getAvailableActions(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'action-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { tilesJson, playerX, playerY } = call.request;
  
  let tilesDict;
  try { tilesDict = JSON.parse(tilesJson || "{}"); } catch { tilesDict = {}; }
  
  const actions = [];

  // Always available: movement (but we don't list each direction)
  // Check adjacent tiles for context-sensitive actions
  const adjacent = [
    { dx: 0, dy: -1, dir: 'north' },
    { dx: 0, dy: 1, dir: 'south' },
    { dx: -1, dy: 0, dir: 'west' },
    { dx: 1, dy: 0, dir: 'east' },
  ];

  let hasDoor = false;
  let hasWall = false;

  for (const { dx, dy, dir } of adjacent) {
    const tile = getTileAt(tilesDict, playerX + dx, playerY + dy);
    if (tile === TILE.DOOR || tile === '+') {
      hasDoor = true;
      actions.push({
        key: 'o',
        label: 'Open Door',
        description: `Open the door to the ${dir}`,
        enabled: true,
      });
    }
    if (tile === TILE.WALL) {
      hasWall = true;
    }
  }

  // Search action is always available in rooms
  const currentTile = getTileAt(tilesDict, playerX, playerY);
  if (currentTile === TILE.PLAYER || currentTile === TILE.FLOOR || currentTile === '@' || currentTile === '.') {
    actions.push({
      key: 's',
      label: 'Search',
      description: 'Search the area for hidden objects',
      enabled: true,
    });
  }

  // Inventory
  actions.push({
    key: 'i',
    label: 'Inventory',
    description: 'Open your inventory',
    enabled: true,
  });

  // Wait/Rest
  actions.push({
    key: '.',
    label: 'Wait',
    description: 'Wait one turn',
    enabled: true,
  });

  const overlay = {
    title: 'Available Actions',
    description: 'What would you like to do?',
    image: '',
    actions: actions
  };

  callback(null, { overlay, trace });
}

function main() {
  const server = new grpc.Server();
  server.addService(ActionService.service, { getAvailableActions });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[ActionService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[ActionService] Running on port ${port}`);
    }
  );
}

main();
