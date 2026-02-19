import { performance } from 'node:perf_hooks';

type Mode = 'single' | 'batch';

interface Options {
  baseUrl: string;
  mode: Mode;
  totalEvents: number;
  warmupEvents: number;
  concurrency: number;
  batchSize: number;
  sessionCardinality: number;
  duplicateRate: number;
  timeoutMs: number;
  agentType: string;
  eventType: string;
  toolName: string;
  project: string;
  branch: string;
}

interface Stats {
  sentEvents: number;
  receivedEvents: number;
  duplicates: number;
  rejected: number;
  failedRequests: number;
  latencyMs: number[];
}

interface BenchEventPayload {
  event_id: string;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name: string;
  status: 'success';
  tokens_in: number;
  tokens_out: number;
  project: string;
  branch: string;
  duration_ms: number;
  client_timestamp: string;
  metadata: {
    source: 'benchmark';
    index: number;
  };
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseInteger(value: string | undefined, fallback: number, min: number = 0): number {
  const parsed = Math.trunc(parseNumber(value, fallback));
  if (parsed < min) return fallback;
  return parsed;
}

function parseMode(value: string | undefined): Mode {
  if (value === 'single' || value === 'batch') return value;
  return 'batch';
}

function parseArgMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue] = arg.slice(2).split('=', 2);
    if (!key || rawValue === undefined) continue;
    map.set(key, rawValue);
  }
  return map;
}

function getOptions(): Options {
  const args = parseArgMap();
  const mode = parseMode(args.get('mode') ?? process.env.AGENTSTATS_BENCH_MODE);
  const totalEvents = parseInteger(
    args.get('events') ?? process.env.AGENTSTATS_BENCH_EVENTS,
    10000,
    1
  );
  const warmupEvents = parseInteger(
    args.get('warmup') ?? process.env.AGENTSTATS_BENCH_WARMUP_EVENTS,
    250,
    0
  );
  const concurrency = parseInteger(
    args.get('concurrency') ?? process.env.AGENTSTATS_BENCH_CONCURRENCY,
    20,
    1
  );
  const configuredBatch = parseInteger(
    args.get('batch-size') ?? process.env.AGENTSTATS_BENCH_BATCH_SIZE,
    25,
    1
  );
  const batchSize = mode === 'single' ? 1 : configuredBatch;
  const sessionCardinality = parseInteger(
    args.get('sessions') ?? process.env.AGENTSTATS_BENCH_SESSION_CARDINALITY,
    100,
    1
  );
  const timeoutMs = parseInteger(
    args.get('timeout-ms') ?? process.env.AGENTSTATS_BENCH_TIMEOUT_MS,
    15000,
    100
  );
  const duplicateRateRaw = parseNumber(
    args.get('duplicate-rate') ?? process.env.AGENTSTATS_BENCH_DUPLICATE_RATE,
    0
  );
  const duplicateRate = Math.max(0, Math.min(duplicateRateRaw, 0.95));

  return {
    baseUrl: (args.get('url') ?? process.env.AGENTSTATS_BENCH_URL ?? 'http://127.0.0.1:3141').replace(/\/$/, ''),
    mode,
    totalEvents,
    warmupEvents,
    concurrency,
    batchSize,
    sessionCardinality,
    duplicateRate,
    timeoutMs,
    agentType: args.get('agent-type') ?? process.env.AGENTSTATS_BENCH_AGENT_TYPE ?? 'benchmark_agent',
    eventType: args.get('event-type') ?? process.env.AGENTSTATS_BENCH_EVENT_TYPE ?? 'tool_use',
    toolName: args.get('tool-name') ?? process.env.AGENTSTATS_BENCH_TOOL_NAME ?? 'benchmark',
    project: args.get('project') ?? process.env.AGENTSTATS_BENCH_PROJECT ?? 'bench-project',
    branch: args.get('branch') ?? process.env.AGENTSTATS_BENCH_BRANCH ?? 'bench/main',
  };
}

