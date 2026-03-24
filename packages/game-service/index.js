const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GameService, WorldService, RoomService, DiceService } = require('@wow/proto');

const PORT = process.env.GAME_SERVICE_PORT || 50062;
const WORLD_SERVICE_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';
const ROOM_SERVICE_URL = process.env.ROOM_SERVICE_URL || 'localhost:50056';
const DICE_SERVICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';

const worldClient = new WorldService(WORLD_SERVICE_URL, grpc.credentials.createInsecure());
const roomClient = new RoomService(ROOM_SERVICE_URL, grpc.credentials.createInsecure());
const diceClient = new DiceService(DICE_SERVICE_URL, grpc.credentials.createInsecure());

const KEYMAP_PATH = path.join(__dirname, '../../data/keymap.json');
const CAMPAIGNS_DIR = path.join(__dirname, '../../data/campaigns');
const SETTINGS_PATH = path.join(__dirname, '../../data/settings.json');

// Log level enum — all log level checks use these constants, never raw strings
const LogLevel = Object.freeze({
  ERROR: 'error',
  WARN:  'warn',
  INFO:  'info',
  DEBUG: 'debug',
});

const LOG_LEVEL_VALUE = Object.freeze({
  [LogLevel.ERROR]: 0,
  [LogLevel.WARN]:  1,
  [LogLevel.INFO]:  2,
  [LogLevel.DEBUG]: 3,
});

function getLogLevel() {
  return LOG_LEVEL_VALUE[settings.logLevel] ?? LOG_LEVEL_VALUE[LogLevel.INFO];
}
function logInfo(...args) {
  if (getLogLevel() >= LOG_LEVEL_VALUE[LogLevel.INFO]) console.log(...args);
}
function logDebug(...args) {
  if (getLogLevel() >= LOG_LEVEL_VALUE[LogLevel.DEBUG]) console.log(...args);
}
function logWarn(...args) {
  if (getLogLevel() >= LOG_LEVEL_VALUE[LogLevel.WARN]) console.warn(...args);
}

// ── In-memory game state ─────────────────────────────────────────────
let gameState = {
  campaignId: 'default',
  currentLevel: 0,
  levelName: '',
  totalLevels: 0,
  started: false,
};

// ── Settings (persisted to disk) ─────────────────────────────────────
let settings = {
  audio: true,
  musicVolume: 0.5,
  sfxVolume: 0.7,
  keymapOverrides: {},
  logLevel: LogLevel.INFO,
};

// Load settings from disk on startup
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  }
} catch (err) {
  console.warn('[GameService] Could not load settings, using defaults:', err.message);
}

function saveSettingsToDisk() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[GameService] Could not save settings:', err.message);
  }
}

// ── Async helpers ────────────────────────────────────────────────────

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
}

