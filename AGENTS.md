# AGENTS.md

Guidance for coding agents working in this repository.

## Project Snapshot

- App: `agentmonitor` real-time localhost dashboard + session browser for AI agent activity.
- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Legacy frontend: static HTML + vanilla JS + Tailwind-generated CSS (at `/`).
- Svelte 5 frontend: Vite SPA served at `/app/` with Monitor, Sessions, Search, Analytics tabs.
- Transport: HTTP ingestion + Server-Sent Events (SSE) for live updates.
- Session ingestion: chokidar file-watcher discovers `~/.claude/projects/**/*.jsonl` automatically.
- Default bind: `127.0.0.1:3141`.

## Working Commands

- Install: `pnpm install`
- Dev server: `pnpm dev`
- CSS one-off build: `pnpm css:build`
- CSS watch mode: `pnpm css:watch`
- Production build: `pnpm build`
- Production start: `pnpm start`
- Import historical logs: `pnpm run import` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`)
- Seed local demo data (server must be running): `pnpm seed`

For legacy UI work in dev, use two terminals:
- Terminal 1: `pnpm dev`
- Terminal 2: `pnpm css:watch`

For Svelte frontend:
- Build: `pnpm frontend:build` (output at `frontend/dist/`, served at `/app/`)
- Dev: `pnpm frontend:dev` (Vite dev server at `:5173` with API proxy to `:3141`)

## Code Map

- `src/server.ts`: app bootstrap, middleware, route mounting, graceful shutdown.
- `src/config.ts`: environment-driven runtime config.
- `src/api/`: HTTP route handlers.
- `src/db/schema.ts`: schema and indexes.
- `src/db/queries.ts`: all DB reads/writes and stats aggregation.
- `src/sse/emitter.ts`: SSE client management and fan-out.
- `public/index.html`: legacy dashboard shell.
- `public/js/`: legacy dashboard client code/components.
- `frontend/`: Svelte 5 + Vite SPA (served at `/app/`).
- `frontend/src/lib/components/monitor/`: Monitor tab (real-time dashboard).
- `frontend/src/lib/components/sessions/`: Sessions tab (session browser + message viewer).
- `frontend/src/lib/components/search/`: Search tab (FTS5 full-text search).
- `frontend/src/lib/components/analytics/`: Analytics tab (charts, project/tool breakdowns).
- `frontend/src/lib/api/client.ts`: typed API client for v1 and v2 endpoints.
- `frontend/src/lib/stores/`: Svelte 5 reactive state (runes).
- `src/api/v2/`: v2 REST API (session browser, search, analytics).
- `src/db/v2-queries.ts`: all v2 SQL queries.
- `src/parser/claude-code.ts`: JSONL parser for Claude Code session files.
- `src/watcher/`: chokidar file-watcher for auto-discovering session files.
- `src/otel/parser.ts`: OTLP JSON log/metric parsing for Claude Code and Codex.
- `src/import/`: historical log importers (Claude Code JSONL, Codex).
- `src/pricing/`: per-model cost calculation with JSON pricing data.
- `hooks/claude-code/`: hook scripts for real-time Claude Code integration.
- `hooks/codex/`: Codex OTEL integration docs.
- `scripts/import.ts`: CLI for historical log import.
- `scripts/seed.ts`: sample traffic generator.

## API Contract Notes

- Ingest endpoints:
  - `POST /api/events`
  - `POST /api/events/batch`
- Required event fields: `session_id`, `agent_type`, `event_type`.
- Optional `event_id` is used for deduplication (unique constraint).
- `metadata` payload is capped by `AGENTMONITOR_MAX_PAYLOAD_KB`.
- OTEL endpoints: `POST /api/otel/v1/logs`, `POST /api/otel/v1/metrics` (JSON only, no protobuf).
- SSE endpoint: `GET /api/stream`.
- SSE event names used by clients: `event`, `stats`, `session_update`.
- Session timeout: 5 min idle → `idle`, 10 min idle → auto `ended`.
- Claude Code `session_end` transitions to `idle` (not `ended`) so cards linger in Active Agents.
- Codex OTEL logs carry no token/cost data; use `pnpm run import --source codex` for cost backfill.
- If Codex terminal activity is visible but `source=otel` stops updating, verify sessions are not still exporting to `127.0.0.1:3142` from older runtime config.
- V2 API (session browser): all endpoints under `/api/v2/`.
  - `GET /api/v2/sessions`: list browsing sessions (cursor pagination, project/agent filters).
  - `GET /api/v2/sessions/:id`: single session detail.
  - `GET /api/v2/sessions/:id/messages`: messages with offset pagination.
  - `GET /api/v2/sessions/:id/children`: sub-sessions.
  - `GET /api/v2/search?q=`: FTS5 full-text search with snippet highlighting.
  - `GET /api/v2/analytics/summary|activity|projects|tools`: analytics endpoints.
  - `GET /api/v2/projects`, `GET /api/v2/agents`: filter option lists.
- V2 DB tables: `browsing_sessions`, `messages`, `tool_calls`, `messages_fts` (FTS5), `watched_files`.
- File-watcher auto-discovers `~/.claude/projects/**/*.jsonl`, parses messages/tool_calls, deduplicates by file hash.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep v1 SQL in `src/db/queries.ts`, v2 SQL in `src/db/v2-queries.ts`.
- Keep v2 route handlers in `src/api/v2/router.ts`.
- If API response shape changes, update `README.md` in the same change.
- Do not commit local runtime artifacts (`data/`, `*.db`, generated CSS output).

## Rust Backend (`rust-backend/`)

The Rust service reimplements core ingest and live-stream behavior (axum + tokio + rusqlite). Spike complete with GO decision — phased migration in progress.

### Working Commands

- Dev server: `pnpm rust:dev` (binds `127.0.0.1:3142`)
- Release build: `pnpm rust:build`
- Run tests: `pnpm rust:test`
- Desktop invariants only: `pnpm rust:test:desktop-invariants`
- Import historical logs via Rust: `pnpm rust:import --source all` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`, `--claude-dir`, `--codex-dir`)
- Parity tests (TS): `pnpm test:parity:ts` (isolated temp server + temp DB; does not touch normal monitor data)
- Parity tests (TS live): `pnpm test:parity:ts:live` (needs TS server running on 3141)
- Parity tests (Rust): `pnpm test:parity:rust` (needs Rust server running on 3142)
- Benchmark comparison: `pnpm bench:compare`
- Tauri desktop dev shell: `pnpm tauri:dev`
- Tauri desktop build: `pnpm tauri:build`
- Tauri macOS release (unsigned): `pnpm tauri:release:mac:unsigned`
- Tauri macOS release (signed preflight + build): `pnpm tauri:release:mac:signed`
- Tauri macOS release (signed + notarization preflight + build): `pnpm tauri:release:mac:notarized`

