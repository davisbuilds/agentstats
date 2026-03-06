import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';

let tempDir = '';
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-parser-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

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

// --- Sample JSONL content ---

function sampleJsonl(lines: object[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

const BASIC_SESSION_JSONL = sampleJsonl([
  {
    parentUuid: null,
    isSidechain: false,
    sessionId: 'sess-100',
    cwd: '/Users/dev/my-project',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Hello, help me fix a bug' }],
    },
    timestamp: '2026-03-06T10:00:00.000Z',
  },
  {
    parentUuid: 'uuid-1',
    isSidechain: false,
    sessionId: 'sess-100',
    cwd: '/Users/dev/my-project',
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [
        { type: 'text', text: "I'll look at the code." },
        {
          type: 'tool_use',
          id: 'toolu_001',
          name: 'Read',
          input: { file_path: '/Users/dev/my-project/src/index.ts' },
        },
      ],
    },
    timestamp: '2026-03-06T10:00:05.000Z',
  },
  {
    parentUuid: 'uuid-2',
    isSidechain: false,
    sessionId: 'sess-100',
    cwd: '/Users/dev/my-project',
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [
        { type: 'thinking', thinking: 'The bug is in the error handling...' },
        { type: 'text', text: 'Found the issue. The error handler is missing a null check.' },
        {
          type: 'tool_use',
          id: 'toolu_002',
          name: 'Edit',
          input: {
            file_path: '/Users/dev/my-project/src/index.ts',
            old_string: 'if (err)',
            new_string: 'if (err != null)',
          },
        },
      ],
    },
    timestamp: '2026-03-06T10:00:15.000Z',
  },
  {
    parentUuid: 'uuid-3',
    isSidechain: false,
    sessionId: 'sess-100',
    cwd: '/Users/dev/my-project',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Looks good, thanks!' }],
    },
    timestamp: '2026-03-06T10:01:00.000Z',
  },
]);

const TOOL_HEAVY_SESSION = sampleJsonl([
  {
    parentUuid: null,
    sessionId: 'sess-200',
    cwd: '/Users/dev/tools-project',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Search for TODO comments' }],
    },
    timestamp: '2026-03-06T11:00:00.000Z',
  },
  {
    parentUuid: 'uuid-a',
    sessionId: 'sess-200',
    cwd: '/Users/dev/tools-project',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_010',
          name: 'Grep',
          input: { pattern: 'TODO', path: '/Users/dev/tools-project' },
        },
        {
          type: 'tool_use',
          id: 'toolu_011',
          name: 'Bash',
          input: { command: 'git status' },
        },
        {
          type: 'tool_use',
          id: 'toolu_012',
          name: 'Glob',
          input: { pattern: '**/*.ts' },
        },
      ],
    },
    timestamp: '2026-03-06T11:00:05.000Z',
  },
]);

const SESSION_WITH_PROGRESS = sampleJsonl([
  {
    type: 'progress',
    sessionId: 'sess-300',
    data: { type: 'hook_progress', hookEvent: 'SessionStart' },
  },
  {
    type: 'file-history-snapshot',
    messageId: 'msg-1',
    snapshot: { timestamp: '2026-03-06T12:00:00.000Z' },
  },
  {
    type: 'user',
    parentUuid: null,
    sessionId: 'sess-300',
    cwd: '/Users/dev/project',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Just one message' }],
    },
    timestamp: '2026-03-06T12:00:01.000Z',
  },
  {
    type: 'system',
    sessionId: 'sess-300',
    subtype: 'stop_hook_summary',
  },
]);

// --- Parser tests ---

