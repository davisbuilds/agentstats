import { getDb } from './connection.js';
import { config } from '../config.js';
import { pricingRegistry } from '../pricing/index.js';
import type { EventStatus, EventType, EventSource } from '../contracts/event-contract.js';

// --- Agents ---

export function upsertAgent(id: string, agentType: string, name?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (id, agent_type, name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')
  `).run(id, agentType, name || null);
}

// --- Sessions ---

export function upsertSession(
  id: string,
  agentId: string,
  agentType: string,
  project?: string,
  branch?: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (id, agent_id, agent_type, project, branch)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_event_at = datetime('now'),
      status = CASE WHEN status = 'ended' THEN status ELSE 'active' END,
      project = COALESCE(excluded.project, sessions.project),
      branch = COALESCE(excluded.branch, sessions.branch)
  `).run(id, agentId, agentType, project || null, branch || null);
}

export interface SessionRow {
  id: string;
  agent_id: string;
  agent_type: string;
  project: string | null;
  branch: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  metadata: string;
  event_count: number;
  tokens_in: number;
  tokens_out: number;
  total_cost_usd: number;
  files_edited: number;
}

export function getSessions(filters: {
  status?: string;
  excludeStatus?: string;
  agentType?: string;
  limit?: number;
}): SessionRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.excludeStatus) {
    conditions.push('s.status != ?');
    params.push(filters.excludeStatus);
  }
  if (filters.agentType) {
    conditions.push('s.agent_type = ?');
    params.push(filters.agentType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;

  return db.prepare(`
    SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
      COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
      COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out,
      COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) as total_cost_usd,
      COALESCE((SELECT COUNT(DISTINCT json_extract(e.metadata, '$.file_path')) FROM events e WHERE e.session_id = s.id AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin') AND json_extract(e.metadata, '$.file_path') IS NOT NULL), 0) as files_edited
    FROM sessions s
    ${where}
    ORDER BY
      CASE s.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
      s.last_event_at DESC
    LIMIT ?
  `).all(...params, limit) as SessionRow[];
}

export function getSessionWithEvents(sessionId: string, eventLimit: number = 10): {
  session: SessionRow | undefined;
  events: EventRow[];
} {
  const db = getDb();
  const session = db.prepare(`
    SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
      COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
      COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out,
      COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) as total_cost_usd,
      COALESCE((SELECT COUNT(DISTINCT json_extract(e.metadata, '$.file_path')) FROM events e WHERE e.session_id = s.id AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin') AND json_extract(e.metadata, '$.file_path') IS NOT NULL), 0) as files_edited
    FROM sessions s WHERE s.id = ?
  `).get(sessionId) as SessionRow | undefined;

  const events = db.prepare(`
    SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, eventLimit) as EventRow[];

  return { session, events };
}

export function updateIdleSessions(timeoutMinutes: number): number {
  const db = getDb();
  // Mark active sessions as idle after timeout
  const idled = db.prepare(`
    UPDATE sessions SET status = 'idle'
    WHERE status = 'active'
    AND last_event_at < datetime('now', ? || ' minutes')
  `).run(`-${timeoutMinutes}`);

  // Auto-end idle sessions after 2x the timeout (no explicit session_end received)
  db.prepare(`
    UPDATE sessions SET status = 'ended', ended_at = datetime('now')
    WHERE status = 'idle'
    AND last_event_at < datetime('now', ? || ' minutes')
  `).run(`-${timeoutMinutes * 2}`);

  return idled.changes;
}

export function idleSession(sessionId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET status = 'idle'
    WHERE id = ? AND status != 'ended'
  `).run(sessionId);
}

export function endSession(sessionId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET status = 'ended', ended_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);
}

// --- Events ---

