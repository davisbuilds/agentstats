import { config } from './config.js';
import { initSchema } from './db/schema.js';
import { updateIdleSessions } from './db/queries.js';
import { startStatsBroadcast } from './api/stream.js';
import { broadcaster } from './sse/emitter.js';
import { createApp } from './app.js';
import { runImport } from './import/index.js';

// Initialize database
initSchema();

const app = createApp();

// Start server
const server = app.listen(config.port, config.host, () => {
  console.log(`AgentStats listening on http://${config.host}:${config.port}`);
  console.log(`Dashboard: http://localhost:${config.port}`);
});

// Start periodic stats broadcast to SSE clients
startStatsBroadcast();

// Session timeout checker - mark idle sessions every 60s
const sessionChecker = setInterval(() => {
  const idled = updateIdleSessions(config.sessionTimeoutMinutes);
  if (idled > 0 && broadcaster.clientCount > 0) {
    broadcaster.broadcast('session_update', { type: 'idle_check', idled });
  }
}, 60_000);

// Auto-import Codex session data periodically
let autoImportTimer: ReturnType<typeof setInterval> | undefined;

function autoImportAll() {
  try {
    const result = runImport({ source: 'all' });
    if (result.totalEventsImported > 0) {
      console.log(`Auto-import: imported ${result.totalEventsImported} events from ${result.totalFiles - result.skippedFiles} file(s)`);
      if (broadcaster.clientCount > 0) {
        broadcaster.broadcast('session_update', { type: 'auto_import', imported: result.totalEventsImported });
      }
    }
  } catch (err) {
    console.error('Auto-import error:', err);
  }
}

if (config.autoImportIntervalMinutes > 0) {
  const intervalMs = config.autoImportIntervalMinutes * 60_000;
  // Run once shortly after startup to catch anything missed while server was down
  setTimeout(autoImportAll, 5_000);
  autoImportTimer = setInterval(autoImportAll, intervalMs);
  console.log(`Auto-import: every ${config.autoImportIntervalMinutes}m`);
}

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down AgentStats...');
  clearInterval(sessionChecker);
  if (autoImportTimer) clearInterval(autoImportTimer);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