function makeAsyncCall(client, method, serviceName) {
  return function(req, parentTrace) {
    return new Promise((resolve, reject) => {
      const callerIdentity = {
        traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
        spanId: crypto.randomUUID(),
      };
      client[method]({ ...req, trace: callerIdentity }, (err, response) => {
        if (err) {
          if (parentTrace) {
            parentTrace.subSpans.push({ ...callerIdentity, serviceName, timeEnd: Date.now(), dataRet: JSON.stringify({ error: err.message }) });
          }
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

const rollDiceAsync = makeAsyncCall(diceClient, 'RollDice', 'dice-service');
const resetWorldAsync = makeAsyncCall(worldClient, 'ResetWorld', 'world-service');
const initWorldAsync = makeAsyncCall(worldClient, 'InitWorld', 'world-service');
const placeStructureAsync = makeAsyncCall(worldClient, 'PlaceStructure', 'world-service');
const generateRoomAsync = makeAsyncCall(roomClient, 'GenerateRoom', 'room-service');
const generateCorridorAsync = makeAsyncCall(roomClient, 'GenerateCorridor', 'room-service');

// ── Campaign loading ─────────────────────────────────────────────────

function loadCampaign(campaignId) {
  const campPath = path.join(CAMPAIGNS_DIR, `${campaignId}.json`);
  return JSON.parse(fs.readFileSync(campPath, 'utf8'));
}

function getLevelConfig(campaign, level) {
  if (!campaign.levels || !Array.isArray(campaign.levels)) {
    return { maxDimensionX: 100, maxDimensionY: 100, maxRooms: 15, maxEnemies: 10, difficulty: 1 };
  }
  const idx = Math.min(level, campaign.levels.length - 1);
  return campaign.levels[idx];
}

// ── RPC: GetKeymap ───────────────────────────────────────────────────

function getKeymap(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'game-service',
    data: '',
    subSpans: []
  };

  try {
    const data = fs.readFileSync(KEYMAP_PATH, 'utf8');
    callback(null, { keymapJson: data, trace });
  } catch (err) {
    console.error('[GameService] Error reading keymap:', err.message);
    callback(err);
  }
}

// ── RPC: GetCampaign ─────────────────────────────────────────────────

function getCampaign(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'game-service',
    data: call.request.campaignId || 'default',
    subSpans: []
  };

  try {
    const campId = call.request.campaignId || 'default';
    const campaign = loadCampaign(campId);
    callback(null, { campaignJson: JSON.stringify(campaign), trace });
  } catch (err) {
    console.error('[GameService] Error reading campaign:', err.message);
    callback(err);
  }
}

// ── RPC: GetGameState ────────────────────────────────────────────────

function getGameState(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'game-service',
    data: '',
    subSpans: []
  };

  callback(null, {
    campaignId: gameState.campaignId,
    currentLevel: gameState.currentLevel,
    levelName: gameState.levelName,
    totalLevels: gameState.totalLevels,
    settingsJson: JSON.stringify(settings),
    trace
  });
}

// ── RPC: GetSettings ─────────────────────────────────────────────────

function getSettings(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'game-service',
    data: '',
    subSpans: []
  };

  callback(null, { settingsJson: JSON.stringify(settings), trace });
}

// ── RPC: UpdateSettings ──────────────────────────────────────────────

function updateSettings(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'game-service',
    data: call.request.settingsJson,
    subSpans: []
  };

  try {
    const incoming = JSON.parse(call.request.settingsJson || '{}');
    settings = { ...settings, ...incoming };
    saveSettingsToDisk();
    logInfo('[GameService] Settings updated:', settings);
    callback(null, { success: true, settingsJson: JSON.stringify(settings), trace });
  } catch (err) {
    console.error('[GameService] Error updating settings:', err.message);
    callback(err);
  }
}

// ── Graph-based level generation ─────────────────────────────────────
// Door distribution: 1 door 10%, 2 doors 70%, 3+ doors 20%
// Every door = one edge = one connection to another room.

function rollDoorCount() {
  const r = Math.random() * 100;
  if (r < 10) return 1;          // 10%
  if (r < 80) return 2;          // 70%
  if (r < 95) return 3;          // 15%
  return 4;                      // 5%
}

// Build a connected node graph where rooms are nodes and edges are door connections.
// Key invariant: each node's final door count == number of edges it participates in.
// 1. Roll initial door counts via distribution
// 2. Build a spanning tree for guaranteed connectivity (adjusting counts as needed)
// 3. Fill remaining door slots with extra edges
// 4. Trim any leftover unmatched door slots so doors == edges
function buildRoomGraph(numRooms) {
  const nodes = [];
  for (let i = 0; i < numRooms; i++) {
    const doorCount = rollDoorCount();
    nodes.push({ id: i, doorCount, edges: [] });
  }

  // Ensure first room (spawn) has at least 2 exits
  if (nodes[0].doorCount < 2) nodes[0].doorCount = 2;

  const edges = [];
  const edgeSet = new Set();

  function addEdge(a, b) {
    const key = `${Math.min(a,b)}-${Math.max(a,b)}`;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    edges.push([a, b]);
    nodes[a].edges.push(b);
    nodes[b].edges.push(a);
    return true;
  }

  // Step 1: Build spanning tree — every node reachable from node 0
  const remaining = [];
  for (let i = 1; i < numRooms; i++) remaining.push(i);
  // Fisher-Yates shuffle for organic layout
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }

  const inTree = new Set([0]);
  for (const nodeId of remaining) {
    // Pick a random tree node with spare door slots
    let candidates = [...inTree].filter(id => nodes[id].edges.length < nodes[id].doorCount);
    if (candidates.length === 0) {
      // All full — force-expand a random tree node
      const forced = [...inTree][Math.floor(Math.random() * inTree.size)];
      nodes[forced].doorCount++;
      candidates = [forced];
    }
    // Also ensure the new node has capacity (it needs at least 1 door for this edge)
    if (nodes[nodeId].doorCount < 1) nodes[nodeId].doorCount = 1;

    const parent = candidates[Math.floor(Math.random() * candidates.length)];
    addEdge(parent, nodeId);
    inTree.add(nodeId);
  }

  // Step 2: Fill remaining door slots with extra edges (loops/shortcuts)
  for (let i = 0; i < numRooms; i++) {
    while (nodes[i].edges.length < nodes[i].doorCount) {
      const candidates = [];
      for (let j = 0; j < numRooms; j++) {
        if (j === i) continue;
        if (nodes[j].edges.length >= nodes[j].doorCount) continue;
        const key = `${Math.min(i,j)}-${Math.max(i,j)}`;
        if (edgeSet.has(key)) continue;
        candidates.push(j);
      }
      if (candidates.length > 0) {
        const partner = candidates[Math.floor(Math.random() * candidates.length)];
        addEdge(i, partner);
      } else {
        break; // No valid partners
      }
    }
  }

  // Step 3: Trim door counts to match actual edge count (doors == edges, always)
  for (const node of nodes) {
    node.doorCount = node.edges.length;
  }

  return { nodes, edges };
}

// Print the level graph in a human-readable format (info level)
function printGraph(graph, roomData) {
  logInfo('');
  logInfo('┌──────────────────────────────────────────────────────────');
  logInfo('│ LEVEL GRAPH');
  logInfo('├──────────────────────────────────────────────────────────');

  for (const node of graph.nodes) {
    const neighbors = node.edges.map(n => `R${n}`).join(', ');
    const placed = roomData && roomData[node.id] ? (roomData[node.id].placed ? '  ✓' : '  ✗') : '';
    const dims = roomData && roomData[node.id]
      ? ` (${roomData[node.id].width}x${roomData[node.id].height})`
      : '';
    logInfo(`│  R${node.id} [${node.doorCount} doors]${dims}${placed} → ${neighbors}`);
  }

  logInfo('├──────────────────────────────────────────────────────────');
  logInfo(`│ Rooms: ${graph.nodes.length}  Edges: ${graph.edges.length}`);

  const dist = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  for (const n of graph.nodes) {
    if (n.doorCount >= 4) dist['4+']++;
    else dist[n.doorCount]++;
  }
  logInfo(`│ Distribution: 1-door=${dist[1]}  2-door=${dist[2]}  3-door=${dist[3]}  4+-door=${dist['4+']}`);

  logInfo('│ Edges: ' + graph.edges.map(([a, b]) => `R${a}↔R${b}`).join('  '));
  logInfo('└──────────────────────────────────────────────────────────');
  logInfo('');
}

// ── RPC: StartGame ───────────────────────────────────────────────────
// Generates a level using graph-based room placement:
// 1. Build a room graph (nodes=rooms, edges=door connections)
// 2. Generate each room via room-service with specified door count
// 3. Place rooms via world-service, connecting edges with corridors

async function startGame(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'game-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  try {
    const level = call.request.level || 0;
    const campaignId = call.request.campaignId || 'default';

    // Load campaign config
    const campaign = loadCampaign(campaignId);
    const levelConfig = getLevelConfig(campaign, level);

    logInfo(`[GameService] Starting campaign "${campaign.name}" level ${level}: "${levelConfig.name}"`);

    // Update game state
    gameState = {
      campaignId,
      currentLevel: level,
      levelName: levelConfig.name || `Level ${level}`,
      totalLevels: campaign.levels ? campaign.levels.length : 1,
      started: true,
    };

    // 1. Reset World
    await resetWorldAsync({}, trace);

    const numRooms = levelConfig.maxRooms || 10;
    const difficulty = levelConfig.difficulty || (level + 1);

    // 2. Build room graph (doors == edges for every node)
    const graph = buildRoomGraph(numRooms);

    // 3. Generate all rooms via room-service with exact door counts
    const roomData = [];
    for (const node of graph.nodes) {
      const genRoom = await generateRoomAsync({
        level: difficulty,
        doorCount: node.doorCount
      }, trace);
      roomData.push({
        id: node.id,
        width: genRoom.width,
        height: genRoom.height,
        description: genRoom.description,
        doors: genRoom.doors || [],
        tilesJson: genRoom.tilesJson || '{}',
        placed: false,
        worldX: 0,
        worldY: 0,
      });
    }

    // Print initial graph (before placement)
    logInfo('[GameService] === GRAPH BUILT ===');
    printGraph(graph, roomData);

    // 4. Place rooms using graph layout
    const room0 = roomData[0];
    const initRes = await initWorldAsync({
      width: room0.width,
      height: room0.height,
      description: room0.description,
      tilesJson: room0.tilesJson,
      doors: room0.doors
    }, trace);
    room0.placed = true;
    room0.worldX = 0;
    room0.worldY = 0;
    logInfo(`[GameService] Placed R0 (spawn) at (0,0) ${room0.width}x${room0.height}`);

    let roomsPlaced = 1;
    const halfX = (levelConfig.maxDimensionX || 100) / 2;
    const halfY = (levelConfig.maxDimensionY || 100) / 2;

    const edgeQueue = [];
    const processedEdges = new Set();
    enqueueEdgesForRoom(0, graph.edges, edgeQueue, processedEdges);

    const maxPlacementAttempts = numRooms * 5;
    let placementAttempts = 0;

    while (edgeQueue.length > 0 && placementAttempts < maxPlacementAttempts) {
      placementAttempts++;
      const [a, b] = edgeQueue.shift();
      const edgeKey = `${Math.min(a,b)}-${Math.max(a,b)}`;
      if (processedEdges.has(edgeKey)) continue;
      processedEdges.add(edgeKey);

      const placedId = roomData[a].placed ? a : (roomData[b].placed ? b : -1);
      const unplacedId = placedId === a ? b : a;

      if (placedId === -1) {
        edgeQueue.push([a, b]);
        processedEdges.delete(edgeKey);
        continue;
      }

      if (roomData[unplacedId].placed) {
        logDebug(`[GameService] Edge R${a}↔R${b}: both placed, adding corridor`);
        await connectRoomsWithCorridor(roomData[placedId], roomData[unplacedId], difficulty, trace);
        continue;
      }

      const placedRoom = roomData[placedId];
      const newRoom = roomData[unplacedId];
      const placedDoorLocal = pickAvailableDoor(placedRoom);
      if (!placedDoorLocal) {
        logDebug(`[GameService] Edge R${placedId}↔R${unplacedId}: no available door on R${placedId}, skipping`);
        continue;
      }

      const anchorX = placedRoom.worldX + placedDoorLocal.x;
      const anchorY = placedRoom.worldY + placedDoorLocal.y;

      if (Math.abs(anchorX) > halfX - 15 || Math.abs(anchorY) > halfY - 15) {
        logDebug(`[GameService] Edge R${placedId}↔R${unplacedId}: out of bounds at (${anchorX},${anchorY})`);
        continue;
      }

      const corrRes = await generateCorridorAsync({ level: difficulty }, trace);
      const isVertical = corrRes.direction === 'N' || corrRes.direction === 'S';
      const corrWidth = isVertical ? 3 : corrRes.length;
      const corrHeight = isVertical ? corrRes.length : 3;

      const corrPlaceRes = await placeStructureAsync({
        structureType: 'corridor',
        width: corrWidth,
        height: corrHeight,
        description: corrRes.description,
        tilesJson: corrRes.tilesJson || '{}',
        doors: [],
        anchorX, anchorY,
        direction: corrRes.direction
      }, trace);

      if (!corrPlaceRes.fitSuccess) {
        const placeRes = await placeStructureAsync({
          structureType: 'room',
          width: newRoom.width,
          height: newRoom.height,
          description: newRoom.description,
          tilesJson: newRoom.tilesJson,
          doors: newRoom.doors,
          anchorX, anchorY,
          direction: ''
        }, trace);

        if (placeRes.fitSuccess) {
          newRoom.placed = true;
          newRoom.worldX = placeRes.originX || anchorX;
          newRoom.worldY = placeRes.originY || anchorY;
          roomsPlaced++;
          logDebug(`[GameService] Edge R${placedId}↔R${unplacedId}: placed R${unplacedId} directly at (${newRoom.worldX},${newRoom.worldY})`);
          enqueueEdgesForRoom(unplacedId, graph.edges, edgeQueue, processedEdges);
        } else {
          logDebug(`[GameService] Edge R${placedId}↔R${unplacedId}: FAILED to place (corridor+room both blocked)`);
        }
        continue;
      }

      const corrTiles = JSON.parse(corrPlaceRes.tilesJson || '{}');
      let corridorEndDoor = null;
      for (const [coord, ch] of Object.entries(corrTiles)) {
        if (ch === '+') {
          const [cx, cy] = coord.split(',').map(Number);
          if (!corridorEndDoor || Math.abs(cx - anchorX) + Math.abs(cy - anchorY) >
              Math.abs(corridorEndDoor.x - anchorX) + Math.abs(corridorEndDoor.y - anchorY)) {
            corridorEndDoor = { x: cx, y: cy };
          }
        }
      }

      if (corridorEndDoor) {
        const placeRes = await placeStructureAsync({
          structureType: 'room',
          width: newRoom.width,
          height: newRoom.height,
          description: newRoom.description,
          tilesJson: newRoom.tilesJson,
          doors: newRoom.doors,
          anchorX: corridorEndDoor.x,
          anchorY: corridorEndDoor.y,
          direction: ''
        }, trace);

        if (placeRes.fitSuccess) {
          newRoom.placed = true;
          newRoom.worldX = placeRes.originX || corridorEndDoor.x;
          newRoom.worldY = placeRes.originY || corridorEndDoor.y;
          roomsPlaced++;
          logDebug(`[GameService] Edge R${placedId}↔R${unplacedId}: placed R${unplacedId} via corridor at (${newRoom.worldX},${newRoom.worldY})`);
          enqueueEdgesForRoom(unplacedId, graph.edges, edgeQueue, processedEdges);
        } else {
          logDebug(`[GameService] Edge R${placedId}↔R${unplacedId}: corridor placed but R${unplacedId} didn't fit`);
        }
      }
    }

    // Print final placement results
    logInfo('[GameService] === PLACEMENT RESULTS ===');
    printGraph(graph, roomData);
    for (const rd of roomData) {
      const status = rd.placed ? `placed at (${rd.worldX},${rd.worldY})` : 'NOT PLACED';
      logInfo(`[GameService]   R${rd.id}: ${rd.width}x${rd.height}, ${rd.doors.length} doors — ${status}`);
    }
    logInfo(`[GameService] Map generation complete. Rooms placed: ${roomsPlaced}/${numRooms}, Attempts: ${placementAttempts}`);

    callback(null, {
      success: true,
      levelName: levelConfig.name || `Level ${level}`,
      levelDescription: levelConfig.description || '',
      currentLevel: level,
      trace
    });
  } catch (err) {
    console.error('[GameService] Error starting game:', err.message);
    callback(err);
  }
}

