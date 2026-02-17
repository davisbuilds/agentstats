export const config = {
  port: parseInt(process.env.AGENTSTATS_PORT || '3141', 10),
  host: process.env.AGENTSTATS_HOST || '127.0.0.1',
  dbPath: process.env.AGENTSTATS_DB_PATH || './data/agentstats.db',
  maxPayloadKB: parseInt(process.env.AGENTSTATS_MAX_PAYLOAD_KB || '10', 10),
  sessionTimeoutMinutes: parseInt(process.env.AGENTSTATS_SESSION_TIMEOUT || '30', 10),
  maxFeed: parseInt(process.env.AGENTSTATS_MAX_FEED || '200', 10),
  statsIntervalMs: parseInt(process.env.AGENTSTATS_STATS_INTERVAL || '5000', 10),
};
