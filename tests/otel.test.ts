import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl = '';
let tempDir = '';
let getDb: (() => { exec: (sql: string) => void }) | null = null;
let closeDb: (() => void) | null = null;

async function postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function postProtobuf(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf' },
    body: new Uint8Array([0x0a, 0x00]),
  });
}

async function getEvents(params = ''): Promise<{ events: Array<Record<string, unknown>>; total: number }> {
  const response = await fetch(`${baseUrl}/api/events?limit=50${params ? '&' + params : ''}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ events: Array<Record<string, unknown>>; total: number }>;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentstats-otel-test-'));
  process.env.AGENTSTATS_DB_PATH = path.join(tempDir, 'agentstats-otel-test.db');
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

// ─── Helper: build OTLP log payload ────────────────────────────────────

function buildLogPayload(opts: {
  serviceName?: string;
  resourceAttrs?: Array<{ key: string; value: { stringValue?: string } }>;
  logRecords: Array<{
    eventName?: string;
    attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string | number } }>;
    body?: unknown;
    timeUnixNano?: string;
  }>;
}) {
  const resourceAttrs: Array<{ key: string; value: { stringValue: string } }> = [];
  if (opts.serviceName) {
    resourceAttrs.push({ key: 'service.name', value: { stringValue: opts.serviceName } });
  }
  if (opts.resourceAttrs) {
    resourceAttrs.push(...(opts.resourceAttrs as Array<{ key: string; value: { stringValue: string } }>));
  }

  return {
    resourceLogs: [{
      resource: { attributes: resourceAttrs },
      scopeLogs: [{
        logRecords: opts.logRecords.map(lr => {
          const attrs = [...(lr.attributes ?? [])];
          if (lr.eventName) {
            attrs.push({ key: 'event.name', value: { stringValue: lr.eventName } });
          }
          return {
            timeUnixNano: lr.timeUnixNano ?? '1700000000000000000',
            body: lr.body ?? { stringValue: '{}' },
            attributes: attrs,
          };
        }),
      }],
    }],
  };
}

// ─── Helper: build OTLP metrics payload ────────────────────────────────

function buildMetricsPayload(opts: {
  serviceName?: string;
  resourceAttrs?: Array<{ key: string; value: { stringValue: string } }>;
  metrics: Array<{
    name: string;
    dataPoints: Array<{
      value: number;
      attributes?: Array<{ key: string; value: { stringValue?: string } }>;
    }>;
    aggregationTemporality?: number;
  }>;
}) {
  const resourceAttrs: Array<{ key: string; value: { stringValue: string } }> = [];
  if (opts.serviceName) {
    resourceAttrs.push({ key: 'service.name', value: { stringValue: opts.serviceName } });
  }
  if (opts.resourceAttrs) {
    resourceAttrs.push(...opts.resourceAttrs);
  }

  return {
    resourceMetrics: [{
      resource: { attributes: resourceAttrs },
      scopeMetrics: [{
        metrics: opts.metrics.map(m => ({
          name: m.name,
          sum: {
            dataPoints: m.dataPoints.map(dp => ({
              asInt: String(dp.value),
              attributes: dp.attributes ?? [],
              timeUnixNano: '1700000000000000000',
            })),
            isMonotonic: true,
            aggregationTemporality: m.aggregationTemporality ?? 1, // delta by default
          },
        })),
      }],
    }],
  };
}

// ─── Logs endpoint tests ────────────────────────────────────────────────

describe('POST /api/otel/v1/logs', () => {
  test('returns 415 for protobuf content-type', async () => {
    const res = await postProtobuf(`${baseUrl}/api/otel/v1/logs`);
    assert.equal(res.status, 415);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('Protobuf not supported'));
  });

  test('returns 200 empty object for empty payload', async () => {
    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {});
  });

  test('ingests Claude Code tool_use log record', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-otel-1' } },
      ],
      logRecords: [{
        eventName: 'claude_code.tool_result',
        attributes: [
          { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
          { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-20250514' } },
        ],
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents('source=otel');
    assert.equal(events.total, 1);
    assert.equal(events.events[0].session_id, 'sess-otel-1');
    assert.equal(events.events[0].agent_type, 'claude_code');
    assert.equal(events.events[0].event_type, 'tool_use');
    assert.equal(events.events[0].tool_name, 'Bash');
    assert.equal(events.events[0].model, 'claude-sonnet-4-20250514');
    assert.equal(events.events[0].source, 'otel');
  });

  test('ingests Claude Code llm_request with token counts', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-otel-2' } },
      ],
      logRecords: [{
        eventName: 'claude_code.api_request',
        attributes: [
          { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-4-20250514' } },
          { key: 'gen_ai.usage.input_tokens', value: { intValue: 1500 } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: 300 } },
          { key: 'gen_ai.usage.cache_read_input_tokens', value: { intValue: 800 } },
        ],
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].event_type, 'llm_request');
    assert.equal(events.events[0].tokens_in, 1500);
    assert.equal(events.events[0].tokens_out, 300);
    assert.equal(events.events[0].cache_read_tokens, 800);
  });

  test('ingests Codex log record using body fields', async () => {
    const payload = buildLogPayload({
      serviceName: 'codex_cli_rs',
      logRecords: [{
        eventName: 'codex.tool_result',
        body: {
          stringValue: JSON.stringify({
            session_id: 'codex-sess-1',
            tool_name: 'shell',
            model: 'o3',
            input_tokens: 200,
            output_tokens: 50,
          }),
        },
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].session_id, 'codex-sess-1');
    assert.equal(events.events[0].agent_type, 'codex');
    assert.equal(events.events[0].event_type, 'tool_use');
    assert.equal(events.events[0].tool_name, 'shell');
    assert.equal(events.events[0].model, 'o3');
    assert.equal(events.events[0].tokens_in, 200);
    assert.equal(events.events[0].tokens_out, 50);
  });

  test('skips log records without session_id', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      logRecords: [{
        eventName: 'claude_code.tool_result',
        attributes: [
          { key: 'gen_ai.tool.name', value: { stringValue: 'Read' } },
        ],
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 0);
  });

  test('ingests multiple log records in one payload', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-multi' } },
      ],
      logRecords: [
        {
          eventName: 'claude_code.tool_result',
          attributes: [
            { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
          ],
        },
        {
          eventName: 'claude_code.tool_result',
          attributes: [
            { key: 'gen_ai.tool.name', value: { stringValue: 'Read' } },
          ],
        },
        {
          eventName: 'claude_code.api_request',
          attributes: [
            { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-20250514' } },
          ],
        },
      ],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 3);
  });

  test('session_start and session_end event names are recognized', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-lifecycle' } },
      ],
      logRecords: [
        { eventName: 'claude_code.session_start' },
        { eventName: 'claude_code.session_end' },
      ],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 2);

    const types = events.events.map(e => e.event_type).sort();
    assert.deepEqual(types, ['session_end', 'session_start']);
  });

  test('sets error status when severity is ERROR', async () => {
    const payload: Record<string, unknown> = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: 'sess-err' } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1700000000000000000',
            body: { stringValue: '{}' },
            attributes: [],
            severityText: 'ERROR',
          }],
        }],
      }],
    };

    const res = await postJson(`${baseUrl}/api/otel/v1/logs`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].event_type, 'error');
    assert.equal(events.events[0].status, 'error');
  });

  test('all ingested events have source=otel', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-src' } },
      ],
      logRecords: [
        { eventName: 'claude_code.tool_result', attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } }] },
        { eventName: 'claude_code.api_request', attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-20250514' } }] },
      ],
    });

    await postJson(`${baseUrl}/api/otel/v1/logs`, payload);

    const events = await getEvents('source=otel');
    assert.equal(events.total, 2);
    for (const e of events.events) {
      assert.equal(e.source, 'otel');
    }
  });

  test('extracts body metadata excluding promoted fields', async () => {
    const payload = buildLogPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-meta' } },
      ],
      logRecords: [{
        eventName: 'claude_code.tool_result',
        body: {
          stringValue: JSON.stringify({
            session_id: 'sess-meta',
            tool_name: 'Bash',
            command: 'ls -la',
            exit_code: 0,
            output: 'total 42',
          }),
        },
        attributes: [
          { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
        ],
      }],
    });

    await postJson(`${baseUrl}/api/otel/v1/logs`, payload);

    const events = await getEvents();
    assert.equal(events.total, 1);

    const meta = JSON.parse(events.events[0].metadata as string) as Record<string, unknown>;
    // session_id and tool_name should be excluded from metadata
    assert.equal(meta.session_id, undefined);
    assert.equal(meta.tool_name, undefined);
    // Non-promoted fields should remain
    assert.equal(meta.command, 'ls -la');
    assert.equal(meta.exit_code, 0);
    assert.equal(meta.output, 'total 42');
  });
});

// ─── Metrics endpoint tests ────────────────────────────────────────────

describe('POST /api/otel/v1/metrics', () => {
  test('returns 415 for protobuf content-type', async () => {
    const res = await postProtobuf(`${baseUrl}/api/otel/v1/metrics`);
    assert.equal(res.status, 415);
  });

  test('returns 200 for empty payload', async () => {
    const res = await postJson(`${baseUrl}/api/otel/v1/metrics`, {});
    assert.equal(res.status, 200);
  });

  test('ingests token usage delta metrics', async () => {
    const payload = buildMetricsPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-metric-1' } },
      ],
      metrics: [{
        name: 'claude_code.token.usage',
        dataPoints: [
          {
            value: 1000,
            attributes: [
              { key: 'type', value: { stringValue: 'input' } },
              { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
            ],
          },
          {
            value: 250,
            attributes: [
              { key: 'type', value: { stringValue: 'output' } },
              { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
            ],
          },
        ],
        aggregationTemporality: 1, // delta
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/metrics`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 2);

    const inputEvent = events.events.find(e => (e.tokens_in as number) > 0);
    const outputEvent = events.events.find(e => (e.tokens_out as number) > 0);
    assert.ok(inputEvent);
    assert.ok(outputEvent);
    assert.equal(inputEvent.tokens_in, 1000);
    assert.equal(outputEvent.tokens_out, 250);
    assert.equal(inputEvent.model, 'claude-sonnet-4-20250514');
    assert.equal(inputEvent.source, 'otel');
    assert.equal(inputEvent.event_type, 'llm_response');
  });

  test('ingests cost delta metrics', async () => {
    // Build with asDouble since cost is fractional
    const rawPayload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: 'sess-cost-1' } },
          ],
        },
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.cost.usage',
            sum: {
              dataPoints: [{
                asDouble: 0.05,
                attributes: [
                  { key: 'model', value: { stringValue: 'claude-opus-4-20250514' } },
                ],
                timeUnixNano: '1700000000000000000',
              }],
              isMonotonic: true,
              aggregationTemporality: 1,
            },
          }],
        }],
      }],
    };

    const res = await postJson(`${baseUrl}/api/otel/v1/metrics`, rawPayload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].cost_usd, 0.05);
    assert.equal(events.events[0].event_type, 'llm_response');
  });

  test('handles cumulative metrics with delta conversion', async () => {
    // Reset the cumulative state between tests by importing the parser
    const { resetCumulativeState } = await import('../src/otel/parser.js');
    resetCumulativeState();

    const makePayload = (value: number) => ({
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: 'sess-cumul' } },
          ],
        },
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.token.usage',
            sum: {
              dataPoints: [{
                asInt: String(value),
                attributes: [
                  { key: 'type', value: { stringValue: 'input' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                ],
                timeUnixNano: '1700000000000000000',
              }],
              isMonotonic: true,
              aggregationTemporality: 2, // cumulative
            },
          }],
        }],
      }],
    });

    // First report: 1000 total (treated as delta = 1000)
    const res1 = await postJson(`${baseUrl}/api/otel/v1/metrics`, makePayload(1000));
    assert.equal(res1.status, 200);

    // Second report: 1500 total (delta = 500)
    const res2 = await postJson(`${baseUrl}/api/otel/v1/metrics`, makePayload(1500));
    assert.equal(res2.status, 200);

    // Third report: 1500 total (delta = 0, should be skipped)
    const res3 = await postJson(`${baseUrl}/api/otel/v1/metrics`, makePayload(1500));
    assert.equal(res3.status, 200);

    const events = await getEvents();
    // Should have 2 events: first delta=1000, second delta=500, third skipped (delta=0)
    assert.equal(events.total, 2);

    const tokenValues = events.events.map(e => e.tokens_in as number).sort((a, b) => a - b);
    assert.deepEqual(tokenValues, [500, 1000]);

    resetCumulativeState();
  });

  test('skips zero-value metrics', async () => {
    const payload = buildMetricsPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-zero' } },
      ],
      metrics: [{
        name: 'claude_code.token.usage',
        dataPoints: [{
          value: 0,
          attributes: [
            { key: 'type', value: { stringValue: 'input' } },
          ],
        }],
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/metrics`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 0);
  });

  test('cache token types are recognized', async () => {
    const payload = buildMetricsPayload({
      serviceName: 'claude_code',
      resourceAttrs: [
        { key: 'gen_ai.session.id', value: { stringValue: 'sess-cache' } },
      ],
      metrics: [{
        name: 'claude_code.token.usage',
        dataPoints: [
          {
            value: 500,
            attributes: [
              { key: 'type', value: { stringValue: 'cacheRead' } },
            ],
          },
          {
            value: 200,
            attributes: [
              { key: 'type', value: { stringValue: 'cacheCreation' } },
            ],
          },
        ],
      }],
    });

    const res = await postJson(`${baseUrl}/api/otel/v1/metrics`, payload);
    assert.equal(res.status, 200);

    const events = await getEvents();
    assert.equal(events.total, 2);

    const cacheReadEvent = events.events.find(e => (e.cache_read_tokens as number) > 0);
    const cacheWriteEvent = events.events.find(e => (e.cache_write_tokens as number) > 0);
    assert.ok(cacheReadEvent);
    assert.ok(cacheWriteEvent);
    assert.equal(cacheReadEvent.cache_read_tokens, 500);
    assert.equal(cacheWriteEvent.cache_write_tokens, 200);
  });

  test('cumulative metrics are scoped per session (no cross-session corruption)', async () => {
    const { resetCumulativeState } = await import('../src/otel/parser.js');
    resetCumulativeState();

    // Build cumulative metric payload for a specific session
    const makeCumulativePayload = (sessionId: string, value: number) => ({
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude_code' } },
            { key: 'gen_ai.session.id', value: { stringValue: sessionId } },
          ],
        },
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.token.usage',
            sum: {
              dataPoints: [{
                asInt: String(value),
                attributes: [
                  { key: 'type', value: { stringValue: 'input' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet-4-20250514' } },
                ],
                timeUnixNano: '1700000000000000000',
              }],
              isMonotonic: true,
              aggregationTemporality: 2, // cumulative
            },
          }],
        }],
      }],
    });

    // Session A: first report = 1000 (delta 1000)
    await postJson(`${baseUrl}/api/otel/v1/metrics`, makeCumulativePayload('sess-A', 1000));
    // Session B: first report = 500 (delta 500, NOT 500-1000=-500)
    await postJson(`${baseUrl}/api/otel/v1/metrics`, makeCumulativePayload('sess-B', 500));
    // Session A: second report = 1800 (delta 800, NOT 1800-500=1300)
    await postJson(`${baseUrl}/api/otel/v1/metrics`, makeCumulativePayload('sess-A', 1800));
    // Session B: second report = 900 (delta 400, NOT 900-1800=-900)
    await postJson(`${baseUrl}/api/otel/v1/metrics`, makeCumulativePayload('sess-B', 900));

    const events = await getEvents();
    assert.equal(events.total, 4);

    // Verify each session's deltas are correct
    const sessAEvents = events.events.filter(e => e.session_id === 'sess-A');
    const sessBEvents = events.events.filter(e => e.session_id === 'sess-B');
    assert.equal(sessAEvents.length, 2);
    assert.equal(sessBEvents.length, 2);

    const sessATokens = sessAEvents.map(e => e.tokens_in as number).sort((a, b) => a - b);
    const sessBTokens = sessBEvents.map(e => e.tokens_in as number).sort((a, b) => a - b);
    // Session A: 1000, then 800
    assert.deepEqual(sessATokens, [800, 1000]);
    // Session B: 500, then 400
    assert.deepEqual(sessBTokens, [400, 500]);

    resetCumulativeState();
  });
});

// ─── Traces endpoint tests ─────────────────────────────────────────────

describe('POST /api/otel/v1/traces', () => {
  test('returns 415 for protobuf content-type', async () => {
    const res = await postProtobuf(`${baseUrl}/api/otel/v1/traces`);
    assert.equal(res.status, 415);
  });

  test('accepts traces and returns empty object (stub)', async () => {
    const res = await postJson(`${baseUrl}/api/otel/v1/traces`, {
      resourceSpans: [],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {});
  });
});

// ─── Codex-specific tests ──────────────────────────────────────────────

describe('Codex OTLP integration', () => {
  test('recognizes codex_cli_rs service name as codex agent type', async () => {
    const payload = buildLogPayload({
      serviceName: 'codex_cli_rs',
      resourceAttrs: [
        { key: 'session.id', value: { stringValue: 'codex-otel-1' } },
      ],
      logRecords: [{
        eventName: 'codex.api_request',
        attributes: [
          { key: 'gen_ai.request.model', value: { stringValue: 'o3' } },
          { key: 'gen_ai.usage.input_tokens', value: { intValue: 500 } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: 100 } },
        ],
      }],
    });

    await postJson(`${baseUrl}/api/otel/v1/logs`, payload);

    const events = await getEvents();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].agent_type, 'codex');
    assert.equal(events.events[0].event_type, 'llm_request');
    assert.equal(events.events[0].model, 'o3');
  });

  test('codex metrics use codex_cli_rs metric names', async () => {
    const payload = buildMetricsPayload({
      serviceName: 'codex_cli_rs',
      resourceAttrs: [
        { key: 'session.id', value: { stringValue: 'codex-metric-1' } },
      ],
      metrics: [{
        name: 'codex_cli_rs.token.usage',
        dataPoints: [{
          value: 750,
          attributes: [
            { key: 'type', value: { stringValue: 'input' } },
            { key: 'model', value: { stringValue: 'o3' } },
          ],
        }],
      }],
    });

    await postJson(`${baseUrl}/api/otel/v1/metrics`, payload);

    const events = await getEvents();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].agent_type, 'codex');
    assert.equal(events.events[0].tokens_in, 750);
  });
});
