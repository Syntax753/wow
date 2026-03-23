const { grpc, DiceService, DndService, RoomService, RenderService, EnemyService, ShadeService } = require('@wow/proto');
const crypto = require('crypto');

const PORT = process.env.DND_SERVICE_PORT || '50052';
const DICE_SERVICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';
const ROOM_SERVICE_URL = process.env.ROOM_SERVICE_URL || 'localhost:50056';
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || 'localhost:50058';
const ENEMY_SERVICE_URL = process.env.ENEMY_SERVICE_URL || 'localhost:50059';
const SHADE_SERVICE_URL = process.env.SHADE_SERVICE_URL || 'localhost:50057';

// Create a client to talk to the DiceService
const diceClient = new DiceService(
  DICE_SERVICE_URL,
  grpc.credentials.createInsecure()
);

// Create a client to talk to the RoomService
const roomClient = new RoomService(
  ROOM_SERVICE_URL,
  grpc.credentials.createInsecure()
);

// Create a client to talk to the RenderService
const renderClient = new RenderService(
  RENDER_SERVICE_URL,
  grpc.credentials.createInsecure()
);

// Create a client to talk to the EnemyService
const enemyClient = new EnemyService(
  ENEMY_SERVICE_URL,
  grpc.credentials.createInsecure()
);

// Create a client to talk to the ShadeService
const shadeClient = new ShadeService(
  SHADE_SERVICE_URL,
  grpc.credentials.createInsecure()
);

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
}

