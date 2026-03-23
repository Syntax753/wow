const grpc = require('@grpc/grpc-js');
const { ShadeService } = require('@wow/proto');

const PORT = process.env.SHADE_PORT || 50057;

function computeVisibility(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'shade-service',
    data: JSON.stringify({
      px: call.request.playerX,
      py: call.request.playerY,
      radius: call.request.visualRange
    }),
    subSpans: []
  };

  try {
    const { tilesJson, playerX: px, playerY: py, visualRange } = call.request;
    const radius = visualRange > 0 ? visualRange : 8; // default to 8 if not specified

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJson || "{}"); } catch { tilesDict = {}; }

    const visible = new Set();

    function getTile(x, y) {
      return tilesDict[`${x},${y}`] || ' ';
    }

    // Player tile is always visible
    visible.add(`${px},${py}`);

    function castRay(x0, y0, x1, y1) {
      let dx = Math.abs(x1 - x0);
      let dy = Math.abs(y1 - y0);
      let sx = (x0 < x1) ? 1 : -1;
      let sy = (y0 < y1) ? 1 : -1;
      let err = dx - dy;

      let cx = x0;
      let cy = y0;

      while (true) {
        // Enforce visual radius (Chebyshev distance)
        if (Math.abs(cx - px) > radius || Math.abs(cy - py) > radius) break;

        const t = getTile(cx, cy);
        visible.add(`${cx},${cy}`);

        // Walls block further vision but are themselves visible
        if (t === '#' && !(cx === x0 && cy === y0)) {
          break;
        }

        // Unknown/empty space beyond the map also blocks
        if (t === ' ' && !(cx === x0 && cy === y0)) {
          break;
        }

        if (cx === x1 && cy === y1) break;
        let e2 = 2 * err;
        if (e2 > -dy) { err -= dy; cx += sx; }
        if (e2 < dx) { err += dx; cy += sy; }
      }
    }

    // Cast rays to the perimeter of the bounding box
    const minX = px - radius;
    const maxX = px + radius;
    const minY = py - radius;
    const maxY = py + radius;

    for (let x = minX; x <= maxX; x++) {
      castRay(px, py, x, minY);
      castRay(px, py, x, maxY);
    }
    for (let y = minY + 1; y < maxY; y++) {
      castRay(px, py, minX, y);
      castRay(px, py, maxX, y);
    }

    // Stringify the array of coordinate strings
    const visibleCoordsJson = JSON.stringify([...visible]);
    console.log(`[ShadeService] Computed FOV at (${px},${py}), ${visible.size} tiles visible`);

    callback(null, {
      layerType: 10,
      tilesJson: visibleCoordsJson,
      trace
    });
  } catch (err) {
    console.error('[ShadeService] Raycast computational error:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(ShadeService.service, { computeVisibility });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[ShadeService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[ShadeService] Running on port ${port}`);
    }
  );
}

main();
