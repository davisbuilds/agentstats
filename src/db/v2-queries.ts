import { getDb } from './connection.js';
import type {
  BrowsingSessionRow,
  MessageRow,
  CountResult,
  SessionsListParams,
  MessagesListParams,
  SearchParams,
  AnalyticsParams,
  AnalyticsSummary,
  ActivityDataPoint,
  ProjectBreakdown,
  ToolUsageStat,
} from '../api/v2/types.js';

// --- Sessions ---

interface SessionsResult {
  data: BrowsingSessionRow[];
  total: number;
  cursor?: string;
}

export function listBrowsingSessions(params: SessionsListParams = {}): SessionsResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    // Include the full day
    conditions.push('started_at < ?');
    const nextDay = new Date(params.date_to);
    nextDay.setDate(nextDay.getDate() + 1);
    values.push(nextDay.toISOString().split('T')[0]);
  }
  if (params.min_messages != null) {
    conditions.push('message_count >= ?');
    values.push(params.min_messages);
  }
  if (params.max_messages != null) {
    conditions.push('message_count <= ?');
    values.push(params.max_messages);
  }
  const filterWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const filterValues = [...values];

  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM browsing_sessions ${filterWhere}`
  ).get(...filterValues) as CountResult).c;

  if (params.cursor) {
    conditions.push('started_at < ?');
    values.push(params.cursor);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  values.push(limit);
  const data = db.prepare(
    `SELECT * FROM browsing_sessions ${where} ORDER BY started_at DESC LIMIT ?`
  ).all(...values) as BrowsingSessionRow[];

  // Build cursor from last item
  let cursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    cursor = data[data.length - 1].started_at ?? undefined;
  }

  return { data, total, cursor };
}

export function getBrowsingSession(id: string): BrowsingSessionRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get(id) as BrowsingSessionRow | undefined;
}

export function getSessionChildren(parentId: string): BrowsingSessionRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM browsing_sessions WHERE parent_session_id = ? ORDER BY started_at'
  ).all(parentId) as BrowsingSessionRow[];
}

// --- Messages ---

interface MessagesResult {
  data: MessageRow[];
  total: number;
}

export function getSessionMessages(sessionId: string, params: MessagesListParams = {}): MessagesResult {
  const db = getDb();
  const offset = params.offset ?? 0;
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);

  const total = (db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE session_id = ?'
  ).get(sessionId) as CountResult).c;

  const data = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal LIMIT ? OFFSET ?'
  ).all(sessionId, limit, offset) as MessageRow[];

  return { data, total };
}

// --- Search ---

interface FtsSearchResult {
  data: Array<{
    session_id: string;
    message_id: number;
    message_ordinal: number;
    message_role: string;
    snippet: string;
  }>;
  total: number;
  cursor?: string;
}

export function searchMessages(params: SearchParams): FtsSearchResult {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('bs.project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('bs.agent = ?');
    values.push(params.agent);
  }

  const joinFilter = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  // Count total matches
  const countSql = `
    SELECT COUNT(*) as c
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN browsing_sessions bs ON bs.id = m.session_id
    WHERE messages_fts MATCH ? ${joinFilter}
  `;
  const total = (db.prepare(countSql).get(params.q, ...values) as CountResult).c;

  // Fetch results with snippets
  const offsetCondition = params.cursor ? `AND m.id < ?` : '';
  const offsetValues = params.cursor ? [parseInt(params.cursor, 10)] : [];

  const searchSql = `
    SELECT
      m.session_id,
      m.id as message_id,
      m.ordinal as message_ordinal,
      m.role as message_role,
      snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) as snippet
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN browsing_sessions bs ON bs.id = m.session_id
    WHERE messages_fts MATCH ? ${joinFilter} ${offsetCondition}
    ORDER BY m.id DESC
    LIMIT ?
  `;

  const data = db.prepare(searchSql).all(
    params.q, ...values, ...offsetValues, limit
  ) as FtsSearchResult['data'];

  let cursor: string | undefined;
  if (data.length === limit && data.length > 0) {
    cursor = String(data[data.length - 1].message_id);
  }

  return { data, total, cursor };
}

// --- Analytics ---

export function getAnalyticsSummary(params: AnalyticsParams = {}): AnalyticsSummary {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(message_count), 0) as total_messages,
      COALESCE(SUM(user_message_count), 0) as total_user_messages,
      MIN(started_at) as earliest,
      MAX(started_at) as latest
    FROM browsing_sessions ${where}
  `).get(...values) as {
    total_sessions: number;
    total_messages: number;
    total_user_messages: number;
    earliest: string | null;
    latest: string | null;
  };

  // Calculate daily averages
  let dailyAvgSessions = 0;
  let dailyAvgMessages = 0;
  if (row.earliest && row.latest) {
    const days = Math.max(1, Math.ceil(
      (new Date(row.latest).getTime() - new Date(row.earliest).getTime()) / 86_400_000
    ) + 1);
    dailyAvgSessions = Math.round((row.total_sessions / days) * 100) / 100;
    dailyAvgMessages = Math.round((row.total_messages / days) * 100) / 100;
  }

  return {
    total_sessions: row.total_sessions,
    total_messages: row.total_messages,
    total_user_messages: row.total_user_messages,
    daily_average_sessions: dailyAvgSessions,
    daily_average_messages: dailyAvgMessages,
    date_range: {
      earliest: row.earliest,
      latest: row.latest,
    },
  };
}

export function getAnalyticsActivity(params: AnalyticsParams = {}): ActivityDataPoint[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('project = ?');
    values.push(params.project);
  }
  if (params.agent) {
    conditions.push('agent = ?');
    values.push(params.agent);
  }
  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      date(started_at) as date,
      COUNT(*) as sessions,
      COALESCE(SUM(message_count), 0) as messages
    FROM browsing_sessions
    ${where}
    GROUP BY date(started_at)
    ORDER BY date
  `).all(...values) as ActivityDataPoint[];
}

export function getAnalyticsProjects(params: AnalyticsParams = {}): ProjectBreakdown[] {
  const db = getDb();
  const conditions: string[] = ['project IS NOT NULL'];
  const values: unknown[] = [];

  if (params.date_from) {
    conditions.push('started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  return db.prepare(`
    SELECT
      project,
      COUNT(*) as session_count,
      COALESCE(SUM(message_count), 0) as message_count
    FROM browsing_sessions
    ${where}
    GROUP BY project
    ORDER BY message_count DESC
  `).all(...values) as ProjectBreakdown[];
}

export function getAnalyticsTools(params: AnalyticsParams = {}): ToolUsageStat[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.project) {
    conditions.push('bs.project = ?');
    values.push(params.project);
  }
  if (params.date_from) {
    conditions.push('bs.started_at >= ?');
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("bs.started_at < date(?, '+1 day')");
    values.push(params.date_to);
  }

  const joinFilter = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      tc.tool_name,
      tc.category,
      COUNT(*) as count
    FROM tool_calls tc
    JOIN browsing_sessions bs ON bs.id = tc.session_id
    ${joinFilter}
    GROUP BY tc.tool_name, tc.category
    ORDER BY count DESC
  `).all(...values) as ToolUsageStat[];
}

// --- Metadata ---

export function getDistinctProjects(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT project FROM browsing_sessions WHERE project IS NOT NULL ORDER BY project'
  ).all() as Array<{ project: string }>;
  return rows.map(r => r.project);
}

export function getDistinctAgents(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT agent FROM browsing_sessions ORDER BY agent'
  ).all() as Array<{ agent: string }>;
  return rows.map(r => r.agent);
}
