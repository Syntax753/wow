const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GameService, WorldService, createLogger } = require('@wow/proto');

const log = createLogger('GameService');

const PORT = process.env.GAME_SERVICE_PORT || 50062;
const WORLD_SERVICE_URL = process.env.WORLD_SERVICE_URL || 'localhost:50060';

const worldClient = new WorldService(WORLD_SERVICE_URL, grpc.credentials.createInsecure());

const KEYMAP_PATH = path.join(__dirname, '../../data/keymap.json');
const CAMPAIGNS_DIR = path.join(__dirname, '../../data/campaigns');
const SETTINGS_PATH = path.join(__dirname, '../../data/settings.json');

// ── In-memory game state ─────────────────────────────────────────────
let gameState = {
  campaignId: 'default',
  currentLevel: 0,
  levelName: '',
  totalLevels: 0,
  started: false,
  spawnPositions: [], // [{x, y}] per player spawn room
};

// ── Settings (persisted to disk) ─────────────────────────────────────
let settings = {
  audio: true,
  musicVolume: 0.5,
  sfxVolume: 0.7,
  keymapOverrides: {},
  logLevel: 'info',
};

// Load settings from disk on startup
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  }
} catch (err) {
  log.warn('Could not load settings, using defaults:', err.message);
}

function saveSettingsToDisk() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (err) {
    log.error('Could not save settings:', err.message);
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

const generateLevelAsync = makeAsyncCall(worldClient, 'GenerateLevel', 'world-service');

// ── Campaign loading ─────────────────────────────────────────────────

function loadCampaign(campaignId) {
  const campPath = path.join(CAMPAIGNS_DIR, `${campaignId}.json`);
  return JSON.parse(fs.readFileSync(campPath, 'utf8'));
}

function getLevelConfig(campaign, level) {
  if (!campaign.levels || !Array.isArray(campaign.levels)) {
    return { width: 80, height: 50, maxRooms: 12, maxEnemies: 10, difficulty: 1, regions: [] };
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
    log.error('Error reading keymap:', err.message);
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
    log.error('Error reading campaign:', err.message);
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
    trace,
    spawnPositionsJson: JSON.stringify(gameState.spawnPositions || []),
    mapType: gameState.mapType || 'dungeon',
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
    log.info('Settings updated:', settings);
    callback(null, { success: true, settingsJson: JSON.stringify(settings), trace });
  } catch (err) {
    log.error('Error updating settings:', err.message);
    callback(err);
  }
}

// ── RPC: StartGame ───────────────────────────────────────────────────
// Delegates level generation to world-service's BSP-based GenerateLevel.

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

    log.info(`Starting campaign "${campaign.name}" level ${level}: "${levelConfig.name}"`);

    const maxPlayers = call.request.maxPlayers || 4;
    const difficulty = levelConfig.difficulty || (level + 1);

    // Delegate level generation to world-service BSP
    const mapType = levelConfig.mapType || 'dungeon';
    const levelRes = await generateLevelAsync({
      width: levelConfig.width || 0,   // 0 = use MapType default
      height: levelConfig.height || 0,
      requiredRooms: levelConfig.maxRooms || 0,
      difficulty,
      minRoomSize: 0,  // 0 = use MapType default
      maxRoomSize: 0,
      maxPlayers,
      gridSize: 2,
      regionsJson: JSON.stringify(levelConfig.regions || []),
      mapType,
    }, trace);

    const spawnPositions = JSON.parse(levelRes.spawnPositionsJson || '[]');

    // Update game state
    gameState = {
      campaignId,
      currentLevel: level,
      levelName: levelConfig.name || `Level ${level}`,
      totalLevels: campaign.levels ? campaign.levels.length : 1,
      started: true,
      spawnPositions,
      mapType,
    };

    log.debug(`Level generated via BSP. Spawns: ${JSON.stringify(spawnPositions)}`);

    callback(null, {
      success: true,
      levelName: levelConfig.name || `Level ${level}`,
      levelDescription: levelConfig.description || '',
      currentLevel: level,
      trace,
      spawnPositionsJson: JSON.stringify(spawnPositions),
    });
  } catch (err) {
    log.error('Error starting game:', err.message);
    callback(err);
  }
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
        log.error('Failed to start:', err);
        process.exit(1);
      }
      log.info(`Running on port ${port}`);
    }
  );
}

main();
