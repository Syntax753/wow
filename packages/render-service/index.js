const grpc = require('@grpc/grpc-js');
const { RenderService } = require('@wow/proto');
const crypto = require('crypto');

const PORT = process.env.RENDER_PORT || 50058;

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

    const viewportWidth = 60;
    const viewportHeight = 15;
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

    // Explicitly overlay the player avatar at the very end (Layer 100)
    const pLocalX = playerX - minX;
    const pLocalY = playerY - minY;
    if (pLocalX >= 0 && pLocalX < viewportWidth && pLocalY >= 0 && pLocalY < viewportHeight) {
      mapGrid[pLocalY][pLocalX].char = '@';
      mapGrid[pLocalY][pLocalX].visible = true;
      mapGrid[pLocalY][pLocalX].revealed = true;
    }

    console.log(`[RenderService] Compositing completed for viewport around ${playerX},${playerY}`);

    callback(null, {
      mergedTilesJson: JSON.stringify(mapGrid),
      updatedEnemiesJson: "",
      trace
    });
  } catch (err) {
    console.error('[RenderService] Composition error:', err.message);
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
        console.error('[RenderService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[RenderService] Running on port ${port}`);
    }
  );
}

main();