### Phase 2 Runtime Model (Internal-First)

- Tauri starts an embedded Rust runtime through `rust-backend`'s `runtime_contract` API (not `runtime_host` internals), then navigates the main window to the contract-provided base URL.
- Rust serves both API routes and dashboard static assets from the same origin (`/api/*`, `/`, `/js/*`, `/css/*`) in desktop mode.
- HTTP ingest/SSE remains the adapter boundary for hooks and parity safety; Tauri IPC is additive and not required for core ingest flow.
- Desktop bind precedence is deterministic: `AGENTMONITOR_DESKTOP_HOST` / `AGENTMONITOR_DESKTOP_PORT` override backend env bind values; otherwise runtime falls back to `AGENTMONITOR_HOST` / `AGENTMONITOR_RUST_PORT` defaults.
- Startup orchestration lives in `src-tauri/src/runtime_coordinator.rs`; keep `src-tauri/src/lib.rs` as composition glue only.
- IPC command surface in `src-tauri/src/ipc/mod.rs` is additive (`desktop_runtime_status`, `desktop_health`); ingest/data flow remains HTTP-first.

### Rust-Specific Gotchas

- **`cargo` not in PATH**: Shell sessions from Claude Code don't inherit cargo. Prefix commands with `export PATH="$HOME/.cargo/bin:$PATH"` or use the `pnpm rust:*` scripts.
- **Lib + bin crate structure**: Integration tests can't import from a binary crate. The crate is split into `src/lib.rs` (all modules + `build_router()`) and a thin `src/main.rs`. Always add new modules to `lib.rs`.
- **`async_stream::stream!` capture semantics**: Variables must be **referenced inside** the stream block to be captured by the macro. A `let _guard = guard;` outside the block will drop immediately when the enclosing function returns, even if the stream is still alive. Move it inside.
- **ManuallyDrop for types with Drop**: You can't destructure a struct that implements `Drop`. Use `ManuallyDrop::new(self)` + `ptr::read` to extract fields without running Drop, then manage cleanup via a separate guard type.
- **`Path::new(":memory:")` in tests**: `db::initialize` expects `&Path`, not `&str`. Use `Path::new(":memory:")` for in-memory test databases.
- **TS validates `agent_type` as required string only, not enum**: Parity tests must match the looser TypeScript behavior. Don't assert enum rejection for `agent_type` in shared parity tests.
- **tsx-in-tsx spawn failure**: Spawning a child process that uses tsx from a parent tsx process fails silently (no output, no error). Use `/bin/sh -c 'exec node --import tsx ...'` with a clean environment instead.
- **`performance.now()` vs `Date.now()`**: Never mix these in deadline calculations. `performance.now()` returns monotonic ms from process start (~small number); `Date.now()` returns epoch ms (~1.7 trillion). Mixing them produces instant timeouts.
- **`pnpm rust:import` already includes Cargo `--` separator**: Pass flags directly (`pnpm rust:import --help`, `pnpm rust:import --source codex`). Do not add an extra `--`.
- **Multiple Rust binaries require explicit `--bin` for `cargo run`**: After adding helper CLIs (for example `import`), plain `cargo run` becomes ambiguous. Keep `pnpm rust:dev` pinned to `--bin agentmonitor-rs`.
- **Keep importer metadata as `serde_json::Value` until insert**: `truncate_metadata` accepts `&Value`; converting metadata to `String` too early causes type mismatches and extra parse/serialize churn.
- **`Option<String>` + helper signature mismatch**: If helper takes `&str`, call `.as_deref().and_then(helper)` instead of `.and_then(helper)`.
- **Rust move semantics in struct literals**: Don't read a moved `String` field later in the same initializer; compute derived booleans before moving or clone intentionally.
- **Import parity requires historical session finalization**: For events with `source = "import"`, mark sessions as `ended` to match TypeScript behavior and keep imported sessions out of active lists.

