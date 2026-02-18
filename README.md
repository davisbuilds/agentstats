# AgentStats

Real-time localhost dashboard for monitoring AI agent activity across sessions, tools, and projects.

## Stack

- Node.js + TypeScript + Express
- SQLite (`better-sqlite3`)
- Vanilla JS frontend + Tailwind CSS
- SSE for live updates

## Quick Start

Requirements:
- Node.js 20+
- `pnpm` 10+

Install dependencies:

```bash
pnpm install
```

Run in development:

```bash
# terminal 1
pnpm dev

# terminal 2 (for live css rebuilds)
pnpm run css:watch
```

Open `http://127.0.0.1:3141`.

## Useful Scripts

- `pnpm dev`: run server in watch mode (`tsx watch`).
- `pnpm run css:build`: one-off Tailwind build to `public/css/output.css`.
- `pnpm run css:watch`: Tailwind watch mode.
- `pnpm run build`: TypeScript build + CSS build.
- `pnpm run test`: run contract + API tests.
- `pnpm run test:watch`: watch-mode test runner.
- `pnpm start`: run compiled server from `dist/`.
- `pnpm run seed`: send demo events to the running server.
- `pnpm run bench:ingest`: run ingest throughput benchmark.

## Configuration

Environment variables (all optional):

- `AGENTSTATS_PORT` (default: `3141`)
- `AGENTSTATS_HOST` (default: `127.0.0.1`)
- `AGENTSTATS_DB_PATH` (default: `./data/agentstats.db`)
- `AGENTSTATS_MAX_PAYLOAD_KB` (default: `10`)
- `AGENTSTATS_SESSION_TIMEOUT` (default: `30`)
- `AGENTSTATS_MAX_FEED` (default: `200`)
- `AGENTSTATS_STATS_INTERVAL` (default: `5000`)
- `AGENTSTATS_MAX_SSE_CLIENTS` (default: `50`)
- `AGENTSTATS_SSE_HEARTBEAT_MS` (default: `30000`)

Seed script target override:

- `AGENTSTATS_URL` (default: `http://127.0.0.1:3141`)

Benchmark script environment overrides:

- `AGENTSTATS_BENCH_URL` (default: `http://127.0.0.1:3141`)
- `AGENTSTATS_BENCH_MODE` (`batch` or `single`, default: `batch`)
- `AGENTSTATS_BENCH_EVENTS` (default: `10000`)
- `AGENTSTATS_BENCH_WARMUP_EVENTS` (default: `250`)
- `AGENTSTATS_BENCH_CONCURRENCY` (default: `20`)
- `AGENTSTATS_BENCH_BATCH_SIZE` (default: `25`, ignored in `single` mode)
- `AGENTSTATS_BENCH_SESSION_CARDINALITY` (default: `100`)
- `AGENTSTATS_BENCH_DUPLICATE_RATE` (default: `0`)
- `AGENTSTATS_BENCH_TIMEOUT_MS` (default: `15000`)

Example benchmark command:

```bash
pnpm run bench:ingest -- --events=20000 --concurrency=40 --batch-size=50
```

## API Summary

- `POST /api/events`: ingest one event.
- `POST /api/events/batch`: ingest many events.
- `GET /api/events`: query events with filters.
- `GET /api/stats`: aggregate counters and breakdowns.
- `GET /api/sessions`: list sessions.
- `GET /api/sessions/:id`: session detail + recent events.
- `GET /api/stream`: SSE stream (`event`, `stats`, `session_update`), returns `503` when max client limit is reached.
- `GET /api/health`: basic service health.

Required fields for ingest payloads: `session_id`, `agent_type`, `event_type`.

Canonical event contract: `docs/event-contract.md`.

Batch ingest response includes:
- `received`
- `ids`
- `duplicates`
- `rejected` (with source index + validation errors)

Timestamp and truncation notes:
- `created_at` is server receive timestamp.
- `client_timestamp` is optional client-supplied timestamp.
- `payload_truncated` is `1` when metadata exceeded byte cap.

Example event:

```json
{
  "event_id": "b968f88c-bf3d-48ea-9f65-59db7e0fd035",
  "session_id": "claude-session-001",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "Bash",
  "status": "success",
  "tokens_in": 120,
  "tokens_out": 640,
  "client_timestamp": "2026-02-18T18:06:41.231Z",
  "branch": "feature/auth",
  "project": "myapp",
  "duration_ms": 950,
  "metadata": {
    "command": "npm test"
  }
}
```

## Repo Notes

- Agent-focused workflow instructions live in `AGENTS.md`.
- `CLAUDE.md` is a symlink to `AGENTS.md`.
