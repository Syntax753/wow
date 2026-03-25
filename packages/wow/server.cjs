/**
 * WoW Backend API Server
 * Bridges the React frontend to all gRPC microservices.
 * All responses include a standard { data, logEntries, trace } envelope.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { grpc, DiceService, DndService, HeroService, InventoryService, ActionService, WorldService, GameService, createLogger } = require('@wow/proto');

const log = createLogger('WoW API');

const API_PORT = process.env.PORT || process.env.API_PORT || 3001;
const DICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';
const DND_URL = process.env.DND_SERVICE_URL || 'localhost:50052';
const HERO_URL = process.env.HERO_SERVICE_URL || 'localhost:50053';
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'localhost:50054';
const ACTION_URL = process.env.ACTION_SERVICE_URL || 'localhost:50055';
const WORLD_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';
const GAME_URL = process.env.GAME_SERVICE_URL || 'localhost:50062';

const diceClient = new DiceService(DICE_URL, grpc.credentials.createInsecure());
const dndClient = new DndService(DND_URL, grpc.credentials.createInsecure());
const heroClient = new HeroService(HERO_URL, grpc.credentials.createInsecure());
const inventoryClient = new InventoryService(INVENTORY_URL, grpc.credentials.createInsecure());
const actionClient = new ActionService(ACTION_URL, grpc.credentials.createInsecure());
const worldClient = new WorldService(WORLD_URL, grpc.credentials.createInsecure());
const gameClient = new GameService(GAME_URL, grpc.credentials.createInsecure());

// ── Player identity & session tracking ────────────────────────────────
const players = {}; // { [playerId]: { name, heroId, active, lastSeen, spawnIndex } }
let nextSpawnIndex = 0;

function getPlayerId(req) {
  return req.headers['x-player-id'] || 'default';
}

function getActivePlayers() {
  return Object.values(players).filter(p => p.active).length;
}

function touchPlayer(req) {
  const pid = getPlayerId(req);
  if (players[pid]) players[pid].lastSeen = Date.now();
}

// Clean up stale players (no activity for 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [pid, p] of Object.entries(players)) {
    if (p.active && p.lastSeen < cutoff) {
      p.active = false;
      log.info(`Player ${p.name} (${pid}) timed out`);
    }
  }
}, 60000);

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
}

function grpcCall(client, serviceName, method, request, rootSpan) {
  return new Promise((resolve, reject) => {
    // Caller generates identity (traceId and new spanId) and passes it in
    const callerIdentity = {
      traceId: rootSpan ? rootSpan.traceId : crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    };
    request.trace = callerIdentity;
    
    client[method](request, (err, response) => {
      if (err) {
        // If error, caller fabricates the return span
        const errSpan = {
          ...callerIdentity,
          serviceName,
          timeEnd: Date.now(),
          dataRet: JSON.stringify({ error: err.message })
        };
        if (rootSpan) rootSpan.subSpans.push(errSpan);
        reject(err);
      } else {
        // Callee returned a trace object (timeStart, data, serviceName)
        const childTrace = response.trace || { ...callerIdentity, serviceName };
        
        // Caller adds timeEnd and dataRet
        childTrace.timeEnd = Date.now();
        childTrace.dataRet = cloneReqRes(response);
        
        if (rootSpan) rootSpan.subSpans.push(childTrace);
        resolve(response);
      }
    });
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
  });
}

function envelope(data, logEntries = [], trace = null) {
  return { data, logEntries, trace };
}

function logEntry(text, type = 'info', source = 'system') {
  return { text, type, source, timestamp: Date.now() };
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Player-Id',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  // Very basic static file serving for React frontend
  if (!req.url.startsWith('/api') && req.method === 'GET') {
    let filePath = path.join(__dirname, 'dist', req.url === '/' ? 'index.html' : req.url);
    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
      case '.js': contentType = 'text/javascript'; break;
      case '.css': contentType = 'text/css'; break;
      case '.json': contentType = 'application/json'; break;
      case '.png': contentType = 'image/png'; break;
      case '.jpg': contentType = 'image/jpg'; break;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        if (error.code === 'ENOENT') {
          fs.readFile(path.join(__dirname, 'dist', 'index.html'), (err, content) => {
            if (!err) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(content, 'utf-8');
            } else {
              res.writeHead(500);
              res.end('Static file serving error: ' + error.code + ' ..\n');
            }
          });
        } else {
          res.writeHead(500);
          res.end('Server Error: ' + error.code + ' ..\n');
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
    return;
  }

  // Root span representing the frontend's API call lifecycle
  const rootSpan = {
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    timeStart: Date.now(),
    serviceName: 'wow-api',
    data: JSON.stringify({ method: req.method, url: req.url }),
    dataRet: '',
    subSpans: []
  };
  
  try {
    let body = {};
    if (req.method === 'POST') {
      body = await parseBody(req);
      rootSpan.data = JSON.stringify({ method: req.method, url: req.url, body });
    }

    // === Dice Service ===
    if (req.url === '/api/dice/roll' && req.method === 'POST') {
      const result = await grpcCall(diceClient, 'dice-service', 'rollDice', { dice: body.dice || [] }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [
        logEntry(`Rolled ${result.results.map(r => `${r.die}=[${r.rolls}]`).join(', ')} => ${result.grandTotal}`, 'action', 'dice'),
      ], rootSpan));

    // === DnD Service ===
    } else if (req.url === '/api/dnd/explore' && req.method === 'POST') {
      const result = await grpcCall(dndClient, 'dnd-service', 'exploreDoor', {
        level: body.level || 1,
        anchorX: body.doorX || 0,
        anchorY: body.doorY || 0,
        playerX: body.playerX || 0,
        playerY: body.playerY || 0,
        currentEnemiesJson: body.currentEnemiesJson || '[]',
        visualRange: body.visualRange || 8
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      
      const logs = [];
      if (result.fitSuccess === false) {
        logs.push(logEntry(result.description || 'The doorway crumbles into dust...', 'discovery', 'dnd'));
      } else {
        logs.push(logEntry(`Explored Door [${result.structureType}]: ${result.description} (${result.width}x${result.height})`, 'discovery', 'dnd'));
      }
      
      json(res, 200, envelope(result, logs, rootSpan));

    // === Hero Service ===
    } else if (req.url === '/api/hero' && req.method === 'GET') {
      const result = await grpcCall(heroClient, 'hero-service', 'getHero', { heroId: getPlayerId(req) }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [], rootSpan));

    } else if (req.url === '/api/hero' && req.method === 'POST') {
      const result = await grpcCall(heroClient, 'hero-service', 'resetHero', {
        heroId: getPlayerId(req),
        name: body.name || 'Adventurer',
        heroClass: body.heroClass || 'Fighter',
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [
        logEntry(`${result.name} the ${result.heroClass} enters the dungeon.`, 'system', 'hero'),
      ], rootSpan));

    } else if (req.url === '/api/hero/stat' && req.method === 'POST') {
      const result = await grpcCall(heroClient, 'hero-service', 'updateStat', {
        heroId: getPlayerId(req),
        statName: body.statName,
        delta: body.delta,
      }, rootSpan);
      const dir = body.delta > 0 ? 'increased' : 'decreased';
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [
        logEntry(`${body.statName} ${dir} by ${Math.abs(body.delta)}`, 'info', 'hero'),
      ], rootSpan));

    // === Inventory Service ===
    } else if (req.url === '/api/inventory' && req.method === 'GET') {
      const result = await grpcCall(inventoryClient, 'inventory-service', 'getInventory', { heroId: getPlayerId(req) }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [], rootSpan));

    } else if (req.url === '/api/inventory/add' && req.method === 'POST') {
      const result = await grpcCall(inventoryClient, 'inventory-service', 'addItem', {
        heroId: getPlayerId(req),
        item: body.item,
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [
        logEntry(`Picked up: ${body.item?.name || 'item'}`, 'action', 'inventory'),
      ], rootSpan));

    } else if (req.url === '/api/inventory/drop' && req.method === 'POST') {
      const result = await grpcCall(inventoryClient, 'inventory-service', 'dropItem', {
        heroId: getPlayerId(req),
        itemId: body.itemId,
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result, [
        logEntry(`Dropped item`, 'action', 'inventory'),
      ], rootSpan));

    } else if (req.url === '/api/inventory/use' && req.method === 'POST') {
      const result = await grpcCall(inventoryClient, 'inventory-service', 'useItem', {
        heroId: getPlayerId(req),
        itemId: body.itemId,
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes(result);
      json(res, 200, envelope(result.inventory, [
        logEntry(result.message, result.success ? 'action' : 'info', 'inventory'),
      ], rootSpan));

    // === Unified Input Handler ===
    } else if (req.url === '/api/input' && req.method === 'POST') {
      touchPlayer(req);
      const dndResult = await grpcCall(dndClient, 'dnd-service', 'processInput', {
        key: body.key || '',
        visualRange: body.visualRange || 8,
        currentEnemiesJson: body.currentEnemiesJson || '[]',
        level: body.level || 1,
        heroId: getPlayerId(req),
      }, rootSpan);

      // Fetch world state for action-service overlay
      const worldState = await grpcCall(worldClient, 'world-service', 'getWorldState', { playerId: getPlayerId(req) }, rootSpan);
      let worldRooms = [];
      try { worldRooms = JSON.parse(worldState.roomsJson || '[]'); } catch {}

      const actionResult = await grpcCall(actionClient, 'action-service', 'getAvailableActions', {
        tilesJson: worldState.tilesJson || '{}',
        playerX: dndResult.playerX || 0,
        playerY: dndResult.playerY || 0,
        level: body.level || 1,
        rooms: worldRooms,
        heroId: getPlayerId(req),
      }, rootSpan);

      rootSpan.timeEnd = Date.now();

      const logs = [];
      if (dndResult.message) {
        logs.push(logEntry(dndResult.message, dndResult.action === 'blocked' ? 'combat' : 'action', 'dnd'));
      }

      json(res, 200, envelope({
        map: {
          merged_tiles_json: dndResult.mergedTilesJson,
          updated_enemies_json: dndResult.updatedEnemiesJson,
          new_collision_tiles: dndResult.newCollisionTiles,
          new_rooms_json: dndResult.newRoomsJson,
        },
        player: {
          x: dndResult.playerX,
          y: dndResult.playerY,
        },
        action: dndResult.action,
        message: dndResult.message,
        actions: actionResult.overlay,
      }, logs, rootSpan));

    // === Game Loop Sync (Map Modifiers + Actions in one unified trace) ===
    } else if (req.url === '/api/sync' && req.method === 'POST') {
      touchPlayer(req);
      // Run DnD map modifiers (will init world if needed)
      const dndResult = await grpcCall(dndClient, 'dnd-service', 'computeMapModifiers', {
        playerX: body.playerX || 0,
        playerY: body.playerY || 0,
        visualRange: body.visualRange || 8,
        currentEnemiesJson: body.currentEnemiesJson || "[]",
        heroId: getPlayerId(req),
      }, rootSpan);

      // Fetch world state from world-service for action-service
      const worldState = await grpcCall(worldClient, 'world-service', 'getWorldState', { playerId: getPlayerId(req) }, rootSpan);
      let worldRooms = [];
      try { worldRooms = JSON.parse(worldState.roomsJson || '[]'); } catch {}

      const actionResult = await grpcCall(actionClient, 'action-service', 'getAvailableActions', {
        tilesJson: worldState.tilesJson || '{}',
        playerX: body.playerX || 0,
        playerY: body.playerY || 0,
        level: body.level || 1,
        rooms: worldRooms,
        heroId: getPlayerId(req),
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = cloneReqRes({ dndResult, actionResult });
      
      const mapPayload = {
        merged_tiles_json: dndResult.mergedTilesJson,
        updated_enemies_json: dndResult.updatedEnemiesJson,
        // Always include world state so frontend has collision data
        new_collision_tiles: dndResult.newCollisionTiles || worldState.tilesJson,
        new_rooms_json: dndResult.newRoomsJson || worldState.roomsJson,
      };
      if (dndResult.newPlayerX !== undefined && dndResult.newPlayerX !== 0) {
        mapPayload.new_player_x = dndResult.newPlayerX;
        mapPayload.new_player_y = dndResult.newPlayerY;
      }
      
      json(res, 200, envelope({ map: mapPayload, actions: actionResult.overlay }, [], rootSpan));

    // === Login & Players ===
    } else if (req.url === '/api/login' && req.method === 'POST') {
      const name = (body.name || 'Adventurer').trim();
      const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
      const playerId = `${slug}-${crypto.randomUUID().slice(0, 4)}`;

      // Create hero for this player
      await grpcCall(heroClient, 'hero-service', 'resetHero', {
        heroId: playerId,
        name,
        heroClass: body.heroClass || 'Fighter',
      }, rootSpan);

      players[playerId] = { name, heroId: playerId, active: false, lastSeen: Date.now(), spawnIndex: -1 };
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({ playerId, name }, [
        logEntry(`${name} has entered the dungeon.`, 'system', 'login'),
      ], rootSpan));

    } else if (req.url === '/api/players' && req.method === 'GET') {
      rootSpan.timeEnd = Date.now();
      const playerList = Object.entries(players).map(([id, p]) => ({ playerId: id, name: p.name }));
      json(res, 200, envelope({ players: playerList }, [], rootSpan));

    } else if (req.url === '/api/game/join' && req.method === 'POST') {
      const playerId = getPlayerId(req);
      const playerInfo = players[playerId];
      const name = playerInfo?.name || body.name || 'Adventurer';

      // Check if world needs regeneration (no active players left)
      let gameRes = await grpcCall(gameClient, 'game-service', 'getGameState', {}, rootSpan);
      const activePlayers = getActivePlayers();

      if (activePlayers === 0 || !gameRes.levelName) {
        // No active players — generate fresh world
        nextSpawnIndex = 0;
        await grpcCall(heroClient, 'hero-service', 'resetHero', {
          heroId: playerId, name, heroClass: body.heroClass || 'Fighter',
        }, rootSpan);
        gameRes = await grpcCall(gameClient, 'game-service', 'startGame', {
          level: 0, campaignId: body.campaignId || 'default', maxPlayers: 4,
        }, rootSpan);
      }

      // Assign spawn position
      const spawns = JSON.parse(gameRes.spawnPositionsJson || '[]');
      const spawnIdx = nextSpawnIndex % Math.max(spawns.length, 1);
      const spawn = spawns[spawnIdx] || { x: 0, y: 0 };
      nextSpawnIndex++;

      if (players[playerId]) {
        players[playerId].active = true;
        players[playerId].lastSeen = Date.now();
        players[playerId].spawnIndex = spawnIdx;
      }

      await grpcCall(heroClient, 'hero-service', 'resetHero', {
        heroId: playerId, name, heroClass: body.heroClass || 'Fighter',
      }, rootSpan);
      await grpcCall(heroClient, 'hero-service', 'updatePosition', {
        heroId: playerId, x: spawn.x, y: spawn.y,
      }, rootSpan);

      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({
        ...gameRes,
        spawnX: spawn.x,
        spawnY: spawn.y,
      }, [
        logEntry(`${name} joins the adventure at spawn ${spawnIdx + 1}...`, 'discovery', 'game'),
      ], rootSpan));

    } else if (req.url === '/api/leave' && req.method === 'POST') {
      // Support both header and body for playerId (sendBeacon can't send custom headers)
      const playerId = getPlayerId(req) !== 'default' ? getPlayerId(req) : (body.playerId || 'default');
      if (players[playerId]) {
        players[playerId].active = false;
        log.info(`Player ${players[playerId].name} (${playerId}) left the game`);
      }
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({ success: true }, [], rootSpan));

    } else if (req.url === '/api/session/status' && req.method === 'GET') {
      const gameRes = await grpcCall(gameClient, 'game-service', 'getGameState', {}, rootSpan);
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({
        activePlayers: getActivePlayers(),
        worldExists: !!gameRes.levelName,
        levelName: gameRes.levelName || '',
      }, [], rootSpan));

    // === Health ===
    } else if (req.url === '/api/health') {
      rootSpan.timeEnd = Date.now();
      const resData = { status: 'ok', services: ['dice', 'dnd', 'hero', 'inventory', 'action', 'world', 'game'] };
      rootSpan.dataRet = JSON.stringify(resData);
      json(res, 200, resData);

    } else if (req.url === '/api/config/keymap' && req.method === 'GET') {
      const resData = await grpcCall(gameClient, 'game-service', 'getKeymap', {}, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = JSON.stringify(resData);
      json(res, 200, envelope(resData, [], rootSpan));

    } else if (req.url === '/api/config/campaigns' && req.method === 'GET') {
      const resData = await grpcCall(gameClient, 'game-service', 'getCampaign', { campaignId: 'default' }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = JSON.stringify(resData);
      json(res, 200, envelope(resData, [], rootSpan));

    } else if (req.url === '/api/game/state' && req.method === 'GET') {
      const resData = await grpcCall(gameClient, 'game-service', 'getGameState', {}, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = JSON.stringify(resData);
      json(res, 200, envelope(resData, [], rootSpan));

    } else if (req.url === '/api/settings' && req.method === 'GET') {
      const resData = await grpcCall(gameClient, 'game-service', 'getSettings', {}, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = JSON.stringify(resData);
      json(res, 200, envelope(resData, [], rootSpan));

    } else if (req.url === '/api/game/new' && req.method === 'POST') {
      // Reset hero to defaults
      await grpcCall(heroClient, 'hero-service', 'resetHero', {
        heroId: getPlayerId(req),
        name: body.name || 'Adventurer',
        heroClass: body.heroClass || 'Fighter',
      }, rootSpan);

      // Start a fresh game (this resets world + regenerates the map)
      const gameRes = await grpcCall(gameClient, 'game-service', 'startGame', {
        level: 0,
        campaignId: body.campaignId || 'default',
      }, rootSpan);

      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope(gameRes, [
        logEntry('A new adventure begins...', 'discovery', 'game'),
      ], rootSpan));

    } else if (req.url === '/api/settings' && req.method === 'POST') {
      const resData = await grpcCall(gameClient, 'game-service', 'updateSettings', {
        settingsJson: JSON.stringify(body),
      }, rootSpan);
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = JSON.stringify(resData);
      json(res, 200, envelope(resData, [
        logEntry('Settings updated', 'info', 'game'),
      ], rootSpan));

    } else {
      rootSpan.timeEnd = Date.now();
      rootSpan.dataRet = JSON.stringify({ error: 'Not found' });
      json(res, 404, envelope(null, [logEntry('Unknown API endpoint', 'system')], rootSpan));
    }
  } catch (err) {
    log.error('Error:', err.message);
    rootSpan.timeEnd = Date.now();
    rootSpan.dataRet = JSON.stringify({ error: err.message });
    json(res, 500, envelope(null, [logEntry(`Error: ${err.message}`, 'combat', 'system')], rootSpan));
  }
});

server.listen(API_PORT, () => {
  log.info(`Running on port ${API_PORT}`);
  log.info(`Services: dice(${DICE_URL}) dnd(${DND_URL}) hero(${HERO_URL}) inventory(${INVENTORY_URL}) action(${ACTION_URL}) world(${WORLD_URL})`);
});