### Tauri Embedding Gotchas

- **Do not block inside async backend readiness checks**: Calling `std::thread::sleep` or sync `std::net::TcpStream` I/O inside async startup checks can starve the runtime and make health waits hang. Use `tokio::time::sleep` + `tokio::net::TcpStream` for readiness probes.
- **Tauri setup failures can explode into macOS panic backtraces**: Returning setup-hook errors from deep startup paths can trigger noisy `panic in a function that cannot unwind` output in `tauri dev`. For bind-collision startup failures, emit a clear message and `std::process::exit(1)` in setup instead of relying on panic surfaces.
- **Embedded-backend tests need unique SQLite paths**: Reusing the same temp DB file across tests causes intermittent `database is locked`. Generate a unique temp DB path per test case.
- **Bind-collision tests should reserve a free port first**: Hardcoded test ports are flaky if already in use. Bind `127.0.0.1:0`, capture the assigned port, release listener, then run collision checks against that port.
- **`pnpm rust:dev` and `pnpm tauri:dev` both target Rust port 3142 by default**: Running both at once is an expected startup collision. Shut down one or set a different `AGENTMONITOR_RUST_PORT` for one process.
- **Use `AGENTMONITOR_DESKTOP_PORT` for Tauri-only overrides**: If you need `pnpm rust:dev` and `pnpm tauri:dev` simultaneously, prefer `AGENTMONITOR_DESKTOP_PORT` so standalone Rust defaults stay unchanged.
- **Keep runtime boundary tests in `src-tauri/tests/runtime_boundary.rs`**: Add new desktop startup contract assertions there, not in ad-hoc manual checks, so boundary regressions fail fast.
- **Do not call `shutdown_blocking()` inside async tokio tests**: It uses `tauri::async_runtime::block_on`, which panics with nested runtime errors. Use `EmbeddedBackendState::shutdown_async().await` in async tests.
- **Keep Tauri command wrappers thin and test helper functions directly**: `#[tauri::command]` functions that take `tauri::State<'_, T>` are awkward to test in isolation. Put logic in plain helpers (for example `runtime_status_from_state`, `desktop_health_from_state`) and keep command functions as thin adapters.
- **Use `pnpm tauri:release:mac -- --dry-run` before release builds**: The release script validates signing/notarization env upfront and fails fast before expensive bundle builds.
- **Notarized mode requires a real API key file path**: `APPLE_API_KEY_PATH` must point to an existing `.p8`; preflight intentionally fails on missing files.
- **DMG bundling runs AppleScript (`create-dmg`) and can stall in headless or restricted GUI sessions**: Use release script `--dry-run` for preflight checks and `pnpm tauri:build --no-bundle` for non-GUI verification.
- **Finder launch differs from terminal cwd**: Relative backend paths (like `./data/agentmonitor-rs.db`) can fail when launched from Finder because cwd is not the repo root. In desktop startup, resolve relative DB paths against Tauri `app_data_dir`.
- **Dashboard bootstrap hard-depends on `GET /api/events`**: `public/js/app.js` parses stats, events, and sessions together before loading cost/tool sections. If `GET /api/events` returns non-JSON (for example 405 HTML), `reloadData()` throws and cost/tool panels stay blank even when `/api/stats/cost` has data.

## Validation Checklist

When code behavior changes, run:
- `pnpm build`
- `pnpm css:build` (if frontend styles touched)
- `pnpm exec playwright test` for browser-based end-to-end UI testing
- `pnpm rust:test` (if Rust code touched)
- Manual sanity check: `GET /api/health`
