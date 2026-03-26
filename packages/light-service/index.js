const grpc = require('@grpc/grpc-js');
const { LightService, createLogger } = require('@wow/proto');

const log = createLogger('LightService');
const PORT = process.env.LIGHT_PORT || 50057;

function computeVisibility(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'light-service',
    data: JSON.stringify({
      px: call.request.playerX,
      py: call.request.playerY,
      radius: call.request.visualRange,
      mapType: call.request.mapType
    }),
    subSpans: []
  };

  try {
    const { tilesJson, playerX: px, playerY: py, visualRange, mapType } = call.request;
    const radius = visualRange > 0 ? visualRange : 6;

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJson || '{}'); } catch { tilesDict = {}; }

    const visible = new Set();

    // Nature / outdoor maps: full visibility across all tiles
    if (mapType === 'nature') {
      for (const coord of Object.keys(tilesDict)) {
        if (tilesDict[coord] !== ' ') visible.add(coord);
      }

      log.debug(`Full visibility (nature) at (${px},${py}), ${visible.size} tiles visible`);

      callback(null, {
        layerType: 10,
        tilesJson: JSON.stringify([...visible]),
        trace
      });
      return;
    }

    // Dungeon / indoor maps: Bresenham raycast with light radius
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
        // Enforce light radius (Chebyshev distance)
        if (Math.abs(cx - px) > radius || Math.abs(cy - py) > radius) break;

        const t = getTile(cx, cy);
        visible.add(`${cx},${cy}`);

        // Walls and alcoves block further vision but are themselves visible
        if ((t === '#' || t === '\u00ac') && !(cx === x0 && cy === y0)) break;

        // Unknown/empty space beyond the map also blocks
        if (t === ' ' && !(cx === x0 && cy === y0)) break;

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

    // Candle light sources — each emits its own small raycast
    let candlePositions = [];
    try { candlePositions = JSON.parse(call.request.candlePositionsJson || '[]'); } catch {}
    for (const candle of candlePositions) {
      const cr = candle.radius || 3;
      const cx0 = candle.x;
      const cy0 = candle.y;
      // Only process candles within reasonable range of the viewport
      if (Math.abs(cx0 - px) > radius + cr + 5 || Math.abs(cy0 - py) > radius + cr + 5) continue;

      visible.add(`${cx0},${cy0}`);
      const cMinX = cx0 - cr, cMaxX = cx0 + cr, cMinY = cy0 - cr, cMaxY = cy0 + cr;

      function castCandleRay(x0, y0, x1, y1) {
        let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        let sx = (x0 < x1) ? 1 : -1, sy = (y0 < y1) ? 1 : -1;
        let err = dx - dy, lx = x0, ly = y0;
        while (true) {
          if (Math.abs(lx - cx0) > cr || Math.abs(ly - cy0) > cr) break;
          const t = getTile(lx, ly);
          visible.add(`${lx},${ly}`);
          if (t === '#' && !(lx === x0 && ly === y0)) break;
          if (t === ' ' && !(lx === x0 && ly === y0)) break;
          if (lx === x1 && ly === y1) break;
          let e2 = 2 * err;
          if (e2 > -dy) { err -= dy; lx += sx; }
          if (e2 < dx) { err += dx; ly += sy; }
        }
      }

      for (let x = cMinX; x <= cMaxX; x++) {
        castCandleRay(cx0, cy0, x, cMinY);
        castCandleRay(cx0, cy0, x, cMaxY);
      }
      for (let y = cMinY + 1; y < cMaxY; y++) {
        castCandleRay(cx0, cy0, cMinX, y);
        castCandleRay(cx0, cy0, cMaxX, y);
      }
    }

    log.debug(`Computed FOV (dungeon) at (${px},${py}), ${visible.size} tiles visible, ${candlePositions.length} candles`);

    callback(null, {
      layerType: 10,
      tilesJson: JSON.stringify([...visible]),
      trace
    });
  } catch (err) {
    log.error('Raycast computational error:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(LightService.service, { computeVisibility });
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
