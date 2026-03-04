/**
 * Side-by-side benchmark comparison of TypeScript and Rust AgentMonitor backends.
 *
 * Measures:
 *   - Ingest throughput (events/s) and latency (p50, p95, p99)
 *   - Startup time (cold start to first /api/health 200)
 *   - Memory footprint (idle RSS after startup, peak RSS under load)
 *   - Binary / runtime size
 *
 * Usage:
 *   tsx scripts/bench/compare-ts-vs-rust.ts [--events=20000] [--concurrency=40] [--batch-size=50] [--soak-minutes=0]
 *
 * Both servers must be stopped before running this script — it manages their lifecycles.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --------------- CLI arg parsing ---------------

function parseArg(name: string, fallback: number): number {
  const match = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!match) return fallback;
  const n = Number(match.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EVENTS = parseArg('events', 20000);
const CONCURRENCY = parseArg('concurrency', 40);
const BATCH_SIZE = parseArg('batch-size', 50);
const SOAK_MINUTES = parseArg('soak-minutes', 0);
const WARMUP = parseArg('warmup', 500);

const PROJECT_ROOT = path.resolve(import.meta.dirname!, '..', '..');
const TS_PORT = 3141;
const RUST_PORT = 3142;

// --------------- Types ---------------

interface RuntimeMetrics {
  name: string;
  startupMs: number;
  idleRssKb: number;
  peakRssKb: number;
  throughputEventsPerSec: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  failedRequests: number;
  runtimeSizeMb: number;
  soakStable: boolean | null;
  soakRssSamples: number[];
}

interface BenchResult {
  sentEvents: number;
  receivedEvents: number;
  duplicates: number;
  rejected: number;
  failedRequests: number;
  latencyMs: number[];
  durationMs: number;
}

// --------------- Utilities ---------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function getRssKb(pid: number): number {
  try {
    // macOS ps reports RSS in kilobytes
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8' }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function waitForHealth(port: number, timeoutMs: number = 15000, childPid?: number): Promise<number> {
  const start = performance.now();
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    if (attempts % 20 === 0 && childPid) {
      // Check if child is still alive
      try { process.kill(childPid, 0); } catch {
        throw new Error(`Child process ${childPid} died before becoming healthy (after ${attempts} attempts)`);
      }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return performance.now() - start;
    } catch { /* not ready yet */ }
    await sleep(50);
  }
  throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs}ms (${attempts} attempts)`);
}

function ensurePortFree(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim();
    if (pids) {
      throw new Error(`Port ${port} is in use (PIDs: ${pids}). Stop existing servers first.`);
    }
  } catch (e: unknown) {
    // lsof exits non-zero when no process found — that's fine
    if (e instanceof Error && 'status' in e) return;
    throw e;
  }
}

// --------------- Server lifecycle ---------------

function startTsServer(): ChildProcess {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bench-ts-'));
  const dbPath = path.join(tmpDir, 'bench.db');
  const child = spawn('/bin/sh', ['-c', 'exec node --import tsx src/server.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      AGENTMONITOR_DB_PATH: dbPath,
      AGENTMONITOR_HOST: '127.0.0.1',
      AGENTMONITOR_PORT: String(TS_PORT),
      AGENTMONITOR_MAX_SSE_CLIENTS: '100',
      AGENTMONITOR_AUTO_IMPORT: '0',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stderr.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  return child;
}

function startRustServer(): ChildProcess {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bench-rust-'));
  const dbPath = path.join(tmpDir, 'bench.db');
  // Run the pre-built release binary directly
  const binaryPath = path.join(PROJECT_ROOT, 'rust-backend', 'target', 'release', 'agentmonitor-rs');
  const child = spawn(binaryPath, [], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      AGENTMONITOR_DB_PATH: dbPath,
      AGENTMONITOR_HOST: '127.0.0.1',
      AGENTMONITOR_PORT: String(RUST_PORT),
      AGENTMONITOR_MAX_SSE_CLIENTS: '100',
      PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  child.stdout?.on('data', (d: Buffer) => process.stderr.write(d));
  return child;
}

function stopServer(child: ChildProcess): void {
  if (child.pid && !child.killed) {
    child.kill('SIGTERM');
  }
}

// --------------- Benchmark runner ---------------

interface BenchEventPayload {
  event_id: string;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  project: string;
  branch: string;
  duration_ms: number;
  client_timestamp: string;
  metadata: { source: string; index: number };
}

function buildEvent(index: number): BenchEventPayload {
  return {
    event_id: `bench-${index}-${Math.random().toString(36).slice(2, 10)}`,
    session_id: `bench-session-${index % 100}`,
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'benchmark',
    status: 'success',
    tokens_in: 10 + (index % 25),
    tokens_out: 50 + (index % 150),
    project: 'bench-project',
    branch: 'bench/main',
    duration_ms: 15 + (index % 120),
    client_timestamp: new Date().toISOString(),
    metadata: { source: 'benchmark', index },
  };
}

async function runBench(port: number, totalEvents: number, warmup: number): Promise<BenchResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const endpoint = `${baseUrl}/api/events/batch`;

  // Warmup
  if (warmup > 0) {
    await runBatchIngest(endpoint, warmup, false);
  }

  // Measured run
  return runBatchIngest(endpoint, totalEvents, true);
}

async function runBatchIngest(endpoint: string, totalEvents: number, measure: boolean): Promise<BenchResult> {
  const result: BenchResult = {
    sentEvents: 0, receivedEvents: 0, duplicates: 0,
    rejected: 0, failedRequests: 0, latencyMs: [], durationMs: 0,
  };

  const requestCount = Math.ceil(totalEvents / BATCH_SIZE);
  let nextRequest = 0;
  let nextEvent = 0;
  const startedAt = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const reqIdx = nextRequest;
      if (reqIdx >= requestCount) return;
      nextRequest += 1;

      const remaining = totalEvents - reqIdx * BATCH_SIZE;
      const count = Math.min(BATCH_SIZE, remaining);
      const events: BenchEventPayload[] = [];
      for (let i = 0; i < count; i++) {
        events.push(buildEvent(nextEvent));
        nextEvent += 1;
      }

      const t0 = performance.now();
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
        });
        const elapsed = performance.now() - t0;
        if (measure) result.latencyMs.push(elapsed);
        result.sentEvents += count;

        if (!res.ok) { result.failedRequests += 1; continue; }
        const body = await res.json() as { received?: number; duplicates?: number; rejected?: unknown[] };
        result.receivedEvents += body.received ?? 0;
        result.duplicates += body.duplicates ?? 0;
        result.rejected += Array.isArray(body.rejected) ? body.rejected.length : 0;
      } catch {
        result.failedRequests += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  result.durationMs = performance.now() - startedAt;
  return result;
}

// --------------- Soak test ---------------

async function runSoak(port: number, minutes: number, pid: number): Promise<{ stable: boolean; samples: number[] }> {
  if (minutes <= 0) return { stable: true, samples: [] };

  const samples: number[] = [];
  const intervalMs = 10_000; // sample every 10s
  const totalMs = minutes * 60 * 1000;
  const endpoint = `http://127.0.0.1:${port}/api/events/batch`;

  console.log(`  Soak: ${minutes}min with continuous ingest + RSS sampling...`);
  const deadline = Date.now() + totalMs;
  let eventIndex = 0;

  // Background ingest
  const soakController = new AbortController();
  const ingestLoop = (async () => {
    while (!soakController.signal.aborted && Date.now() < deadline) {
      const events = Array.from({ length: 10 }, () => buildEvent(eventIndex++));
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
          signal: soakController.signal,
        });
      } catch { /* abort or network error */ }
      await sleep(100);
    }
  })();

  // RSS sampling
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const rss = getRssKb(pid);
    if (rss > 0) samples.push(rss);
  }

  soakController.abort();
  await ingestLoop.catch(() => {});

  // Stability check: RSS should not grow more than 50% from first to last quarter
  if (samples.length < 4) return { stable: true, samples };
  const quarter = Math.floor(samples.length / 4);
  const firstQ = samples.slice(0, quarter);
  const lastQ = samples.slice(-quarter);
  const avgFirst = firstQ.reduce((a, b) => a + b, 0) / firstQ.length;
  const avgLast = lastQ.reduce((a, b) => a + b, 0) / lastQ.length;
  const growth = avgLast / avgFirst;
  const stable = growth < 1.5;
  if (!stable) {
    console.log(`  WARNING: RSS grew ${((growth - 1) * 100).toFixed(1)}% during soak (first avg: ${Math.round(avgFirst)}KB, last avg: ${Math.round(avgLast)}KB)`);
  }

  return { stable, samples };
}

