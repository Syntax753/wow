const crypto = require('crypto');
const { grpc, MultiService, DndService, HeroService, GameService, WorldService, createLogger } = require('@wow/proto');

const log = createLogger('MultiService');

const PORT = process.env.MULTI_SERVICE_PORT || '50063';
const DND_URL = process.env.DND_SERVICE_URL || 'localhost:50052';
const HERO_URL = process.env.HERO_SERVICE_URL || 'localhost:50053';
const GAME_URL = process.env.GAME_SERVICE_URL || 'localhost:50062';
const WORLD_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';

const dndClient = new DndService(DND_URL, grpc.credentials.createInsecure());
const heroClient = new HeroService(HERO_URL, grpc.credentials.createInsecure());
const gameClient = new GameService(GAME_URL, grpc.credentials.createInsecure());
const worldClient = new WorldService(WORLD_URL, grpc.credentials.createInsecure());

// ── Color palette ─────────────────────────────────────────────────────
const PLAYER_COLORS = [
  '#22c55e', '#ef4444', '#3b82f6', '#eab308', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
];

// ── In-memory session state ───────────────────────────────────────────
const sessions = {}; // { [playerId]: { name, color, active, lastSeen, spawnIndex } }
let worldActive = false;
let spawnPositions = []; // [{x, y}] from game-service
let nextSpawnIndex = 0;

// Shared fog-of-war player ID — all multiplayer players share this
const SHARED_FOW_ID = 'multi-shared';

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
}

// ── Async helper ──────────────────────────────────────────────────────
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
          childTrace.dataRet = cloneReqRes(response);
          if (parentTrace) parentTrace.subSpans.push(childTrace);
          resolve(response);
        }
      });
    });
  };
}

const processInputAsync = makeAsyncCall(dndClient, 'ProcessInput', 'dnd-service');
const computeMapModifiersAsync = makeAsyncCall(dndClient, 'ComputeMapModifiers', 'dnd-service');
const getHeroAsync = makeAsyncCall(heroClient, 'GetHero', 'hero-service');
const resetHeroAsync = makeAsyncCall(heroClient, 'ResetHero', 'hero-service');
const updatePositionAsync = makeAsyncCall(heroClient, 'UpdatePosition', 'hero-service');
const startGameAsync = makeAsyncCall(gameClient, 'StartGame', 'game-service');
const getGameStateAsync = makeAsyncCall(gameClient, 'GetGameState', 'game-service');
const revealTilesAsync = makeAsyncCall(worldClient, 'RevealTiles', 'world-service');

// ── Helpers ───────────────────────────────────────────────────────────

function getActiveSessions() {
  return Object.entries(sessions).filter(([, s]) => s.active);
}

function getActiveCount() {
  return getActiveSessions().length;
}

function assignColor() {
  const usedColors = new Set(getActiveSessions().map(([, s]) => s.color));
  for (const c of PLAYER_COLORS) {
    if (!usedColors.has(c)) return c;
  }
  return PLAYER_COLORS[Object.keys(sessions).length % PLAYER_COLORS.length];
}

async function buildPlayersJson(trace) {
  const active = getActiveSessions();
  const positions = [];
  for (const [pid, s] of active) {
    try {
      const hero = await getHeroAsync({ heroId: pid }, trace);
      positions.push({ x: hero.positionX || 0, y: hero.positionY || 0, playerId: pid, color: s.color });
    } catch {
      // Hero not found — skip
    }
  }
  return JSON.stringify(positions);
}

// Note: discovered areas are merged into 'multi-shared' fog ID by dnd-service
// automatically when playersJson has multiple players. No explicit merge needed here.

// Stale player cleanup (5 min timeout)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [pid, s] of Object.entries(sessions)) {
    if (s.active && s.lastSeen < cutoff) {
      s.active = false;
      log.info(`Player ${s.name} (${pid}) timed out`);
    }
  }
  if (worldActive && getActiveCount() === 0) {
    worldActive = false;
    log.info('All players left — world marked inactive');
  }
}, 60000);

