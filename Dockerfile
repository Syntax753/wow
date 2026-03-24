# Stage 1: Install deps and build frontend
FROM node:24-slim AS builder

WORKDIR /app

# Copy workspace config and all package.json files first (for layer caching)
COPY package.json package-lock.json ./
COPY packages/proto/package.json packages/proto/
COPY packages/dice-service/package.json packages/dice-service/
COPY packages/dnd-service/package.json packages/dnd-service/
COPY packages/hero-service/package.json packages/hero-service/
COPY packages/inventory-service/package.json packages/inventory-service/
COPY packages/action-service/package.json packages/action-service/
COPY packages/shade-service/package.json packages/shade-service/
COPY packages/render-service/package.json packages/render-service/
COPY packages/world-service/package.json packages/world-service/
COPY packages/input-service/package.json packages/input-service/
COPY packages/game-service/package.json packages/game-service/
COPY packages/generators/room-service/package.json packages/generators/room-service/
COPY packages/generators/enemy-service/package.json packages/generators/enemy-service/
COPY packages/wow/package.json packages/wow/

RUN npm install --loglevel verbose 2>&1

# Copy all source
COPY . .

# Build frontend (Vite outputs to packages/wow/dist/)
RUN npm run build -w wow

# Stage 2: Production image
FROM node:24-slim

WORKDIR /app

# Copy everything from builder (node_modules + built frontend)
COPY --from=builder /app .

# Cloud Run sets PORT env var (default 8080)
ENV NODE_ENV=production
ENV PORT=3001

# Expose API gateway port
EXPOSE 3001

# Start all services + API gateway using concurrently
# Cloud Run only exposes one port, so we only need the API gateway (3001)
# which also serves the built frontend static files from packages/wow/dist/
CMD ["npm", "run", "start"]
