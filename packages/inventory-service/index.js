const { grpc, InventoryService } = require('@wow/proto');

const PORT = process.env.INVENTORY_SERVICE_PORT || '50054';

// In-memory inventory storage (keyed by hero_id)
const inventories = {};

function defaultInventory(heroId) {
  return {
    heroId: heroId || 'default',
    items: [
      {
        itemId: 'torch_1',
        name: 'Torch',
        description: 'A flickering wooden torch. Illuminates nearby tiles.',
        itemType: 'misc',
        quantity: 1,
        modifiers: { visibility: 4 },
      }
    ],
    capacity: 20,
    gold: 0,
  };
}

let nextItemId = 1;

function getInventory(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'inventory-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId } = call.request;
  const id = heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }
  console.log(`[InventoryService] GetInventory: ${id} (${inventories[id].items.length} items)`);
  
  callback(null, { ...inventories[id], trace });
}

function addItem(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'inventory-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId, item } = call.request;
  const id = heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  if (inventories[id].items.length >= inventories[id].capacity) {
    console.log(`[InventoryService] AddItem: ${id} - inventory full`);
    callback(null, inventories[id]);
    return;
  }

  const newItem = {
    itemId: item.itemId || `item_${nextItemId++}`,
    name: item.name || 'Unknown Item',
    description: item.description || '',
    itemType: item.itemType || 'misc',
    quantity: item.quantity || 1,
    modifiers: item.modifiers || {},
  };

  inventories[id].items.push(newItem);
  console.log(`[InventoryService] AddItem: ${id} + ${newItem.name}`);

  callback(null, { ...inventories[id], trace });
}

function dropItem(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'inventory-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId, itemId } = call.request;
  const id = heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  const idx = inventories[id].items.findIndex((i) => i.itemId === itemId);
  if (idx !== -1) {
    const dropped = inventories[id].items.splice(idx, 1)[0];
    console.log(`[InventoryService] DropItem: ${id} - ${dropped.name}`);
  }

  callback(null, { ...inventories[id], trace });
}

function useItem(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'inventory-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId, itemId } = call.request;
  const id = heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  const idx = inventories[id].items.findIndex((i) => i.itemId === itemId);

  // If item not found early return branch
  if (idx === -1) {
    callback(null, {
      success: false,
      message: 'Item not found',
      inventory: { ...inventories[id], trace },
      trace,
    });
    return;
  }

  const item = inventories[id].items[idx];
  // Consume single-use items (potions, scrolls)
  if (item.itemType === 'potion' || item.itemType === 'scroll') {
    item.quantity -= 1;
    if (item.quantity <= 0) {
      inventories[id].items.splice(idx, 1);
    }
  }

  console.log(`[InventoryService] UseItem: ${id} used ${item.name}`);
  callback(null, {
    success: true,
    message: `Used ${item.name}`,
    inventory: { ...inventories[id], trace },
    trace,
  });
}

// Sum all modifiers across all items in the inventory
function getStatBonuses(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'inventory-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const { heroId } = call.request;
  const id = heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  const bonuses = {};
  for (const item of inventories[id].items) {
    if (item.modifiers) {
      for (const [stat, value] of Object.entries(item.modifiers)) {
        bonuses[stat] = (bonuses[stat] || 0) + value;
      }
    }
  }

  console.log(`[InventoryService] GetStatBonuses: ${id} =>`, bonuses);
  callback(null, { bonuses, trace });
}

function main() {
  const server = new grpc.Server();
  server.addService(InventoryService.service, { getInventory, addItem, dropItem, useItem, getStatBonuses });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[InventoryService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[InventoryService] Running on port ${port}`);
    }
  );
}

main();
