// Seed script - generate realistic multi-agent events for development/demo
const BASE_URL = process.env.AGENTSTATS_URL || 'http://127.0.0.1:3141';

interface EventPayload {
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name?: string;
  status?: string;
  tokens_in?: number;
  tokens_out?: number;
  branch?: string;
  project?: string;
  duration_ms?: number;
  model?: string;
  cost_usd?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  metadata?: Record<string, unknown>;
}

const CLAUDE_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101',
];

const CODEX_MODELS = [
  'o3-mini',
  'gpt-4.1',
  'codex-mini-latest',
];

// Simplified pricing (per million tokens) for seed cost estimation
const SEED_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-opus-4-5-20251101': { input: 5, output: 25 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'codex-mini-latest': { input: 1.5, output: 6 },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = SEED_PRICING[model];
  if (!pricing) return 0;
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

async function postEvent(event: EventPayload) {
  const res = await fetch(`${BASE_URL}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    console.error(`Failed to post event: ${res.status} ${await res.text()}`);
  }
  return res;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Simulated agent sessions
const sessions = [
  {
    id: 'claude-session-001',
    agent_type: 'claude_code',
    project: 'myapp',
    branch: 'feature/auth',
    models: CLAUDE_MODELS,
    tools: [
      { name: 'Read', meta: { file_path: 'src/auth/login.ts' } },
      { name: 'Grep', meta: { pattern: 'handleAuth', query: 'handleAuth' } },
      { name: 'Edit', meta: { file_path: 'src/auth/login.ts' } },
      { name: 'Bash', meta: { command: 'npm test' } },
      { name: 'Read', meta: { file_path: 'src/auth/middleware.ts' } },
      { name: 'Write', meta: { file_path: 'src/auth/session.ts' } },
      { name: 'Glob', meta: { pattern: 'src/**/*.test.ts' } },
      { name: 'Bash', meta: { command: 'npm run lint' } },
      { name: 'Edit', meta: { file_path: 'src/auth/middleware.ts' } },
      { name: 'Bash', meta: { command: 'npm test -- --watch' } },
    ],
  },
  {
    id: 'claude-session-002',
    agent_type: 'claude_code',
    project: 'api-server',
    branch: 'main',
    models: CLAUDE_MODELS,
    tools: [
      { name: 'Read', meta: { file_path: 'src/routes/users.ts' } },
      { name: 'Bash', meta: { command: 'npm run build' } },
      { name: 'Grep', meta: { pattern: 'export.*Router', query: 'export Router' } },
      { name: 'Edit', meta: { file_path: 'src/routes/users.ts' } },
      { name: 'Read', meta: { file_path: 'src/db/schema.ts' } },
      { name: 'Bash', meta: { command: 'npm test' } },
      { name: 'Write', meta: { file_path: 'src/routes/health.ts' } },
    ],
  },
  {
    id: 'codex-session-001',
    agent_type: 'codex',
    project: 'frontend',
    branch: 'redesign-nav',
    models: CODEX_MODELS,
    tools: [
      { name: 'command_execution', meta: { command: 'npm run dev' } },
      { name: 'file_change', meta: { file_path: 'src/components/Nav.tsx' } },
      { name: 'command_execution', meta: { command: 'npm test' } },
      { name: 'file_change', meta: { file_path: 'src/components/Sidebar.tsx' } },
      { name: 'command_execution', meta: { command: 'npm run build' } },
    ],
  },
];

async function seedSession(session: typeof sessions[0], delayBetweenEvents: number) {
  // Session start
  await postEvent({
    session_id: session.id,
    agent_type: session.agent_type,
    event_type: 'session_start',
    project: session.project,
    branch: session.branch,
    metadata: { source: 'seed' },
  });
  console.log(`  Started ${session.agent_type} session: ${session.project}/${session.branch}`);

  // Tool events
  for (const tool of session.tools) {
    await sleep(delayBetweenEvents + randomInt(0, 500));

    const isError = Math.random() < 0.05;
    const model = randomChoice(session.models);
    const tokensIn = randomInt(50, 500);
    const tokensOut = randomInt(100, 2000);
    const cacheRead = Math.random() < 0.4 ? randomInt(10, 200) : 0;
    await postEvent({
      session_id: session.id,
      agent_type: session.agent_type,
      event_type: 'tool_use',
      tool_name: tool.name,
      status: isError ? 'error' : 'success',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      branch: session.branch,
      project: session.project,
      duration_ms: randomInt(100, 5000),
      model,
      cost_usd: estimateCost(model, tokensIn, tokensOut),
      cache_read_tokens: cacheRead,
      metadata: tool.meta,
    });
    console.log(`  [${session.project}] ${tool.name}: ${JSON.stringify(tool.meta).slice(0, 60)}`);

    // Occasional response event for Codex
    if (session.agent_type === 'codex' && Math.random() < 0.5) {
      await sleep(delayBetweenEvents);
      const respModel = randomChoice(session.models);
      const respIn = randomInt(200, 1000);
      const respOut = randomInt(500, 3000);
      await postEvent({
        session_id: session.id,
        agent_type: session.agent_type,
        event_type: 'response',
        project: session.project,
        branch: session.branch,
        tokens_in: respIn,
        tokens_out: respOut,
        model: respModel,
        cost_usd: estimateCost(respModel, respIn, respOut),
        metadata: { type: 'turn_complete' },
      });
    }
  }
}

async function main() {
  console.log(`Seeding AgentStats at ${BASE_URL}...\n`);

  // Check server health
  try {
    const health = await fetch(`${BASE_URL}/api/health`);
    if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
    console.log('Server is healthy.\n');
  } catch {
    console.error(`Cannot connect to AgentStats at ${BASE_URL}. Is the server running?`);
    process.exit(1);
  }

  // Run sessions with staggered starts
  const delayBetweenEvents = 300;

  // Start all sessions concurrently with slight offsets
  await Promise.all(
    sessions.map((session, i) =>
      sleep(i * 800).then(() => seedSession(session, delayBetweenEvents))
    )
  );

  console.log('\nSeeding complete!');
  console.log(`Open http://localhost:3000 to see the dashboard.`);
}

main().catch(console.error);