// --------------- Size measurement ---------------

function measureTsSize(): number {
  try {
    const out = execSync(`du -sm node_modules`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    return Number(out.split('\t')[0]) || 0;
  } catch { return 0; }
}

function measureRustSize(): number {
  const binary = path.join(PROJECT_ROOT, 'rust-backend/target/release/agentmonitor-rs');
  try {
    const stat = fs.statSync(binary);
    return Math.round(stat.size / 1024 / 1024 * 10) / 10;
  } catch { return 0; }
}

// --------------- Main ---------------

async function benchmarkRuntime(
  name: string,
  startFn: () => ChildProcess,
  port: number,
  sizeFn: () => number,
): Promise<RuntimeMetrics> {
  console.log(`\n=== ${name} ===`);

  ensurePortFree(port);
  const child = startFn();
  let peakRss: number;

  try {
    // Measure startup time
    console.log('  Starting server...');
    const startupMs = await waitForHealth(port, 60000, child.pid);
    console.log(`  Startup: ${startupMs.toFixed(0)}ms`);

    await sleep(500); // let process settle
    const pid = child.pid!;
    const idleRssKb = getRssKb(pid);
    console.log(`  Idle RSS: ${(idleRssKb / 1024).toFixed(1)}MB`);

    // Run benchmark
    console.log(`  Running benchmark: ${EVENTS} events, concurrency=${CONCURRENCY}, batch=${BATCH_SIZE}...`);
    const bench = await runBench(port, EVENTS, WARMUP);
    peakRss = getRssKb(pid);

    const elapsedSec = bench.durationMs / 1000;
    const throughput = bench.sentEvents / elapsedSec;
    console.log(`  Throughput: ${throughput.toFixed(0)} events/s`);
    console.log(`  Latency p50=${percentile(bench.latencyMs, 50).toFixed(1)}ms p95=${percentile(bench.latencyMs, 95).toFixed(1)}ms p99=${percentile(bench.latencyMs, 99).toFixed(1)}ms`);
    console.log(`  Peak RSS: ${(peakRss / 1024).toFixed(1)}MB`);
    console.log(`  Failed requests: ${bench.failedRequests}`);

    // Soak test
    let soakResult = { stable: true as boolean | null, samples: [] as number[] };
    if (SOAK_MINUTES > 0) {
      const soak = await runSoak(port, SOAK_MINUTES, pid);
      soakResult = soak;
    }

    const runtimeSizeMb = sizeFn();
    console.log(`  Runtime size: ${runtimeSizeMb}MB`);

    return {
      name,
      startupMs,
      idleRssKb,
      peakRssKb: peakRss,
      throughputEventsPerSec: throughput,
      latencyP50Ms: percentile(bench.latencyMs, 50),
      latencyP95Ms: percentile(bench.latencyMs, 95),
      latencyP99Ms: percentile(bench.latencyMs, 99),
      failedRequests: bench.failedRequests,
      runtimeSizeMb,
      soakStable: SOAK_MINUTES > 0 ? soakResult.stable : null,
      soakRssSamples: soakResult.samples,
    };
  } finally {
    stopServer(child);
    await sleep(500);
  }
}

function printComparison(ts: RuntimeMetrics, rust: RuntimeMetrics): void {
  const delta = (a: number, b: number) => {
    if (a === 0) return 'N/A';
    const pct = ((b - a) / a * 100);
    return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };

  console.log('\n================================================');
  console.log('  BENCHMARK COMPARISON: TypeScript vs Rust');
  console.log('================================================\n');

  const rows = [
    ['Metric', 'TypeScript', 'Rust', 'Delta'],
    ['---', '---', '---', '---'],
    ['Startup (ms)', ts.startupMs.toFixed(0), rust.startupMs.toFixed(0), delta(ts.startupMs, rust.startupMs)],
    ['Idle RSS (MB)', (ts.idleRssKb / 1024).toFixed(1), (rust.idleRssKb / 1024).toFixed(1), delta(ts.idleRssKb, rust.idleRssKb)],
    ['Peak RSS (MB)', (ts.peakRssKb / 1024).toFixed(1), (rust.peakRssKb / 1024).toFixed(1), delta(ts.peakRssKb, rust.peakRssKb)],
    ['Throughput (events/s)', ts.throughputEventsPerSec.toFixed(0), rust.throughputEventsPerSec.toFixed(0), delta(ts.throughputEventsPerSec, rust.throughputEventsPerSec)],
    ['Latency p50 (ms)', ts.latencyP50Ms.toFixed(1), rust.latencyP50Ms.toFixed(1), delta(ts.latencyP50Ms, rust.latencyP50Ms)],
    ['Latency p95 (ms)', ts.latencyP95Ms.toFixed(1), rust.latencyP95Ms.toFixed(1), delta(ts.latencyP95Ms, rust.latencyP95Ms)],
    ['Latency p99 (ms)', ts.latencyP99Ms.toFixed(1), rust.latencyP99Ms.toFixed(1), delta(ts.latencyP99Ms, rust.latencyP99Ms)],
    ['Failed requests', String(ts.failedRequests), String(rust.failedRequests), ''],
    ['Runtime size (MB)', String(ts.runtimeSizeMb), String(rust.runtimeSizeMb), delta(ts.runtimeSizeMb, rust.runtimeSizeMb)],
  ];

  if (ts.soakStable !== null) {
    rows.push(['Soak stable', ts.soakStable ? 'YES' : 'NO', rust.soakStable ? 'YES' : 'NO', '']);
  }

  // Print table
  const colWidths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(colWidths[i])).join('  '));
  }

  console.log('');
}