export interface EventRow {
  id: number;
  event_id: string | null;
  schema_version: number;
  session_id: string;
  agent_type: string;
  event_type: EventType;
  tool_name: string | null;
  status: EventStatus;
  tokens_in: number;
  tokens_out: number;
  branch: string | null;
  project: string | null;
  duration_ms: number | null;
  created_at: string;
  client_timestamp: string | null;
  metadata: string;
  payload_truncated: number;
  model: string | null;
  cost_usd: number | null;
  cache_read_tokens: number;
  cache_write_tokens: number;
  source: EventSource;
}

const METADATA_PRIORITY_KEYS = [
  'command',
  'file_path',
  'query',
  'pattern',
  'error',
  'message',
  'tool_name',
  'path',
  'type',
];

function utf8SliceByBytes(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  let currentBytes = 0;
  let out = '';
  for (const char of input) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > maxBytes) break;
    out += char;
    currentBytes += charBytes;
  }
  return out;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value ?? {}, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    return '{"_serialization_error":true}';
  }
}

function buildTruncatedObjectSummary(
  metadata: Record<string, unknown>,
  originalBytes: number
): string {
  const summary: Record<string, unknown> = {
    _truncated: true,
    _original_bytes: originalBytes,
  };

  for (const key of METADATA_PRIORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      summary[key] = metadata[key];
    }
  }

  return safeJsonStringify(summary);
}

function buildTruncatedGenericSummary(originalBytes: number): string {
  return safeJsonStringify({
    _truncated: true,
    _original_bytes: originalBytes,
  });
}

function truncateMetadata(metadata: unknown): { value: string; truncated: boolean } {
  const maxBytes = Math.max(0, config.maxPayloadKB * 1024);

  if (typeof metadata === 'string') {
    const byteLength = Buffer.byteLength(metadata, 'utf8');
    if (byteLength <= maxBytes) return { value: metadata, truncated: false };
    return { value: utf8SliceByBytes(metadata, maxBytes), truncated: true };
  }

  const serialized = safeJsonStringify(metadata ?? {});
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength <= maxBytes) {
    return { value: serialized, truncated: false };
  }

  let summary = buildTruncatedGenericSummary(byteLength);
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    summary = buildTruncatedObjectSummary(metadata as Record<string, unknown>, byteLength);
  }

  if (Buffer.byteLength(summary, 'utf8') <= maxBytes) {
    return { value: summary, truncated: true };
  }

  return {
    value: utf8SliceByBytes(summary, maxBytes),
    truncated: true,
  };
}

