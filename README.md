# AgentMonitor

Real-time localhost dashboard + session browser for monitoring AI agent activity across sessions, tools, and projects.

## Stack

- Node.js + TypeScript + Express
- SQLite (`better-sqlite3`) with FTS5
- Svelte 5 + Vite frontend (at `/app/`) — Monitor, Sessions, Search, Analytics tabs
- Legacy vanilla JS frontend + Tailwind CSS (at `/`)
- SSE for live updates
- chokidar file-watcher for automatic session discovery

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

# terminal 2 (shared Tailwind CSS for `/` and `/app/`)
pnpm css:watch

# terminal 3 (for live Svelte SPA changes at /app/)
pnpm frontend:dev
```

Open `http://127.0.0.1:3141` (legacy dashboard) or `http://127.0.0.1:5173/app/` for live Svelte development.
If you want the Express-served `/app/` at `http://127.0.0.1:3141/app/`, run `pnpm frontend:build` after frontend changes.
For continuous rebuilds of the Express-served `/app/`, run `pnpm frontend:watch`.

## Useful Scripts

- `pnpm dev`: run server in watch mode (`tsx watch`).
- `pnpm css:build`: one-off Tailwind build to `public/css/output.css`.
- `pnpm css:watch`: Tailwind watch mode.
- `pnpm build`: TypeScript build + CSS build.
- `pnpm frontend:build`: build Svelte SPA to `frontend/dist/`.
- `pnpm frontend:dev`: Svelte Vite dev server at `:5173` with API proxy.
- `pnpm frontend:watch`: continuously rebuild Svelte SPA to `frontend/dist/` for the Express-served `/app/`.
- `pnpm test`: run the self-contained TypeScript test suite (excludes parity tests).
- `pnpm test:watch`: watch-mode test runner.
- `pnpm test:parity:ts`: run black-box parity tests against an isolated temporary TypeScript server and temp DB.
- `pnpm test:parity:ts:live`: run parity tests against a TypeScript server already running on `:3141`.
- `pnpm test:parity:rust`: run black-box parity tests against a running Rust server on `:3142`.
- `pnpm start`: run compiled server from `dist/`.
- `pnpm run import`: import historical sessions from Claude Code and Codex logs.
- `pnpm seed`: send demo events to the running server.
- `pnpm bench:ingest`: run ingest throughput benchmark.
- `pnpm tauri:dev`: run Tauri desktop shell in dev mode.
- `pnpm tauri:build`: build desktop app with Tauri defaults.
- `pnpm tauri:release:mac:unsigned`: unsigned macOS app + dmg bundles.
- `pnpm tauri:release:mac:signed`: signed macOS bundles (requires `APPLE_SIGNING_IDENTITY`).
- `pnpm tauri:release:mac:notarized`: signed + notarization-ready preflight and build.

## Configuration

Environment variables (all optional):

- `AGENTMONITOR_PORT` (default: `3141`)
- `AGENTMONITOR_HOST` (default: `127.0.0.1`)
- `AGENTMONITOR_DB_PATH` (default: `./data/agentmonitor.db`)
- `AGENTMONITOR_MAX_PAYLOAD_KB` (default: `10`)
- `AGENTMONITOR_SESSION_TIMEOUT` (default: `5`)
- `AGENTMONITOR_MAX_FEED` (default: `200`)
- `AGENTMONITOR_STATS_INTERVAL` (default: `5000`)
- `AGENTMONITOR_MAX_SSE_CLIENTS` (default: `50`)
- `AGENTMONITOR_SSE_HEARTBEAT_MS` (default: `30000`)
- `AGENTMONITOR_PROJECTS_DIR` (default: auto-detected from cwd ancestry; falls back to current working directory)

Seed script target override:

- `AGENTMONITOR_URL` (default: `http://127.0.0.1:3141`)

Benchmark script environment overrides:

- `AGENTMONITOR_BENCH_URL` (default: `http://127.0.0.1:3141`)
- `AGENTMONITOR_BENCH_MODE` (`batch` or `single`, default: `batch`)
- `AGENTMONITOR_BENCH_EVENTS` (default: `10000`)
- `AGENTMONITOR_BENCH_WARMUP_EVENTS` (default: `250`)
- `AGENTMONITOR_BENCH_CONCURRENCY` (default: `20`)
- `AGENTMONITOR_BENCH_BATCH_SIZE` (default: `25`, ignored in `single` mode)
- `AGENTMONITOR_BENCH_SESSION_CARDINALITY` (default: `100`)
- `AGENTMONITOR_BENCH_DUPLICATE_RATE` (default: `0`)
- `AGENTMONITOR_BENCH_TIMEOUT_MS` (default: `15000`)

