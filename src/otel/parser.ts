import type { NormalizedIngestEvent, EventType } from '../contracts/event-contract.js';

// ─── OTLP JSON types (subset we care about) ────────────────────────────

interface OtelKeyValue {
  key: string;
  value: OtelAnyValue;
}

interface OtelAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  kvlistValue?: { values: OtelKeyValue[] };
  arrayValue?: { values: OtelAnyValue[] };
}

interface OtelResource {
  attributes?: OtelKeyValue[];
}

// ─── Logs ───────────────────────────────────────────────────────────────

interface OtelLogRecord {
  timeUnixNano?: string;
  body?: OtelAnyValue;
  attributes?: OtelKeyValue[];
  severityText?: string;
}

interface OtelScopeLogs {
  logRecords?: OtelLogRecord[];
}

interface OtelResourceLogs {
  resource?: OtelResource;
  scopeLogs?: OtelScopeLogs[];
}

export interface OtelLogsPayload {
  resourceLogs?: OtelResourceLogs[];
}

// ─── Metrics ────────────────────────────────────────────────────────────

interface OtelNumberDataPoint {
  asInt?: string | number;
  asDouble?: number;
  attributes?: OtelKeyValue[];
  timeUnixNano?: string;
  startTimeUnixNano?: string;
}

interface OtelSum {
  dataPoints?: OtelNumberDataPoint[];
  isMonotonic?: boolean;
  aggregationTemporality?: number; // 1=delta, 2=cumulative
}

interface OtelGauge {
  dataPoints?: OtelNumberDataPoint[];
}

interface OtelMetric {
  name?: string;
  sum?: OtelSum;
  gauge?: OtelGauge;
}

interface OtelScopeMetrics {
  metrics?: OtelMetric[];
}

interface OtelResourceMetrics {
  resource?: OtelResource;
  scopeMetrics?: OtelScopeMetrics[];
}

export interface OtelMetricsPayload {
  resourceMetrics?: OtelResourceMetrics[];
}

// ─── Attribute helpers ──────────────────────────────────────────────────

function getAttr(attrs: OtelKeyValue[] | undefined, key: string): string | undefined {
  if (!attrs) return undefined;
  const kv = attrs.find(a => a.key === key);
  if (!kv) return undefined;
  if (kv.value.stringValue !== undefined) return kv.value.stringValue;
  if (kv.value.intValue !== undefined) return String(kv.value.intValue);
  if (kv.value.doubleValue !== undefined) return String(kv.value.doubleValue);
  return undefined;
}

