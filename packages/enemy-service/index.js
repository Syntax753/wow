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

function getTile(tilesDict, x, y) {
  return tilesDict[`${x},${y}`] || ' ';
}

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
    try { tilesDict = JSON.parse(tilesJson || "{}"); } catch { tilesDict = {}; }
    
    let enemies = [];
    if (currentEnemiesJson) {
      enemies = JSON.parse(currentEnemiesJson);
    }
    
    let rooms = [];
    if (roomsJson) {
      rooms = JSON.parse(roomsJson);
    }

    let logs = [];
    let stateModified = false;

    // 1. Encounter Generation Loop (Check rooms for missing enemies)
    // For simplicity, we assume an "unpopulated" room is one that lacks any enemy completely.
    // D&D Rule: 25% chance of an encounter in an empty room upon discovery.
    for (const room of rooms) {
      // Is there an enemy in this room?
      const hasEnemy = enemies.some(e => e.x >= room.x && e.x < room.x + room.width && e.y >= room.y && e.y < room.y + room.height);
      
      // If room has no enemy, let's roll for encounter
      // But wait! We only want to roll ONCE when discovered. 
      // If we roll every turn, eventually it fills up.
      // Let's use a simple deterministic hash of the room coordinates to see if we spawn.
      // E.g. (room.x * 73856093 ^ room.y * 19349663) modulo 4 == 0 (25% chance)
      const roomHash = (room.x * 73856093) ^ (room.y * 19349663);
      if (!hasEnemy && (Math.abs(roomHash) % 4 === 0)) {
        // Roll 1d6 for number of enemies (wait, maybe just 1 for now)
        const encounterRoll = await rollDiceAsync(["1d20"], trace);
        
        let type = "Goblin";
        let char = "g";
        let maxHp = 7;
        
        if (encounterRoll.grandTotal >= 15) {
          type = "Skeleton";
          char = "s";
          maxHp = 13;
        } else if (encounterRoll.grandTotal >= 19) {
          type = "Orc";
          char = "o";
          maxHp = 15;
        }

        // Spawn in center of room
        const spawnX = room.x + Math.floor(room.width / 2);
        const spawnY = room.y + Math.floor(room.height / 2);
        
        // Don't spawn on top of player or walls
        if (spawnX !== playerX || spawnY !== playerY) {
          const tile = getTile(tilesDict, spawnX, spawnY);
          if (tile === '.') {
            enemies.push({
              id: crypto.randomUUID(),
              type,
              char,
              x: spawnX,
              y: spawnY,
              hp: maxHp,
              maxHp
            });
            logs.push({
              text: `A wild ${type} appears in the shadows.`,
              type: 'combat',
              source: 'enemy',
              timestamp: Date.now()
            });
            stateModified = true;
          }
        }
      }
    }

    // 2. AI Turn Loop
    for (let enemy of enemies) {
      // Simple AI: Move towards player if within 5 squares (Aggro Radius)
      const dist = Math.abs(enemy.x - playerX) + Math.abs(enemy.y - playerY);
      
      if (dist <= 5 && dist > 1) {
        let dx = 0;
        let dy = 0;
        if (playerX > enemy.x) dx = 1;
        else if (playerX < enemy.x) dx = -1;
        
        if (playerY > enemy.y) dy = 1;
        else if (playerY < enemy.y) dy = -1;

        // Try to move X first
        let moved = false;
        if (dx !== 0 && getTile(tilesDict, enemy.x + dx, enemy.y) === '.') {
          enemy.x += dx;
          moved = true;
          stateModified = true;
        } else if (dy !== 0 && getTile(tilesDict, enemy.x, enemy.y + dy) === '.') {
          enemy.y += dy;
          moved = true;
          stateModified = true;
        }
      } else if (dist === 1) {
        // Attack
        const attackRoll = await rollDiceAsync(["1d20"], trace);
        logs.push({
          text: `The ${enemy.type} strikes at you! (Rolled ${attackRoll.grandTotal})`,
          type: 'combat',
          source: 'enemy',
          timestamp: Date.now()
        });
        stateModified = true;
      }
    }

    // 3. Build Layer 30
    const interactables = {};
    for (const e of enemies) {
      if (e.hp > 0) {
        interactables[`${e.x},${e.y}`] = e.char;
      }
    }

    callback(null, {
      updatedEnemiesJson: stateModified ? JSON.stringify(enemies) : currentEnemiesJson,
      enemyLayer: {
        layerType: 30, // Layer 30 for Enemies
        tilesJson: JSON.stringify(interactables)
      },
      logEntries: logs,
      trace
    });

  } catch (err) {
    console.error('[EnemyService] Error processing enemies:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(EnemyService.service, { processEnemies });
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
