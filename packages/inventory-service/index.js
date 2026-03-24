const { grpc, InventoryService } = require('@wow/proto');

const PORT = process.env.INVENTORY_SERVICE_PORT || '50054';

// ── Body part enum — all canFit checks use these constants ───────────
const BodyPart = Object.freeze({
  HEAD:       'head',
  CHEST:      'chest',
  LEGS:       'legs',
  FEET:       'feet',
  RIGHT_HAND: 'right hand',
  LEFT_HAND:  'left hand',
  NECK:       'neck',
  FINGER:     'finger',
});

// ── Item type enum ───────────────────────────────────────────────────
const ItemType = Object.freeze({
  WEAPON: 'weapon',
  ARMOR:  'armor',
  POTION: 'potion',
  SCROLL: 'scroll',
  KEY:    'key',
  MISC:   'misc',
});

// ── Item class ───────────────────────────────────────────────────────
// Every item in the game is an instance of this class.
// Attributes:
//   itemId      - unique identifier
//   name        - display name
//   description - flavour text
//   itemType    - one of ItemType
//   quantity    - stack count
//   modifiers   - stat bonuses { attack, defense, hp, visibility, ... }
//   weight      - weight in pounds (affects carry capacity)
//   canCarry    - whether the player can pick this up
//   canFit      - array of BodyPart values where this item can be equipped
class Item {
  constructor({
    itemId,
    name,
    description = '',
    itemType = ItemType.MISC,
    quantity = 1,
    modifiers = {},
    weight = 0,
    canCarry = true,
    canFit = [],
  }) {
    this.itemId = itemId;
    this.name = name;
    this.description = description;
    this.itemType = itemType;
    this.quantity = quantity;
    this.modifiers = modifiers;
    this.weight = weight;
    this.canCarry = canCarry;
    this.canFit = canFit;
  }

  // Serialize to proto-compatible plain object
  toProto() {
    return {
      itemId: this.itemId,
      name: this.name,
      description: this.description,
      itemType: this.itemType,
      quantity: this.quantity,
      modifiers: this.modifiers,
      weight: this.weight,
      canCarry: this.canCarry,
      canFit: this.canFit,
    };
  }

  // Create an Item from a proto/request object
  static fromProto(obj) {
    return new Item({
      itemId: obj.itemId || obj.item_id,
      name: obj.name || 'Unknown Item',
      description: obj.description || '',
      itemType: obj.itemType || obj.item_type || ItemType.MISC,
      quantity: obj.quantity || 1,
      modifiers: obj.modifiers || {},
      weight: obj.weight || 0,
      canCarry: obj.canCarry !== undefined ? obj.canCarry : (obj.can_carry !== undefined ? obj.can_carry : true),
      canFit: obj.canFit || obj.can_fit || [],
    });
  }
}

// ── Default starting inventory ───────────────────────────────────────
function createStarterItems() {
  return [
    new Item({
      itemId: 'torch_1',
      name: 'Torch',
      description: 'A flickering wooden torch. Illuminates nearby tiles.',
      itemType: ItemType.MISC,
      quantity: 1,
      modifiers: { visibility: 4, attack: 1, defense: 0 },
      weight: 1.0,
      canCarry: true,
      canFit: [BodyPart.RIGHT_HAND, BodyPart.LEFT_HAND],
    }),
    new Item({
      itemId: 'health_potion_1',
      name: 'Health Potion',
      description: 'A small vial of red liquid. Restores a modest amount of health.',
      itemType: ItemType.POTION,
      quantity: 3,
      modifiers: { hp: 10 },
      weight: 0.5,
      canCarry: true,
      canFit: [],
    }),
    new Item({
      itemId: 'dirty_shirt_1',
      name: 'Dirty Shirt',
      description: 'A threadbare cotton shirt. Barely qualifies as clothing.',
      itemType: ItemType.ARMOR,
      quantity: 1,
      modifiers: { defense: 0, attack: 0 },
      weight: 1.0,
      canCarry: true,
      canFit: [BodyPart.CHEST],
    }),
    new Item({
      itemId: 'dirty_trousers_1',
      name: 'Dirty Trousers',
      description: 'Stained and fraying trousers. Better than nothing.',
      itemType: ItemType.ARMOR,
      quantity: 1,
      modifiers: { defense: 0, attack: 0 },
      weight: 0.8,
      canCarry: true,
      canFit: [BodyPart.LEGS],
    }),
    new Item({
      itemId: 'broken_sandals_1',
      name: 'Broken Sandals',
      description: 'Worn leather sandals held together by a single strap.',
      itemType: ItemType.ARMOR,
      quantity: 1,
      modifiers: { defense: 0, attack: 0 },
      weight: 0.5,
      canCarry: true,
      canFit: [BodyPart.FEET],
    }),
  ];
}

