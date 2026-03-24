const { grpc, HeroService, InventoryService } = require('@wow/proto');

const PORT = process.env.HERO_SERVICE_PORT || '50053';
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'localhost:50054';

const inventoryClient = new InventoryService(INVENTORY_URL, grpc.credentials.createInsecure());

// In-memory hero storage (keyed by hero_id)
const heroes = {};

function defaultHero(heroId, name, heroClass) {
  return {
    heroId: heroId || 'default',
    name: name || 'Adventurer',
    heroClass: heroClass || 'Fighter',
    level: 1,
    hp: 20,
    maxHp: 20,
    xp: 0,
    strength: 10,
    vitality: 10,
    agility: 10,
    wisdom: 10,
    luck: 10,
    armorClass: 10,
    visibility: 6,
    positionX: 0,
    positionY: 0,
  };
}

// Async wrapper for inventory-service calls
function inventoryCall(method, request) {
  return new Promise((resolve, reject) => {
    inventoryClient[method](request, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function getHero(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'hero-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId } = call.request;
  const id = heroId || 'default';
  if (!heroes[id]) {
    heroes[id] = defaultHero(id);
  }
  callback(null, { ...heroes[id], trace });
}

function updateStat(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'hero-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId, statName, delta } = call.request;
  const id = heroId || 'default';
  if (!heroes[id]) {
    heroes[id] = defaultHero(id);
  }

  const statMap = {
    STR: 'strength',
    VIT: 'vitality',
    AGI: 'agility',
    WIS: 'wisdom',
    LCK: 'luck',
  };

  const field = statMap[statName.toUpperCase()];
  if (field && heroes[id][field] !== undefined) {
    heroes[id][field] = Math.max(1, heroes[id][field] + delta);
    console.log(`[HeroService] UpdateStat: ${id} ${statName} ${delta > 0 ? '+' : ''}${delta} => ${heroes[id][field]}`);
  }
  callback(null, { ...heroes[id], trace });
}

function resetHero(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'hero-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId, name, heroClass } = call.request;
  const id = heroId || 'default';
  heroes[id] = defaultHero(id, name, heroClass);
  callback(null, { ...heroes[id], trace });
}

async function getEffectiveStats(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'hero-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  try {
    const { heroId } = call.request;
    const id = heroId || 'default';
    if (!heroes[id]) {
      heroes[id] = defaultHero(id);
    }
    const hero = heroes[id];

    // Get item bonuses from inventory-service
    let bonuses = {};
    try {
      const invResult = await inventoryCall('getStatBonuses', { heroId: id, trace: { traceId: trace.traceId, spanId: trace.spanId } });
      bonuses = invResult.bonuses || {};
    } catch (err) {
      console.error('[HeroService] Could not reach inventory-service:', err.message);
    }

    // Aggregate base stats + item bonuses
    const effective = {
      strength: hero.strength + (bonuses.strength || bonuses.STR || 0),
      vitality: hero.vitality + (bonuses.vitality || bonuses.VIT || 0),
      agility: hero.agility + (bonuses.agility || bonuses.AGI || 0),
      wisdom: hero.wisdom + (bonuses.wisdom || bonuses.WIS || 0),
      armorClass: hero.armorClass + (bonuses.armorClass || bonuses.AC || 0),
      visibility: hero.visibility + (bonuses.visibility || 0),
      attack: hero.strength + (bonuses.attack || 0),
      defense: hero.armorClass + (bonuses.defense || 0),
      bonuses,
      trace
    };

    console.log(`[HeroService] GetEffectiveStats: ${id} visibility=${effective.visibility} (base=${hero.visibility} + bonus=${bonuses.visibility || 0})`);
    callback(null, effective);
  } catch (err) {
    console.error('[HeroService] Error getting effective stats:', err.message);
    callback(err);
  }
}

function updatePosition(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'hero-service',
    data: JSON.stringify({ x: call.request.x, y: call.request.y }),
    subSpans: []
  };

  const { heroId, x, y } = call.request;
  const id = heroId || 'default';
  if (!heroes[id]) {
    heroes[id] = defaultHero(id);
  }
  heroes[id].positionX = x;
  heroes[id].positionY = y;
  callback(null, { ...heroes[id], trace });
}

function main() {
  const server = new grpc.Server();
  server.addService(HeroService.service, { getHero, updateStat, resetHero, updatePosition, getEffectiveStats });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[HeroService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[HeroService] Running on port ${port}`);
    }
  );
}

main();
