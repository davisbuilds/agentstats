import { getDb } from './connection.js';

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      name TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      project TEXT,
      branch TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      session_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      branch TEXT,
      project TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      client_timestamp TEXT,
      metadata TEXT DEFAULT '{}',
      payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
      model TEXT,
      cost_usd REAL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      source TEXT DEFAULT 'api'
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_type);
    CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);

  // Import state tracking - avoids re-importing unchanged files
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_state (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      source TEXT NOT NULL,
      events_imported INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Backward-compatible schema updates for existing local databases.
  const eventColumns = new Set<string>(
    (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map(col => col.name)
  );

  if (!eventColumns.has('client_timestamp')) {
    db.exec('ALTER TABLE events ADD COLUMN client_timestamp TEXT');
  }
  if (!eventColumns.has('payload_truncated')) {
    db.exec('ALTER TABLE events ADD COLUMN payload_truncated INTEGER NOT NULL DEFAULT 0');
  }
  if (!eventColumns.has('model')) {
    db.exec('ALTER TABLE events ADD COLUMN model TEXT');
  }
  if (!eventColumns.has('cost_usd')) {
    db.exec('ALTER TABLE events ADD COLUMN cost_usd REAL');
  }
  if (!eventColumns.has('cache_read_tokens')) {
    db.exec('ALTER TABLE events ADD COLUMN cache_read_tokens INTEGER DEFAULT 0');
  }
  if (!eventColumns.has('cache_write_tokens')) {
    db.exec('ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER DEFAULT 0');
  }
  if (!eventColumns.has('source')) {
    db.exec("ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'api'");
  }

  db.exec('UPDATE events SET payload_truncated = 0 WHERE payload_truncated IS NULL');

  // Remove restrictive CHECK constraint on event_type if present on existing databases.
  // SQLite does not support ALTER CONSTRAINT, so we recreate the table.
  const tableSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
  ).get() as { sql: string } | undefined)?.sql ?? '';

  if (tableSql.includes('CHECK (event_type IN')) {
    db.exec(`
      CREATE TABLE events_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        session_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        branch TEXT,
        project TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        client_timestamp TEXT,
        metadata TEXT DEFAULT '{}',
        payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
        model TEXT,
        cost_usd REAL,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        source TEXT DEFAULT 'api'
      );

      INSERT INTO events_migrated (
        id, event_id, schema_version, session_id, agent_type, event_type, tool_name,
        status, tokens_in, tokens_out, branch, project, duration_ms,
        created_at, client_timestamp, metadata, payload_truncated,
        model, cost_usd, cache_read_tokens, cache_write_tokens, source
      )
      SELECT
        id, event_id, schema_version, session_id, agent_type, event_type, tool_name,
        status, tokens_in, tokens_out, branch, project, duration_ms,
        created_at, client_timestamp, metadata, payload_truncated,
        model, cost_usd,
        COALESCE(cache_read_tokens, 0), COALESCE(cache_write_tokens, 0),
        COALESCE(source, 'api')
      FROM events;

      DROP TABLE events;
      ALTER TABLE events_migrated RENAME TO events;

      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
      CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_type);
      CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
    `);
  }
}
