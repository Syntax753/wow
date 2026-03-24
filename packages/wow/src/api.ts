// API client for communicating with the WoW backend server
// All responses use the standard envelope: { data, logEntries }

const API_BASE = '/api';

// === Standard Envelope ===
export interface LogEntry {
  text: string;
  type: 'info' | 'action' | 'discovery' | 'combat' | 'system';
  source: string;
  timestamp: number;
}

export interface ApiResponse<T> {
  data: T;
  logEntries: LogEntry[];
}

// === Dice ===
export interface RollResult {
  die: string;
  rolls: number[];
  total: number;
}

export interface DiceResponse {
  results: RollResult[];
  grandTotal: number;
}

// === DnD ===
export interface RoomResponse {
  width: number;
  height: number;
  description: string;
}

export interface CorridorResponse {
  length: number;
  direction: string;
  description: string;
}

export interface RoomPosition {
  x: number;
  y: number;
}

export interface ExploreDoorResponse {
  structureType: string;
  width: number;
  height: number;
  description: string;
  doors?: RoomPosition[];
  fitSuccess: boolean;
  originX: number;
  originY: number;
  newTilesJson: string;
  mergedTilesJson?: string;
  updatedEnemiesJson?: string;
  newRoomsJson?: string;
}

// === Hero ===
export interface HeroState {
  heroId: string;
  name: string;
  heroClass: string;
  level: number;
  hp: number;
  maxHp: number;
  xp: number;
  strength: number;
  vitality: number;
  agility: number;
  wisdom: number;
  luck: number;
  armorClass: number;
}

// === Inventory ===
export interface Item {
  itemId: string;
  name: string;
  description: string;
  itemType: string;
  quantity: number;
  modifiers: Record<string, number>;
  weight: number;
  canCarry: boolean;
  canFit: string[];  // body parts: 'head', 'chest', 'legs', 'feet', 'right hand', 'left hand', 'neck', 'finger'
}

export interface InventoryState {
  heroId: string;
  items: Item[];
  capacity: number;
  gold: number;
}

// === Actions ===
export interface GameAction {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface ActionsResponse {
  overlay: Inspector;
}

// === World State (for serialization) ===
// Slimmed down — world-service is now the authoritative source for tiles/rooms
export interface WorldStatePayload {
  level: number;
  playerX: number;
  playerY: number;
}

// === Action & Inspector Overlay ===

export interface Inspector {
  title: string;
  description: string;
  image?: string;
  actions: GameAction[];
}

// === DnD Orchestrated Map Modifiers ===
export interface Tile {
  char: string;
  visible: boolean;
  revealed: boolean;
}

export interface ComputeMapModifiersResponse {
  merged_tiles_json: string;
  new_collision_tiles?: string;
  new_player_x?: number;
  new_player_y?: number;
  new_rooms_json?: string;
  updated_enemies_json?: string;
}

export interface GameSyncResponse {
  map: ComputeMapModifiersResponse;
  actions: Inspector;
}

export interface InputResponse {
  map: {
    merged_tiles_json: string;
    updated_enemies_json?: string;
    new_collision_tiles?: string;
    new_rooms_json?: string;
  };
  player: {
    x: number;
    y: number;
  };
  action: string;
  message: string;
  actions: Inspector;
}

// === Configuration ===
export interface GetKeymapResponse {
  keymapJson: string;
}

export interface GetCampaignResponse {
  campaignJson: string;
}

// === API calls ===
function logTrace(trace: any, parentName = 'wow') {
  if (!trace) return;
  const { traceId, spanId, serviceName, timeStart, timeEnd, data, dataRet, subSpans } = trace;
  const duration = timeEnd ? timeEnd - timeStart : '?';
  
  let parsedData: any = null;
  let summary = '';
  
  try {
    if (data) parsedData = JSON.parse(data);
  } catch {}

  if (serviceName === 'wow-api' && parsedData?.url) {
    summary = parsedData.url;
  } else if (parsedData) {
    // Summarize the top-level keys for the title (excluding giant fields like tiles)
    const keys = Object.keys(parsedData)
      .filter(k => k !== 'trace' && k !== 'tiles')
      .slice(0, 3);
    if (keys.length > 0) {
       summary = keys.map(k => {
         const val = parsedData[k];
         if (typeof val === 'object') return `${k}:{...}`;
         const valStr = String(val);
         return `${k}:${valStr.length > 15 ? valStr.substring(0, 15) + '...' : valStr}`;
       }).join(', ');
    }
  }
  
  const title = parentName === 'wow'
    ? `[Trace] ${parentName} ➔ ${serviceName}${summary ? ` (${summary})` : ''} | traceId: ${traceId} | ${duration}ms`
    : `[Span] ${parentName} ➔ ${serviceName}${summary ? ` [${summary}]` : ''} | spanId: ${spanId} | ${duration}ms`;

  console.groupCollapsed(
    `%c${title}`,
    parentName === 'wow' ? 'color: #00ff00; font-weight: bold;' : 'color: #8888ff;'
  );
  
  if (parsedData) console.log('Request Payload:', parsedData);
  else if (data) console.log('Request Payload:', data);
  
  try {
    if (dataRet) console.log('Returned Data:', JSON.parse(dataRet));
  } catch {
    if (dataRet) console.log('Returned Data:', dataRet);
  }

  if (subSpans && subSpans.length > 0) {
    for (const sub of subSpans) {
      logTrace(sub, serviceName);
    }
  }
  
  console.groupEnd();
}

async function post<T>(url: string, body: object = {}): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const jsonData = await res.json();
  if (jsonData.trace) logTrace(jsonData.trace);
  else if ((jsonData.data as any)?.trace) logTrace((jsonData.data as any).trace);
  return jsonData;
}

