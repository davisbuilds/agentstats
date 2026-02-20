function parseEnvInt(value: string | undefined, fallback: number, min: number = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

export const config = {
  port: parseEnvInt(process.env.AGENTSTATS_PORT, 3141, 1),
  host: process.env.AGENTSTATS_HOST || '127.0.0.1',
  dbPath: process.env.AGENTSTATS_DB_PATH || './data/agentstats.db',
  maxPayloadKB: parseEnvInt(process.env.AGENTSTATS_MAX_PAYLOAD_KB, 10, 0),
  sessionTimeoutMinutes: parseEnvInt(process.env.AGENTSTATS_SESSION_TIMEOUT, 5, 1),
  maxFeed: parseEnvInt(process.env.AGENTSTATS_MAX_FEED, 200, 1),
  statsIntervalMs: parseEnvInt(process.env.AGENTSTATS_STATS_INTERVAL, 5000, 250),
  maxSseClients: parseEnvInt(process.env.AGENTSTATS_MAX_SSE_CLIENTS, 50, 1),
  sseHeartbeatMs: parseEnvInt(process.env.AGENTSTATS_SSE_HEARTBEAT_MS, 30000, 1000),
  autoImportIntervalMinutes: parseEnvInt(process.env.AGENTSTATS_AUTO_IMPORT_MINUTES, 10, 0),
};
