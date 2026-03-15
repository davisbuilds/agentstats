# Architecture

## High-Level Flow

1. Agent hooks (Claude Code) or OTEL exporters (Codex) send events via HTTP to the ingest API.
2. Events are validated, normalized, and stored in SQLite.
3. The SSE emitter broadcasts new events and stats to connected dashboard clients.
4. The vanilla JS dashboard renders agent cards, event feeds, cost breakdowns, and tool analytics in real time.
5. Historical sessions can be backfilled via the import pipeline.

## Active Decision Records

- `2026-02-24`: [Rust Backend Spike Before Desktop Packaging](../archive/adr/2026-02-24-rust-backend-spike-decision-record.md) — **GO decision reached**. Proceeding with phased Rust migration and Tauri desktop shell. See [spike decision](../archive/plans/rust-spike/2026-02-24-rust-backend-spike-decision.md).
- `2026-02-26`: [Tauri Internal-First Shell](../archive/plans/tauri-shell/2026-02-26-tauri-internal-first-shell-plan.md) with [implementation plan](../archive/plans/tauri-shell/2026-02-26-tauri-internal-first-shell-implementation.md) — Phase 2 execution path.

## Rust Backend (phase 1 complete)

An isolated Rust service (`rust-backend/`) reimplements ingest and live-stream behavior using axum, tokio, and rusqlite. Phase 1 parity work is complete and includes:
- `POST /api/events`, `POST /api/events/batch` — ingest with dedup and batch rejection
- `GET /api/stats`, `GET /api/stats/tools`, `GET /api/stats/cost`, `GET /api/stats/usage-monitor` — aggregate and analytics counters
- `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/transcript`, `GET /api/filter-options`
- `POST /api/otel/v1/logs`, `/api/otel/v1/metrics`, `/api/otel/v1/traces`
- `GET /api/stream` — SSE fan-out via tokio::broadcast
- `GET /api/health` — service health with SSE client count
- Import pipeline + runtime auto-import scheduling parity
- Pricing auto-cost parity on ingest

Runs on port 3142 by default. Current verification includes full Rust test suite + shared parity tests.

## Tauri Desktop Runtime (phase 2 in progress)

Current desktop runtime is internal-first:
- Tauri app setup starts the embedded Rust runtime via `rust-backend/src/runtime_contract.rs`.
- `runtime_contract` is the public boundary for startup/shutdown and endpoint metadata (`base_url`, `local_addr`).
- Tauri startup/shutdown orchestration is centralized in `src-tauri/src/runtime_coordinator.rs`.
- Startup includes readiness gate (`/api/health`) before window navigation.
- Tauri main window navigates using the contract-provided backend origin (`http://127.0.0.1:3142` by default).
- Desktop bind policy is deterministic: desktop overrides (`AGENTMONITOR_DESKTOP_HOST`, `AGENTMONITOR_DESKTOP_PORT`) take precedence over backend env bind config.
- Rust backend serves dashboard static assets as router fallback, so UI and API share the same origin in desktop mode.
- HTTP ingest/SSE remains available on localhost as adapter boundary for hooks and parity coverage.
- IPC is additive and now includes first functional handlers in `src-tauri/src/ipc/mod.rs` (`desktop_runtime_status`, `desktop_health`), while ingest/state traffic remains HTTP-first.

Guardrail coverage:
- `rust-backend/tests/desktop_invariants.rs` validates dedup persistence, session lifecycle transitions, and SSE delivery/client-count invariants.
- `src-tauri/tests/runtime_boundary.rs` validates runtime boundary contracts (endpoint metadata, restart after shutdown, desktop bind precedence).

## API Layer

Express route handlers in `src/api/`:

