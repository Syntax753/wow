const { grpc, DiceService, createLogger } = require('@wow/proto');

const log = createLogger('DiceService');
const PORT = process.env.DICE_SERVICE_PORT || '50051';

/**
 * Parse a dice string like "2d12" into { count, sides }.
 * Supports: "d6", "1d20", "3d8", etc.
 * Default: 1d6
 */
function parseDice(diceStr) {
  if (!diceStr || diceStr.trim() === '') return { count: 1, sides: 6 };
  const match = diceStr.trim().toLowerCase().match(/^(\d*)d(\d+)$/);
  if (!match) return { count: 1, sides: 6 };
  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2], 10);
  return { count: Math.max(1, count), sides: Math.max(1, sides) };
}

function rollDice(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'dice-service',
    data: JSON.stringify(call.request.dice),
    subSpans: []
  };

  const { dice } = call.request;
  const diceList = dice && dice.length > 0 ? dice : ['1d6'];

  let grandTotal = 0;
  const results = diceList.map((dieStr) => {
    const { count, sides } = parseDice(dieStr);
    const rolls = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * sides) + 1;
      rolls.push(roll);
      total += roll;
    }
    grandTotal += total;
    return {
      die: `${count}d${sides}`,
      rolls,
      total,
    };
  });

  log.debug(`Rolled: ${JSON.stringify(results)} => ${grandTotal}`);

  callback(null, {
    results,
    grandTotal,
    trace,
  });
}

function main() {
  const server = new grpc.Server();
  server.addService(DiceService.service, { rollDice });
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
