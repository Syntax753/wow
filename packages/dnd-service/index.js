const { grpc, DiceService, DndService, RoomService, RenderService, EnemyService, LightService, WorldService, HeroService, InputService, GameService, createLogger } = require('@wow/proto');
const crypto = require('crypto');

const log = createLogger('DndService');

const PORT = process.env.DND_SERVICE_PORT || '50052';
const DICE_SERVICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';
const ROOM_SERVICE_URL = process.env.ROOM_SERVICE_URL || 'localhost:50056';
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || 'localhost:50058';
const ENEMY_SERVICE_URL = process.env.ENEMY_SERVICE_URL || 'localhost:50059';
const LIGHT_SERVICE_URL = process.env.LIGHT_SERVICE_URL || 'localhost:50057';
const WORLD_SERVICE_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';
const HERO_SERVICE_URL = process.env.HERO_SERVICE_URL || 'localhost:50053';
const INPUT_SERVICE_URL = process.env.INPUT_SERVICE_URL || 'localhost:50061';
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'localhost:50062';

const diceClient = new DiceService(DICE_SERVICE_URL, grpc.credentials.createInsecure());
const roomClient = new RoomService(ROOM_SERVICE_URL, grpc.credentials.createInsecure());
const renderClient = new RenderService(RENDER_SERVICE_URL, grpc.credentials.createInsecure());
const enemyClient = new EnemyService(ENEMY_SERVICE_URL, grpc.credentials.createInsecure());
const lightClient = new LightService(LIGHT_SERVICE_URL, grpc.credentials.createInsecure());
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
const computeVisibilityAsync = makeAsyncCall(lightClient, 'ComputeVisibility', 'light-service');
const getWorldStateAsync = makeAsyncCall(worldClient, 'GetWorldState', 'world-service');
const initWorldAsync = makeAsyncCall(worldClient, 'InitWorld', 'world-service');
const placeStructureAsync = makeAsyncCall(worldClient, 'PlaceStructure', 'world-service');
const resetWorldAsync = makeAsyncCall(worldClient, 'ResetWorld', 'world-service');
const revealTilesAsync = makeAsyncCall(worldClient, 'RevealTiles', 'world-service');
const setTileAsync = makeAsyncCall(worldClient, 'SetTile', 'world-service');
const getHeroAsync = makeAsyncCall(heroClient, 'GetHero', 'hero-service');
const updatePositionAsync = makeAsyncCall(heroClient, 'UpdatePosition', 'hero-service');
const getEffectiveStatsAsync = makeAsyncCall(heroClient, 'GetEffectiveStats', 'hero-service');
const startGameAsync = makeAsyncCall(gameClient, 'StartGame', 'game-service');
const getKeymapAsync = makeAsyncCall(gameClient, 'GetKeymap', 'game-service');
const getGameStateAsync = makeAsyncCall(gameClient, 'GetGameState', 'game-service');

