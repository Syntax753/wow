const { grpc, HeroService } = require('@wow/proto');

const PORT = process.env.HERO_SERVICE_PORT || '50053';

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
    positionX: 0,
    positionY: 0,
  };
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
  server.addService(HeroService.service, { getHero, updateStat, resetHero, updatePosition });
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
