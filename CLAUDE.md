# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start all services (frontend + all microservices)
npm run dev

# Build all workspaces
npm run build

# Lint (frontend only)
cd packages/wow && npm run lint

# Kill all service ports
npm run kill

# Frontend only
cd packages/wow && npm run dev      # Vite dev server on :8080
cd packages/wow && npm run preview  # Preview production build
```

`npm run dev` runs 12 concurrent processes — dice, dnd, hero, inv, act, room, shd, rnd, enm, wld services + API gateway + Vite. The `predev` hook kills ports first via `kill-ports.js`.

## Architecture

This is a **D&D dungeon crawler** (NetHack-style) built as a microservices monorepo. npm workspaces share the `@wow/proto` package containing all `.proto` files.

### Service Categories

Services are organized into two categories:

**Aggregator Services** — orchestrate game logic and manage state:
- DnD, World, Hero, Inventory, Action, Shade, Render, Input

**Generator Services** (`packages/generators/`) — produce game objects via dice rolls, returning self-contained JSON structures. No world knowledge:
- Room (generates room/corridor structures)
- Enemy (generates enemies for rooms based on D&D encounter rules; also provides ProcessEnemies AI RPC)
- Future: Loot, Layout, Trap generators

### Service Map

| Service | Port | Role | Category |
|---------|------|------|----------|
| Dice | 50051 | Dice rolling (e.g., "2d12") | Utility |
| DnD | 50052 | **Orchestrator** — coordinates all other services | Aggregator |
| Hero | 50053 | Player character state (in-memory) | Aggregator |
| Inventory | 50054 | Item management (in-memory) | Aggregator |
| Action | 50055 | Determines available player actions from tile context | Aggregator |
| Room | 50056 | Procedural room/corridor generation (local coords) | Generator |
| Shade | 50057 | Field-of-view (Bresenham raycast) | Aggregator |
| Render | 50058 | Layer compositing → 60×15 character viewport | Aggregator |
| Enemy | 50059 | Enemy generation (D&D rules) + AI movement | Generator |
| World | 50060 | **Authoritative world state** — tile storage, collision, placement, fog of war | Aggregator |
| Input | 50061 | Validates keypresses against world state, returns movement/actions | Aggregator |
| API Gateway | 3001 | HTTP→gRPC bridge (`packages/wow/server.cjs`) | — |
| Frontend | 8080 | React + Vite (`packages/wow/src/`) | — |

### Unified Input Loop (`/api/input`)

1. Frontend sends keypress to `/api/input`
2. DnD-Service gets hero position from Hero-Service + world state from World-Service
3. DnD calls Input-Service to validate the keypress against world tiles
4. Input-Service returns: new position, action type (move/open_door/blocked), message
5. If `open_door`: DnD rolls 1d20, generates structure via Room-Service, places via World-Service
6. World-Service converts opened doors (`+`) to floor (`.`) after successful placement
7. DnD runs render pipeline: Enemy → Shade → RevealTiles → Render
8. Render composites layers (z-index: base=0, revealed=5, FOV=10, interactables=20, enemies=30, player=100)
9. API Gateway calls Action-Service for context-sensitive overlay (e.g., [o] Open Door)
10. Frontend renders the grid, updates player position, and displays actions

### Initial Sync (`/api/sync`)

Used only on first page load to initialize the world and render the starting room.

### Key Design Patterns

- **All services use gRPC** with shared proto definitions in `packages/proto/`
- **Distributed tracing**: Every request creates a root UUID span; trace/span IDs propagate through all gRPC calls with timing data
- **Standard response envelope**: `{ data, logEntries, trace }` on all HTTP endpoints
- **Server-side input**: All movement and actions go through Input-Service → DnD-Service. No client-side movement logic.
- **In-memory state**: Hero (position + stats), Inventory, and World services store state in plain JS objects (no DB)
- **World-Service is authoritative**: Frontend no longer sends tile state; World-Service owns all tiles, rooms, and revealed tiles (fog of war)
- **Fog of war**: World-Service tracks revealed tiles persistently. Shade-Service computes current FOV. Render-Service outputs 3 visibility states: visible (in FOV), revealed (seen before), hidden (never seen)
- **Generator pattern**: Generator services (in `packages/generators/`) only produce local-coordinate structures via dice rolls — no world knowledge
- **Deterministic enemy spawning**: Room hash `(x * 73856093 ^ y * 19349663) % 4 == 0` → 25% spawn chance per room

### Frontend Key Files

- `packages/wow/server.cjs` — API gateway (native Node `http`, not Express)
- `packages/wow/src/App.tsx` — Main game component; polls health every 5s, calls `syncTurn`
- `packages/wow/src/api.ts` — Typed REST client for all endpoints
- `packages/wow/src/game.ts` — Tile constants and game state helpers
- `packages/wow/vite.config.ts` — Proxies `/api/*` → `http://localhost:3001`

### Environment Variables (`.env`)

Service URLs are configured via env vars (`DICE_SERVICE_URL`, `DND_SERVICE_URL`, `WORLD_SERVICE_URL`, etc.). An optional `GEMINI_API_KEY` is available but unused in current code.
