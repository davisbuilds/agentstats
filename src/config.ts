function parseEnvInt(value: string | undefined, fallback: number, min: number = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

function parseEnvFloat(value: string | undefined, fallback: number, min: number = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
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
  // Usage monitor: per-agent-type limits (tokens or cost depending on agent)
  // Claude Code: token limits (AGENTSTATS_SESSION_TOKEN_LIMIT_CLAUDE_CODE)
  // Codex: cost limits in USD (AGENTSTATS_SESSION_COST_LIMIT_CODEX)
  usageMonitor: parseUsageMonitorConfig(),
};

export type UsageLimitType = 'tokens' | 'cost';

interface AgentUsageConfig {
  limitType: UsageLimitType;
  sessionWindowHours: number;
  sessionLimit: number;
  extendedWindowHours: number;
  extendedLimit: number;
}

function parseUsageMonitorConfig(): Record<string, AgentUsageConfig> {
  const defaultWindowHours = parseEnvInt(process.env.AGENTSTATS_SESSION_WINDOW_HOURS, 5, 1);

  // Known agent types — each uses its own limit type
  const agents: Record<string, AgentUsageConfig> = {
    claude_code: {
      limitType: 'tokens',
      sessionWindowHours: parseEnvInt(process.env.AGENTSTATS_SESSION_WINDOW_HOURS_CLAUDE_CODE, defaultWindowHours, 1),
      sessionLimit: parseEnvInt(process.env.AGENTSTATS_SESSION_TOKEN_LIMIT_CLAUDE_CODE, 44000, 0),
      extendedWindowHours: parseEnvInt(process.env.AGENTSTATS_EXTENDED_WINDOW_HOURS_CLAUDE_CODE, 24, 1),
      extendedLimit: parseEnvInt(process.env.AGENTSTATS_EXTENDED_TOKEN_LIMIT_CLAUDE_CODE, 0, 0),
    },
    codex: {
      limitType: 'cost',
      sessionWindowHours: parseEnvInt(process.env.AGENTSTATS_SESSION_WINDOW_HOURS_CODEX, defaultWindowHours, 1),
      sessionLimit: parseEnvFloat(process.env.AGENTSTATS_SESSION_COST_LIMIT_CODEX, 100, 0),
      extendedWindowHours: parseEnvInt(process.env.AGENTSTATS_EXTENDED_WINDOW_HOURS_CODEX, 168, 1),
      extendedLimit: parseEnvFloat(process.env.AGENTSTATS_EXTENDED_COST_LIMIT_CODEX, 500, 0),
    },
    _default: {
      limitType: 'tokens',
      sessionWindowHours: defaultWindowHours,
      sessionLimit: 0,
      extendedWindowHours: 24,
      extendedLimit: 0,
    },
  };

  return agents;
}
