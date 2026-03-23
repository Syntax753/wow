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

`npm run dev` runs 11 concurrent processes — dice, dnd, hero, inv, act, room, shd, rnd, enm services + API gateway + Vite. The `predev` hook kills ports first via `kill-ports.js`.

## Architecture

This is a **D&D dungeon crawler** (NetHack-style) built as a microservices monorepo. npm workspaces share the `@wow/proto` package containing all `.proto` files.

### Service Map

| Service | Port | Role |
|---------|------|------|
| Dice | 50051 | Dice rolling (e.g., "2d12") |
| DnD | 50052 | **Orchestrator** — coordinates all other services |
| Hero | 50053 | Player character state (in-memory) |
| Inventory | 50054 | Item management (in-memory) |
| Action | 50055 | Determines available player actions from tile context |
| Room | 50056 | Procedural room/corridor generation |
| Shade | 50057 | Field-of-view (Bresenham raycast) |
| Render | 50058 | Layer compositing → 60×15 character viewport |
| Enemy | 50059 | Enemy spawning and AI movement |
| API Gateway | 3001 | HTTP→gRPC bridge (`packages/wow/server.cjs`) |
| Frontend | 8080 | React + Vite (`packages/wow/src/`) |

### Game Loop (`/api/sync`)

1. Frontend sends current game state to `/api/sync`
2. API Gateway calls `DnD.computeMapModifiers`
3. DnD orchestrates in order: Enemy-Service → Shade-Service → Render-Service
4. Render composites layers (z-index: base=0, FOV=10, interactables=20, enemies=30, player=100) into a 60×15 grid
5. Frontend renders the grid and fetches available actions

### Door Exploration (`/api/dnd/explore`)

DnD rolls 1d20 via Dice-Service: 1–8 → Room, 9–20 → Corridor. Calls Room-Service accordingly. Collision detection prevents overlapping structures.

### Key Design Patterns

- **All services use gRPC** with shared proto definitions in `packages/proto/`
- **Distributed tracing**: Every request creates a root UUID span; trace/span IDs propagate through all gRPC calls with timing data
- **Standard response envelope**: `{ data, logEntries, trace }` on all HTTP endpoints
- **In-memory state**: Hero and inventory services store state in plain JS objects (no DB)
- **Deterministic enemy spawning**: Room hash `(x * 73856093 ^ y * 19349663) % 4 == 0` → 25% spawn chance per room

### Frontend Key Files

- `packages/wow/server.cjs` — API gateway (native Node `http`, not Express)
- `packages/wow/src/App.tsx` — Main game component; polls health every 5s, calls `syncTurn`
- `packages/wow/src/api.ts` — Typed REST client for all endpoints
- `packages/wow/src/game.ts` — Tile constants and game state helpers
- `packages/wow/vite.config.ts` — Proxies `/api/*` → `http://localhost:3001`

### Environment Variables (`.env`)

Service URLs are configured via env vars (`DICE_SERVICE_URL`, `DND_SERVICE_URL`, etc.). An optional `GEMINI_API_KEY` is available but unused in current code.
