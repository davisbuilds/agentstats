import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl = '';
let tempDir = '';
let getDb: (() => { exec: (sql: string) => void }) | null = null;
let closeDb: (() => void) | null = null;

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getEvents(): Promise<{ events: Array<Record<string, unknown>>; total: number }> {
  const response = await fetch(`${baseUrl}/api/events?limit=20`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ events: Array<Record<string, unknown>>; total: number }>;
}

async function getHealth(): Promise<{ sse_clients: number }> {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ sse_clients: number }>;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentstats-test-'));
  process.env.AGENTSTATS_DB_PATH = path.join(tempDir, 'agentstats-test.db');
  process.env.AGENTSTATS_MAX_PAYLOAD_KB = '1';
  process.env.AGENTSTATS_MAX_SSE_CLIENTS = '1';
  process.env.AGENTSTATS_SSE_HEARTBEAT_MS = '1000';

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');

  getDb = dbModule.getDb as () => { exec: (sql: string) => void };
  closeDb = dbModule.closeDb as () => void;

  initSchema();
  server = createApp({ serveStatic: false }).listen(0);
  await once(server, 'listening');

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  if (!getDb) throw new Error('Database not initialized');
  getDb().exec(`
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM agents;
  `);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
  closeDb?.();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /api/events rejects invalid enum values', async () => {
  const response = await postJson(`${baseUrl}/api/events`, {
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'unknown_type',
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; details: Array<{ field: string }> };
  assert.equal(body.error, 'Invalid event payload');
  assert.ok(body.details.some(detail => detail.field === 'event_type'));
});

test('POST /api/events deduplicates by event_id', async () => {
  const payload = {
    event_id: 'evt-duplicate-1',
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Bash',
  };

  const first = await postJson(`${baseUrl}/api/events`, payload);
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { received: number; duplicates: number };
  assert.equal(firstBody.received, 1);
  assert.equal(firstBody.duplicates, 0);

  const second = await postJson(`${baseUrl}/api/events`, payload);
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { received: number; duplicates: number };
  assert.equal(secondBody.received, 0);
  assert.equal(secondBody.duplicates, 1);

  const events = await getEvents();
  assert.equal(events.total, 1);
});

test('POST /api/events/batch reports received, duplicates, and rejected items', async () => {
  const response = await postJson(`${baseUrl}/api/events/batch`, {
    events: [
      {
        event_id: 'batch-1',
        session_id: 'session-1',
        agent_type: 'codex',
        event_type: 'response',
      },
      {
        event_id: 'batch-1',
        session_id: 'session-1',
        agent_type: 'codex',
        event_type: 'response',
      },
      {
        session_id: 'session-2',
        agent_type: 'codex',
        event_type: 'response',
        status: 'bad',
      },
      {
        session_id: '',
        agent_type: 'codex',
        event_type: 'response',
      },
    ],
  });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    received: number;
    duplicates: number;
    rejected: Array<{ index: number }>;
  };

  assert.equal(body.received, 1);
  assert.equal(body.duplicates, 1);
  assert.deepEqual(body.rejected.map(item => item.index), [2, 3]);
});

test('POST /api/events stores client_timestamp while keeping server created_at', async () => {
  const clientTimestamp = '2020-01-02T03:04:05.000Z';
  const response = await postJson(`${baseUrl}/api/events`, {
    session_id: 'session-ts',
    agent_type: 'claude_code',
    event_type: 'response',
    client_timestamp: clientTimestamp,
  });
  assert.equal(response.status, 201);

  const events = await getEvents();
  assert.equal(events.total, 1);

  const event = events.events[0] as Record<string, unknown>;
  assert.equal(event.client_timestamp, clientTimestamp);
  assert.equal(event.payload_truncated, 0);
  assert.ok(typeof event.created_at === 'string');

  const createdAt = String(event.created_at);
  const createdAtDate = new Date(createdAt.endsWith('Z') ? createdAt : `${createdAt}Z`);
  assert.ok(!Number.isNaN(createdAtDate.getTime()));
  assert.notEqual(event.created_at, event.client_timestamp);
});

test('POST /api/events stores byte-capped metadata and payload_truncated marker', async () => {
  const response = await postJson(`${baseUrl}/api/events`, {
    session_id: 'session-big',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Bash',
    metadata: {
      command: 'pnpm test',
      blob: '😀'.repeat(1200),
    },
  });
  assert.equal(response.status, 201);

  const events = await getEvents();
  const event = events.events[0] as Record<string, unknown>;

  assert.equal(event.payload_truncated, 1);
  assert.ok(Buffer.byteLength(String(event.metadata), 'utf8') <= 1024);

  const metadata = JSON.parse(String(event.metadata)) as {
    _truncated: boolean;
    command?: string;
  };
  assert.equal(metadata._truncated, true);
  assert.equal(metadata.command, 'pnpm test');
});

test('session_end remains terminal when later events arrive for the same session', async () => {
  const sessionId = 'session-ended-1';

  await postJson(`${baseUrl}/api/events`, {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'session_start',
  });
  await postJson(`${baseUrl}/api/events`, {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'session_end',
  });
  await postJson(`${baseUrl}/api/events`, {
    session_id: sessionId,
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Read',
  });

  const sessionsRes = await fetch(`${baseUrl}/api/sessions?limit=10`);
  assert.equal(sessionsRes.status, 200);
  const body = await sessionsRes.json() as { sessions: Array<{ id: string; status: string }> };

  const session = body.sessions.find(item => item.id === sessionId);
  assert.ok(session);
  assert.equal(session.status, 'ended');
});

test('SSE enforces max clients and cleans up disconnected clients', async () => {
  const sseController = new AbortController();
  const first = await fetch(`${baseUrl}/api/stream`, {
    signal: sseController.signal,
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') || '', /text\/event-stream/);

  const blocked = await fetch(`${baseUrl}/api/stream`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(blocked.status, 503);
  const blockedBody = await blocked.json() as { error: string; max_clients: number };
  assert.equal(blockedBody.error, 'SSE client limit reached');
  assert.equal(blockedBody.max_clients, 1);

  const healthWhileOpen = await getHealth();
  assert.equal(healthWhileOpen.sse_clients, 1);

  sseController.abort();
  try {
    await first.body?.cancel();
  } catch {
    // The aborted stream may already be closed.
  }

  let closed = false;
  for (let i = 0; i < 20; i += 1) {
    const health = await getHealth();
    if (health.sse_clients === 0) {
      closed = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(closed, true);
});

test('POST /api/events preserves source field through normalization', async () => {
  const response = await postJson(`${baseUrl}/api/events`, {
    session_id: 'session-source',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Bash',
    source: 'hook',
  });
  assert.equal(response.status, 201);

  const events = await getEvents();
  assert.equal(events.total, 1);
  assert.equal(events.events[0].source, 'hook');
});
