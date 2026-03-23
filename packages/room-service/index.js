const grpc = require('@grpc/grpc-js');
const { RoomService, DiceService, grpc: protoGrpc } = require('@wow/proto');

const PORT = process.env.ROOM_PORT || 50056;

// Configure dice service client
const DICE_HOST = process.env.DICE_HOST || 'localhost:50051';
const diceClient = new DiceService(
  DICE_HOST,
  grpc.credentials.createInsecure()
);

const ROOM_DESCRIPTIONS = [
  'A damp, moldy stone chamber.',
  'A forgotten armory with rusted racks.',
  'A completely bare, perfectly square room.',
  'A room smelling faintly of ozone and old blood.',
  'A ruined shrine dedicated to an unknown deity.',
  'An opulent bedroom, now thick with dust.',
  'A collapsed library with burned pages.',
  'A strange room with a geometric mosaic floor.'
];

const CORRIDOR_DESCRIPTIONS = [
  'A narrow, rough-hewn tunnel.',
  'A perfectly smooth hallway of black stone.',
  'A dusty corridor lined with empty alcoves.',
  'A passageway with water dripping from the ceiling.',
  'A hallway littered with old bones.'
];

function canFit(tilesDict, x, y, w, h, anchorX, anchorY) {
  if (!tilesDict || Object.keys(tilesDict).length === 0) return true; // Initial generation

  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (c === anchorX && r === anchorY) continue; // The gateway boundary is allowed to intersect!
      
      const t = tilesDict[`${c},${r}`] || ' ';
      
      // We can only carve through dense void (' ') or existing peripheral walls ('#').
      // Overlapping floors ('.') or unique gates ('+') is a structural collision.
      if (t === '.' || t === '+') {
        return false;
      }
    }
  }
  return true;
}

