# AgentStats: Codex CLI Integration

Codex CLI does not have a hooks system like Claude Code. Integration is via OpenTelemetry (OTLP), which requires the AgentStats OTLP receiver (Phase 2 of the roadmap).

## Current Status

OTLP ingestion is not yet implemented. Once available, Codex will be supported via its native OTLP export.

## Future Configuration

When OTLP support lands, add this to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://localhost:3141/api/otel/v1/logs", protocol = "json" } }
```

## Alternative: Seed Script

In the meantime, you can use the seed script to generate demo Codex events:

```bash
pnpm run seed
```

This creates a sample Codex session (`codex-session-001`) with realistic tool events.