function writeJsonArtifact(ts: RuntimeMetrics, rust: RuntimeMetrics): void {
  const artifact = {
    timestamp: new Date().toISOString(),
    config: { events: EVENTS, concurrency: CONCURRENCY, batchSize: BATCH_SIZE, warmup: WARMUP, soakMinutes: SOAK_MINUTES },
    platform: { os: os.platform(), arch: os.arch(), cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1024 / 1024) },
    typescript: ts,
    rust,
  };
  const outPath = path.join(PROJECT_ROOT, 'docs', 'plans', 'benchmark-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`JSON artifact written to ${outPath}`);
}

async function main(): Promise<void> {
  console.log('AgentMonitor Benchmark Comparison');
  console.log(`Events: ${EVENTS}  Concurrency: ${CONCURRENCY}  Batch: ${BATCH_SIZE}  Warmup: ${WARMUP}  Soak: ${SOAK_MINUTES}min`);
  console.log(`Platform: ${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 1024 / 1024)}MB RAM`);

  // Build Rust release binary first
  console.log('\nBuilding Rust release binary...');
  execSync(`${process.env.HOME}/.cargo/bin/cargo build --manifest-path rust-backend/Cargo.toml --release`, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });

  // Kill any existing servers on these ports
  for (const port of [TS_PORT, RUST_PORT]) {
    try { execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' }); } catch { /* fine */ }
  }
  await sleep(500);

  const tsMetrics = await benchmarkRuntime('TypeScript (Node.js)', startTsServer, TS_PORT, measureTsSize);
  await sleep(1000);
  const rustMetrics = await benchmarkRuntime('Rust (axum + tokio)', startRustServer, RUST_PORT, measureRustSize);

  printComparison(tsMetrics, rustMetrics);
  writeJsonArtifact(tsMetrics, rustMetrics);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
