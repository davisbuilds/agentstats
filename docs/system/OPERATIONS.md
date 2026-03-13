# Operations

## Local Development

```bash
pnpm install
pnpm dev          # terminal 1: server in watch mode
pnpm css:watch    # terminal 2: Tailwind CSS watch
```

Open `http://127.0.0.1:3141`.

## Useful Commands

```bash
pnpm build              # TypeScript build + CSS build
pnpm start              # Run compiled server from dist/
pnpm test               # Run self-contained TypeScript tests (excludes parity)
pnpm test:watch         # Watch-mode self-contained test runner
pnpm test:parity:ts     # Run isolated TypeScript parity tests (temp server + temp DB)
pnpm test:parity:ts:live # Run parity tests against a running TS server on :3141
pnpm test:parity:rust   # Run parity tests against a running Rust server on :3142
pnpm lint               # ESLint
pnpm seed               # Send demo events (server must be running)
pnpm run import         # Import historical sessions
pnpm bench:ingest       # Ingest throughput benchmark
pnpm recalculate-costs  # Recalculate costs from pricing data
```

## Tauri macOS Release

```bash
pnpm tauri:release:mac:unsigned                     # unsigned app + dmg bundles
pnpm tauri:release:mac:signed                       # requires APPLE_SIGNING_IDENTITY
pnpm tauri:release:mac:notarized                    # requires signing + notarization env vars
pnpm tauri:release:mac -- --mode signed --dry-run  # preflight only (no build)
pnpm tauri:build --no-bundle                        # non-GUI release sanity check
```

Note: DMG bundling uses AppleScript via `create-dmg` and may hang in headless or restricted GUI sessions. Run `--dry-run` first when validating env setup.

Signed/notarized preflight environment:

| Variable | Required For | Notes |
|----------|--------------|-------|
| `APPLE_SIGNING_IDENTITY` | `signed`, `signed-notarized` | Developer ID Application identity |
| `APPLE_API_KEY` | `signed-notarized` | App Store Connect API key id |
| `APPLE_API_ISSUER` | `signed-notarized` | App Store Connect issuer UUID |
| `APPLE_API_KEY_PATH` | `signed-notarized` | Absolute path to `.p8` key file; file must exist |

## Environment Variables

All optional with sensible defaults:

| Variable | Default | Used For |
|----------|---------|----------|
| `AGENTMONITOR_PORT` | `3141` | HTTP listen port |
| `AGENTMONITOR_HOST` | `127.0.0.1` | HTTP bind address |
| `AGENTMONITOR_DB_PATH` | `./data/agentmonitor.db` | SQLite database path |
| `AGENTMONITOR_MAX_PAYLOAD_KB` | `10` | Max metadata payload size |
| `AGENTMONITOR_SESSION_TIMEOUT` | `5` | Minutes before session goes idle |
| `AGENTMONITOR_MAX_FEED` | `200` | Max events in feed |
| `AGENTMONITOR_STATS_INTERVAL` | `5000` | Stats broadcast interval (ms) |
| `AGENTMONITOR_MAX_SSE_CLIENTS` | `50` | Max concurrent SSE connections |
| `AGENTMONITOR_SSE_HEARTBEAT_MS` | `30000` | SSE heartbeat interval (ms) |
| `AGENTMONITOR_PROJECTS_DIR` | auto-detected from cwd ancestry | Workspace root used for git branch resolution |

Benchmark overrides: `AGENTMONITOR_BENCH_URL`, `AGENTMONITOR_BENCH_MODE`, `AGENTMONITOR_BENCH_EVENTS`, `AGENTMONITOR_BENCH_CONCURRENCY`, `AGENTMONITOR_BENCH_BATCH_SIZE`.

## Hook Installation

### Claude Code

```bash
./hooks/claude-code/install.sh
```

Restart Claude Code after installing. See `hooks/claude-code/README.md` for details.

### Codex

Add to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://localhost:3141/api/otel/v1/logs"
protocol = "json"
```

The dev server must be running before starting a Codex session.

## Historical Import

```bash
pnpm run import --source claude-code    # Claude Code JSONL logs
pnpm run import --source codex          # Codex session files
pnpm run import --dry-run               # Preview without writing
```

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Current required check on `main` branch protection:

- `Lint, Build, Test`

The CI job runs:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm build`
- `pnpm test`

Parity tests are available for manual/shared-runtime verification but are not part of the required CI workflow.

## Runtime Artifacts

Do not commit: `data/`, `*.db`, generated CSS output in `public/css/output.css`.
