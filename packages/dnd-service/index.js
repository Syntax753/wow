const { grpc, DiceService, DndService, RoomService, RenderService, EnemyService, ShadeService, WorldService, HeroService, InputService, GameService } = require('@wow/proto');
const crypto = require('crypto');

const PORT = process.env.DND_SERVICE_PORT || '50052';
const DICE_SERVICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';
const ROOM_SERVICE_URL = process.env.ROOM_SERVICE_URL || 'localhost:50056';
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || 'localhost:50058';
const ENEMY_SERVICE_URL = process.env.ENEMY_SERVICE_URL || 'localhost:50059';
const SHADE_SERVICE_URL = process.env.SHADE_SERVICE_URL || 'localhost:50057';
const WORLD_SERVICE_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';
const HERO_SERVICE_URL = process.env.HERO_SERVICE_URL || 'localhost:50053';
const INPUT_SERVICE_URL = process.env.INPUT_SERVICE_URL || 'localhost:50061';
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'localhost:50062';

const diceClient = new DiceService(DICE_SERVICE_URL, grpc.credentials.createInsecure());
const roomClient = new RoomService(ROOM_SERVICE_URL, grpc.credentials.createInsecure());
const renderClient = new RenderService(RENDER_SERVICE_URL, grpc.credentials.createInsecure());
const enemyClient = new EnemyService(ENEMY_SERVICE_URL, grpc.credentials.createInsecure());
const shadeClient = new ShadeService(SHADE_SERVICE_URL, grpc.credentials.createInsecure());
const worldClient = new WorldService(WORLD_SERVICE_URL, grpc.credentials.createInsecure());
const heroClient = new HeroService(HERO_SERVICE_URL, grpc.credentials.createInsecure());
const inputClient = new InputService(INPUT_SERVICE_URL, grpc.credentials.createInsecure());
const gameClient = new GameService(GAME_SERVICE_URL, grpc.credentials.createInsecure());

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
const revealTilesAsync = makeAsyncCall(worldClient, 'RevealTiles', 'world-service');
const getHeroAsync = makeAsyncCall(heroClient, 'GetHero', 'hero-service');
const updatePositionAsync = makeAsyncCall(heroClient, 'UpdatePosition', 'hero-service');
const getEffectiveStatsAsync = makeAsyncCall(heroClient, 'GetEffectiveStats', 'hero-service');
const startGameAsync = makeAsyncCall(gameClient, 'StartGame', 'game-service');
const getKeymapAsync = makeAsyncCall(gameClient, 'GetKeymap', 'game-service');

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

  // Persist visible tiles into world-service's revealed set
  const revealResponse = await revealTilesAsync({
    visibleCoordsJson: shadeResponse.tilesJson
  }, trace);

  // Revealed layer (all tiles ever seen)
  const layer5 = { layerType: 5, tilesJson: revealResponse.revealedJson };

  // Composite via render-service
  const renderResponse = await compositeLayersAsync({
    playerX: px,
    playerY: py,
    layers: [layer0, layer5, layer10, layer20, layer30]
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
    // 1. Get hero effective stats for visibility
    const effectiveStats = await getEffectiveStatsAsync({ heroId: 'default' }, trace);
    const visualRange = effectiveStats.visibility || 6;

    // 2. Roll 1d20 to determine Room vs Corridor
    const typeRoll = await rollDiceAsync(['1d20'], trace);
    const score = typeRoll.grandTotal;
    const isRoom = score <= 8; // 1-8 Room, 9-20 Corridor

    const px = call.request.playerX ?? 0;
    const py = call.request.playerY ?? 0;
    const anchorX = call.request.anchorX;
    const anchorY = call.request.anchorY;

    let structureType, width, height, description, doors, direction, generatorTilesJson;

    if (isRoom) {
      // 2a. Generate room structure (local coords) from room-service
      const roomRes = await generateRoomAsync({ level: call.request.level }, trace);
      structureType = 'room';
      width = roomRes.width;
      height = roomRes.height;
      description = roomRes.description;
      doors = roomRes.doors || [];
      direction = '';
      generatorTilesJson = roomRes.tilesJson || '{}';
    } else {
      // 2b. Generate corridor structure (local coords) from room-service
      const corrRes = await generateCorridorAsync({ level: call.request.level }, trace);
      structureType = 'corridor';
      const isVertical = corrRes.direction === 'N' || corrRes.direction === 'S';
      width = isVertical ? 3 : corrRes.length;
      height = isVertical ? corrRes.length : 3;
      description = corrRes.description;
      doors = [];
      direction = corrRes.direction;
      generatorTilesJson = corrRes.tilesJson || '{}';
    }

    // 3. Place structure into the world via world-service
    const placeRes = await placeStructureAsync({
      structureType,
      width,
      height,
      description,
      tilesJson: generatorTilesJson,
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
      visualRange,
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
    let isInit = false;

    // 1. Get hero position and effective stats
    const hero = await getHeroAsync({ heroId: 'default' }, trace);
    const effectiveStats = await getEffectiveStatsAsync({ heroId: 'default' }, trace);
    const visualRange = effectiveStats.visibility || 6;
    let px = call.request.playerX ?? hero.positionX ?? 0;
    let py = call.request.playerY ?? hero.positionY ?? 0;

    // Update hero position from frontend (frontend tracks movement)
    if (call.request.playerX !== undefined) {
      await updatePositionAsync({ heroId: 'default', x: px, y: py }, trace);
    }

    // 2. Get current world state from world-service
    const worldState = await getWorldStateAsync({}, trace);
    let tilesJsonStr = worldState.tilesJson || '{}';
    let roomsJsonStr = worldState.roomsJson || '[]';

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJsonStr); } catch { tilesDict = {}; }

    // 3. If world is empty, initialize via game-service
    if (Object.keys(tilesDict).length === 0) {
      isInit = true;

      // Start the game, which pre-generates the entire map
      await startGameAsync({ level: 0 }, trace);

      // Now fetch the populated world state
      const newWorldState = await getWorldStateAsync({}, trace);
      tilesJsonStr = newWorldState.tilesJson || '{}';
      roomsJsonStr = newWorldState.roomsJson || '[]';
      px = 0; // The game-service places the start at 0,0
      py = 0;

      // Update hero with initial position
      await updatePositionAsync({ heroId: 'default', x: px, y: py }, trace);

      console.log(`[DndService] Initialized world via game-service`);
    }

    // 4. Run render pipeline with hero's effective visibility
    const rendered = await buildAndRender(
      tilesJsonStr, roomsJsonStr,
      px, py,
      visualRange,
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

// ── RPC: ProcessInput ─────────────────────────────────────────────────
// Unified input handler: validates keypress, moves player, triggers
// door exploration, and returns fully rendered map.
async function processInput(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'dnd-service',
    data: JSON.stringify({ key: call.request.key }),
    subSpans: []
  };

  try {
    const { key, currentEnemiesJson, level } = call.request;

    // 1. Get hero position and effective stats (includes inventory bonuses)
    const hero = await getHeroAsync({ heroId: 'default' }, trace);
    const effectiveStats = await getEffectiveStatsAsync({ heroId: 'default' }, trace);
    const visualRange = effectiveStats.visibility || 6;
    let px = hero.positionX ?? 0;
    let py = hero.positionY ?? 0;

    // 2. Get world state
    const worldState = await getWorldStateAsync({}, trace);
    let tilesJsonStr = worldState.tilesJson || '{}';
    let roomsJsonStr = worldState.roomsJson || '[]';

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJsonStr); } catch { tilesDict = {}; }

    // 3. If world is empty, initialize via game-service
    if (Object.keys(tilesDict).length === 0) {
      await startGameAsync({ level: level || 0 }, trace);

      const initRes = await getWorldStateAsync({}, trace);
      tilesJsonStr = initRes.tilesJson || '{}';
      roomsJsonStr = initRes.roomsJson || '[]';
      px = 0;
      py = 0;
      await updatePositionAsync({ heroId: 'default', x: px, y: py }, trace);
      console.log(`[DndService] Initialized world via ProcessInput through game-service`);
    }

    // 4. Fetch dynamic keymap
    const keymapRes = await getKeymapAsync({}, trace);
    const keymap = JSON.parse(keymapRes.keymapJson || '{}');

    // Find requested action
    let actionId = null;
    let actionDef = null;
    for (const [id, def] of Object.entries(keymap)) {
      if (def.key === key) {
        actionId = id;
        actionDef = def;
        break;
      }
    }

    let inputResult = { action: 'none', message: '', positionChanged: false, newX: px, newY: py };

    const getTile = (x, y) => tilesDict[`${x},${y}`] || ' ';

    if (actionId) {
      if (actionId.startsWith('move')) {
        const nx = px + actionDef.dx;
        const ny = py + actionDef.dy;
        const target = getTile(nx, ny);

        if (target === '#') {
          inputResult = { newX: px, newY: py, action: 'blocked', message: 'Ouch!', positionChanged: false };
        } else if (target === ' ') {
          inputResult = { newX: px, newY: py, action: 'blocked', message: '', positionChanged: false };
        } else if (target === '+') {
          inputResult = { newX: nx, newY: ny, action: 'open_door', message: 'You push the door open and peer into the darkness...', doorX: nx, doorY: ny, positionChanged: true };
        } else {
          inputResult = { newX: nx, newY: ny, action: 'move', message: '', positionChanged: true };
        }
      } else if (actionId === 'open') {
        const adjacent = [{ x: px, y: py - 1 }, { x: px, y: py + 1 }, { x: px - 1, y: py }, { x: px + 1, y: py }];
        let foundDoor = false;
        for (const pos of adjacent) {
          if (getTile(pos.x, pos.y) === '+') {
            inputResult = { newX: pos.x, newY: pos.y, action: 'open_door', message: 'You push the door open and peer into the darkness...', doorX: pos.x, doorY: pos.y, positionChanged: true };
            foundDoor = true;
            break;
          }
        }
        if (!foundDoor) {
          inputResult.message = 'There is no door nearby.';
        }
      } else if (actionId === 'wait') {
        inputResult = { newX: px, newY: py, action: 'wait', message: 'You wait...', positionChanged: false };
      } else {
        inputResult = { newX: px, newY: py, action: actionId, message: '', positionChanged: false };
      }
    }

    let message = inputResult.message || '';

    // 5. Update hero position if changed
    if (inputResult.positionChanged) {
      px = inputResult.newX;
      py = inputResult.newY;
      await updatePositionAsync({ heroId: 'default', x: px, y: py }, trace);
    }

    // 6. If open_door, run the explore flow
    if (inputResult.action === 'open_door') {
      const typeRoll = await rollDiceAsync(['1d20'], trace);
      const score = typeRoll.grandTotal;
      const isRoom = score <= 8;

      const anchorX = inputResult.doorX;
      const anchorY = inputResult.doorY;

      let structureType, width, height, description, doors, direction, generatorTilesJson;

      if (isRoom) {
        const roomRes = await generateRoomAsync({ level: level || 1 }, trace);
        structureType = 'room';
        width = roomRes.width;
        height = roomRes.height;
        description = roomRes.description;
        doors = roomRes.doors || [];
        direction = '';
        generatorTilesJson = roomRes.tilesJson || '{}';
      } else {
        const corrRes = await generateCorridorAsync({ level: level || 1 }, trace);
        structureType = 'corridor';
        const isVertical = corrRes.direction === 'N' || corrRes.direction === 'S';
        width = isVertical ? 3 : corrRes.length;
        height = isVertical ? corrRes.length : 3;
        description = corrRes.description;
        doors = [];
        direction = corrRes.direction;
        generatorTilesJson = corrRes.tilesJson || '{}';
      }

      const placeRes = await placeStructureAsync({
        structureType, width, height, description,
        tilesJson: generatorTilesJson, doors,
        anchorX, anchorY, direction
      }, trace);

      if (placeRes.fitSuccess) {
        tilesJsonStr = placeRes.tilesJson;
        roomsJsonStr = placeRes.roomsJson;
        message = `${message} You discover a ${structureType}: ${description}`;
        console.log(`[DndService] ProcessInput: explored ${structureType} at ${placeRes.originX},${placeRes.originY}`);
      } else {
        message = 'The doorway collapses into solid rock...';
        // Refresh world state (door may have been consumed)
        const refreshed = await getWorldStateAsync({}, trace);
        tilesJsonStr = refreshed.tilesJson;
        roomsJsonStr = refreshed.roomsJson;
      }
    }

    // 7. Run render pipeline with hero's effective visibility
    const rendered = await buildAndRender(
      tilesJsonStr, roomsJsonStr,
      px, py,
      visualRange,
      currentEnemiesJson,
      trace
    );

    callback(null, {
      mergedTilesJson: rendered.mergedTilesJson,
      updatedEnemiesJson: rendered.updatedEnemiesJson,
      newCollisionTiles: tilesJsonStr,
      newRoomsJson: roomsJsonStr,
      playerX: px,
      playerY: py,
      message,
      action: inputResult.action || 'none',
      trace
    });
  } catch (err) {
    console.error('[DndService] Error processing input:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(DndService.service, {
    exploreDoor,
    computeMapModifiers,
    processInput
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