function rollDiceAsync(diceArray, trace) {
  return new Promise((resolve, reject) => {
    diceClient.rollDice({ dice: diceArray, trace }, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}

async function generateRoom(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'room-service',
    data: JSON.stringify({
      level: call.request.level,
      anchorX: call.request.anchorX,
      anchorY: call.request.anchorY
    }),
    subSpans: []
  };

  try {
    const { tilesJson, anchorX, anchorY } = call.request;

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJson || "{}"); } catch { tilesDict = {}; }

    let fitSuccess = false;
    let finalWidth = 0, finalHeight = 0, finalX = 0, finalY = 0, doors = [];
    
    // Deduce which direction the door is facing by checking adjacent floors
    let forcedWall = -1;
    if (Object.keys(tilesDict).length > 0 && anchorX !== undefined && anchorY !== undefined) {
      // Floor is opposite the direction of growth — new room grows AWAY from existing floor
      if (tilesDict[`${anchorX - 1},${anchorY}`] === '.') forcedWall = 3; // Floor to West  → grow East
      else if (tilesDict[`${anchorX + 1},${anchorY}`] === '.') forcedWall = 2; // Floor to East  → grow West
      else if (tilesDict[`${anchorX},${anchorY - 1}`] === '.') forcedWall = 1; // Floor to North → grow South
      else if (tilesDict[`${anchorX},${anchorY + 1}`] === '.') forcedWall = 0; // Floor to South → grow North
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const wRoll = await rollDiceAsync(['2d4'], trace);
      const width = wRoll.grandTotal + 1; // 3 to 9

      const hRoll = await rollDiceAsync(['2d4'], trace);
      const height = hRoll.grandTotal + 1; // 3 to 9

      let wall = forcedWall;
      if (wall === -1) {
         const wallRoll = await rollDiceAsync(['1d4'], trace);
         wall = wallRoll.grandTotal - 1; // 0=N, 1=S, 2=W, 3=E
      }
      
      let rx, ry;
      if (wall === 0) {
        // Grow North: anchor is on South wall of new room
        ry = anchorY - height + 1;
        rx = anchorX - Math.floor(Math.random() * (width - 2)) - 1;
      } else if (wall === 1) {
        // Grow South: anchor is on North wall of new room
        ry = anchorY;
        rx = anchorX - Math.floor(Math.random() * (width - 2)) - 1;
      } else if (wall === 2) {
        // Grow West: anchor is on East wall of new room
        rx = anchorX - width + 1;
        ry = anchorY - Math.floor(Math.random() * (height - 2)) - 1;
      } else {
        // Grow East: anchor is on West wall of new room
        rx = anchorX;
        ry = anchorY - Math.floor(Math.random() * (height - 2)) - 1;
      }

      if (canFit(tilesDict, rx, ry, width, height, anchorX, anchorY)) {
        fitSuccess = true;
        finalWidth = width;
        finalHeight = height;
        finalX = rx;
        finalY = ry;
        break;
      }
    }

    const descRoll = await rollDiceAsync(['1d8'], trace);
    const descIndex = (descRoll.grandTotal - 1) % ROOM_DESCRIPTIONS.length;
    const description = fitSuccess ? ROOM_DESCRIPTIONS[descIndex] : 'The doorway collapses into solid rock...';

    if (fitSuccess) {
      // The origin door MUST exist locally
      doors.push({ x: anchorX - finalX, y: anchorY - finalY });
      
      // Roll for 1-2 additional unique structural doors
      const numDoors = (await rollDiceAsync(['1d2'], trace)).grandTotal;
      for (let i = 0; i < numDoors; i++) {
         const sRoll = await rollDiceAsync(['1d4'], trace);
         const side = sRoll.grandTotal - 1;
         let dx = 0, dy = 0;
         if (side === 0 && finalWidth > 2) { dx = Math.floor(Math.random() * (finalWidth-2)) + 1; dy = 0; }
         else if (side === 1 && finalWidth > 2) { dx = Math.floor(Math.random() * (finalWidth-2)) + 1; dy = finalHeight - 1; }
         else if (side === 2 && finalHeight > 2) { dx = 0; dy = Math.floor(Math.random() * (finalHeight-2)) + 1; }
         else if (side === 3 && finalHeight > 2) { dx = finalWidth - 1; dy = Math.floor(Math.random() * (finalHeight-2)) + 1; }
         else continue;
         
         const isDup = doors.some(d => d.x === dx && d.y === dy);
         if (!isDup) doors.push({ x: dx, y: dy });
      }
      console.log(`[RoomService] Room fit success: ${finalWidth}x${finalHeight} at ${finalX},${finalY}`);
    } else {
      console.log(`[RoomService] Room structural layout failed after 5 attempts.`);
    }

    let newTilesJsonStr = tilesJson;
    if (fitSuccess && Object.keys(tilesDict).length > 0) {
       for (let r = finalY; r < finalY + finalHeight; r++) {
         for (let c = finalX; c < finalX + finalWidth; c++) {
           if (r === finalY || r === finalY + finalHeight - 1 || c === finalX || c === finalX + finalWidth - 1) {
             tilesDict[`${c},${r}`] = tilesDict[`${c},${r}`] === '+' ? '+' : '#';
           } else {
             tilesDict[`${c},${r}`] = '.';
           }
         }
       }
       for (const d of doors) {
         tilesDict[`${finalX + d.x},${finalY + d.y}`] = '+';
       }
       newTilesJsonStr = JSON.stringify(tilesDict);
    }

    callback(null, { 
      width: finalWidth, height: finalHeight, description, doors, trace,
      fitSuccess,
      originX: finalX,
      originY: finalY,
      newTilesJson: newTilesJsonStr
    });
  } catch (err) {
    console.error('[RoomService] Error generating room:', err.message);
    callback(err);
  }
}