describe('parseSessionMessages', () => {
  let parseSessionMessages: typeof import('../src/parser/claude-code.js').parseSessionMessages;

  before(async () => {
    const mod = await import('../src/parser/claude-code.js');
    parseSessionMessages = mod.parseSessionMessages;
  });

  test('extracts messages with correct roles and ordinals', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');
    assert.ok(result.messages.length >= 3, `expected >=3 messages, got ${result.messages.length}`);

    // First message should be user
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].ordinal, 0);

    // Second should be assistant
    assert.equal(result.messages[1].role, 'assistant');
    assert.equal(result.messages[1].ordinal, 1);

    // Ordinals should be sequential
    for (let i = 0; i < result.messages.length; i++) {
      assert.equal(result.messages[i].ordinal, i, `ordinal mismatch at index ${i}`);
    }
  });

  test('extracts timestamps from messages', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');
    assert.equal(result.messages[0].timestamp, '2026-03-06T10:00:00.000Z');
    assert.equal(result.messages[1].timestamp, '2026-03-06T10:00:05.000Z');
  });

  test('identifies content blocks correctly', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');

    // First user message: text only
    const userBlocks = JSON.parse(result.messages[0].content);
    assert.equal(userBlocks[0].type, 'text');
    assert.equal(userBlocks[0].text, 'Hello, help me fix a bug');

    // First assistant message: text + tool_use
    const assistantBlocks = JSON.parse(result.messages[1].content);
    const blockTypes = assistantBlocks.map((b: { type: string }) => b.type);
    assert.ok(blockTypes.includes('text'), 'should have text block');
    assert.ok(blockTypes.includes('tool_use'), 'should have tool_use block');
  });

  test('detects thinking blocks', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');

    // Third message (index 2) has thinking
    assert.equal(result.messages[2].has_thinking, 1);
    // First message has no thinking
    assert.equal(result.messages[0].has_thinking, 0);
  });

  test('detects tool_use blocks', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');

    // First assistant message has tool_use
    assert.equal(result.messages[1].has_tool_use, 1);
    // First user message has no tool_use
    assert.equal(result.messages[0].has_tool_use, 0);
  });

  test('extracts tool calls with correct categories', () => {
    const result = parseSessionMessages(TOOL_HEAVY_SESSION, 'sess-200');

    assert.ok(result.toolCalls.length >= 3, `expected >=3 tool calls, got ${result.toolCalls.length}`);

    const byName = new Map(result.toolCalls.map(tc => [tc.tool_name, tc]));
    assert.ok(byName.has('Grep'), 'should have Grep call');
    assert.ok(byName.has('Bash'), 'should have Bash call');
    assert.ok(byName.has('Glob'), 'should have Glob call');

    // Check categories
    assert.equal(byName.get('Grep')!.category, 'Search');
    assert.equal(byName.get('Bash')!.category, 'Bash');
    assert.equal(byName.get('Glob')!.category, 'Search');
  });

  test('normalizes tool categories correctly', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');
    const byName = new Map(result.toolCalls.map(tc => [tc.tool_name, tc]));

    assert.equal(byName.get('Read')!.category, 'Read');
    assert.equal(byName.get('Edit')!.category, 'Edit');
  });

  test('extracts session metadata', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');

    assert.equal(result.metadata.session_id, 'sess-100');
    assert.equal(result.metadata.message_count, result.messages.length);
    assert.equal(result.metadata.user_message_count, 2); // two user messages
    assert.ok(result.metadata.started_at, 'should have started_at');
    assert.ok(result.metadata.ended_at, 'should have ended_at');
    assert.ok(result.metadata.first_message, 'should have first_message');
    assert.ok(result.metadata.first_message!.includes('bug'), 'first_message should be from first user message');
  });

  test('skips non-message lines (progress, system, file-history-snapshot)', () => {
    const result = parseSessionMessages(SESSION_WITH_PROGRESS, 'sess-300');

    // Only the user message should be extracted
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
  });

  test('handles empty JSONL content', () => {
    const result = parseSessionMessages('', 'sess-empty');
    assert.equal(result.messages.length, 0);
    assert.equal(result.toolCalls.length, 0);
  });

  test('handles malformed lines gracefully', () => {
    const content = 'not valid json\n{"type":"user","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"ok"}]}}\n{broken\n';
    const result = parseSessionMessages(content, 's');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
  });

  test('handles missing fields gracefully', () => {
    const content = sampleJsonl([
      { type: 'user', sessionId: 'sess-x' },
      { type: 'assistant', sessionId: 'sess-x', message: {} },
      { type: 'assistant', sessionId: 'sess-x', message: { role: 'assistant', content: null } },
    ]);
    // Should not throw
    const result = parseSessionMessages(content, 'sess-x');
    assert.ok(result.messages.length >= 0);
  });

  test('extracts project name from directory structure', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100', '/Users/dev/.claude/projects/-Users-dev-my-project/sess-100.jsonl');
    assert.equal(result.metadata.project, 'my-project');
  });

  test('tool_use_id is preserved', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');
    const readCall = result.toolCalls.find(tc => tc.tool_name === 'Read');
    assert.ok(readCall, 'should have Read tool call');
    assert.equal(readCall!.tool_use_id, 'toolu_001');
  });

  test('tool input_json is stored', () => {
    const result = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-100');
    const readCall = result.toolCalls.find(tc => tc.tool_name === 'Read');
    assert.ok(readCall!.input_json, 'should have input_json');
    const input = JSON.parse(readCall!.input_json!);
    assert.ok(input.file_path, 'input should have file_path');
  });
});

