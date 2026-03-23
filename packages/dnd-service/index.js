const { grpc, DiceService, DndService, RoomService, RenderService, EnemyService, ShadeService, WorldService } = require('@wow/proto');
const crypto = require('crypto');

const PORT = process.env.DND_SERVICE_PORT || '50052';
const DICE_SERVICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';
const ROOM_SERVICE_URL = process.env.ROOM_SERVICE_URL || 'localhost:50056';
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || 'localhost:50058';
const ENEMY_SERVICE_URL = process.env.ENEMY_SERVICE_URL || 'localhost:50059';
const SHADE_SERVICE_URL = process.env.SHADE_SERVICE_URL || 'localhost:50057';
const WORLD_SERVICE_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';

const diceClient = new DiceService(DICE_SERVICE_URL, grpc.credentials.createInsecure());
const roomClient = new RoomService(ROOM_SERVICE_URL, grpc.credentials.createInsecure());
const renderClient = new RenderService(RENDER_SERVICE_URL, grpc.credentials.createInsecure());
const enemyClient = new EnemyService(ENEMY_SERVICE_URL, grpc.credentials.createInsecure());
const shadeClient = new ShadeService(SHADE_SERVICE_URL, grpc.credentials.createInsecure());
const worldClient = new WorldService(WORLD_SERVICE_URL, grpc.credentials.createInsecure());

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
}

// ── Async wrappers with trace propagation ──────────────────────────────