Example benchmark command:

```bash
pnpm bench:ingest -- --events=20000 --concurrency=40 --batch-size=50
```

## Agent Integration

### Claude Code (hooks)

```bash
./hooks/claude-code/install.sh
```

Restart Claude Code after installing. Events flow via hooks on `SessionStart`, `Stop`, `PostToolUse`, and `PreToolUse`. See `hooks/claude-code/README.md` for options.

To backfill historical sessions with token/cost data:

```bash
pnpm run import --source claude-code
```

### Codex CLI (OTEL)

Add to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://localhost:3141/api/otel/v1/logs"
protocol = "json"
```

Restart Codex after configuring. The dev server must be running before starting a Codex session (the OTEL exporter connects at startup and does not retry).

**Note:** Codex OTEL logs do not include token/cost data. To backfill cost data from Codex session files:

```bash
pnpm run import --source codex
```

See `hooks/codex/README.md` for details.

## API Summary

- `POST /api/events`: ingest one event.
- `POST /api/events/batch`: ingest many events.
- `GET /api/events`: query events with filters (`agent_type`, `event_type`, `tool_name`, `session_id`, `branch`, `model`, `source`, `since`, `until`).
- `GET /api/stats`: aggregate counters and breakdowns (includes `total_cost_usd`, `model_breakdown`).
- `GET /api/sessions`: list sessions (supports `status`, `exclude_status`, `agent_type`, `limit`).
- `GET /api/sessions/:id`: session detail + recent events.
- `GET /api/stats/cost`: cost breakdowns by model, project, and timeline.
- `GET /api/filter-options`: distinct values for all filterable fields.
- `GET /api/stream`: SSE stream (`event`, `stats`, `session_update`), returns `503` when max client limit is reached.
- `GET /api/health`: basic service health.
- `POST /api/otel/v1/logs`: OTLP JSON log ingestion (Claude Code + Codex).
- `POST /api/otel/v1/metrics`: OTLP JSON metric ingestion (token usage, cost).
- `POST /api/otel/v1/traces`: OTLP traces (stub — accepted but not processed yet).
- `GET /api/v2/sessions`: browsing sessions (cursor pagination, project/agent filters).
- `GET /api/v2/sessions/:id`: session detail.
- `GET /api/v2/sessions/:id/messages`: session messages (offset pagination).
- `GET /api/v2/sessions/:id/children`: sub-sessions.
- `GET /api/v2/search?q=`: FTS5 full-text search with snippet highlighting.
- `GET /api/v2/analytics/summary`: aggregate analytics.
- `GET /api/v2/analytics/activity`: daily activity data points.
- `GET /api/v2/analytics/projects`: project breakdowns.
- `GET /api/v2/analytics/tools`: tool usage stats.
- `GET /api/v2/projects`: distinct project names.
- `GET /api/v2/agents`: distinct agent types.

Required fields for ingest payloads: `session_id`, `agent_type`, `event_type`.

Canonical event contract: `docs/api/event-contract.md`.

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

## Documentation

- Contributor workflow and PR expectations: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent implementation guidance: [AGENTS.md](AGENTS.md)
- Architecture and code organization: [docs/system/ARCHITECTURE.md](docs/system/ARCHITECTURE.md)
- Architecture decisions: [docs/plans/adr/2026-02-24-rust-backend-spike-decision-record.md](docs/plans/adr/2026-02-24-rust-backend-spike-decision-record.md)
- Feature and API reference: [docs/system/FEATURES.md](docs/system/FEATURES.md)
- Runtime operations (env, scripts, hooks): [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)
- Product roadmap snapshot: [docs/project/ROADMAP.md](docs/project/ROADMAP.md)
- Event contract specification: [docs/api/event-contract.md](docs/api/event-contract.md)
- Git history and branch policy: [docs/project/GIT_HISTORY_POLICY.md](docs/project/GIT_HISTORY_POLICY.md)