// ── In-memory inventory storage (keyed by hero_id) ───────────────────
const inventories = {};

function defaultInventory(heroId) {
  return {
    heroId: heroId || 'default',
    items: createStarterItems(),
    capacity: 20,
    gold: 0,
  };
}

function serializeInventory(inv) {
  return {
    heroId: inv.heroId,
    items: inv.items.map(i => i instanceof Item ? i.toProto() : i),
    capacity: inv.capacity,
    gold: inv.gold,
  };
}

let nextItemId = 1;

// ── RPC handlers ─────────────────────────────────────────────────────

function getInventory(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'inventory-service',
    data: JSON.stringify(call.request),
    subSpans: []
  };

  const id = call.request.heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }
  console.log(`[InventoryService] GetInventory: ${id} (${inventories[id].items.length} items)`);

  callback(null, { ...serializeInventory(inventories[id]), trace });
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

  const id = call.request.heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  if (inventories[id].items.length >= inventories[id].capacity) {
    console.log(`[InventoryService] AddItem: ${id} - inventory full`);
    callback(null, serializeInventory(inventories[id]));
    return;
  }

  const incoming = call.request.item || {};
  const newItem = Item.fromProto({
    ...incoming,
    itemId: incoming.itemId || `item_${nextItemId++}`,
  });

  if (!newItem.canCarry) {
    console.log(`[InventoryService] AddItem: ${id} - ${newItem.name} cannot be carried`);
    callback(null, { ...serializeInventory(inventories[id]), trace });
    return;
  }

  inventories[id].items.push(newItem);
  console.log(`[InventoryService] AddItem: ${id} + ${newItem.name} (${newItem.weight}lbs, fits: [${newItem.canFit.join(', ')}])`);

  callback(null, { ...serializeInventory(inventories[id]), trace });
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

  const id = call.request.heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  const idx = inventories[id].items.findIndex((i) => i.itemId === call.request.itemId);
  if (idx !== -1) {
    const dropped = inventories[id].items.splice(idx, 1)[0];
    console.log(`[InventoryService] DropItem: ${id} - ${dropped.name}`);
  }

  callback(null, { ...serializeInventory(inventories[id]), trace });
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

  const id = call.request.heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  const idx = inventories[id].items.findIndex((i) => i.itemId === call.request.itemId);

  if (idx === -1) {
    callback(null, {
      success: false,
      message: 'Item not found',
      inventory: { ...serializeInventory(inventories[id]), trace },
      trace,
    });
    return;
  }

  const item = inventories[id].items[idx];
  // Consume single-use items (potions, scrolls)
  if (item.itemType === ItemType.POTION || item.itemType === ItemType.SCROLL) {
    item.quantity -= 1;
    if (item.quantity <= 0) {
      inventories[id].items.splice(idx, 1);
    }
  }

  console.log(`[InventoryService] UseItem: ${id} used ${item.name}`);
  callback(null, {
    success: true,
    message: `Used ${item.name}`,
    inventory: { ...serializeInventory(inventories[id]), trace },
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

  const id = call.request.heroId || 'default';
  if (!inventories[id]) {
    inventories[id] = defaultInventory(id);
  }

  const bonuses = {};
  for (const item of inventories[id].items) {
    if (item.modifiers) {
      for (const [stat, value] of Object.entries(item.modifiers)) {
        if (typeof value === 'number') {
          bonuses[stat] = (bonuses[stat] || 0) + value;
        }
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