function computeVisibilityAsync(req, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    
    const requestWithTrace = { ...req, trace: callerIdentity };

    shadeClient.ComputeVisibility(requestWithTrace, (err, response) => {
      if (err) {
        const errSpan = {
          ...callerIdentity,
          serviceName: 'shade-service',
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
        if (parentTrace) parentTrace.subSpans.push(errSpan);
        reject(err);
      } else {
        const childTrace = response.trace || { ...callerIdentity, serviceName: 'shade-service' };
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        if (parentTrace) parentTrace.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
}

function processEnemiesAsync(req, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    
    const requestWithTrace = { ...req, trace: callerIdentity };

    enemyClient.ProcessEnemies(requestWithTrace, (err, response) => {
      if (err) {
        const errSpan = {
          ...callerIdentity,
          serviceName: 'enemy-service',
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
        if (parentTrace) parentTrace.subSpans.push(errSpan);
        reject(err);
      } else {
        const childTrace = response.trace || { ...callerIdentity, serviceName: 'enemy-service' };
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        if (parentTrace) parentTrace.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
}

function rollDiceAsync(dice, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    
    diceClient.rollDice({ dice, trace: callerIdentity }, (err, response) => {
      if (err) {
        const errSpan = {
          ...callerIdentity,
          serviceName: 'dice-service',
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
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
}

function generateRoomAsync(req, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    const requestPayload = { 
      level: req.level, 
      trace: callerIdentity,
      tilesJson: req.tilesJson,
      anchorX: req.anchorX,
      anchorY: req.anchorY
    };
    
    roomClient.GenerateRoom(requestPayload, (err, response) => {
      if (err) {
        const errSpan = {
          ...callerIdentity,
          serviceName: 'room-service',
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
        if (parentTrace) parentTrace.subSpans.push(errSpan);
        reject(err);
      } else {
        const childTrace = response.trace || { ...callerIdentity, serviceName: 'room-service' };
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        if (parentTrace) parentTrace.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
}

function generateCorridorAsync(req, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    const requestPayload = { 
      level: req.level, 
      trace: callerIdentity,
      tilesJson: req.tilesJson,
      anchorX: req.anchorX,
      anchorY: req.anchorY
    };
    
    roomClient.GenerateCorridor(requestPayload, (err, response) => {
      if (err) {
        const errSpan = {
          ...callerIdentity,
          serviceName: 'room-service',
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
        if (parentTrace) parentTrace.subSpans.push(errSpan);
        reject(err);
      } else {
        const childTrace = response.trace || { ...callerIdentity, serviceName: 'room-service' };
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        if (parentTrace) parentTrace.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
}

// Eliminated Shade and Enemy async wrappers

function compositeLayersAsync(req, parentTrace) {
  return new Promise((resolve, reject) => {
    const callerIdentity = {
      traceId: parentTrace ? parentTrace.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    
    const requestWithTrace = { ...req, trace: callerIdentity };

    renderClient.CompositeLayers(requestWithTrace, (err, response) => {
      if (err) {
        const errSpan = {
          ...callerIdentity,
          serviceName: 'render-service',
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
        if (parentTrace) parentTrace.subSpans.push(errSpan);
        reject(err);
      } else {
        const childTrace = response.trace || { ...callerIdentity, serviceName: 'render-service' };
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        if (parentTrace) parentTrace.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
}

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

    let width, height, description, newTilesJson;
    let doors = [];
    let originX = 0, originY = 0;
    let fitSuccess = false;
    let structureType = isRoom ? 'room' : 'corridor';

    const px = call.request.playerX ?? 0;
    const py = call.request.playerY ?? 0;

    if (isRoom) {
      const roomRes = await generateRoomAsync({
        level: call.request.level,
        tilesJson: call.request.tilesJson,
        anchorX: call.request.anchorX,
        anchorY: call.request.anchorY
      }, trace);
      width = roomRes.width;
      height = roomRes.height;
      description = roomRes.description;
      doors = roomRes.doors || [];
      fitSuccess = roomRes.fitSuccess;
      originX = roomRes.originX;
      originY = roomRes.originY;
      newTilesJson = roomRes.newTilesJson || call.request.tilesJson;
      console.log(`[DndService] Orchestrated Room: ${width}x${height} | fit: ${fitSuccess} at ${originX},${originY}`);
    } else {
      const corrRes = await generateCorridorAsync({
        level: call.request.level,
        tilesJson: call.request.tilesJson,
        anchorX: call.request.anchorX,
        anchorY: call.request.anchorY
      }, trace);
      const isVertical = corrRes.direction === 'N' || corrRes.direction === 'S';
      width = isVertical ? 1 : corrRes.length;
      height = isVertical ? corrRes.length : 1;
      description = corrRes.description;
      fitSuccess = corrRes.fitSuccess;
      originX = corrRes.originX;
      originY = corrRes.originY;
      newTilesJson = corrRes.newTilesJson || call.request.tilesJson;
      console.log(`[DndService] Orchestrated Corridor: ${width}x${height} | fit: ${fitSuccess} at ${originX},${originY}`);
    }

    // If it didn't fit, return immediately with no map changes
    if (!fitSuccess) {
      callback(null, {
        structureType, width: 0, height: 0, description, doors: [], trace,
        fitSuccess: false, originX, originY,
        newTilesJson: call.request.tilesJson,
        mergedTilesJson: '',
        updatedEnemiesJson: ''
      });
      return;
    }

    // 2. Build base layer from new map
    let tilesDict;
    try { tilesDict = JSON.parse(newTilesJson || '{}'); } catch { tilesDict = {}; }

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

    // 3. Enemy layer
    const roomsJson = call.request.roomsJson || '[]';
    const enemyResponse = await processEnemiesAsync({
      tilesJson: newTilesJson,
      roomsJson,
      playerX: px,
      playerY: py,
      currentEnemiesJson: call.request.currentEnemiesJson || '[]'
    }, trace);

    const layer30 = { layerType: 30, tilesJson: enemyResponse.enemyLayer?.tilesJson || '{}' };

    // 4. FOV layer
    const shadeResponse = await computeVisibilityAsync({
      tilesJson: newTilesJson,
      playerX: px,
      playerY: py,
      visualRange: call.request.visualRange || 8
    }, trace);

    const layer10 = { layerType: 10, tilesJson: shadeResponse.tilesJson };

    // 5. Composite via render-service
    const renderResponse = await compositeLayersAsync({
      playerX: px,
      playerY: py,
      layers: [layer0, layer10, layer20, layer30]
    }, trace);

    callback(null, {
      structureType, width, height, description, doors, trace,
      fitSuccess,
      originX,
      originY,
      newTilesJson,
      mergedTilesJson: renderResponse.mergedTilesJson,
      updatedEnemiesJson: enemyResponse.updatedEnemiesJson || ''
    });
  } catch (err) {
    console.error('[DndService] Error orchestrating door explore:', err.message);
    callback(err);
  }

}

// Stub passthrough wrappers in case frontend somehow calls them directly
async function generateRoomPassthrough(call, callback) {
  try {
     const res = await generateRoomAsync({
       level: call.request.level,
       mapWidth: call.request.mapWidth,
       mapHeight: call.request.mapHeight,
       tiles: call.request.tiles,
       anchorX: call.request.anchor_x,
       anchorY: call.request.anchor_y
     }, call.request.trace);
     callback(null, res);
  } catch(e) { callback(e); }
}

async function generateCorridorPassthrough(call, callback) {
  try {
     const res = await generateCorridorAsync({
       level: call.request.level,
       mapWidth: call.request.mapWidth,
       mapHeight: call.request.mapHeight,
       tiles: call.request.tiles,
       anchorX: call.request.anchor_x,
       anchorY: call.request.anchor_y
     }, call.request.trace);
     callback(null, res);
  } catch(e) { callback(e); }
}

async function computeMapModifiers(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'dnd-service',
    data: JSON.stringify({
      mapWidth: call.request.mapWidth,
      mapHeight: call.request.mapHeight,
      px: call.request.playerX,
      py: call.request.playerY
    }),
    subSpans: []
  };

  try {
    let tilesJsonStr = call.request.tilesJson || "{}";
    let px = call.request.playerX ?? 0;
    let py = call.request.playerY ?? 0;
    let isInit = false;
    let newRoomsJson = "[]";

    let tilesDict;
    try {
      tilesDict = JSON.parse(tilesJsonStr);
    } catch {
      tilesDict = {};
    }

    // 0. Detect missing map state and initialize it 
    if (Object.keys(tilesDict).length === 0) {
      isInit = true;
      const roomRes = await generateRoomAsync({
        level: 1,
        tilesJson: "{}",
        anchorX: 0,
        anchorY: 0
      }, trace);
      
      const rw = roomRes.width;
      const rh = roomRes.height;
      const rx = -Math.floor(rw / 2);
      const ry = -Math.floor(rh / 2);
      const generatedDoors = roomRes.doors || [];
      
      for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
          if (x === rx || x === rx + rw - 1 || y === ry || y === ry + rh - 1) {
            const isDoor = generatedDoors.some(d => d.x === (x - rx) && d.y === (y - ry));
            if (isDoor) {
              tilesDict[`${x},${y}`] = '+';
            } else {
              tilesDict[`${x},${y}`] = '#';
            }
          } else {
            tilesDict[`${x},${y}`] = '.';
          }
        }
      }
      
      px = 0;
      py = 0;
      tilesJsonStr = JSON.stringify(tilesDict);
      newRoomsJson = JSON.stringify([{ x: rx, y: ry, width: rw, height: rh, description: roomRes.description }]);
      console.log(`[DndService] Initialized Infinite Map with Starter Room around 0,0 (${rx},${ry})`);
    }

    let roomsJsonStr = call.request.roomsJson || "[]";
    if (isInit) {
      roomsJsonStr = newRoomsJson;
    }

    // 1. Split the raw tiles into Layer 0 (Base) and Layer 20 (Interactables)
    let baseMap = {}; 
    let interactables = {}; 

    for (const [coord, ch] of Object.entries(tilesDict)) {
      if (ch === '#' || ch === '.' || ch === ' ') {
        baseMap[coord] = ch;
      } else {
        baseMap[coord] = '.';
        interactables[coord] = ch;
      }
    }

    const layer0 = {
      layerType: 0,
      tilesJson: JSON.stringify(baseMap)
    };

    const layer20 = {
      layerType: 20,
      tilesJson: JSON.stringify(interactables)
    };

    // 2. Linear Pipeline: Call Enemy-Service -> Shade-Service
    const enemyResponse = await processEnemiesAsync({
      tilesJson: tilesJsonStr,
      roomsJson: roomsJsonStr,
      playerX: px,
      playerY: py,
      currentEnemiesJson: call.request.currentEnemiesJson || "[]"
    }, trace);

    const shadeResponse = await computeVisibilityAsync({
      tilesJson: tilesJsonStr,
      playerX: px,
      playerY: py,
      visualRange: call.request.visualRange || 8
    }, trace);

    const layer10 = {
      layerType: 10,
      tilesJson: shadeResponse.tilesJson // Maps the shade FOV array dynamically
    };

    const layer30 = {
      layerType: 30,
      tilesJson: enemyResponse.enemyLayer.tilesJson // Maps the enemy positions dynamically 
    };

    // 3. Composite all specific layers via render-service 
    const renderPayload = {
      playerX: px,
      playerY: py,
      layers: [layer0, layer10, layer20, layer30]
    };

    const renderResponse = await compositeLayersAsync(renderPayload, trace);

    const responsePayload = {
      mergedTilesJson: renderResponse.mergedTilesJson,
      updatedEnemiesJson: enemyResponse.updatedEnemiesJson,
      trace
    };

    if (isInit) {
      responsePayload.newCollisionTiles = tilesJsonStr;
      responsePayload.newPlayerX = px;
      responsePayload.newPlayerY = py;
      responsePayload.newRoomsJson = newRoomsJson;
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
    generateRoom: generateRoomPassthrough, 
    generateCorridor: generateCorridorPassthrough, 
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
