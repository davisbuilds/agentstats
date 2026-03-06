import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';
import crypto from 'node:crypto';

let tempDir = '';
let dbDir = '';
let watchDir = '';
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-watcher-'));
  dbDir = path.join(tempDir, 'db');
  watchDir = path.join(tempDir, 'watch', 'projects', '-Users-dev-Dev-testproject');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(watchDir, { recursive: true });

  process.env.AGENTMONITOR_DB_PATH = path.join(dbDir, 'test.db');

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sampleJsonl(lines: object[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function writeSessionFile(sessionId: string, content: string): string {
  const filePath = path.join(watchDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const makeSession = (sessionId: string) => sampleJsonl([
  {
    type: 'user',
    parentUuid: null,
    sessionId,
    cwd: '/Users/dev/Dev/testproject',
    message: { role: 'user', content: [{ type: 'text', text: `Hello from session ${sessionId}` }] },
    timestamp: '2026-03-06T10:00:00.000Z',
  },
  {
    type: 'assistant',
    parentUuid: 'u1',
    sessionId,
    cwd: '/Users/dev/Dev/testproject',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there! How can I help?' }],
    },
    timestamp: '2026-03-06T10:00:05.000Z',
  },
]);

describe('syncSessionFile', () => {
  let syncSessionFile: typeof import('../src/watcher/index.js').syncSessionFile;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    syncSessionFile = mod.syncSessionFile;
  });

  test('parses and inserts a new session file', () => {
    const db = getDb();
    const sessionId = 'new-sess-001';
    const filePath = writeSessionFile(sessionId, makeSession(sessionId));

    const result = syncSessionFile(db, filePath);
    assert.equal(result, 'parsed');

    // Verify data in DB
    const session = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
    assert.ok(session, 'session should exist');
    assert.equal(session.message_count, 2);

    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(sessionId);
    assert.equal(messages.length, 2);

    // Verify watched_files record
    const watched = db.prepare('SELECT * FROM watched_files WHERE file_path = ?').get(filePath) as Record<string, unknown>;
    assert.ok(watched, 'watched_files record should exist');
    assert.equal(watched.status, 'parsed');
  });

  test('skips file with unchanged hash', () => {
    const db = getDb();
    const sessionId = 'skip-sess-001';
    const filePath = writeSessionFile(sessionId, makeSession(sessionId));

    // First parse
    const result1 = syncSessionFile(db, filePath);
    assert.equal(result1, 'parsed');

    // Second parse — same content, should skip
    const result2 = syncSessionFile(db, filePath);
    assert.equal(result2, 'skipped');
  });

  test('re-parses file with changed hash', () => {
    const db = getDb();
    const sessionId = 'changed-sess-001';
    const content1 = makeSession(sessionId);
    const filePath = writeSessionFile(sessionId, content1);

    syncSessionFile(db, filePath);

    // Modify file — add another message
    const content2 = content1 + JSON.stringify({
      type: 'user',
      parentUuid: 'u2',
      sessionId,
      cwd: '/Users/dev/Dev/testproject',
      message: { role: 'user', content: [{ type: 'text', text: 'One more question' }] },
      timestamp: '2026-03-06T10:02:00.000Z',
    }) + '\n';
    fs.writeFileSync(filePath, content2);

    const result = syncSessionFile(db, filePath);
    assert.equal(result, 'parsed');

    // Should now have 3 messages
    const count = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number }).c;
    assert.equal(count, 3);
  });

  test('handles empty/invalid JSONL files gracefully', () => {
    const db = getDb();
    const filePath = writeSessionFile('empty-sess', '');
    const result = syncSessionFile(db, filePath);
    // Should mark as skipped (no messages to parse)
    assert.ok(result === 'skipped' || result === 'parsed');
  });
});

describe('discoverSessionFiles', () => {
  let discoverSessionFiles: typeof import('../src/watcher/index.js').discoverSessionFiles;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    discoverSessionFiles = mod.discoverSessionFiles;
  });

  test('discovers JSONL files in projects directory', () => {
    // Write some session files
    writeSessionFile('discover-001', makeSession('discover-001'));
    writeSessionFile('discover-002', makeSession('discover-002'));

    const parentDir = path.join(tempDir, 'watch');
    const files = discoverSessionFiles(parentDir);
    assert.ok(files.length >= 2, `expected >= 2 files, got ${files.length}`);
    assert.ok(files.some(f => f.endsWith('discover-001.jsonl')));
    assert.ok(files.some(f => f.endsWith('discover-002.jsonl')));
  });

  test('ignores non-JSONL files', () => {
    // Write a non-JSONL file
    fs.writeFileSync(path.join(watchDir, 'readme.txt'), 'not a session');

    const parentDir = path.join(tempDir, 'watch');
    const files = discoverSessionFiles(parentDir);
    assert.ok(!files.some(f => f.endsWith('.txt')), 'should not include .txt files');
  });
});

describe('syncAllFiles', () => {
  let syncAllFiles: typeof import('../src/watcher/index.js').syncAllFiles;

  before(async () => {
    const mod = await import('../src/watcher/index.js');
    syncAllFiles = mod.syncAllFiles;
  });

  test('syncs all discovered files and returns stats', () => {
    const db = getDb();
    const parentDir = path.join(tempDir, 'watch');

    // Write fresh session files
    const syncDir = path.join(tempDir, 'watch', 'projects', '-Users-dev-Dev-syncproject');
    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(
      path.join(syncDir, 'sync-001.jsonl'),
      makeSession('sync-001'),
    );
    fs.writeFileSync(
      path.join(syncDir, 'sync-002.jsonl'),
      makeSession('sync-002'),
    );

    const stats = syncAllFiles(db, parentDir);
    assert.ok(stats.parsed >= 2, `expected >= 2 parsed, got ${stats.parsed}`);
    assert.ok(typeof stats.skipped === 'number');
    assert.ok(typeof stats.errors === 'number');
  });
});
