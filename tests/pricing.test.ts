import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PricingRegistry } from '../src/pricing/index.js';

// ─── Unit tests: PricingRegistry ────────────────────────────────────────

describe('PricingRegistry', () => {
  const registry = new PricingRegistry();

  describe('lookup', () => {
    test('finds Claude Sonnet 4.5 by canonical name', () => {
      const pricing = registry.lookup('claude-sonnet-4-5-20250929');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'anthropic');
      assert.equal(pricing.deprecated, false);
    });

    test('finds Claude Sonnet 4.5 by alias', () => {
      const pricing = registry.lookup('claude-sonnet-4-5');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'anthropic');
    });

    test('finds Claude Opus 4 by alias', () => {
      const pricing = registry.lookup('opus');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'anthropic');
    });

    test('finds OpenAI o3 model', () => {
      const pricing = registry.lookup('o3');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'openai');
    });

    test('finds Gemini model', () => {
      const pricing = registry.lookup('gemini-2.5-pro');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'google');
    });

    test('strips anthropic/ prefix', () => {
      const pricing = registry.lookup('anthropic/claude-sonnet-4-5-20250929');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'anthropic');
    });

    test('strips openai/ prefix', () => {
      const pricing = registry.lookup('openai/o3');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'openai');
    });

    test('strips google/ prefix', () => {
      const pricing = registry.lookup('google/gemini-2.5-pro');
      assert.ok(pricing);
      assert.equal(pricing.provider, 'google');
    });

    test('returns null for unknown model', () => {
      const pricing = registry.lookup('unknown-model-xyz');
      assert.equal(pricing, null);
    });

    test('returns null for empty string', () => {
      const pricing = registry.lookup('');
      assert.equal(pricing, null);
    });

    test('identifies deprecated models', () => {
      const pricing = registry.lookup('claude-3-opus-20240229');
      assert.ok(pricing);
      assert.equal(pricing.deprecated, true);
    });
  });

  describe('calculate', () => {
    test('calculates cost for Claude Sonnet 4.5', () => {
      // Sonnet 4.5: $3/MTok input, $15/MTok output
      const cost = registry.calculate('claude-sonnet-4-5-20250929', {
        input: 1_000_000,
        output: 1_000_000,
      });
      assert.ok(cost !== null);
      // $3 input + $15 output = $18
      assert.equal(cost, 18);
    });

    test('calculates cost with cache tokens', () => {
      // Sonnet 4.5: $0.3/MTok cacheRead, $3.75/MTok cacheWrite
      const cost = registry.calculate('claude-sonnet-4-5-20250929', {
        input: 100_000,
        output: 50_000,
        cacheRead: 500_000,
        cacheWrite: 10_000,
      });
      assert.ok(cost !== null);
      // 100K * $3/MTok + 50K * $15/MTok + 500K * $0.3/MTok + 10K * $3.75/MTok
      // = $0.30 + $0.75 + $0.15 + $0.0375
      const expected = 0.3 + 0.75 + 0.15 + 0.0375;
      assert.ok(Math.abs(cost - expected) < 0.0001);
    });

    test('calculates cost for OpenAI o3', () => {
      // o3: $2/MTok input, $8/MTok output
      const cost = registry.calculate('o3', {
        input: 500_000,
        output: 200_000,
      });
      assert.ok(cost !== null);
      // 500K * $2/MTok + 200K * $8/MTok = $1.00 + $1.60 = $2.60
      const expected = 1.0 + 1.6;
      assert.ok(Math.abs(cost - expected) < 0.0001);
    });

    test('returns null for unknown model', () => {
      const cost = registry.calculate('unknown-model', {
        input: 1000,
        output: 500,
      });
      assert.equal(cost, null);
    });

    test('returns 0 for zero tokens', () => {
      const cost = registry.calculate('claude-sonnet-4-5-20250929', {
        input: 0,
        output: 0,
      });
      assert.ok(cost !== null);
      assert.equal(cost, 0);
    });

    test('handles typical Claude Code session token counts', () => {
      // Typical session: 15K input, 3K output, 10K cache read
      const cost = registry.calculate('claude-sonnet-4-5-20250929', {
        input: 15_000,
        output: 3_000,
        cacheRead: 10_000,
      });
      assert.ok(cost !== null);
      // 15K * $3/MTok + 3K * $15/MTok + 10K * $0.3/MTok
      // = $0.045 + $0.045 + $0.003 = $0.093
      const expected = 0.045 + 0.045 + 0.003;
      assert.ok(Math.abs(cost - expected) < 0.0001);
    });

    test('works via alias', () => {
      const byCanonical = registry.calculate('claude-sonnet-4-5-20250929', {
        input: 1000,
        output: 500,
      });
      const byAlias = registry.calculate('claude-sonnet-4-5', {
        input: 1000,
        output: 500,
      });
      assert.ok(byCanonical !== null);
      assert.ok(byAlias !== null);
      assert.equal(byCanonical, byAlias);
    });
  });

  describe('has', () => {
    test('returns true for known model', () => {
      assert.ok(registry.has('claude-sonnet-4-5-20250929'));
    });

    test('returns true for alias', () => {
      assert.ok(registry.has('sonnet'));
    });

    test('returns false for unknown model', () => {
      assert.ok(!registry.has('totally-fake'));
    });
  });

  describe('knownModels', () => {
    test('includes models from all three providers', () => {
      const models = registry.knownModels;
      assert.ok(models.some(m => m.includes('claude')));
      assert.ok(models.some(m => m.includes('o3') || m.includes('gpt')));
      assert.ok(models.some(m => m.includes('gemini')));
    });

    test('returns non-empty array', () => {
      assert.ok(registry.knownModels.length > 0);
    });
  });
});

