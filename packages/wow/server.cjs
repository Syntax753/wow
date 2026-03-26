/**
 * WoW Backend API Server
 * Bridges the React frontend to all gRPC microservices.
 * All responses include a standard { data, logEntries, trace } envelope.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { grpc, DiceService, DndService, HeroService, InventoryService, ActionService, WorldService, GameService, MultiService, createLogger } = require('@wow/proto');

const log = createLogger('WoW API');

const https = require('https');

const API_PORT = process.env.PORT || process.env.API_PORT || 3001;

// ── GitHub OAuth config ──────────────────────────────────────────────
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const OAUTH_CALLBACK_URL = process.env.OAUTH_CALLBACK_URL || ''; // explicit override for Cloud Run

// Derive base URL from the incoming request (respects Cloud Run's forwarded headers)
function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  return `${proto}://${host}`;
}

// In dev, Vite runs on :8080; in production (Cloud Run), API serves frontend on same origin
const DEV_FRONTEND = process.env.FRONTEND_URL || '';
function getFrontendUrl(req) {
  if (DEV_FRONTEND) return DEV_FRONTEND;                 // explicit override
  const origin = getOrigin(req);
  if (origin.includes('localhost:' + API_PORT)) return 'http://localhost:8080'; // local dev
  return origin;                                          // production: same origin
}
const DICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';
const DND_URL = process.env.DND_SERVICE_URL || 'localhost:50052';
const HERO_URL = process.env.HERO_SERVICE_URL || 'localhost:50053';
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'localhost:50054';
const ACTION_URL = process.env.ACTION_SERVICE_URL || 'localhost:50055';
const WORLD_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';
const GAME_URL = process.env.GAME_SERVICE_URL || 'localhost:50062';
const MULTI_URL = process.env.MULTI_SERVICE_URL || 'localhost:50063';

const diceClient = new DiceService(DICE_URL, grpc.credentials.createInsecure());
const dndClient = new DndService(DND_URL, grpc.credentials.createInsecure());
const heroClient = new HeroService(HERO_URL, grpc.credentials.createInsecure());
const inventoryClient = new InventoryService(INVENTORY_URL, grpc.credentials.createInsecure());
const actionClient = new ActionService(ACTION_URL, grpc.credentials.createInsecure());
const worldClient = new WorldService(WORLD_URL, grpc.credentials.createInsecure());
const gameClient = new GameService(GAME_URL, grpc.credentials.createInsecure());
const multiClient = new MultiService(MULTI_URL, grpc.credentials.createInsecure());

// ── Player identity & session tracking ────────────────────────────────
const PLAYER_COLORS = [
  '#22c55e', '#ef4444', '#3b82f6', '#eab308', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
];

const players = {}; // { [playerId]: { name, heroId, active, lastSeen, spawnIndex, color } }
let nextSpawnIndex = 0;

function assignColor() {
  const usedColors = new Set(Object.values(players).filter(p => p.active).map(p => p.color));
  for (const c of PLAYER_COLORS) {
    if (!usedColors.has(c)) return c;
  }
  return PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length];
}

async function getActivePlayersJson(rootSpan) {
  const activePlayers = Object.entries(players).filter(([, p]) => p.active);
  const positions = [];
  for (const [pid, p] of activePlayers) {
    try {
      const hero = await grpcCall(heroClient, 'hero-service', 'getHero', { heroId: pid }, rootSpan);
      positions.push({ x: hero.positionX || 0, y: hero.positionY || 0, playerId: pid, color: p.color });
    } catch {
      // Hero not found — skip
    }
  }
  return JSON.stringify(positions);
}

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

// ── SSE (Server-Sent Events) for real-time multiplayer ─────────────
const sseClients = new Map(); // playerId → res

function broadcastPlayerPositions(excludePlayerId) {
  if (sseClients.size === 0) return;
  // Use SSE-connected clients as the source of truth for who is online
  const connectedIds = [...sseClients.keys()];
  const positions = [];
  let pending = connectedIds.length;
  if (pending === 0) return;
  for (const pid of connectedIds) {
    const p = players[pid];
    grpcCall(heroClient, 'hero-service', 'getHero', { heroId: pid }, null)
      .then(hero => {
        positions.push({ playerId: pid, x: hero.positionX || 0, y: hero.positionY || 0, color: p?.color || '#eab308' });
      })
      .catch(() => {})
      .finally(() => {
        pending--;
        if (pending === 0) {
          const data = JSON.stringify(positions);
          for (const [clientId, res] of sseClients) {
            if (clientId === excludePlayerId) continue;
            try { res.write(`event: players\ndata: ${data}\n\n`); } catch {}
          }
        }
      });
  }
}

function broadcastResync(excludePlayerId) {
  for (const [clientId, res] of sseClients) {
    if (clientId === excludePlayerId) continue;
    try { res.write(`event: resync\ndata: {}\n\n`); } catch {}
  }
}

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

// ── GitHub OAuth helpers ──────────────────────────────────────────────
function githubRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
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

  // === GitHub OAuth (outside rootSpan — these are redirects, not JSON APIs) ===
  if (req.url === '/api/auth/github' && req.method === 'GET') {
    const callbackUrl = OAUTH_CALLBACK_URL || `${getOrigin(req)}/api/auth/github/callback`;
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: callbackUrl,
      scope: 'read:user',
    });
    res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` });
    res.end();
    return;
  }

  if (req.url.startsWith('/api/auth/github/callback') && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    const frontend = getFrontendUrl(req);
    const callbackUrl = OAUTH_CALLBACK_URL || `${getOrigin(req)}/api/auth/github/callback`;
    if (!code) {
      res.writeHead(302, { Location: frontend });
      res.end();
      return;
    }

    try {
      // Exchange code for access token
      const tokenBody = JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
      });
      const tokenRes = await githubRequest({
        hostname: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(tokenBody),
        },
      }, tokenBody);

      if (!tokenRes.access_token) {
        log.error('GitHub OAuth token error:', tokenRes);
        res.writeHead(302, { Location: `${frontend}?error=auth_failed` });
        res.end();
        return;
      }

      // Fetch GitHub user profile
      const ghUser = await githubRequest({
        hostname: 'api.github.com',
        path: '/user',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${tokenRes.access_token}`,
          'Accept': 'application/json',
          'User-Agent': 'WoW-Game',
        },
      });

      const name = ghUser.login || 'Adventurer';
      const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
      const playerId = `gh-${slug}`;

      // Check if hero already exists for this GitHub user
      let heroExists = false;
      try {
        await grpcCall(heroClient, 'hero-service', 'getHero', { heroId: playerId }, null);
        heroExists = true;
        log.info(`GitHub login (returning): ${name} (${playerId})`);
      } catch {
        // Hero doesn't exist — create a new one
        await grpcCall(heroClient, 'hero-service', 'resetHero', {
          heroId: playerId,
          name,
          heroClass: 'Fighter',
        }, null);
        log.info(`GitHub login (new): ${name} (${playerId})`);
      }

      if (!players[playerId]) {
        players[playerId] = { name, heroId: playerId, active: false, lastSeen: Date.now(), spawnIndex: -1, color: assignColor() };
      } else {
        players[playerId].lastSeen = Date.now();
      }

      // Set cookies and redirect to app (7 days)
      const maxAge = 604800;
      res.writeHead(302, {
        Location: frontend,
        'Set-Cookie': [
          `wow_player_id=${encodeURIComponent(playerId)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
          `wow_player_name=${encodeURIComponent(name)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
          `wow_github_avatar=${encodeURIComponent(ghUser.avatar_url || '')}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
        ],
      });
      res.end();
    } catch (err) {
      log.error('GitHub OAuth error:', err.message);
      res.writeHead(302, { Location: `${frontend}?error=auth_failed` });
      res.end();
    }
    return;
  }

  // === Auth info & logout ===
  if (req.url === '/api/auth/me' && req.method === 'GET') {
    const pid = getPlayerId(req);
    const player = players[pid];
    if (player) {
      json(res, 200, { playerId: pid, name: player.name, provider: pid.startsWith('gh-') ? 'github' : 'guest' });
    } else if (pid.startsWith('gh-')) {
      // Player entry lost (server restart) but cookie is valid — re-register
      const name = pid.replace(/^gh-/, '').replace(/-/g, ' ');
      players[pid] = { name, heroId: pid, active: false, lastSeen: Date.now(), spawnIndex: -1, color: assignColor() };
      json(res, 200, { playerId: pid, name, provider: 'github' });
    } else {
      json(res, 401, { error: 'Not authenticated' });
    }
    return;
  }

  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    const pid = getPlayerId(req);
    if (players[pid]) {
      players[pid].active = false;
      log.info(`Logout: ${players[pid].name} (${pid})`);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': [
        'wow_player_id=; Path=/; Max-Age=0',
        'wow_player_name=; Path=/; Max-Age=0',
        'wow_github_avatar=; Path=/; Max-Age=0',
      ],
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // SSE endpoint for real-time multiplayer updates
  if (req.url.startsWith('/api/events') && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pid = url.searchParams.get('playerId') || getPlayerId(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable proxy buffering (nginx/Cloud Run)
    });
    res.flushHeaders();
    res.write(`event: connected\ndata: ${JSON.stringify({ playerId: pid })}\n\n`);
    sseClients.set(pid, res);
    // Heartbeat every 30s to keep Cloud Run connection alive (5min timeout)
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(pid); });
    // Send current player positions immediately
    broadcastPlayerPositions(null);
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
      const pid = getPlayerId(req);
      const isMulti = players[pid]?.multiplayer;

      let dndResult;
      if (isMulti) {
        dndResult = await grpcCall(multiClient, 'multi-service', 'processMultiInput', {
          playerId: pid,
          key: body.key || '',
          visualRange: body.visualRange || 8,
          currentEnemiesJson: body.currentEnemiesJson || '[]',
          level: body.level || 1,
          viewportWidth: body.viewportWidth || 0,
          viewportHeight: body.viewportHeight || 0,
        }, rootSpan);
      } else {
        const playersJson = await getActivePlayersJson(rootSpan);
        dndResult = await grpcCall(dndClient, 'dnd-service', 'processInput', {
          key: body.key || '',
          visualRange: body.visualRange || 8,
          currentEnemiesJson: body.currentEnemiesJson || '[]',
          level: body.level || 1,
          heroId: pid,
          playersJson,
          viewportWidth: body.viewportWidth || 0,
          viewportHeight: body.viewportHeight || 0,
        }, rootSpan);
      }

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

      // Broadcast position update to all other connected SSE clients
      broadcastPlayerPositions(pid);

    // === Game Loop Sync (Map Modifiers + Actions in one unified trace) ===
    } else if (req.url === '/api/sync' && req.method === 'POST') {
      touchPlayer(req);
      const pid = getPlayerId(req);
      const isMulti = players[pid]?.multiplayer;

      let dndResult;
      if (isMulti) {
        dndResult = await grpcCall(multiClient, 'multi-service', 'syncMultiPlayer', {
          playerId: pid,
          playerX: body.playerX || 0,
          playerY: body.playerY || 0,
          visualRange: body.visualRange || 8,
          currentEnemiesJson: body.currentEnemiesJson || '[]',
          viewportWidth: body.viewportWidth || 0,
          viewportHeight: body.viewportHeight || 0,
        }, rootSpan);
      } else {
        const playersJson = await getActivePlayersJson(rootSpan);
        // Run DnD map modifiers (will init world if needed)
        dndResult = await grpcCall(dndClient, 'dnd-service', 'computeMapModifiers', {
          playerX: body.playerX || 0,
          playerY: body.playerY || 0,
          visualRange: body.visualRange || 8,
          currentEnemiesJson: body.currentEnemiesJson || "[]",
          heroId: pid,
          playersJson,
          viewportWidth: body.viewportWidth || 0,
          viewportHeight: body.viewportHeight || 0,
        }, rootSpan);
      }

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

      // Broadcast position update to all connected SSE clients
      broadcastPlayerPositions(pid);

    // === Login & Players ===
    } else if (req.url === '/api/login' && req.method === 'POST') {
      const { name, heroClass } = body;
      const guestName = (name || 'Adventurer').slice(0, 20);
      const slug = guestName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const playerId = `guest-${slug}-${Date.now().toString(36)}`;

      await grpcCall(heroClient, 'hero-service', 'resetHero', {
        heroId: playerId,
        name: guestName,
        heroClass: heroClass || 'Fighter',
      }, rootSpan);

      if (!players[playerId]) {
        players[playerId] = { name: guestName, heroId: playerId, active: false, lastSeen: Date.now(), spawnIndex: -1, color: assignColor() };
      }

      log.info(`Guest login: ${guestName} (${playerId})`);

      const maxAge = 604800;
      res.setHeader('Set-Cookie', [
        `wow_player_id=${encodeURIComponent(playerId)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
        `wow_player_name=${encodeURIComponent(guestName)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
      ]);
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({ playerId, name: guestName }, [], rootSpan));

    } else if (req.url === '/api/players' && req.method === 'GET') {
      const playerList = [];
      for (const [id, p] of Object.entries(players)) {
        const entry = { playerId: id, name: p.name };
        try {
          const hero = await grpcCall(heroClient, 'hero-service', 'getHero', { heroId: id }, rootSpan);
          entry.positionX = hero.positionX;
          entry.positionY = hero.positionY;
        } catch { /* hero may not exist yet */ }
        playerList.push(entry);
      }
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({ players: playerList }, [], rootSpan));

    } else if (req.url === '/api/game/join' && req.method === 'POST') {
      const playerId = getPlayerId(req);
      const playerInfo = players[playerId];
      const name = playerInfo?.name || body.name || 'Adventurer';

      // Delegate to multi-service for session management
      const joinRes = await grpcCall(multiClient, 'multi-service', 'joinSession', {
        playerId,
        name,
        heroClass: body.heroClass || 'Fighter',
        campaignId: body.campaignId || 'default',
      }, rootSpan);

      // Mark player as multiplayer in gateway
      if (players[playerId]) {
        players[playerId].active = true;
        players[playerId].multiplayer = true;
        players[playerId].lastSeen = Date.now();
        players[playerId].color = joinRes.color;
      }

      // Upgrade all other active players to multiplayer mode so they
      // use multi-service path (shared fog-of-war, player positions)
      for (const [pid, p] of Object.entries(players)) {
        if (pid !== playerId && p.active && !p.multiplayer) {
          p.multiplayer = true;
          log.info(`Upgraded ${p.name} (${pid}) to multiplayer mode`);
        }
      }

      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({
        success: joinRes.success,
        spawnX: joinRes.spawnX,
        spawnY: joinRes.spawnY,
        levelName: joinRes.levelName,
        activePlayers: joinRes.activePlayers,
        color: joinRes.color,
      }, [
        logEntry(`${name} joins the adventure...`, 'discovery', 'game'),
      ], rootSpan));

      // Broadcast to all existing players so they see the new player immediately
      broadcastPlayerPositions();
      broadcastResync();

    } else if (req.url === '/api/leave' && req.method === 'POST') {
      // Support both header and body for playerId (sendBeacon can't send custom headers)
      const playerId = getPlayerId(req) !== 'default' ? getPlayerId(req) : (body.playerId || 'default');
      if (players[playerId]) {
        if (players[playerId].multiplayer) {
          try {
            await grpcCall(multiClient, 'multi-service', 'leaveSession', { playerId }, rootSpan);
          } catch { /* multi-service may be down */ }
        }
        players[playerId].active = false;
        players[playerId].multiplayer = false;
        log.info(`Player ${players[playerId].name} (${playerId}) left the game`);
        // Notify remaining players
        broadcastPlayerPositions();
        broadcastResync();
      }
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({ success: true }, [], rootSpan));

    } else if (req.url === '/api/session/status' && req.method === 'GET') {
      const sessionInfo = await grpcCall(multiClient, 'multi-service', 'getSessionInfo', {}, rootSpan);
      rootSpan.timeEnd = Date.now();
      json(res, 200, envelope({
        activePlayers: sessionInfo.activePlayers,
        worldExists: sessionInfo.worldExists,
        levelName: sessionInfo.levelName || '',
        players: sessionInfo.playersJson,
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

      // Check if a world already exists (another player may be in it)
      const existingWorld = await grpcCall(worldClient, 'world-service', 'getWorldState', { playerId: getPlayerId(req) }, rootSpan);
      let existingTiles = {};
      try { existingTiles = JSON.parse(existingWorld.tilesJson || '{}'); } catch {}

      let gameRes;
      if (Object.keys(existingTiles).length > 0) {
        // World exists — join it instead of regenerating
        gameRes = await grpcCall(gameClient, 'game-service', 'getGameState', {}, rootSpan);
      } else {
        // No world — generate a fresh one
        gameRes = await grpcCall(gameClient, 'game-service', 'startGame', {
          level: 0,
          campaignId: body.campaignId || 'default',
        }, rootSpan);
      }

      // Move hero to spawn position
      let spawnPositions = [];
      try { spawnPositions = JSON.parse(gameRes.spawnPositionsJson || '[]'); } catch {}
      if (spawnPositions.length > 0) {
        await grpcCall(heroClient, 'hero-service', 'updatePosition', {
          heroId: getPlayerId(req),
          x: spawnPositions[0].x,
          y: spawnPositions[0].y,
        }, rootSpan);
      }

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
  log.info(`Services: dice(${DICE_URL}) dnd(${DND_URL}) hero(${HERO_URL}) inventory(${INVENTORY_URL}) action(${ACTION_URL}) world(${WORLD_URL}) game(${GAME_URL}) multi(${MULTI_URL})`);
});