async function generateCorridor(call, callback) {
  const trace = {
    traceId: call.request.trace?.traceId,
    spanId: call.request.trace?.spanId,
    timeStart: Date.now(),
    serviceName: 'room-service',
    data: JSON.stringify({
      level: call.request.level,
      anchorX: call.request.anchorX,
      anchorY: call.request.anchorY
    }),
    subSpans: []
  };

  try {
    const { tilesJson, anchorX, anchorY } = call.request;

    let tilesDict;
    try { tilesDict = JSON.parse(tilesJson || "{}"); } catch { tilesDict = {}; }

    let fitSuccess = false;
    let finalLength = 0, finalDirection = 'N', finalX = 0, finalY = 0;

    let forcedDir = null;
    if (Object.keys(tilesDict).length > 0 && anchorX !== undefined && anchorY !== undefined) {
      // Corridor grows AWAY from existing floor
      if (tilesDict[`${anchorX - 1},${anchorY}`] === '.') forcedDir = 'E'; // Floor to West  → go East
      else if (tilesDict[`${anchorX + 1},${anchorY}`] === '.') forcedDir = 'W'; // Floor to East  → go West
      else if (tilesDict[`${anchorX},${anchorY - 1}`] === '.') forcedDir = 'S'; // Floor to North → go South
      else if (tilesDict[`${anchorX},${anchorY + 1}`] === '.') forcedDir = 'N'; // Floor to South → go North
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const lenRoll = await rollDiceAsync(['1d6'], trace);
      const length = lenRoll.grandTotal + 2; // 3 to 8

      let dir = forcedDir;
      if (!dir) {
        const dirRoll = await rollDiceAsync(['1d4'], trace);
        const directions = ['N', 'S', 'E', 'W'];
        dir = directions[(dirRoll.grandTotal - 1) % 4];
      }

      // rx,ry = top-left of corridor bounding box, anchor is always inside it
      let rx = anchorX, ry = anchorY, w = 1, h = 1;
      if (dir === 'N') { ry = anchorY - length + 1; w = 1; h = length; }  // grow upward
      else if (dir === 'S') { ry = anchorY; w = 1; h = length; }            // grow downward
      else if (dir === 'W') { rx = anchorX - length + 1; w = length; h = 1; } // grow leftward
      else if (dir === 'E') { rx = anchorX; w = length; h = 1; }             // grow rightward

      if (canFit(tilesDict, rx, ry, w, h, anchorX, anchorY)) {
        fitSuccess = true;
        finalLength = length;
        finalDirection = dir;
        finalX = rx;
        finalY = ry;
        break;
      }
    }

    const descRoll = await rollDiceAsync(['1d5'], trace);
    const descIndex = (descRoll.grandTotal - 1) % CORRIDOR_DESCRIPTIONS.length;
    const description = fitSuccess ? CORRIDOR_DESCRIPTIONS[descIndex] : 'The passage collapses into solid rock...';

    if (fitSuccess) {
      console.log(`[RoomService] Corridor fit success: ${finalLength} tiles ${finalDirection} at ${finalX},${finalY}`);
    } else {
      console.log(`[RoomService] Corridor layout failed after 5 attempts.`);
    }

    let newTilesJsonStr = tilesJson;
    if (fitSuccess && Object.keys(tilesDict).length > 0) {
       for (let r = finalY; r < finalY + (finalDirection === 'N' || finalDirection === 'S' ? finalLength : 1); r++) {
         for (let c = finalX; c < finalX + (finalDirection === 'E' || finalDirection === 'W' ? finalLength : 1); c++) {
           tilesDict[`${c},${r}`] = '.';
         }
       }
       newTilesJsonStr = JSON.stringify(tilesDict);
    }

    callback(null, {
      length: finalLength,
      direction: finalDirection,
      description,
      trace,
      fitSuccess,
      originX: finalX,
      originY: finalY,
      newTilesJson: newTilesJsonStr
    });
  } catch (err) {
    console.error('[RoomService] Error generating corridor:', err.message);
    callback(err);
  }
}

function main() {
  const server = new grpc.Server();
  server.addService(RoomService.service, { generateRoom, generateCorridor });
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('[RoomService] Failed to start:', err);
        process.exit(1);
      }
      console.log(`[RoomService] Running on port ${port}`);
    }
  );
}

main();