// ── Helper: build layers from world tiles and run render pipeline ──────
async function buildAndRender(tilesJsonStr, roomsJsonStr, px, py, visualRange, currentEnemiesJson, trace, playerId, playersJson, tileColorsJson, viewportWidth, viewportHeight, mapType) {
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

  const layer0 = { layerType: 0, tilesJson: JSON.stringify(baseMap), colorsJson: tileColorsJson || '{}' };
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
  const lightResponse = await computeVisibilityAsync({
    tilesJson: tilesJsonStr,
    playerX: px,
    playerY: py,
    visualRange: visualRange || 8,
    mapType: mapType || 'dungeon'
  }, trace);

  const layer10 = { layerType: 10, tilesJson: lightResponse.tilesJson };

  // Determine fog-of-war ID: if playersJson has entries, it's a multiplayer session
  let allPlayers = [];
  try { allPlayers = JSON.parse(playersJson || '[]'); } catch {}
  const isMultiplayer = allPlayers.length > 0;
  const fowId = isMultiplayer ? 'multi-shared' : (playerId || 'default');

  // Persist visible tiles: always save to player's own set AND shared set in multiplayer
  await revealTilesAsync({
    visibleCoordsJson: lightResponse.tilesJson,
    playerId: playerId || 'default'
  }, trace);

  if (isMultiplayer) {
    await revealTilesAsync({
      visibleCoordsJson: lightResponse.tilesJson,
      playerId: 'multi-shared'
    }, trace);
  }

  // Read revealed tiles from shared set (multiplayer) or player's own set (single)
  const revealResponse = await getWorldStateAsync({ playerId: fowId }, trace);

  // Revealed layer (all tiles ever seen)
  const layer5 = { layerType: 5, tilesJson: revealResponse.revealedJson };

  // Composite via render-service
  const renderResponse = await compositeLayersAsync({
    playerX: px,
    playerY: py,
    layers: [layer0, layer5, layer10, layer20, layer30],
    playersJson: playersJson || '[]',
    viewportWidth: viewportWidth || 0,
    viewportHeight: viewportHeight || 0,
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
    // 1. Get hero effective stats for visibility + map type
    const heroId = call.request.heroId || 'default';
    const [effectiveStats, gameStateRes] = await Promise.all([
      getEffectiveStatsAsync({ heroId }, trace),
      getGameStateAsync({}, trace),
    ]);
    const visualRange = effectiveStats.visibility || 6;
    const mapType = gameStateRes.mapType || 'dungeon';

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

    log.trace(`Orchestrated ${structureType}: fit at ${placeRes.originX},${placeRes.originY}`);

    // 4. Run render pipeline with updated world state
    const rendered = await buildAndRender(
      placeRes.tilesJson, placeRes.roomsJson,
      px, py,
      visualRange,
      call.request.currentEnemiesJson,
      trace, heroId, call.request.playersJson || '[]',
      '{}',
      call.request.viewportWidth, call.request.viewportHeight,
      mapType
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
    log.error('Error orchestrating door explore:', err.message);
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
    const heroId = call.request.heroId || 'default';
    const hero = await getHeroAsync({ heroId }, trace);
    const effectiveStats = await getEffectiveStatsAsync({ heroId }, trace);
    const visualRange = effectiveStats.visibility || 6;
    let px = call.request.playerX ?? hero.positionX ?? 0;
    let py = call.request.playerY ?? hero.positionY ?? 0;

    // Update hero position from frontend (frontend tracks movement)
    if (call.request.playerX !== undefined) {
      await updatePositionAsync({ heroId, x: px, y: py }, trace);
    }

    // 2. Get current world state from world-service
    const worldState = await getWorldStateAsync({ playerId: heroId }, trace);
    let tilesJsonStr = worldState.tilesJson || '{}';
    let roomsJsonStr = worldState.roomsJson || '[]';
    let tileColorsJson = worldState.tileColorsJson || '{}';

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJsonStr); } catch { tilesDict = {}; }

    // 3. If world is empty, initialize via game-service
    if (Object.keys(tilesDict).length === 0) {
      isInit = true;

      // Start the game, which pre-generates the entire map
      const gameRes = await startGameAsync({ level: 0, campaignId: 'default' }, trace);

      // Now fetch the populated world state
      const newWorldState = await getWorldStateAsync({ playerId: heroId }, trace);
      tilesJsonStr = newWorldState.tilesJson || '{}';
      roomsJsonStr = newWorldState.roomsJson || '[]';
      tileColorsJson = newWorldState.tileColorsJson || '{}';

      // Get spawn position from game state
      let spawnPositions = [];
      try { spawnPositions = JSON.parse(gameRes.spawnPositionsJson || '[]'); } catch {}
      if (spawnPositions.length > 0) {
        px = spawnPositions[0].x;
        py = spawnPositions[0].y;
      }

      // Update hero with initial position
      await updatePositionAsync({ heroId, x: px, y: py }, trace);

      log.trace(`Initialized world via game-service: ${gameRes.levelName || 'Level 0'}`);
    }

    // 4. Get map type for light computation
    const gameStateForLight = await getGameStateAsync({}, trace);
    const mapType = gameStateForLight.mapType || 'dungeon';

    // 5. Run render pipeline with hero's effective visibility
    const rendered = await buildAndRender(
      tilesJsonStr, roomsJsonStr,
      px, py,
      visualRange,
      call.request.currentEnemiesJson,
      trace, heroId, call.request.playersJson || '[]',
      tileColorsJson,
      call.request.viewportWidth, call.request.viewportHeight,
      mapType
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
    log.error('Error orchestrating map modifiers:', err.message);
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
    const heroId = call.request.heroId || 'default';

    // 1. Get hero position, effective stats, and map type
    const [hero, effectiveStats, gameStateForInput] = await Promise.all([
      getHeroAsync({ heroId }, trace),
      getEffectiveStatsAsync({ heroId }, trace),
      getGameStateAsync({}, trace),
    ]);
    const visualRange = effectiveStats.visibility || 6;
    const mapType = gameStateForInput.mapType || 'dungeon';
    let px = hero.positionX ?? 0;
    let py = hero.positionY ?? 0;

    // 2. Get world state
    const worldState = await getWorldStateAsync({ playerId: heroId }, trace);
    let tilesJsonStr = worldState.tilesJson || '{}';
    let roomsJsonStr = worldState.roomsJson || '[]';
    const tileColorsJson = worldState.tileColorsJson || '{}';

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJsonStr); } catch { tilesDict = {}; }

    // 3. If world is empty, initialize via game-service
    if (Object.keys(tilesDict).length === 0) {
      const gameRes = await startGameAsync({ level: level || 0, campaignId: 'default' }, trace);

      const initRes = await getWorldStateAsync({ playerId: heroId }, trace);
      tilesJsonStr = initRes.tilesJson || '{}';
      roomsJsonStr = initRes.roomsJson || '[]';
      px = 0;
      py = 0;
      await updatePositionAsync({ heroId, x: px, y: py }, trace);
      log.trace(`Initialized world via ProcessInput: ${gameRes.levelName || 'Level 0'}`);
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
      } else if (actionId === 'close') {
        // Close: find an adjacent open doorway (floor tile on a wall boundary)
        // We look for '.' tiles that were previously doors — these are adjacent to walls on 3+ sides
        const adjacent = [{ x: px, y: py - 1 }, { x: px, y: py + 1 }, { x: px - 1, y: py }, { x: px + 1, y: py }];
        let foundOpening = false;
        for (const pos of adjacent) {
          const tile = getTile(pos.x, pos.y);
          if (tile !== '.') continue;
          // Check if this floor tile is on a wall boundary (adjacent to walls on 2+ sides = doorway)
          let wallCount = 0;
          if (getTile(pos.x, pos.y - 1) === '#') wallCount++;
          if (getTile(pos.x, pos.y + 1) === '#') wallCount++;
          if (getTile(pos.x - 1, pos.y) === '#') wallCount++;
          if (getTile(pos.x + 1, pos.y) === '#') wallCount++;
          if (wallCount >= 2) {
            inputResult = { newX: px, newY: py, action: 'close_door', message: '', doorX: pos.x, doorY: pos.y, positionChanged: false };
            foundOpening = true;
            break;
          }
        }
        if (!foundOpening) {
          inputResult.message = 'There is nothing to close nearby.';
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
      await updatePositionAsync({ heroId, x: px, y: py }, trace);
    }

    // 6. If open_door, convert door to floor and run explore flow
    if (inputResult.action === 'open_door') {
      const anchorX = inputResult.doorX;
      const anchorY = inputResult.doorY;

      // Always convert the door tile to floor first (door is now open)
      const setRes = await setTileAsync({ x: anchorX, y: anchorY, tileChar: '.' }, trace);
      tilesJsonStr = setRes.tilesJson;
      roomsJsonStr = setRes.roomsJson;

      // Check if BSP already placed a structure beyond this door
      let tilesCheck;
      try { tilesCheck = JSON.parse(tilesJsonStr); } catch { tilesCheck = {}; }
      const adjacentFloor = [
        tilesCheck[`${anchorX + 1},${anchorY}`],
        tilesCheck[`${anchorX - 1},${anchorY}`],
        tilesCheck[`${anchorX},${anchorY + 1}`],
        tilesCheck[`${anchorX},${anchorY - 1}`],
      ].filter(t => t === '.' || t === '+');

      if (adjacentFloor.length >= 2) {
        // Door leads to pre-generated BSP structure
        message = 'You push the door open.';
      } else {

      const typeRoll = await rollDiceAsync(['1d20'], trace);
      const score = typeRoll.grandTotal;
      const isRoom = score <= 8;

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
        log.trace(`ProcessInput: explored ${structureType} at ${placeRes.originX},${placeRes.originY}`);
      } else {
        message = 'The door opens to solid rock...';
      }
      } // end else (on-demand generation fallback)
    }

    // 6b. If close_door, convert adjacent floor back to door
    if (inputResult.action === 'close_door') {
      const dx = inputResult.doorX;
      const dy = inputResult.doorY;
      const setRes = await setTileAsync({ x: dx, y: dy, tileChar: '+' }, trace);
      tilesJsonStr = setRes.tilesJson;
      roomsJsonStr = setRes.roomsJson;
      message = 'You close the door.';
    }

    // 7. Run render pipeline with hero's effective visibility
    const rendered = await buildAndRender(
      tilesJsonStr, roomsJsonStr,
      px, py,
      visualRange,
      currentEnemiesJson,
      trace, heroId, call.request.playersJson || '[]',
      tileColorsJson,
      call.request.viewportWidth, call.request.viewportHeight,
      mapType
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
    log.error('Error processing input:', err.message);
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
        log.error('Failed to start:', err);
        process.exit(1);
      }
      log.info(`Running on port ${port}`);
    }
  );
}

main();
