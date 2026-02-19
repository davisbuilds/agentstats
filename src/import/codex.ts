import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { NormalizedIngestEvent, EventType } from '../contracts/event-contract.js';

// ─── Codex JSONL line types ─────────────────────────────────────────────

interface CodexLogLine {
  type?: string;
  session_id?: string;
  model?: string;
  timestamp?: string;

  // tool/execution fields
  command?: string;
  cwd?: string;
  exitCode?: number;
  exit_code?: number;
  output?: string;
  duration?: number;
  duration_ms?: number;
  status?: string;

  // file change fields
  path?: string;
  diff?: string;

  // turn fields
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;

  // generic
  tool?: string;
  tool_name?: string;
  name?: string;
  error?: string | { message?: string };
  content?: unknown;
}

// ─── Event type mapping ─────────────────────────────────────────────────

const TYPE_MAP: Record<string, EventType> = {
  'tool/execution': 'tool_use',
  'tool/call': 'tool_use',
  'mcpToolCall': 'tool_use',
  'fileChange': 'file_change',
  'file/diff': 'file_change',
  'turn/started': 'session_start',
  'turn/completed': 'response',
  'turn/diff/updated': 'file_change',
  'turn/plan/updated': 'plan_step',
  'error': 'error',
  'message': 'response',
  'assistant': 'response',
  'user': 'response',
};

// ─── Discover JSONL files ──────────────────────────────────────────────

export function discoverCodexLogs(baseDir?: string): string[] {
  const codexHome = baseDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  const files: string[] = [];

  if (!fs.existsSync(sessionsDir)) return files;

  // Walk ~/.codex/sessions/YYYY/MM/DD/<session-id>.jsonl
  walkDir(sessionsDir, files);
  return files.sort();
}

function walkDir(dir: string, files: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
}

// ─── Parse a single JSONL file ──────────────────────────────────────────

export function parseCodexFile(
  filePath: string,
  options?: { from?: Date; to?: Date },
): NormalizedIngestEvent[] {
  const events: NormalizedIngestEvent[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Extract session ID from filename
  const fileBasename = path.basename(filePath, '.jsonl');

  for (let i = 0; i < lines.length; i++) {
    let line: CodexLogLine;
    try {
      line = JSON.parse(lines[i]) as CodexLogLine;
    } catch {
      continue;
    }

    if (!line.type) continue;

    const sessionId = line.session_id ?? fileBasename;

    // Apply date filter
    if (line.timestamp && options?.from) {
      const ts = new Date(line.timestamp);
      if (ts < options.from) continue;
    }
    if (line.timestamp && options?.to) {
      const ts = new Date(line.timestamp);
      if (ts > options.to) continue;
    }

    const eventType = TYPE_MAP[line.type] ?? 'response';

    // Extract tool name
    const toolName = line.tool ?? line.tool_name ?? line.name
      ?? (line.type === 'tool/execution' ? 'shell' : undefined);

    // Determine status
    let status: 'success' | 'error' | 'timeout' = 'success';
    if (line.type === 'error' || line.status === 'error' || line.status === 'failed') {
      status = 'error';
    }
    if (line.exitCode !== undefined && line.exitCode !== 0) status = 'error';
    if (line.exit_code !== undefined && line.exit_code !== 0) status = 'error';

    // Duration
    const durationMs = line.duration_ms
      ?? (typeof line.duration === 'number' ? Math.round(line.duration * 1000) : undefined);

    // Token counts
    const tokensIn = line.input_tokens ?? 0;
    const tokensOut = line.output_tokens ?? 0;

    // Deterministic event_id
    const eventId = crypto
      .createHash('sha256')
      .update(`codex:${sessionId}:${i}`)
      .digest('hex')
      .slice(0, 32);

    // Build metadata with content for transcript enrichment
    const metadataObj: Record<string, unknown> = {};
    if (line.command) metadataObj.command = line.command;
    if (line.cwd) metadataObj.cwd = line.cwd;
    if (line.exitCode !== undefined) metadataObj.exit_code = line.exitCode;
    if (line.exit_code !== undefined) metadataObj.exit_code = line.exit_code;
    if (line.path) metadataObj.file_path = line.path;
    if (line.diff) metadataObj.diff_preview = line.diff.slice(0, 500);
    if (typeof line.error === 'string') metadataObj.error = line.error;
    else if (line.error?.message) metadataObj.error = line.error.message;
    // Capture output for transcript enrichment
    if (line.output) metadataObj.content_preview = String(line.output).slice(0, 500);
    if (typeof line.content === 'string') metadataObj.content_preview = line.content.slice(0, 500);

    const event: NormalizedIngestEvent = {
      event_id: `import-cdx-${eventId}`,
      session_id: sessionId,
      agent_type: 'codex',
      event_type: eventType,
      tool_name: eventType === 'tool_use' ? toolName : undefined,
      status,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      model: line.model,
      duration_ms: durationMs,
      client_timestamp: line.timestamp,
      metadata: Object.keys(metadataObj).length > 0 ? metadataObj : {},
      source: 'import',
    };

    events.push(event);
  }

  return events;
}

// ─── File hash for import state tracking ────────────────────────────────

export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}
