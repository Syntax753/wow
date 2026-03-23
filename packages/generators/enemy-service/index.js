const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const { EnemyService, DiceService } = require('@wow/proto');

const PORT = process.env.ENEMY_SERVICE_PORT || '50059';
const DICE_SERVICE_URL = process.env.DICE_SERVICE_URL || 'localhost:50051';

const diceClient = new DiceService(
  DICE_SERVICE_URL,
  grpc.credentials.createInsecure()
);

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
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

// ── Generator RPC: GenerateEnemies ─────────────────────────────────────
// Pure generator — takes a room, rolls dice to determine if enemies spawn
// and what type. Returns a list of Enemy objects in world coordinates.
// Called by world-service after placing a room.
async function generateEnemies(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'enemy-service',
    data: JSON.stringify({ room: call.request.room, level: call.request.level }),
    subSpans: []
  };

  try {
    const room = call.request.room;
    const level = call.request.level || 1;

    if (!room) {
      callback(null, { enemies: [], trace });
      return;
    }

    // Deterministic spawn check: 25% chance based on room coordinate hash
    const roomHash = (room.x * 73856093) ^ (room.y * 19349663);
    if (Math.abs(roomHash) % 4 !== 0) {
      console.log(`[EnemyService] No encounter for room at ${room.x},${room.y} (hash miss)`);
      callback(null, { enemies: [], trace });
      return;
    }

    // Roll 1d20 to determine enemy type (D&D encounter table)
    const encounterRoll = await rollDiceAsync(['1d20'], trace);
    const roll = encounterRoll.grandTotal;

    let type, char, maxHp;
    if (roll >= 19) {
      type = 'Orc';
      char = 'o';
      maxHp = 15;
    } else if (roll >= 15) {
      type = 'Skeleton';
      char = 's';
      maxHp = 13;
    } else {
      type = 'Goblin';
      char = 'g';
      maxHp = 7;
    }

    // Scale HP with dungeon level
    maxHp = maxHp + Math.floor(level / 3);

    // Spawn in center of room (world coordinates)
    const spawnX = room.x + Math.floor(room.width / 2);
    const spawnY = room.y + Math.floor(room.height / 2);

    const enemies = [{
      id: crypto.randomUUID(),
      type,
      char,
      x: spawnX,
      y: spawnY,
      hp: maxHp,
      maxHp
    }];

    console.log(`[EnemyService] Generated ${type} for room at ${room.x},${room.y} (roll: ${roll})`);

    callback(null, { enemies, trace });
  } catch (err) {
    console.error('[EnemyService] Error generating enemies:', err.message);
    callback(err);
  }
}

// ── Aggregator RPC: ProcessEnemies ─────────────────────────────────────
// AI movement, attacks, and layer building. Called by dnd-service each turn.
// Also handles spawning for rooms that don't yet have enemies (backwards compat).
async function processEnemies(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'enemy-service',
    data: JSON.stringify({
      px: call.request.playerX,
      py: call.request.playerY
    }),
    subSpans: []
  };

  try {
    const { tilesJson, roomsJson, playerX, playerY, currentEnemiesJson } = call.request;

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJson || '{}'); } catch { tilesDict = {}; }

    let enemies = [];
    if (currentEnemiesJson) {
      enemies = JSON.parse(currentEnemiesJson);
    }

    let rooms = [];
    if (roomsJson) {
      rooms = JSON.parse(roomsJson);
    }

    let stateModified = false;

    // Spawn enemies for rooms that don't have any yet (deterministic hash check)
    for (const room of rooms) {
      const hasEnemy = enemies.some(e =>
        e.x >= room.x && e.x < room.x + room.width &&
        e.y >= room.y && e.y < room.y + room.height
      );

      const roomHash = (room.x * 73856093) ^ (room.y * 19349663);
      if (!hasEnemy && (Math.abs(roomHash) % 4 === 0)) {
        const encounterRoll = await rollDiceAsync(['1d20'], trace);
        const roll = encounterRoll.grandTotal;

        let type = 'Goblin', char = 'g', maxHp = 7;
        if (roll >= 19) { type = 'Orc'; char = 'o'; maxHp = 15; }
        else if (roll >= 15) { type = 'Skeleton'; char = 's'; maxHp = 13; }

        const spawnX = room.x + Math.floor(room.width / 2);
        const spawnY = room.y + Math.floor(room.height / 2);

        const tile = tilesDict[`${spawnX},${spawnY}`] || ' ';
        if ((spawnX !== playerX || spawnY !== playerY) && tile === '.') {
          enemies.push({ id: crypto.randomUUID(), type, char, x: spawnX, y: spawnY, hp: maxHp, maxHp });
          stateModified = true;
        }
      }
    }

    // AI Turn Loop
    for (const enemy of enemies) {
      const dist = Math.abs(enemy.x - playerX) + Math.abs(enemy.y - playerY);

      if (dist <= 5 && dist > 1) {
        let dx = 0, dy = 0;
        if (playerX > enemy.x) dx = 1;
        else if (playerX < enemy.x) dx = -1;
        if (playerY > enemy.y) dy = 1;
        else if (playerY < enemy.y) dy = -1;

        if (dx !== 0 && (tilesDict[`${enemy.x + dx},${enemy.y}`] || ' ') === '.') {
          enemy.x += dx;
          stateModified = true;
        } else if (dy !== 0 && (tilesDict[`${enemy.x},${enemy.y + dy}`] || ' ') === '.') {
          enemy.y += dy;
          stateModified = true;
        }
      } else if (dist === 1) {
        await rollDiceAsync(['1d20'], trace);
        stateModified = true;
      }
    }

    // Build Layer 30
    const interactables = {};
    for (const e of enemies) {
      if (e.hp > 0) {
        interactables[`${e.x},${e.y}`] = e.char;
      }
    }

    callback(null, {
      updatedEnemiesJson: stateModified ? JSON.stringify(enemies) : currentEnemiesJson,
      enemyLayer: {
        layerType: 30,
        tilesJson: JSON.stringify(interactables)
      },
      trace
    });
  } catch (err) {
    console.error('[EnemyService] Error processing enemies:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(EnemyService.service, { generateEnemies, processEnemies });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[EnemyService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[EnemyService] Running on port ${port}`);
    }
  );
}

main();