function buildEvent(
  index: number,
  options: Options,
  previousEventId: string | null
): { event: BenchEventPayload; generatedEventId: string } {
  const duplicate = previousEventId !== null && Math.random() < options.duplicateRate;
  const generatedEventId = duplicate ? previousEventId : `bench-${index}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    generatedEventId,
    event: {
      event_id: generatedEventId,
      session_id: `bench-session-${index % options.sessionCardinality}`,
      agent_type: options.agentType,
      event_type: options.eventType,
      tool_name: options.toolName,
      status: 'success',
      tokens_in: 10 + (index % 25),
      tokens_out: 50 + (index % 150),
      project: options.project,
      branch: options.branch,
      duration_ms: 15 + (index % 120),
      client_timestamp: new Date().toISOString(),
      metadata: {
        source: 'benchmark',
        index,
      },
    },
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function ensureServerAvailable(baseUrl: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`health check returned ${res.status}`);
    }
  } catch (cause) {
    throw new Error(`Cannot reach ${baseUrl}. Ensure AgentStats is running.`, { cause });
  } finally {
    clearTimeout(timeout);
  }
}

async function runStage(
  stageName: string,
  stageEvents: number,
  options: Options,
  measureLatency: boolean
): Promise<{ stats: Stats; durationMs: number }> {
  const stats: Stats = {
    sentEvents: 0,
    receivedEvents: 0,
    duplicates: 0,
    rejected: 0,
    failedRequests: 0,
    latencyMs: [],
  };

  if (stageEvents === 0) {
    return { stats, durationMs: 0 };
  }

  const requestCount = Math.ceil(stageEvents / options.batchSize);
  let nextRequestIndex = 0;
  let nextEventIndex = 0;
  let lastEventId: string | null = null;
  const endpoint =
    options.mode === 'single' ? `${options.baseUrl}/api/events` : `${options.baseUrl}/api/events/batch`;

  const startedAt = performance.now();
  const progressTicker = setInterval(() => {
    const processed = nextRequestIndex;
    const pct = Math.min(100, (processed / requestCount) * 100);
    process.stdout.write(`\r${stageName}: ${processed}/${requestCount} requests (${pct.toFixed(1)}%)`);
  }, 400);

  async function worker(): Promise<void> {
    while (true) {
      const requestIndex = nextRequestIndex;
      if (requestIndex >= requestCount) return;
      nextRequestIndex += 1;

      const remaining = stageEvents - requestIndex * options.batchSize;
      const count = Math.min(options.batchSize, remaining);
      const events: BenchEventPayload[] = [];

      for (let i = 0; i < count; i += 1) {
        const { event, generatedEventId } = buildEvent(nextEventIndex, options, lastEventId);
        lastEventId = generatedEventId;
        events.push(event);
        nextEventIndex += 1;
      }

      const payload = options.mode === 'single' ? events[0] : { events };
      const requestStartedAt = performance.now();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const elapsed = performance.now() - requestStartedAt;
        if (measureLatency) stats.latencyMs.push(elapsed);
        stats.sentEvents += count;

        if (!res.ok) {
          stats.failedRequests += 1;
          continue;
        }

        const body = await res.json() as {
          received?: number;
          duplicates?: number;
          rejected?: unknown[];
        };
        stats.receivedEvents += body.received ?? 0;
        stats.duplicates += body.duplicates ?? 0;
        stats.rejected += Array.isArray(body.rejected) ? body.rejected.length : 0;
      } catch {
        stats.failedRequests += 1;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  const workers = Array.from({ length: options.concurrency }, () => worker());
  await Promise.all(workers);

  clearInterval(progressTicker);
  const durationMs = performance.now() - startedAt;
  process.stdout.write(`\r${stageName}: ${requestCount}/${requestCount} requests (100.0%)\n`);

  return { stats, durationMs };
}

function printConfig(options: Options): void {
  console.log('AgentStats Ingest Benchmark');
  console.log('--------------------------');
  console.log(`Target URL:      ${options.baseUrl}`);
  console.log(`Mode:            ${options.mode}`);
  console.log(`Events:          ${options.totalEvents}`);
  console.log(`Warmup Events:   ${options.warmupEvents}`);
  console.log(`Concurrency:     ${options.concurrency}`);
  console.log(`Batch Size:      ${options.batchSize}`);
  console.log(`Session Spread:  ${options.sessionCardinality}`);
  console.log(`Duplicate Rate:  ${(options.duplicateRate * 100).toFixed(2)}%`);
  console.log(`Timeout (ms):    ${options.timeoutMs}`);
  console.log('');
}

function printSummary(
  options: Options,
  stats: Stats,
  durationMs: number
): void {
  const elapsedSeconds = durationMs / 1000;
  const requests = options.mode === 'single'
    ? stats.sentEvents
    : Math.ceil(stats.sentEvents / options.batchSize);
  const sentPerSecond = elapsedSeconds > 0 ? stats.sentEvents / elapsedSeconds : 0;
  const receivedPerSecond = elapsedSeconds > 0 ? stats.receivedEvents / elapsedSeconds : 0;
  const dropped = stats.duplicates + stats.rejected;

  console.log('\nBenchmark Summary');
  console.log('-----------------');
  console.log(`Elapsed:               ${elapsedSeconds.toFixed(2)}s`);
  console.log(`Requests Sent:         ${requests}`);
  console.log(`Events Sent:           ${stats.sentEvents}`);
  console.log(`Events Received:       ${stats.receivedEvents}`);
  console.log(`Events Dropped:        ${dropped} (duplicates=${stats.duplicates}, rejected=${stats.rejected})`);
  console.log(`Failed Requests:       ${stats.failedRequests}`);
  console.log(`Throughput Sent:       ${sentPerSecond.toFixed(2)} events/s`);
  console.log(`Throughput Received:   ${receivedPerSecond.toFixed(2)} events/s`);
  console.log(`Latency p50:           ${percentile(stats.latencyMs, 50).toFixed(2)} ms`);
  console.log(`Latency p95:           ${percentile(stats.latencyMs, 95).toFixed(2)} ms`);
  console.log(`Latency p99:           ${percentile(stats.latencyMs, 99).toFixed(2)} ms`);
}

async function main(): Promise<void> {
  const options = getOptions();
  printConfig(options);
  await ensureServerAvailable(options.baseUrl, options.timeoutMs);

  if (options.warmupEvents > 0) {
    const warmup = await runStage('Warmup', options.warmupEvents, options, false);
    console.log(`Warmup complete in ${(warmup.durationMs / 1000).toFixed(2)}s\n`);
  }

  const run = await runStage('Benchmark', options.totalEvents, options, true);
  printSummary(options, run.stats, run.durationMs);
}

main().catch(err => {
  console.error(String(err));
  process.exitCode = 1;
});