export function insertEvent(event: {
  event_id?: string;
  session_id: string;
  agent_type: string;
  event_type: EventType;
  tool_name?: string;
  status: EventStatus;
  tokens_in: number;
  tokens_out: number;
  branch?: string;
  project?: string;
  duration_ms?: number;
  metadata: unknown;
  client_timestamp?: string;
  model?: string;
  cost_usd?: number | null;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  source?: string;
}): EventRow | null {
  const db = getDb();

  const agentId = `${event.agent_type}-default`;
  upsertAgent(agentId, event.agent_type);
  upsertSession(event.session_id, agentId, event.agent_type, event.project, event.branch);

  // Handle session lifecycle events
  if (event.event_type === 'session_end') {
    // Claude Code sessions go to 'idle' first so they linger on the dashboard
    // for one timeout cycle before the periodic cleanup marks them 'ended'.
    if (event.agent_type === 'claude_code') {
      idleSession(event.session_id);
    } else {
      endSession(event.session_id);
    }
  }

  // Imported sessions are historical — mark as ended unless already managed
  if (event.source === 'import') {
    const db2 = getDb();
    db2.prepare(`
      UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
      WHERE id = ? AND status != 'ended'
    `).run(event.session_id);
  }

  // Auto-calculate cost if model + tokens present but cost not provided
  if (event.model && (event.tokens_in > 0 || event.tokens_out > 0)) {
    if (event.cost_usd === undefined || event.cost_usd === null) {
      event.cost_usd = pricingRegistry.calculate(event.model, {
        input: event.tokens_in,
        output: event.tokens_out,
        cacheRead: event.cache_read_tokens,
        cacheWrite: event.cache_write_tokens,
      });
    }
  }

  const metadata = truncateMetadata(event.metadata);

  try {
    const result = db.prepare(`
      INSERT INTO events (event_id, session_id, agent_type, event_type, tool_name, status,
        tokens_in, tokens_out, branch, project, duration_ms, created_at, client_timestamp,
        metadata, payload_truncated, model, cost_usd, cache_read_tokens, cache_write_tokens, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id || null,
      event.session_id,
      event.agent_type,
      event.event_type,
      event.tool_name || null,
      event.status,
      event.tokens_in,
      event.tokens_out,
      event.branch || null,
      event.project || null,
      event.duration_ms || null,
      event.client_timestamp || null,
      metadata.value,
      metadata.truncated ? 1 : 0,
      event.model || null,
      event.cost_usd ?? null,
      event.cache_read_tokens ?? 0,
      event.cache_write_tokens ?? 0,
      event.source || 'api'
    );

    if (result.changes === 0) return null; // duplicate event_id

    return db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid) as EventRow;
  } catch (err: unknown) {
    // UNIQUE constraint violation = duplicate event_id, silently skip
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: events.event_id')) {
      return null;
    }
    throw err;
  }
}

export function getEvents(filters: {
  limit?: number;
  offset?: number;
  agentType?: string;
  eventType?: string;
  toolName?: string;
  sessionId?: string;
  branch?: string;
  model?: string;
  source?: string;
  since?: string;
  until?: string;
}): { events: EventRow[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters.eventType) {
    conditions.push('event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.toolName) {
    conditions.push('tool_name = ?');
    params.push(filters.toolName);
  }
  if (filters.sessionId) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.branch) {
    conditions.push('branch = ?');
    params.push(filters.branch);
  }
  if (filters.model) {
    conditions.push('model = ?');
    params.push(filters.model);
  }
  if (filters.source) {
    conditions.push('source = ?');
    params.push(filters.source);
  }
  if (filters.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push('created_at <= ?');
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const total = (db.prepare(`SELECT COUNT(*) as count FROM events ${where}`).get(...params) as { count: number }).count;
  const events = db.prepare(`
    SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as EventRow[];

  return { events, total };
}

// --- Stats ---

export interface Stats {
  total_events: number;
  active_sessions: number;
  total_sessions: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  tool_breakdown: Record<string, number>;
  agent_breakdown: Record<string, number>;
  model_breakdown: Record<string, number>;
  branches: string[];
}

export function getStats(filters?: { agentType?: string; since?: string }): Stats {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_events,
      COALESCE(SUM(tokens_in), 0) as total_tokens_in,
      COALESCE(SUM(tokens_out), 0) as total_tokens_out,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd
    FROM events ${where}
  `).get(...params) as { total_events: number; total_tokens_in: number; total_tokens_out: number; total_cost_usd: number };

  const activeSessions = (db.prepare(
    `SELECT COUNT(*) as count FROM sessions WHERE status = 'active'`
  ).get() as { count: number }).count;

  const totalSessions = (db.prepare(
    `SELECT COUNT(*) as count FROM sessions`
  ).get() as { count: number }).count;

  const toolRows = db.prepare(`
    SELECT tool_name, COUNT(*) as count FROM events
    ${where.replace('WHERE', conditions.length ? 'WHERE' : '')}
    ${conditions.length > 0 ? 'AND' : 'WHERE'} tool_name IS NOT NULL
    GROUP BY tool_name ORDER BY count DESC
  `).all(...params) as { tool_name: string; count: number }[];

  const toolBreakdown: Record<string, number> = {};
  for (const row of toolRows) {
    toolBreakdown[row.tool_name] = row.count;
  }

  const agentRows = db.prepare(`
    SELECT agent_type, COUNT(*) as count FROM events ${where}
    GROUP BY agent_type ORDER BY count DESC
  `).all(...params) as { agent_type: string; count: number }[];

  const agentBreakdown: Record<string, number> = {};
  for (const row of agentRows) {
    agentBreakdown[row.agent_type] = row.count;
  }

  const modelRows = db.prepare(`
    SELECT model, COUNT(*) as count FROM events
    ${where.replace('WHERE', conditions.length ? 'WHERE' : '')}
    ${conditions.length > 0 ? 'AND' : 'WHERE'} model IS NOT NULL
    GROUP BY model ORDER BY count DESC
  `).all(...params) as { model: string; count: number }[];

  const modelBreakdown: Record<string, number> = {};
  for (const row of modelRows) {
    modelBreakdown[row.model] = row.count;
  }

  const branchRows = db.prepare(`
    SELECT DISTINCT branch FROM sessions WHERE branch IS NOT NULL ORDER BY last_event_at DESC
  `).all() as { branch: string }[];

  return {
    total_events: totals.total_events,
    active_sessions: activeSessions,
    total_sessions: totalSessions,
    total_tokens_in: totals.total_tokens_in,
    total_tokens_out: totals.total_tokens_out,
    total_cost_usd: totals.total_cost_usd,
    tool_breakdown: toolBreakdown,
    agent_breakdown: agentBreakdown,
    model_breakdown: modelBreakdown,
    branches: branchRows.map(r => r.branch),
  };
}

// --- Filter Options ---

export interface FilterOptions {
  agent_types: string[];
  event_types: string[];
  tool_names: string[];
  models: string[];
  projects: string[];
  branches: string[];
  sources: string[];
}

export function getFilterOptions(): FilterOptions {
  const db = getDb();

  const agentTypes = (db.prepare(
    'SELECT DISTINCT agent_type FROM events WHERE agent_type IS NOT NULL ORDER BY agent_type'
  ).all() as { agent_type: string }[]).map(r => r.agent_type);

  const eventTypes = (db.prepare(
    'SELECT DISTINCT event_type FROM events WHERE event_type IS NOT NULL ORDER BY event_type'
  ).all() as { event_type: string }[]).map(r => r.event_type);

  const toolNames = (db.prepare(
    'SELECT DISTINCT tool_name FROM events WHERE tool_name IS NOT NULL ORDER BY tool_name'
  ).all() as { tool_name: string }[]).map(r => r.tool_name);

  const models = (db.prepare(
    'SELECT DISTINCT model FROM events WHERE model IS NOT NULL ORDER BY model'
  ).all() as { model: string }[]).map(r => r.model);

  const projects = (db.prepare(
    'SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL ORDER BY project'
  ).all() as { project: string }[]).map(r => r.project);

  const branches = (db.prepare(
    'SELECT DISTINCT branch FROM sessions WHERE branch IS NOT NULL ORDER BY last_event_at DESC'
  ).all() as { branch: string }[]).map(r => r.branch);

  const sources = (db.prepare(
    'SELECT DISTINCT source FROM events WHERE source IS NOT NULL ORDER BY source'
  ).all() as { source: string }[]).map(r => r.source);

  return { agent_types: agentTypes, event_types: eventTypes, tool_names: toolNames, models, projects, branches, sources };
}

// --- Tool Analytics ---

export interface ToolAnalyticsRow {
  tool_name: string;
  total_calls: number;
  error_count: number;
  error_rate: number;
  avg_duration_ms: number | null;
  by_agent: Record<string, number>;
}

export function getToolAnalytics(filters?: { agentType?: string; since?: string }): ToolAnalyticsRow[] {
  const db = getDb();
  const conditions: string[] = ['tool_name IS NOT NULL'];
  const params: unknown[] = [];

  if (filters?.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) as total_calls,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      ROUND(CAST(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) as error_rate,
      ROUND(AVG(duration_ms)) as avg_duration_ms
    FROM events ${where}
    GROUP BY tool_name
    ORDER BY total_calls DESC
  `).all(...params) as Array<{
    tool_name: string;
    total_calls: number;
    error_count: number;
    error_rate: number;
    avg_duration_ms: number | null;
  }>;

  // Get per-agent breakdown for each tool
  const agentRows = db.prepare(`
    SELECT tool_name, agent_type, COUNT(*) as count
    FROM events ${where}
    GROUP BY tool_name, agent_type
    ORDER BY tool_name, count DESC
  `).all(...params) as Array<{ tool_name: string; agent_type: string; count: number }>;

  const agentMap = new Map<string, Record<string, number>>();
  for (const r of agentRows) {
    if (!agentMap.has(r.tool_name)) agentMap.set(r.tool_name, {});
    agentMap.get(r.tool_name)![r.agent_type] = r.count;
  }

  return rows.map(r => ({
    tool_name: r.tool_name,
    total_calls: r.total_calls,
    error_count: r.error_count,
    error_rate: r.error_rate,
    avg_duration_ms: r.avg_duration_ms,
    by_agent: agentMap.get(r.tool_name) || {},
  }));
}

// --- Cost over time (hourly buckets) ---

export interface CostBucket {
  bucket: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  event_count: number;
}

export function getCostOverTime(filters?: { since?: string; agentType?: string }): CostBucket[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters?.since) {
    conditions.push('COALESCE(client_timestamp, created_at) >= ?');
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', COALESCE(client_timestamp, created_at)) as bucket,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COALESCE(SUM(tokens_in), 0) as tokens_in,
      COALESCE(SUM(tokens_out), 0) as tokens_out,
      COUNT(*) as event_count
    FROM events ${where}
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(...params) as CostBucket[];
}

// --- Cost by session (top sessions) ---

export interface ProjectCostRow {
  project: string;
  cost_usd: number;
  session_count: number;
  event_count: number;
}

export function getCostByProject(limit: number = 10, filters?: { agentType?: string; since?: string }): ProjectCostRow[] {
  const db = getDb();
  const conditions: string[] = ['e.cost_usd > 0'];
  const params: unknown[] = [];

  if (filters?.agentType) {
    conditions.push('e.agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters?.since) {
    conditions.push('e.created_at >= ?');
    params.push(filters.since);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  return db.prepare(`
    SELECT
      COALESCE(s.project, 'unknown') as project,
      COALESCE(SUM(e.cost_usd), 0) as cost_usd,
      COUNT(DISTINCT e.session_id) as session_count,
      COUNT(*) as event_count
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    ${where}
    GROUP BY s.project
    ORDER BY cost_usd DESC
    LIMIT ?
  `).all(...params, limit) as ProjectCostRow[];
}

// --- Cost by model ---

export interface ModelCostRow {
  model: string;
  cost_usd: number;
  event_count: number;
  tokens_in: number;
  tokens_out: number;
}

export function getCostByModel(filters?: { agentType?: string; since?: string }): ModelCostRow[] {
  const db = getDb();
  const conditions: string[] = ['model IS NOT NULL', 'cost_usd > 0'];
  const params: unknown[] = [];

  if (filters?.agentType) {
    conditions.push('agent_type = ?');
    params.push(filters.agentType);
  }
  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  return db.prepare(`
    SELECT
      model,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COUNT(*) as event_count,
      COALESCE(SUM(tokens_in), 0) as tokens_in,
      COALESCE(SUM(tokens_out), 0) as tokens_out
    FROM events
    ${where}
    GROUP BY model
    ORDER BY cost_usd DESC
  `).all(...params) as ModelCostRow[];
}

// --- Session Transcript ---

export interface TranscriptEvent {
  id: number;
  event_type: string;
  tool_name: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
  client_timestamp: string | null;
  metadata: string;
}

export function getSessionTranscript(sessionId: string): TranscriptEvent[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, event_type, tool_name, status, tokens_in, tokens_out,
           model, cost_usd, duration_ms, created_at, client_timestamp, metadata
    FROM events
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sessionId) as TranscriptEvent[];
}