function makeAsyncCall(client, method, serviceName) {
  return function(req, parentTrace) {
    return new Promise((resolve, reject) => {
      const callerIdentity = {
        traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
        spanId: crypto.randomUUID(),
      };

      const requestWithTrace = { ...req, trace: callerIdentity };

      client[method](requestWithTrace, (err, response) => {
        if (err) {
          const errSpan = {
            ...callerIdentity,
            serviceName,
            timeEnd: Date.now(),
            dataRet: JSON.stringify({ error: err.message })
          };
          if (parentTrace) parentTrace.subSpans.push(errSpan);
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

const rollDiceAsync = function(dice, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };

    diceClient.rollDice({ dice, trace: callerIdentity }, (err, response) => {
      if (err) {
        const errSpan = { ...callerIdentity, serviceName: 'dice-service', timeEnd: Date.now(), dataRet: JSON.stringify({ error: err.message }) };
        if (parentTrace) parentTrace.subSpans.push(errSpan);
        reject(err);
      } else {
        const childTrace = response.trace || { ...callerIdentity, serviceName: 'dice-service' };
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        if (parentTrace) parentTrace.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
};

const generateRoomAsync = makeAsyncCall(roomClient, 'GenerateRoom', 'room-service');
const generateCorridorAsync = makeAsyncCall(roomClient, 'GenerateCorridor', 'room-service');
const compositeLayersAsync = makeAsyncCall(renderClient, 'CompositeLayers', 'render-service');
const processEnemiesAsync = makeAsyncCall(enemyClient, 'ProcessEnemies', 'enemy-service');
const computeVisibilityAsync = makeAsyncCall(shadeClient, 'ComputeVisibility', 'shade-service');
const getWorldStateAsync = makeAsyncCall(worldClient, 'GetWorldState', 'world-service');
const initWorldAsync = makeAsyncCall(worldClient, 'InitWorld', 'world-service');
const placeStructureAsync = makeAsyncCall(worldClient, 'PlaceStructure', 'world-service');
const resetWorldAsync = makeAsyncCall(worldClient, 'ResetWorld', 'world-service');

// ── Helper: build layers from world tiles and run render pipeline ──────
async function buildAndRender(tilesJsonStr, roomsJsonStr, px, py, visualRange, currentEnemiesJson, trace) {
  let tilesDict;
  try { tilesDict = JSON.parse(tilesJsonStr || '{}'); } catch { tilesDict = {}; }

  // Split raw tiles into Layer 0 (Base) and Layer 20 (Interactables)
  const baseMap = {};
  const interactables = {};
  for (const [coord, ch] of Object.entries(tilesDict)) {
    if (ch === '#' || ch === '.' || ch === ' ') {
      baseMap[coord] = ch;
    } else {
      baseMap[coord] = '.';
      interactables[coord] = ch;
    }
  }

  const layer0 = { layerType: 0, tilesJson: JSON.stringify(baseMap) };
  const layer20 = { layerType: 20, tilesJson: JSON.stringify(interactables) };

  // Enemy layer
  const enemyResponse = await processEnemiesAsync({
    tilesJson: tilesJsonStr,
    roomsJson: roomsJsonStr,
    playerX: px,
    playerY: py,
    currentEnemiesJson: currentEnemiesJson || '[]'
  }, trace);

  const layer30 = { layerType: 30, tilesJson: enemyResponse.enemyLayer?.tilesJson || '{}' };

  // FOV layer
  const shadeResponse = await computeVisibilityAsync({
    tilesJson: tilesJsonStr,
    playerX: px,
    playerY: py,
    visualRange: visualRange || 8
  }, trace);

  const layer10 = { layerType: 10, tilesJson: shadeResponse.tilesJson };

  // Composite via render-service
  const renderResponse = await compositeLayersAsync({
    playerX: px,
    playerY: py,
    layers: [layer0, layer10, layer20, layer30]
  }, trace);

  return {
    mergedTilesJson: renderResponse.mergedTilesJson,
    updatedEnemiesJson: enemyResponse.updatedEnemiesJson || ''
  };
}

// ── RPC: ExploreDoor ───────────────────────────────────────────────────
async function exploreDoor(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'dnd-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  try {
    // 1. Roll 1d20 to determine Room vs Corridor
    const typeRoll = await rollDiceAsync(['1d20'], trace);
    const score = typeRoll.grandTotal;
    const isRoom = score <= 8; // 1-8 Room, 9-20 Corridor

    const px = call.request.playerX ?? 0;
    const py = call.request.playerY ?? 0;
    const anchorX = call.request.anchorX;
    const anchorY = call.request.anchorY;

    let structureType, width, height, description, doors, direction;

    if (isRoom) {
      // 2a. Generate room structure (local coords) from room-service
      const roomRes = await generateRoomAsync({ level: call.request.level }, trace);
      structureType = 'room';
      width = roomRes.width;
      height = roomRes.height;
      description = roomRes.description;
      doors = roomRes.doors || [];
      direction = '';
    } else {
      // 2b. Generate corridor structure (local coords) from room-service
      const corrRes = await generateCorridorAsync({ level: call.request.level }, trace);
      structureType = 'corridor';
      const isVertical = corrRes.direction === 'N' || corrRes.direction === 'S';
      width = isVertical ? 1 : corrRes.length;
      height = isVertical ? corrRes.length : 1;
      description = corrRes.description;
      doors = [];
      direction = corrRes.direction;
    }

    // 3. Place structure into the world via world-service
    const placeRes = await placeStructureAsync({
      structureType,
      width,
      height,
      description,
      tilesJson: '{}', // world-service has its own state
      doors,
      anchorX,
      anchorY,
      direction
    }, trace);

    if (!placeRes.fitSuccess) {
      callback(null, {
        structureType, width: 0, height: 0,
        description: 'The doorway collapses into solid rock...',
        doors: [], trace,
        fitSuccess: false,
        originX: 0, originY: 0,
        newTilesJson: placeRes.tilesJson,
        mergedTilesJson: '',
        updatedEnemiesJson: '',
        newRoomsJson: placeRes.roomsJson
      });
      return;
    }

    console.log(`[DndService] Orchestrated ${structureType}: fit at ${placeRes.originX},${placeRes.originY}`);

    // 4. Run render pipeline with updated world state
    const rendered = await buildAndRender(
      placeRes.tilesJson, placeRes.roomsJson,
      px, py,
      call.request.visualRange,
      call.request.currentEnemiesJson,
      trace
    );

    callback(null, {
      structureType,
      width,
      height,
      description,
      doors,
      trace,
      fitSuccess: true,
      originX: placeRes.originX,
      originY: placeRes.originY,
      newTilesJson: placeRes.tilesJson,
      mergedTilesJson: rendered.mergedTilesJson,
      updatedEnemiesJson: rendered.updatedEnemiesJson,
      newRoomsJson: placeRes.roomsJson
    });
  } catch (err) {
    console.error('[DndService] Error orchestrating door explore:', err.message);
    callback(err);
  }
}

// ── RPC: ComputeMapModifiers ───────────────────────────────────────────
async function computeMapModifiers(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'dnd-service',
    data: JSON.stringify({
      px: call.request.playerX,
      py: call.request.playerY
    }),
    subSpans: []
  };

  try {
    let px = call.request.playerX ?? 0;
    let py = call.request.playerY ?? 0;
    let isInit = false;

    // 1. Get current world state from world-service
    const worldState = await getWorldStateAsync({}, trace);
    let tilesJsonStr = worldState.tilesJson || '{}';
    let roomsJsonStr = worldState.roomsJson || '[]';

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJsonStr); } catch { tilesDict = {}; }

    // 2. If world is empty, initialize with a starter room
    if (Object.keys(tilesDict).length === 0) {
      isInit = true;

      // Generate a room via room-service (pure generator)
      const roomRes = await generateRoomAsync({ level: 1 }, trace);

      // Initialize world via world-service (places room centered at 0,0)
      const initRes = await initWorldAsync({
        width: roomRes.width,
        height: roomRes.height,
        description: roomRes.description,
        tilesJson: roomRes.tilesJson,
        doors: roomRes.doors || []
      }, trace);

      tilesJsonStr = initRes.tilesJson;
      roomsJsonStr = initRes.roomsJson;
      px = initRes.playerX;
      py = initRes.playerY;

      console.log(`[DndService] Initialized world via world-service`);
    }

    // 3. Run render pipeline
    const rendered = await buildAndRender(
      tilesJsonStr, roomsJsonStr,
      px, py,
      call.request.visualRange,
      call.request.currentEnemiesJson,
      trace
    );

    const responsePayload = {
      mergedTilesJson: rendered.mergedTilesJson,
      updatedEnemiesJson: rendered.updatedEnemiesJson,
      trace
    };

    if (isInit) {
      responsePayload.newCollisionTiles = tilesJsonStr;
      responsePayload.newPlayerX = px;
      responsePayload.newPlayerY = py;
      responsePayload.newRoomsJson = roomsJsonStr;
    }

    callback(null, responsePayload);
  } catch (err) {
    console.error('[DndService] Error orchestrating map modifiers:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(DndService.service, {
    exploreDoor,
    computeMapModifiers
  });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[DndService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[DndService] Running on port ${port}`);
    }
  );
}

main();