// --- Category normalization tests ---

describe('categorizeToolName', () => {
  let categorizeToolName: typeof import('../src/parser/claude-code.js').categorizeToolName;

  before(async () => {
    const mod = await import('../src/parser/claude-code.js');
    categorizeToolName = mod.categorizeToolName;
  });

  test('Read tools', () => {
    assert.equal(categorizeToolName('Read'), 'Read');
    assert.equal(categorizeToolName('NotebookRead'), 'Read');
  });

  test('Write tools', () => {
    assert.equal(categorizeToolName('Write'), 'Write');
    assert.equal(categorizeToolName('NotebookEdit'), 'Write');
  });

  test('Edit tools', () => {
    assert.equal(categorizeToolName('Edit'), 'Edit');
    assert.equal(categorizeToolName('MultiEdit'), 'Edit');
  });

  test('Search tools', () => {
    assert.equal(categorizeToolName('Grep'), 'Search');
    assert.equal(categorizeToolName('Glob'), 'Search');
    assert.equal(categorizeToolName('WebSearch'), 'Search');
  });

  test('Bash tools', () => {
    assert.equal(categorizeToolName('Bash'), 'Bash');
  });

  test('Agent tools', () => {
    assert.equal(categorizeToolName('Agent'), 'Agent');
    assert.equal(categorizeToolName('ToolSearch'), 'Agent');
  });

  test('Unknown tools get Other category', () => {
    assert.equal(categorizeToolName('SomethingNew'), 'Other');
  });
});

// --- DB insertion integration tests ---

describe('insertParsedSession', () => {
  let parseSessionMessages: typeof import('../src/parser/claude-code.js').parseSessionMessages;
  let insertParsedSession: typeof import('../src/parser/claude-code.js').insertParsedSession;

  before(async () => {
    const mod = await import('../src/parser/claude-code.js');
    parseSessionMessages = mod.parseSessionMessages;
    insertParsedSession = mod.insertParsedSession;
  });

  test('inserts parsed data into browsing_sessions, messages, and tool_calls', () => {
    const db = getDb();
    const parsed = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-db-001', '/path/to/sess-db-001.jsonl');

    insertParsedSession(db, parsed, '/path/to/sess-db-001.jsonl', 1024, 'hash123');

    // Check browsing_sessions
    const session = db.prepare('SELECT * FROM browsing_sessions WHERE id = ?').get('sess-db-001') as Record<string, unknown>;
    assert.ok(session, 'session should exist');
    assert.equal(session.file_hash, 'hash123');
    assert.equal(session.message_count, parsed.messages.length);

    // Check messages
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal').all('sess-db-001') as Array<Record<string, unknown>>;
    assert.equal(messages.length, parsed.messages.length);

    // Check tool_calls
    const toolCalls = db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all('sess-db-001') as Array<Record<string, unknown>>;
    assert.ok(toolCalls.length > 0, 'should have tool calls');
  });

  test('inserted messages are FTS-searchable', () => {
    const db = getDb();
    const results = db.prepare(`
      SELECT messages.session_id
      FROM messages_fts
      JOIN messages ON messages.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
    `).all('bug') as Array<{ session_id: string }>;

    assert.ok(results.some(r => r.session_id === 'sess-db-001'), 'FTS search for "bug" should find the session');
  });

  test('transaction is atomic — re-insert replaces cleanly', () => {
    const db = getDb();
    const parsed = parseSessionMessages(BASIC_SESSION_JSONL, 'sess-db-002');
    insertParsedSession(db, parsed, '/path/to/sess-db-002.jsonl', 512, 'hash_first');

    const count1 = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get('sess-db-002') as { c: number }).c;

    // Re-insert with different hash (simulating file change)
    insertParsedSession(db, parsed, '/path/to/sess-db-002.jsonl', 600, 'hash_second');

    const count2 = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get('sess-db-002') as { c: number }).c;
    assert.equal(count1, count2, 'message count should be the same after re-insert');

    const session = db.prepare('SELECT file_hash FROM browsing_sessions WHERE id = ?').get('sess-db-002') as { file_hash: string };
    assert.equal(session.file_hash, 'hash_second', 'hash should be updated');
  });
});