function getAttrNumber(attrs: OtelKeyValue[] | undefined, key: string): number | undefined {
  if (!attrs) return undefined;
  const kv = attrs.find(a => a.key === key);
  if (!kv) return undefined;
  if (kv.value.intValue !== undefined) {
    const n = typeof kv.value.intValue === 'number' ? kv.value.intValue : parseInt(kv.value.intValue, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  if (kv.value.doubleValue !== undefined) return kv.value.doubleValue;
  if (kv.value.stringValue !== undefined) {
    const n = parseFloat(kv.value.stringValue);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function getBodyJson(body: OtelAnyValue | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  if (body.stringValue) {
    try {
      const parsed = JSON.parse(body.stringValue);
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // not JSON, ignore
    }
    return undefined;
  }
  if (body.kvlistValue?.values) {
    const obj: Record<string, unknown> = {};
    for (const kv of body.kvlistValue.values) {
      obj[kv.key] = extractAnyValue(kv.value);
    }
    return obj;
  }
  return undefined;
}

function extractAnyValue(v: OtelAnyValue): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'number' ? v.intValue : parseInt(v.intValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.kvlistValue?.values) {
    const obj: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values) {
      obj[kv.key] = extractAnyValue(kv.value);
    }
    return obj;
  }
  if (v.arrayValue?.values) {
    return v.arrayValue.values.map(extractAnyValue);
  }
  return undefined;
}

function nanoToIso(nanos: string | undefined): string | undefined {
  if (!nanos) return undefined;
  const ms = Math.floor(Number(BigInt(nanos) / BigInt(1_000_000)));
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

// ─── Event name → event_type mapping ────────────────────────────────────

const CLAUDE_EVENT_MAP: Record<string, EventType> = {
  'claude_code.tool_result': 'tool_use',
  'claude_code.tool_use': 'tool_use',
  'claude_code.api_request': 'llm_request',
  'claude_code.api_response': 'llm_response',
  'claude_code.session_start': 'session_start',
  'claude_code.session_end': 'session_end',
  'claude_code.file_change': 'file_change',
  'claude_code.git_commit': 'git_commit',
  'claude_code.plan_step': 'plan_step',
  'claude_code.error': 'error',
  'claude_code.response': 'response',
};

const CODEX_EVENT_MAP: Record<string, EventType> = {
  'codex.tool_result': 'tool_use',
  'codex.tool_use': 'tool_use',
  'codex.api_request': 'llm_request',
  'codex.api_response': 'llm_response',
  'codex.session_start': 'session_start',
  'codex.session_end': 'session_end',
  'codex.file_change': 'file_change',
  'codex.error': 'error',
  'codex.response': 'response',
};

// ─── Log parser ─────────────────────────────────────────────────────────

function resolveServiceName(resourceAttrs: OtelKeyValue[] | undefined): string {
  const svc = getAttr(resourceAttrs, 'service.name') ?? '';
  if (svc.includes('codex') || svc === 'codex_cli_rs') return 'codex';
  if (svc.includes('claude') || svc === 'claude_code') return 'claude_code';
  return svc || 'unknown';
}

function resolveEventType(
  logRecord: OtelLogRecord,
  agentType: string,
): EventType {
  // Check event name from attributes
  const eventName = getAttr(logRecord.attributes, 'event.name')
    ?? getAttr(logRecord.attributes, 'name');

  if (eventName) {
    const map = agentType === 'codex' ? CODEX_EVENT_MAP : CLAUDE_EVENT_MAP;
    if (map[eventName]) return map[eventName];

    // Try generic suffix matching (e.g. "tool_use" from "some_prefix.tool_use")
    const suffix = eventName.split('.').pop() ?? '';
    const EVENT_TYPE_SUFFIXES: Record<string, EventType> = {
      tool_result: 'tool_use',
      tool_use: 'tool_use',
      api_request: 'llm_request',
      api_response: 'llm_response',
      session_start: 'session_start',
      session_end: 'session_end',
      file_change: 'file_change',
      git_commit: 'git_commit',
      plan_step: 'plan_step',
      error: 'error',
      response: 'response',
    };
    if (EVENT_TYPE_SUFFIXES[suffix]) return EVENT_TYPE_SUFFIXES[suffix];
  }

  // Fallback: check severity
  if (logRecord.severityText === 'ERROR') return 'error';

  return 'response'; // default
}

function parseLogRecord(
  logRecord: OtelLogRecord,
  resourceAttrs: OtelKeyValue[] | undefined,
): NormalizedIngestEvent | null {
  const agentType = resolveServiceName(resourceAttrs);

  // Session ID: prefer log attribute, then resource attribute, then body
  const bodyJson = getBodyJson(logRecord.body);
  const sessionId =
    getAttr(logRecord.attributes, 'gen_ai.session.id')
    ?? getAttr(resourceAttrs, 'session.id')
    ?? getAttr(resourceAttrs, 'gen_ai.session.id')
    ?? (bodyJson?.session_id as string | undefined);

  if (!sessionId) return null; // Cannot process without session_id

  const eventType = resolveEventType(logRecord, agentType);

  // Extract fields from attributes + body
  const toolName =
    getAttr(logRecord.attributes, 'gen_ai.tool.name')
    ?? getAttr(logRecord.attributes, 'tool.name')
    ?? (bodyJson?.tool_name as string | undefined);

  const model =
    getAttr(logRecord.attributes, 'gen_ai.request.model')
    ?? getAttr(logRecord.attributes, 'model')
    ?? (bodyJson?.model as string | undefined);

  const tokensIn =
    getAttrNumber(logRecord.attributes, 'gen_ai.usage.input_tokens')
    ?? (typeof bodyJson?.input_tokens === 'number' ? bodyJson.input_tokens : undefined)
    ?? 0;

  const tokensOut =
    getAttrNumber(logRecord.attributes, 'gen_ai.usage.output_tokens')
    ?? (typeof bodyJson?.output_tokens === 'number' ? bodyJson.output_tokens : undefined)
    ?? 0;

  const cacheReadTokens =
    getAttrNumber(logRecord.attributes, 'gen_ai.usage.cache_read_input_tokens')
    ?? (typeof bodyJson?.cache_read_tokens === 'number' ? bodyJson.cache_read_tokens : undefined)
    ?? 0;

  const cacheWriteTokens =
    getAttrNumber(logRecord.attributes, 'gen_ai.usage.cache_creation_input_tokens')
    ?? (typeof bodyJson?.cache_write_tokens === 'number' ? bodyJson.cache_write_tokens : undefined)
    ?? 0;

  const costUsd =
    getAttrNumber(logRecord.attributes, 'gen_ai.usage.cost')
    ?? (typeof bodyJson?.cost_usd === 'number' ? bodyJson.cost_usd : undefined);

  const durationMs =
    getAttrNumber(logRecord.attributes, 'gen_ai.latency')
    ?? getAttrNumber(logRecord.attributes, 'duration_ms')
    ?? (typeof bodyJson?.duration_ms === 'number' ? bodyJson.duration_ms : undefined);

  const project =
    getAttr(logRecord.attributes, 'project')
    ?? getAttr(resourceAttrs, 'project')
    ?? (bodyJson?.project as string | undefined);

  const branch =
    getAttr(logRecord.attributes, 'branch')
    ?? getAttr(resourceAttrs, 'branch')
    ?? (bodyJson?.branch as string | undefined);

  const clientTimestamp = nanoToIso(logRecord.timeUnixNano);

  // Build metadata from body JSON (minus fields we've already extracted)
  let metadata: unknown = {};
  if (bodyJson) {
    const extracted = new Set([
      'session_id', 'tool_name', 'model', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'duration_ms',
      'project', 'branch',
    ]);
    const remaining: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bodyJson)) {
      if (!extracted.has(k)) remaining[k] = v;
    }
    if (Object.keys(remaining).length > 0) metadata = remaining;
  }

  return {
    session_id: sessionId,
    agent_type: agentType,
    event_type: eventType,
    tool_name: toolName,
    status: eventType === 'error' ? 'error' : 'success',
    tokens_in: tokensIn as number,
    tokens_out: tokensOut as number,
    cache_read_tokens: cacheReadTokens as number,
    cache_write_tokens: cacheWriteTokens as number,
    model,
    cost_usd: costUsd,
    duration_ms: durationMs,
    project,
    branch,
    client_timestamp: clientTimestamp,
    metadata,
    source: 'otel',
  };
}

export function parseOtelLogs(payload: OtelLogsPayload): NormalizedIngestEvent[] {
  const events: NormalizedIngestEvent[] = [];

  if (!payload.resourceLogs) return events;

  for (const rl of payload.resourceLogs) {
    const resourceAttrs = rl.resource?.attributes;
    if (!rl.scopeLogs) continue;

    for (const sl of rl.scopeLogs) {
      if (!sl.logRecords) continue;

      for (const lr of sl.logRecords) {
        const event = parseLogRecord(lr, resourceAttrs);
        if (event) events.push(event);
      }
    }
  }

  return events;
}

// ─── Metric parser with cumulative-to-delta ─────────────────────────────

// In-memory store for cumulative-to-delta conversion.
// Keyed by `service|metricName|model|type` → last seen value.
const cumulativeState = new Map<string, number>();

export interface ParsedMetricDelta {
  session_id: string;
  agent_type: string;
  model?: string;
  tokens_in_delta: number;
  tokens_out_delta: number;
  cache_read_delta: number;
  cache_write_delta: number;
  cost_usd_delta: number;
}

function getDataPointValue(dp: OtelNumberDataPoint): number {
  if (dp.asDouble !== undefined) return dp.asDouble;
  if (dp.asInt !== undefined) {
    return typeof dp.asInt === 'number' ? dp.asInt : parseInt(dp.asInt, 10);
  }
  return 0;
}

function computeDelta(key: string, currentValue: number): number {
  const lastValue = cumulativeState.get(key);
  cumulativeState.set(key, currentValue);

  if (lastValue === undefined) {
    // First time seeing this metric — treat current value as the delta
    return currentValue;
  }

  const delta = currentValue - lastValue;
  // Skip if delta <= 0 (counter reset or no change)
  return delta > 0 ? delta : 0;
}

const TOKEN_METRICS = new Set([
  'claude_code.token.usage',
  'codex_cli_rs.token.usage',
  'gen_ai.client.token.usage',
]);

const COST_METRICS = new Set([
  'claude_code.cost.usage',
  'codex_cli_rs.cost.usage',
  'gen_ai.client.cost.usage',
]);

export function parseOtelMetrics(payload: OtelMetricsPayload): ParsedMetricDelta[] {
  const results: ParsedMetricDelta[] = [];

  if (!payload.resourceMetrics) return results;

  for (const rm of payload.resourceMetrics) {
    const resourceAttrs = rm.resource?.attributes;
    const agentType = resolveServiceName(resourceAttrs);
    const sessionId =
      getAttr(resourceAttrs, 'gen_ai.session.id')
      ?? getAttr(resourceAttrs, 'session.id')
      ?? 'unknown';

    if (!rm.scopeMetrics) continue;

    for (const sm of rm.scopeMetrics) {
      if (!sm.metrics) continue;

      for (const metric of sm.metrics) {
        const metricName = metric.name ?? '';
        const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        const isCumulative = metric.sum?.aggregationTemporality === 2;

        for (const dp of dataPoints) {
          const rawValue = getDataPointValue(dp);
          const model = getAttr(dp.attributes, 'model')
            ?? getAttr(dp.attributes, 'gen_ai.request.model')
            ?? getAttr(resourceAttrs, 'model');
          const tokenType = getAttr(dp.attributes, 'type')
            ?? getAttr(dp.attributes, 'token.type');

          const cacheKey = `${sessionId}|${agentType}|${metricName}|${model ?? ''}|${tokenType ?? ''}`;
          const delta = isCumulative ? computeDelta(cacheKey, rawValue) : rawValue;

          if (delta <= 0) continue;

          if (TOKEN_METRICS.has(metricName)) {
            const entry: ParsedMetricDelta = {
              session_id: sessionId,
              agent_type: agentType,
              model: model ?? undefined,
              tokens_in_delta: 0,
              tokens_out_delta: 0,
              cache_read_delta: 0,
              cache_write_delta: 0,
              cost_usd_delta: 0,
            };

            switch (tokenType) {
              case 'input':
                entry.tokens_in_delta = delta;
                break;
              case 'output':
                entry.tokens_out_delta = delta;
                break;
              case 'cacheRead':
              case 'cache_read':
                entry.cache_read_delta = delta;
                break;
              case 'cacheCreation':
              case 'cache_creation':
              case 'cache_write':
                entry.cache_write_delta = delta;
                break;
              default:
                // Unknown token type — default to input
                entry.tokens_in_delta = delta;
            }

            results.push(entry);
          } else if (COST_METRICS.has(metricName)) {
            results.push({
              session_id: sessionId,
              agent_type: agentType,
              model: model ?? undefined,
              tokens_in_delta: 0,
              tokens_out_delta: 0,
              cache_read_delta: 0,
              cache_write_delta: 0,
              cost_usd_delta: delta,
            });
          }
        }
      }
    }
  }

  return results;
}

// Exposed for testing — reset cumulative state
export function resetCumulativeState(): void {
  cumulativeState.clear();
}