| Route File | Endpoints | Purpose |
|------------|-----------|---------|
| `events.ts` | `POST /api/events`, `POST /api/events/batch`, `GET /api/events` | Event ingest (single + batch) and query |
| `stats.ts` | `GET /api/stats`, `GET /api/stats/cost` | Aggregate counters and cost breakdowns |
| `sessions.ts` | `GET /api/sessions`, `GET /api/sessions/:id` | Session listing and detail |
| `stream.ts` | `GET /api/stream` | SSE endpoint with filters and backpressure |
| `health.ts` | `GET /api/health` | Service health check |
| `otel.ts` | `POST /api/otel/v1/logs`, `POST /api/otel/v1/metrics`, `POST /api/otel/v1/traces` | OTLP JSON ingestion |
| `filter-options.ts` | `GET /api/filter-options` | Distinct values for filterable fields |
| `transcripts.ts` | `GET /api/sessions/:id` (transcript) | Session transcript aggregation |

Routes are composed in `src/api/router.ts`.

## Database Layer

SQLite via `better-sqlite3` with WAL mode.

### Tables

| Table | Purpose |
|-------|---------|
| `agents` | Registered agent identities and last-seen timestamps |
| `sessions` | Session lifecycle (active → idle → ended) with metadata |
| `events` | Individual tool use, prompt, and lifecycle events with cost data |
| `import_state` | Tracks imported files to prevent duplicate backfills |

### Key Patterns

- All SQL lives in `src/db/queries.ts` (no ad-hoc DB logic in route handlers).
- Schema initialization and backward-compatible migrations in `src/db/schema.ts`.
- Indexes on `created_at`, `session_id`, `event_type`, `tool_name`, `agent_type`, `model`.

## SSE Broadcasting

`src/sse/emitter.ts` manages connected clients:

- Fan-out of `event`, `stats`, and `session_update` messages.
- Configurable max client limit (`AGENTMONITOR_MAX_SSE_CLIENTS`).
- Heartbeat keep-alive (`AGENTMONITOR_SSE_HEARTBEAT_MS`).
- Returns `503` when max client limit is reached.

## Event Contract

Defined in `src/contracts/event-contract.ts` and documented in `docs/api/event-contract.md`:

- Required fields: `session_id`, `agent_type`, `event_type`.
- Optional `event_id` for deduplication (unique constraint).
- `metadata` payload capped by `AGENTMONITOR_MAX_PAYLOAD_KB` with UTF-8 safe truncation.
- `client_timestamp` for client-supplied timing; `created_at` is server receive time.

## Pricing Engine

`src/pricing/` calculates per-event costs:

- `PricingRegistry` loads JSON pricing data files for each model family (Claude, Codex, Gemini).
- Cost computed from `tokens_in`, `tokens_out`, `cache_read_tokens`, `cache_write_tokens`.
- Costs stored as `cost_usd` on each event row.

## Import Pipeline

`src/import/` supports historical backfill:

- `claude-code.ts`: Parses Claude Code JSONL conversation logs.
- `codex.ts`: Parses Codex session JSON files.
- `import_state` table tracks file hashes to prevent re-import.

## OTEL Parser

`src/otel/parser.ts` converts OTLP JSON payloads (logs, metrics) into normalized events for the standard ingest pipeline.

## Runtime Path Resolution

- `AGENTMONITOR_PROJECTS_DIR` controls the workspace root used for git branch lookups.
- If unset, config auto-detects the AgentMonitor repo root from `process.cwd()` ancestry and uses its parent directory.
- If no repo root is detected, config falls back to the current working directory.

## Directory Map

```text
src/api/                  # HTTP route handlers (9 files)
src/contracts/            # TypeScript event types and validation
src/db/                   # Schema, queries, connection management
src/import/               # Historical log importers
src/otel/                 # OTLP JSON parser
src/pricing/              # Cost calculation + JSON pricing data
src/sse/                  # SSE client management and fan-out
src/util/                 # Utilities (git branch detection)
public/                   # Dashboard HTML, JS components, CSS
hooks/claude-code/        # Claude Code integration hooks (bash + Python)
hooks/codex/              # Codex OTEL integration docs
scripts/                  # Seed, import, benchmark, cost recalculation
tests/                    # Node test runner suite (8 files)
```
