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

const KEYMAP_PATH = path.join(__dirname, '../../data/keymap.json');
const CAMPAIGNS_DIR = path.join(__dirname, '../../data/campaigns');

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
    const filePath = path.join(CAMPAIGNS_DIR, `${campId}.json`);
    const data = fs.readFileSync(filePath, 'utf8');
    callback(null, { campaignJson: data, trace });
  } catch (err) {
    console.error('[GameService] Error reading campaign:', err.message);
    callback(err);
  }
}

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
    console.log(`[GameService] Starting campaign level ${level}`);

    // 1. Reset World
    await resetWorldAsync({}, trace);

    // 2. Initialize World with a starter room
    const roomRes = await generateRoomAsync({ level: level + 1 }, trace);
    const initRes = await initWorldAsync({
      width: roomRes.width,
      height: roomRes.height,
      description: roomRes.description,
      tilesJson: roomRes.tilesJson,
      doors: roomRes.doors || []
    }, trace);

    let tiles = JSON.parse(initRes.tilesJson || '{}');
    
    // BFS queue for map expansion
    let unexplored = [];
    let visited = new Set();
    
    for (const [coord, ch] of Object.entries(tiles)) {
      if (ch === '+') unexplored.push(coord);
    }

    // Parse campaign config dynamically
    const campPath = path.join(CAMPAIGNS_DIR, `genesis.json`);
    const campaignData = JSON.parse(fs.readFileSync(campPath, 'utf8'));

    const halfX = campaignData.maxDimensionX / 2;
    const halfY = campaignData.maxDimensionY / 2;
    const margin = 5; // don't place doors too close to the boundary
    let attempts = 0;
    const maxAttempts = 300; // safety limit

    console.log(`[GameService] Pre-generating map for level ${level}...`);

    while (unexplored.length > 0 && attempts < maxAttempts) {
      // Pick random door to expand (makes organic dungeon shape)
      const rIdx = Math.floor(Math.random() * unexplored.length);
      const currentDoor = unexplored.splice(rIdx, 1)[0];

      if (visited.has(currentDoor)) continue;
      visited.add(currentDoor);
      
      attempts++;
      const [anchorX, anchorY] = currentDoor.split(',').map(Number);
      
      // Check absolute bounds
      if (Math.abs(anchorX) > halfX - margin || Math.abs(anchorY) > halfY - margin) {
        // Beyond the bounding box, do not expand further
        continue;
      }

      // Roll structure type
      const typeRoll = await rollDiceAsync({ dice: ['1d20'] }, trace);
      const isRoom = typeRoll.grandTotal <= 8;

      let structureType, width, height, description, doors, direction, generatorTilesJson;

      if (isRoom) {
        const genRoom = await generateRoomAsync({ level: level + 1 }, trace);
        structureType = 'room';
        width = genRoom.width;
        height = genRoom.height;
        description = genRoom.description;
        doors = genRoom.doors || [];
        direction = '';
        generatorTilesJson = genRoom.tilesJson || '{}';
      } else {
        const corrRes = await generateCorridorAsync({ level: level + 1 }, trace);
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
        const newTiles = JSON.parse(placeRes.tilesJson || '{}');
        for (const [coord, ch] of Object.entries(newTiles)) {
          if (ch === '+' && !visited.has(coord) && !unexplored.includes(coord)) {
            unexplored.push(coord);
          }
        }
      }
    }

    console.log(`[GameService] Map generation complete. Placed/Attempted structures: ${attempts}`);

    callback(null, { success: true, trace });
  } catch (err) {
    console.error('[GameService] Error starting game:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(GameService.service, {
    startGame,
    getKeymap,
    getCampaign
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
