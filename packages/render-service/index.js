const grpc = require('@grpc/grpc-js');
const { RenderService, createLogger } = require('@wow/proto');

const log = createLogger('RenderService');
const crypto = require('crypto');

const PORT = process.env.RENDER_PORT || 50058;

const DEFAULT_PLAYER_COLOR = '#22c55e'; // green

function cloneReqRes(obj) {
  const clone = { ...obj };
  delete clone.trace;
  return JSON.stringify(clone);
}

async function compositeLayers(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'render-service',
    data: JSON.stringify({
      layerCount: call.request.layers?.length || 0,
      center: `${call.request.playerX},${call.request.playerY}`
    }),
    subSpans: []
  };

  try {
    const { layers, playerX, playerY } = call.request;

    const viewportWidth = call.request.viewportWidth || 60;
    const viewportHeight = call.request.viewportHeight || 15;
    const halfW = Math.floor(viewportWidth / 2);
    const halfH = Math.floor(viewportHeight / 2);

    const minX = playerX - halfW;
    const minY = playerY - halfH;

    // 2. Initialize a 2D array of objects for the final UI state
    // visibility: 'hidden' (never seen), 'revealed' (seen before), 'visible' (in current FOV)
    let mapGrid = Array(viewportHeight).fill(null).map(() =>
      Array(viewportWidth).fill(null).map(() => ({ char: ' ', visible: false, revealed: false }))
    );

    // Sort all layers by ascending z-index
    const sortedLayers = [...(layers || [])].sort((a, b) => a.layerType - b.layerType);

    for (const layer of sortedLayers) {
      if (!layer.tilesJson) continue;
      const parsed = JSON.parse(layer.tilesJson);

      if (layer.layerType === 0) {
        // Base Layer (parsed is dictionary {"x,y": "char"})
        for (const [coord, char] of Object.entries(parsed)) {
          const [cx, cy] = coord.split(',').map(Number);
          const localX = cx - minX;
          const localY = cy - minY;
          if (localX >= 0 && localX < viewportWidth && localY >= 0 && localY < viewportHeight) {
            mapGrid[localY][localX].char = char;
          }
        }
        // Apply tile colors if provided
        if (layer.colorsJson) {
          let colors;
          try { colors = JSON.parse(layer.colorsJson); } catch { colors = {}; }
          for (const [coord, color] of Object.entries(colors)) {
            const [cx, cy] = coord.split(',').map(Number);
            const localX = cx - minX;
            const localY = cy - minY;
            if (localX >= 0 && localX < viewportWidth && localY >= 0 && localY < viewportHeight) {
              mapGrid[localY][localX].color = color;
            }
          }
        }
      } else if (layer.layerType === 5) {
        // Revealed Layer — tiles the player has ever seen (parsed is array of "x,y" strings)
        for (const coord of parsed) {
          const [cx, cy] = coord.split(',').map(Number);
          const localX = cx - minX;
          const localY = cy - minY;
          if (localX >= 0 && localX < viewportWidth && localY >= 0 && localY < viewportHeight) {
            mapGrid[localY][localX].revealed = true;
          }
        }
      } else if (layer.layerType === 10) {
        // FOV Layer — currently visible tiles (parsed is array of "x,y" strings)
        for (const coord of parsed) {
          const [cx, cy] = coord.split(',').map(Number);
          const localX = cx - minX;
          const localY = cy - minY;
          if (localX >= 0 && localX < viewportWidth && localY >= 0 && localY < viewportHeight) {
            mapGrid[localY][localX].visible = true;
            mapGrid[localY][localX].revealed = true;
          }
        }
      } else if (layer.layerType === 20 || layer.layerType === 30) {
        // Interactables/Sprites/Enemies Layer (parsed is dictionary {"x,y": "char"})
        for (const [coord, char] of Object.entries(parsed)) {
          const [cx, cy] = coord.split(',').map(Number);
          const localX = cx - minX;
          const localY = cy - minY;
          if (localX >= 0 && localX < viewportWidth && localY >= 0 && localY < viewportHeight) {
            mapGrid[localY][localX].char = char;
          }
        }
      }
    }

    // Overlay all players (Layer 100) — other players first, then the calling player on top
    let allPlayers = [];
    try { allPlayers = JSON.parse(call.request.playersJson || '[]'); } catch {}

    if (allPlayers.length === 0) {
      // Single-player fallback
      allPlayers = [{ x: playerX, y: playerY, color: DEFAULT_PLAYER_COLOR }];
    }

    for (const p of allPlayers) {
      const lx = p.x - minX;
      const ly = p.y - minY;
      if (lx >= 0 && lx < viewportWidth && ly >= 0 && ly < viewportHeight) {
        mapGrid[ly][lx].char = '@';
        mapGrid[ly][lx].visible = true;
        mapGrid[ly][lx].revealed = true;
        mapGrid[ly][lx].color = p.color || DEFAULT_PLAYER_COLOR;
      }
    }

    // Ensure calling player is on top (re-overlay)
    const pLocalX = playerX - minX;
    const pLocalY = playerY - minY;
    if (pLocalX >= 0 && pLocalX < viewportWidth && pLocalY >= 0 && pLocalY < viewportHeight) {
      const callingPlayer = allPlayers.find(p => p.x === playerX && p.y === playerY);
      mapGrid[pLocalY][pLocalX].char = '@';
      mapGrid[pLocalY][pLocalX].visible = true;
      mapGrid[pLocalY][pLocalX].revealed = true;
      mapGrid[pLocalY][pLocalX].color = callingPlayer?.color || DEFAULT_PLAYER_COLOR;
    }

    log.debug(`Compositing completed for viewport around ${playerX},${playerY}`);

    callback(null, {
      mergedTilesJson: JSON.stringify(mapGrid),
      updatedEnemiesJson: "",
      trace
    });
  } catch (err) {
    log.error('Composition error:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(RenderService.service, { compositeLayers });
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
