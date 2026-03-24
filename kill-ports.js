const { execSync } = require('child_process');

const ports = [
  3001, // API Gateway
  50051, // DiceService
  50052, // DndService
  50053, // HeroService
  50054, // InventoryService
  50055, // ActionService
  50056, // RoomService
  50057, // ShadeService
  50058, // RenderService
  50059, // EnemyService
  50060, // WorldService
  50061, // InputService
  50062, // GameService
  8080, // React Frontend
];

console.log('Killing processes on ports: ' + ports.join(', '));

for (const port of ports) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const lines = output.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 4 && parts[1].includes(`:${port}`)) {
          const pid = parts[4];
          if (pid !== '0' && pid !== 'System') {
            try {
              execSync(`taskkill /F /PID ${pid} 2>nul`);
              console.log(`Killed PID ${pid} listening on port ${port}`);
            } catch (e) {
              // ignore
            }
          }
        }
      }
    } else {
      execSync(`npx kill-port ${port}`);
      console.log(`Killed port ${port}`);
    }
  } catch (err) {
    // Port not in use, ignore
  }
}
console.log('Done.');