// ─── Integration tests: pricing in ingestion pipeline ────────────────────

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

async function getEvents(params = ''): Promise<{ events: Array<Record<string, unknown>>; total: number }> {
  const response = await fetch(`${baseUrl}/api/events?limit=50${params ? '&' + params : ''}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ events: Array<Record<string, unknown>>; total: number }>;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentstats-pricing-test-'));
  process.env.AGENTSTATS_DB_PATH = path.join(tempDir, 'agentstats-pricing-test.db');
  process.env.AGENTSTATS_MAX_PAYLOAD_KB = '64';
  process.env.AGENTSTATS_MAX_SSE_CLIENTS = '0';

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
        if (err) { reject(err); return; }
        resolve();
      });
    });
  }
  closeDb?.();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('Pricing auto-calculation on ingest', () => {
  test('auto-calculates cost_usd when model and tokens provided', async () => {
    const res = await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-price-1',
      agent_type: 'claude_code',
      event_type: 'llm_request',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 1_000_000,
      tokens_out: 100_000,
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    assert.equal(events.total, 1);

    const event = events.events[0];
    assert.ok(event.cost_usd !== null && event.cost_usd !== undefined);
    // 1M * $3/MTok + 100K * $15/MTok = $3.00 + $1.50 = $4.50
    const cost = event.cost_usd as number;
    assert.ok(Math.abs(cost - 4.5) < 0.0001, `Expected ~$4.50, got $${cost}`);
  });

  test('auto-calculates cost including cache tokens', async () => {
    const res = await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-price-2',
      agent_type: 'claude_code',
      event_type: 'llm_request',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 100_000,
      tokens_out: 50_000,
      cache_read_tokens: 500_000,
      cache_write_tokens: 10_000,
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    const cost = events.events[0].cost_usd as number;
    // 100K * $3/MTok + 50K * $15/MTok + 500K * $0.3/MTok + 10K * $3.75/MTok
    const expected = 0.3 + 0.75 + 0.15 + 0.0375;
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected ~$${expected}, got $${cost}`);
  });

  test('preserves client-provided cost_usd (no override)', async () => {
    const res = await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-price-3',
      agent_type: 'claude_code',
      event_type: 'llm_request',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 1_000_000,
      tokens_out: 100_000,
      cost_usd: 99.99,
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    assert.equal(events.events[0].cost_usd, 99.99);
  });

  test('does not set cost when model is unknown', async () => {
    const res = await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-price-4',
      agent_type: 'custom',
      event_type: 'llm_request',
      model: 'totally-unknown-model',
      tokens_in: 1000,
      tokens_out: 500,
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    assert.equal(events.events[0].cost_usd, null);
  });

  test('does not set cost when no tokens', async () => {
    const res = await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-price-5',
      agent_type: 'claude_code',
      event_type: 'session_start',
      model: 'claude-sonnet-4-5-20250929',
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    // tokens_in and tokens_out both default to 0, so no calculation
    assert.equal(events.events[0].cost_usd, null);
  });

  test('auto-calculates cost for OpenAI models', async () => {
    const res = await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-price-6',
      agent_type: 'codex',
      event_type: 'llm_request',
      model: 'o3',
      tokens_in: 500_000,
      tokens_out: 200_000,
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    const cost = events.events[0].cost_usd as number;
    // 500K * $2/MTok + 200K * $8/MTok = $1.00 + $1.60 = $2.60
    assert.ok(Math.abs(cost - 2.6) < 0.0001, `Expected ~$2.60, got $${cost}`);
  });

  test('stats endpoint includes total_cost_usd from auto-calculated costs', async () => {
    // Ingest two events with known costs
    await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-stats-cost',
      agent_type: 'claude_code',
      event_type: 'llm_request',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 1_000_000,
      tokens_out: 0,
    });
    await postJson(`${baseUrl}/api/events`, {
      session_id: 'sess-stats-cost',
      agent_type: 'claude_code',
      event_type: 'llm_request',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 0,
      tokens_out: 1_000_000,
    });

    const statsRes = await fetch(`${baseUrl}/api/stats`);
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json() as { total_cost_usd: number };
    // $3.00 + $15.00 = $18.00
    assert.ok(Math.abs(stats.total_cost_usd - 18.0) < 0.0001, `Expected ~$18.00, got $${stats.total_cost_usd}`);
  });

  test('batch ingest auto-calculates costs for all events', async () => {
    const res = await postJson(`${baseUrl}/api/events/batch`, {
      events: [
        {
          session_id: 'sess-batch-price',
          agent_type: 'claude_code',
          event_type: 'llm_request',
          model: 'claude-sonnet-4-5-20250929',
          tokens_in: 100_000,
          tokens_out: 10_000,
        },
        {
          session_id: 'sess-batch-price',
          agent_type: 'codex',
          event_type: 'llm_request',
          model: 'o3',
          tokens_in: 50_000,
          tokens_out: 20_000,
        },
      ],
    });
    assert.equal(res.status, 201);

    const events = await getEvents();
    assert.equal(events.total, 2);

    // Both should have cost_usd populated
    for (const event of events.events) {
      assert.ok(event.cost_usd !== null, `Event with model ${event.model} should have cost_usd`);
      assert.ok((event.cost_usd as number) > 0);
    }
  });

  test('OTEL ingest auto-calculates costs for log records with tokens', async () => {
    const payload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: 'sess-otel-price' } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1700000000000000000',
            body: { stringValue: '{}' },
            attributes: [
              { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
              { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-5-20250929' } },
              { key: 'gen_ai.usage.input_tokens', value: { intValue: 100000 } },
              { key: 'gen_ai.usage.output_tokens', value: { intValue: 20000 } },
            ],
          }],
        }],
      }],
    };

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 1);
    const cost = events.events[0].cost_usd as number;
    // 100K * $3/MTok + 20K * $15/MTok = $0.30 + $0.30 = $0.60
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost - 0.6) < 0.0001, `Expected ~$0.60, got $${cost}`);
  });

  test('OTEL cost metric takes precedence over auto-calculation', async () => {
    // When OTEL provides cost_usd via log attributes, it should be preserved
    const payload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: 'sess-otel-cost-prio' } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1700000000000000000',
            body: { stringValue: JSON.stringify({ cost_usd: 42.0 }) },
            attributes: [
              { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
              { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-5-20250929' } },
              { key: 'gen_ai.usage.input_tokens', value: { intValue: 1000 } },
              { key: 'gen_ai.usage.output_tokens', value: { intValue: 500 } },
            ],
          }],
        }],
      }],
    };

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 1);
    // The OTel parser extracts cost_usd from body, so insertEvent should preserve it
    assert.equal(events.events[0].cost_usd, 42.0);
  });
});

// ─── Lint test ──────────────────────────────────────────────────────────

describe('Code quality', () => {
  test('ESLint passes on all source files', () => {
    try {
      execSync("npx eslint 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'", {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf-8',
        timeout: 60_000,
      });
    } catch (err: unknown) {
      const e = err as { stdout: string; stderr: string };
      assert.fail(`ESLint found errors:\n${e.stdout || e.stderr}`);
    }
  });

  test('TypeScript compiles without errors', () => {
    try {
      execSync('npx tsc --noEmit', {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf-8',
        timeout: 60_000,
      });
    } catch (err: unknown) {
      const e = err as { stdout: string; stderr: string };
      assert.fail(`TypeScript compilation errors:\n${e.stdout || e.stderr}`);
    }
  });
});