// ── RPC: JoinSession ──────────────────────────────────────────────────
async function joinSession(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'multi-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  try {
    const { playerId, name, heroClass, campaignId } = call.request;
    const color = assignColor();

    // Check if we need to generate a new world
    const activeCount = getActiveCount();
    if (!worldActive || activeCount === 0) {
      log.info(`[Multi] No active world — generating fresh level`);
      nextSpawnIndex = 0;
      const gameRes = await startGameAsync({
        level: 0,
        campaignId: campaignId || 'default',
        maxPlayers: 4,
      }, trace);
      spawnPositions = JSON.parse(gameRes.spawnPositionsJson || '[]');
      worldActive = true;
      log.info(`[Multi] World generated: ${gameRes.levelName}, spawns: ${JSON.stringify(spawnPositions)}`);
    } else {
      // Fetch existing spawn positions
      const gameState = await getGameStateAsync({}, trace);
      spawnPositions = JSON.parse(gameState.spawnPositionsJson || '[]');
    }

    // All players start at (0,0) — center of the first room
    const spawn = { x: 0, y: 0 };

    // Create/reset hero at shared spawn
    await resetHeroAsync({ heroId: playerId, name: name || 'Adventurer', heroClass: heroClass || 'Fighter' }, trace);
    await updatePositionAsync({ heroId: playerId, x: spawn.x, y: spawn.y }, trace);

    sessions[playerId] = { name, color, active: true, lastSeen: Date.now(), spawnIndex: 0 };

    log.info(`[Multi] ${name} (${playerId}) joined at (${spawn.x},${spawn.y}) color=${color}`);

    callback(null, {
      success: true,
      color,
      spawnX: spawn.x,
      spawnY: spawn.y,
      levelName: '',
      activePlayers: getActiveCount(),
      trace,
    });
  } catch (err) {
    log.error('JoinSession error:', err.message);
    callback(err);
  }
}

// ── RPC: LeaveSession ─────────────────────────────────────────────────
async function leaveSession(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'multi-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { playerId } = call.request;
  if (sessions[playerId]) {
    sessions[playerId].active = false;
    log.info(`[Multi] ${sessions[playerId].name} (${playerId}) left`);
  }

  const activeCount = getActiveCount();
  if (activeCount === 0) {
    worldActive = false;
    log.info('[Multi] All players left — world marked inactive');
  }

  callback(null, { success: true, activePlayers: activeCount, trace });
}

// ── RPC: ProcessMultiInput ────────────────────────────────────────────
async function processMultiInput(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'multi-service',
    data: JSON.stringify({ playerId: call.request.playerId, key: call.request.key }),
    subSpans: []
  };

  try {
    const { playerId, key, visualRange, currentEnemiesJson, level } = call.request;

    // Update lastSeen
    if (sessions[playerId]) sessions[playerId].lastSeen = Date.now();

    // Build combined player positions
    const playersJson = await buildPlayersJson(trace);


    // Forward to dnd-service with shared fog-of-war ID
    const result = await processInputAsync({
      key: key || '',
      visualRange: visualRange || 8,
      currentEnemiesJson: currentEnemiesJson || '[]',
      level: level || 1,
      heroId: playerId,
      playersJson,
    }, trace);

    callback(null, {
      mergedTilesJson: result.mergedTilesJson,
      updatedEnemiesJson: result.updatedEnemiesJson,
      newCollisionTiles: result.newCollisionTiles,
      newRoomsJson: result.newRoomsJson,
      playerX: result.playerX,
      playerY: result.playerY,
      message: result.message,
      action: result.action,
      trace,
    });
  } catch (err) {
    log.error('ProcessMultiInput error:', err.message);
    callback(err);
  }
}

// ── RPC: SyncMultiPlayer ──────────────────────────────────────────────
async function syncMultiPlayer(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'multi-service',
    data: JSON.stringify({ playerId: call.request.playerId }),
    subSpans: []
  };

  try {
    const { playerId, playerX, playerY, visualRange, currentEnemiesJson } = call.request;

    if (sessions[playerId]) sessions[playerId].lastSeen = Date.now();

    const playersJson = await buildPlayersJson(trace);

    // Merge revealed tiles into shared fog-of-war
    await mergeRevealedTiles(trace);

    // Use shared fog-of-war ID so player sees everywhere anyone has explored
    const result = await computeMapModifiersAsync({
      playerX: playerX || 0,
      playerY: playerY || 0,
      visualRange: visualRange || 8,
      currentEnemiesJson: currentEnemiesJson || '[]',
      heroId: playerId,
      playersJson,
    }, trace);

    callback(null, {
      mergedTilesJson: result.mergedTilesJson,
      newCollisionTiles: result.newCollisionTiles,
      newPlayerX: result.newPlayerX,
      newPlayerY: result.newPlayerY,
      newRoomsJson: result.newRoomsJson,
      updatedEnemiesJson: result.updatedEnemiesJson,
      trace,
    });
  } catch (err) {
    log.error('SyncMultiPlayer error:', err.message);
    callback(err);
  }
}

// ── RPC: GetSessionInfo ───────────────────────────────────────────────
async function getSessionInfo(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'multi-service',
    data: '',
    subSpans: []
  };

  const activePlayers = getActiveCount();
  const playerList = getActiveSessions().map(([pid, s]) => ({
    playerId: pid, name: s.name, color: s.color,
  }));

  callback(null, {
    activePlayers,
    worldExists: worldActive,
    levelName: '',
    playersJson: JSON.stringify(playerList),
    trace,
  });
}

// ── Server bootstrap ──────────────────────────────────────────────────
function main() {
  const server = new grpc.Server();
  server.addService(MultiService.service, {
    joinSession,
    leaveSession,
    processMultiInput,
    syncMultiPlayer,
    getSessionInfo,
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