async function get<T>(url: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const jsonData = await res.json();
  if (jsonData.trace) logTrace(jsonData.trace);
  else if ((jsonData.data as any)?.trace) logTrace((jsonData.data as any).trace);
  return jsonData;
}

// Dice
export const rollDice = (dice: string[] = ['1d6']) =>
  post<DiceResponse>('/dice/roll', { dice });

// DnD
export const exploreDoor = (doorX: number, doorY: number, playerX: number, playerY: number, currentEnemiesJson = '[]', visualRange = 8, level = 1) =>
  post<ExploreDoorResponse>('/dnd/explore', { doorX, doorY, playerX, playerY, currentEnemiesJson, visualRange, level });

// Hero
export const getHero = () => get<HeroState>('/hero');
export const resetHero = (name: string, heroClass: string) =>
  post<HeroState>('/hero', { name, heroClass });
export const updateHeroStat = (statName: string, delta: number) =>
  post<HeroState>('/hero/stat', { statName, delta });

// Inventory
export const getInventory = () => get<InventoryState>('/inventory');
export const addItem = (item: Partial<Item>) =>
  post<InventoryState>('/inventory/add', { item });
export const dropItem = (itemId: string) =>
  post<InventoryState>('/inventory/drop', { itemId });
export const useItem = (itemId: string) =>
  post<InventoryState>('/inventory/use', { itemId });

// Actions
export const getAvailableActions = (worldState: WorldStatePayload) =>
  post<ActionsResponse>('/actions', worldState);

// Map Modifiers
export const computeMapModifiers = (worldState: WorldStatePayload, visualRange = 8) =>
  post<ComputeMapModifiersResponse>('/dnd/map-modifiers', { ...worldState, visualRange });

// Sync (Unified Game Turn loop) — world-service owns tile state
export const syncTurn = (playerX: number, playerY: number, currentEnemiesJson = '[]', visualRange = 8, level = 1) =>
  post<GameSyncResponse>('/sync', { playerX, playerY, currentEnemiesJson, visualRange, level });

// Input — unified keypress handler (movement, actions, door exploration)
export const sendInput = (key: string, currentEnemiesJson = '[]', visualRange = 8, level = 1) =>
  post<InputResponse>('/input', { key, currentEnemiesJson, visualRange, level });

// Config
export const getKeymap = () => get<GetKeymapResponse>('/config/keymap');
export const getCampaign = () => get<GetCampaignResponse>('/config/campaigns');

// Game State
export interface GameStateResponse {
  campaignId: string;
  currentLevel: number;
  levelName: string;
  totalLevels: number;
  settingsJson: string;
}

export interface SettingsResponse {
  settingsJson: string;
}

export const getGameState = () => get<GameStateResponse>('/game/state');
export const getSettings = () => get<SettingsResponse>('/settings');
export const updateSettings = (settings: Record<string, any>) =>
  post<SettingsResponse>('/settings', settings);
export const startNewAdventure = (campaignId = 'default', name = 'Adventurer', heroClass = 'Fighter') =>
  post<{ success: boolean }>('/game/new', { campaignId, name, heroClass });

// Health
export async function healthCheck(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/health`);
  return res.json();
}