// Pick a door from a room that hasn't been used for a connection yet
function pickAvailableDoor(room) {
  if (!room.doors || room.doors.length === 0) return null;
  if (!room._usedDoorIndices) room._usedDoorIndices = new Set();

  for (let i = 0; i < room.doors.length; i++) {
    if (!room._usedDoorIndices.has(i)) {
      room._usedDoorIndices.add(i);
      return room.doors[i];
    }
  }
  // All doors used — reuse a random one (corridor will branch from it)
  return room.doors[Math.floor(Math.random() * room.doors.length)];
}

// Add edges for a newly-placed room to the processing queue
function enqueueEdgesForRoom(roomId, allEdges, queue, processedEdges) {
  for (const [a, b] of allEdges) {
    if (a === roomId || b === roomId) {
      const key = `${Math.min(a,b)}-${Math.max(a,b)}`;
      if (!processedEdges.has(key)) {
        queue.push([a, b]);
      }
    }
  }
}

// Connect two already-placed rooms with a corridor between their closest doors
async function connectRoomsWithCorridor(roomA, roomB, difficulty, trace) {
  const doorA = pickAvailableDoor(roomA);
  const doorB = pickAvailableDoor(roomB);
  if (!doorA || !doorB) return;

  const ax = roomA.worldX + doorA.x;
  const ay = roomA.worldY + doorA.y;

  const corrRes = await generateCorridorAsync({ level: difficulty }, trace);
  const isVertical = corrRes.direction === 'N' || corrRes.direction === 'S';

  await placeStructureAsync({
    structureType: 'corridor',
    width: isVertical ? 3 : corrRes.length,
    height: isVertical ? corrRes.length : 3,
    description: corrRes.description,
    tilesJson: corrRes.tilesJson || '{}',
    doors: [],
    anchorX: ax, anchorY: ay,
    direction: corrRes.direction
  }, trace);
}

// ── Server bootstrap ─────────────────────────────────────────────────

function main() {
  const server = new grpc.Server();
  server.addService(GameService.service, {
    startGame,
    getKeymap,
    getCampaign,
    getGameState,
    getSettings,
    updateSettings,
  });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[GameService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[GameService] Running on port ${port}`);
    }
  );
}

main();
