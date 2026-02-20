import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { NormalizedIngestEvent, EventType } from '../contracts/event-contract.js';
import { pricingRegistry } from '../pricing/index.js';

// ─── Codex JSONL line types ─────────────────────────────────────────────

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
}

interface CodexToolResult {
  tool_name?: string;
  call_id?: string;
  arguments?: string;
  duration_ms?: number;
  success?: boolean;
  output?: string;
}

interface CodexLogLine {
  timestamp: string;
  type: string;
  payload: {
    // session_meta
    id?: string;
    cwd?: string;
    originator?: string;
    timestamp?: string;

    // event_msg
    type?: string;
    info?: {
      total_token_usage?: CodexTokenUsage;
      last_token_usage?: CodexTokenUsage;
      model_context_window?: number;
    };

    // response_item
    role?: string;
    content?: Array<{ type: string; text?: string }>;

    // generic fields from OTEL-style
    [key: string]: unknown;
  };
}

// ─── Discover JSONL files ──────────────────────────────────────────────

export function discoverCodexLogs(baseDir?: string): string[] {
  const codexHome = baseDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  const files: string[] = [];

  if (!fs.existsSync(sessionsDir)) return files;

  // Walk ~/.codex/sessions/YYYY/MM/DD/<session-id>.jsonl
  walkDir(sessionsDir, files);
  return files.sort();
}

function walkDir(dir: string, files: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
}

// ─── Read model from config.toml ────────────────────────────────────────

function readCodexModel(codexHome?: string): string | undefined {
  const base = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(base, 'config.toml');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Simple parse for top-level model = "..."
    const match = content.match(/^model\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ─── Parse a single JSONL file ──────────────────────────────────────────

export function parseCodexFile(
  filePath: string,
  options?: { from?: Date; to?: Date; codexDir?: string },
): NormalizedIngestEvent[] {
  const events: NormalizedIngestEvent[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const defaultModel = readCodexModel(options?.codexDir);

  // First pass: extract session metadata
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let sessionTimestamp: string | undefined;

  for (const rawLine of lines) {
    let line: CodexLogLine;
    try {
      line = JSON.parse(rawLine) as CodexLogLine;
    } catch {
      continue;
    }

    if (line.type === 'session_meta') {
      sessionId = line.payload.id;
      cwd = line.payload.cwd;
      sessionTimestamp = line.payload.timestamp ?? line.timestamp;
      break;
    }
  }

  // Fall back to filename for session ID
  if (!sessionId) {
    const basename = path.basename(filePath, '.jsonl');
    // Extract UUID from filename like "rollout-2026-02-18T20-10-57-019c7373-39f7..."
    const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = uuidMatch?.[1] ?? basename;
  }

  const project = cwd ? path.basename(cwd) : undefined;

  // Apply date filter on session start time
  if (sessionTimestamp && options?.from) {
    const ts = new Date(sessionTimestamp);
    if (ts < options.from) return events;
  }
  if (sessionTimestamp && options?.to) {
    const ts = new Date(sessionTimestamp);
    if (ts > options.to) return events;
  }

  // Second pass: extract events
  let prevTokensIn = 0;
  let prevTokensOut = 0;
  let prevCacheRead = 0;
  let eventIndex = 0;

  for (const rawLine of lines) {
    let line: CodexLogLine;
    try {
      line = JSON.parse(rawLine) as CodexLogLine;
    } catch {
      continue;
    }

    // Generate session_start from session_meta
    if (line.type === 'session_meta') {
      const eventId = crypto
        .createHash('sha256')
        .update(`codex:${sessionId}:meta`)
        .digest('hex')
        .slice(0, 32);

      events.push({
        event_id: `import-cdx-${eventId}`,
        session_id: sessionId,
        agent_type: 'codex',
        event_type: 'session_start',
        status: 'success',
        tokens_in: 0,
        tokens_out: 0,
        model: defaultModel,
        project,
        client_timestamp: line.timestamp,
        metadata: {
          cli_version: line.payload.originator,
          cwd,
        },
        source: 'import',
      });
      continue;
    }

    // Extract token deltas from token_count events
    if (line.type === 'event_msg' && line.payload?.type === 'token_count') {
      const usage = line.payload.info?.total_token_usage;
      if (!usage) continue;

      const totalIn = (usage.input_tokens ?? 0);
      const totalOut = (usage.output_tokens ?? 0);
      const totalCacheRead = (usage.cached_input_tokens ?? 0);

      // Compute deltas
      const deltaIn = totalIn - prevTokensIn;
      const deltaOut = totalOut - prevTokensOut;
      const deltaCacheRead = totalCacheRead - prevCacheRead;

      prevTokensIn = totalIn;
      prevTokensOut = totalOut;
      prevCacheRead = totalCacheRead;

      // Only emit if there's a meaningful delta
      if (deltaIn <= 0 && deltaOut <= 0) continue;

      const eventId = crypto
        .createHash('sha256')
        .update(`codex:${sessionId}:token:${eventIndex}`)
        .digest('hex')
        .slice(0, 32);

      // Calculate cost from deltas
      const costUsd = defaultModel
        ? pricingRegistry.calculate(defaultModel, {
            input: deltaIn,
            output: deltaOut,
            cacheRead: deltaCacheRead,
          })
        : undefined;

      events.push({
        event_id: `import-cdx-${eventId}`,
        session_id: sessionId,
        agent_type: 'codex',
        event_type: 'llm_response',
        status: 'success',
        tokens_in: deltaIn,
        tokens_out: deltaOut,
        cache_read_tokens: deltaCacheRead,
        model: defaultModel,
        cost_usd: costUsd ?? undefined,
        project,
        client_timestamp: line.timestamp,
        metadata: { _synthetic: true, _source: 'codex_session_jsonl' },
        source: 'import',
      });

      eventIndex++;
      continue;
    }

    // Skip other event types for now (response_item, etc.)
  }

  // Add session_end event
  if (events.length > 0) {
    const lastTimestamp = lines.length > 0
      ? (() => { try { return (JSON.parse(lines[lines.length - 1]) as CodexLogLine).timestamp; } catch { return undefined; } })()
      : undefined;

    const eventId = crypto
      .createHash('sha256')
      .update(`codex:${sessionId}:end`)
      .digest('hex')
      .slice(0, 32);

    events.push({
      event_id: `import-cdx-${eventId}`,
      session_id: sessionId,
      agent_type: 'codex',
      event_type: 'session_end',
      status: 'success',
      tokens_in: 0,
      tokens_out: 0,
      model: defaultModel,
      project,
      client_timestamp: lastTimestamp,
      metadata: {
        total_tokens_in: prevTokensIn,
        total_tokens_out: prevTokensOut,
        total_cache_read: prevCacheRead,
      },
      source: 'import',
    });
  }

  return events;
}

// ─── File hash for import state tracking ────────────────────────────────

export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}
