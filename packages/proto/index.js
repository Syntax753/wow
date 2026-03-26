const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { createLogger, LogLevel } = require('./logger');
const { TILE, ACTION, DIRECTION, MAP_TYPE, LAYER, ACTION_ID, PROXIMITY, ROOM_DESCRIPTIONS } = require('./constants');

const PROTO_DIR = __dirname;

const loaderOptions = {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
};

function loadProto(protoFile) {
  const packageDefinition = protoLoader.loadSync(
    path.join(PROTO_DIR, protoFile),
    loaderOptions
  );
  return grpc.loadPackageDefinition(packageDefinition);
}

const diceProto = loadProto('dice.proto');
const dndProto = loadProto('dnd.proto');
const heroProto = loadProto('hero.proto');
const inventoryProto = loadProto('inventory.proto');
const actionProto = loadProto('action.proto');
const roomProto = loadProto('room.proto');
const lightProto = loadProto('light.proto');
const renderProto = loadProto('render.proto');
const enemyProto = loadProto('enemy.proto');
const worldProto = loadProto('world.proto');
const inputProto = loadProto('input.proto');
const gameProto = loadProto('game.proto');
const multiProto = loadProto('multi.proto');

module.exports = {
  grpc,
  diceProto,
  dndProto,
  heroProto,
  inventoryProto,
  actionProto,
  roomProto,
  lightProto,
  renderProto,
  worldProto,
  gameProto,
  DiceService: diceProto.dice.DiceService,
  DndService: dndProto.dnd.DndService,
  HeroService: heroProto.hero.HeroService,
  InventoryService: inventoryProto.inventory.InventoryService,
  ActionService: actionProto.action.ActionService,
  RoomService: roomProto.room.RoomService,
  LightService: lightProto.light.LightService,
  RenderService: renderProto.render.RenderService,
  EnemyService: enemyProto.enemy.EnemyService,
  WorldService: worldProto.world.WorldService,
  InputService: inputProto.input.InputService,
  GameService: gameProto.game.GameService,
  MultiService: multiProto.multi.MultiService,
  createLogger,
  LogLevel,
  TILE,
  ACTION,
  DIRECTION,
  MAP_TYPE,
  LAYER,
  ACTION_ID,
  PROXIMITY,
  ROOM_DESCRIPTIONS,
};
