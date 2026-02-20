import fs from 'fs';
import { getDb } from '../db/connection.js';
import { insertEvent } from '../db/queries.js';
import { discoverClaudeCodeLogs, parseClaudeCodeFile, hashFile as hashClaudeFile } from './claude-code.js';
import { discoverCodexLogs, parseCodexFile, hashFile as hashCodexFile } from './codex.js';
import type { NormalizedIngestEvent } from '../contracts/event-contract.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type ImportSource = 'claude-code' | 'codex' | 'all';

export interface ImportOptions {
  source: ImportSource;
  from?: Date;
  to?: Date;
  dryRun?: boolean;
  force?: boolean;
  claudeDir?: string;
  codexDir?: string;
}

export interface ImportFileResult {
  path: string;
  source: string;
  eventsFound: number;
  eventsImported: number;
  skippedDuplicate: number;
  skippedUnchanged: boolean;
}

export interface ImportResult {
  files: ImportFileResult[];
  totalFiles: number;
  totalEventsFound: number;
  totalEventsImported: number;
  totalDuplicates: number;
  skippedFiles: number;
}

// ─── Import state DB helpers ────────────────────────────────────────────

interface ImportStateRow {
  file_path: string;
  file_hash: string;
  file_size: number;
  source: string;
  events_imported: number;
  imported_at: string;
}

function getImportState(filePath: string): ImportStateRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM import_state WHERE file_path = ?').get(filePath) as ImportStateRow | undefined;
}

function setImportState(filePath: string, hash: string, size: number, source: string, eventsImported: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO import_state (file_path, file_hash, file_size, source, events_imported, imported_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      file_size = excluded.file_size,
      events_imported = excluded.events_imported,
      imported_at = datetime('now')
  `).run(filePath, hash, size, source, eventsImported);
}

// ─── Core import logic ──────────────────────────────────────────────────

function importEvents(events: NormalizedIngestEvent[], dryRun: boolean): { imported: number; duplicates: number } {
  let imported = 0;
  let duplicates = 0;

  if (dryRun) {
    return { imported: events.length, duplicates: 0 };
  }

  for (const event of events) {
    const row = insertEvent(event);
    if (row) {
      imported++;
    } else {
      duplicates++;
    }
  }

  return { imported, duplicates };
}

function processFile(
  filePath: string,
  source: 'claude-code' | 'codex',
  options: ImportOptions,
): ImportFileResult {
  const stat = fs.statSync(filePath);
  const hashFn = source === 'claude-code' ? hashClaudeFile : hashCodexFile;

  // Check import state (skip if unchanged, unless --force)
  if (!options.force) {
    const state = getImportState(filePath);
    if (state) {
      const currentHash = hashFn(filePath);
      if (state.file_hash === currentHash) {
        return {
          path: filePath,
          source,
          eventsFound: 0,
          eventsImported: 0,
          skippedDuplicate: 0,
          skippedUnchanged: true,
        };
      }
    }
  }

  // Parse the file
  const parseFn = source === 'claude-code' ? parseClaudeCodeFile : parseCodexFile;
  const events = parseFn(filePath, { from: options.from, to: options.to, codexDir: options.codexDir });

  // Import events
  const { imported, duplicates } = importEvents(events, options.dryRun ?? false);

  // Record import state (unless dry run or date-scoped import).
  // Date-scoped imports are partial — caching the hash would cause a later
  // full import to skip the file, permanently losing the excluded events.
  const isDateScoped = options.from !== undefined || options.to !== undefined;
  if (!options.dryRun && !isDateScoped && events.length > 0) {
    const hash = hashFn(filePath);
    setImportState(filePath, hash, stat.size, source, imported);
  }

  return {
    path: filePath,
    source,
    eventsFound: events.length,
    eventsImported: imported,
    skippedDuplicate: duplicates,
    skippedUnchanged: false,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

export function runImport(options: ImportOptions): ImportResult {
  const files: ImportFileResult[] = [];

  // Discover files
  const claudeFiles = (options.source === 'claude-code' || options.source === 'all')
    ? discoverClaudeCodeLogs(options.claudeDir)
    : [];
  const codexFiles = (options.source === 'codex' || options.source === 'all')
    ? discoverCodexLogs(options.codexDir)
    : [];

  // Process Claude Code files
  for (const filePath of claudeFiles) {
    files.push(processFile(filePath, 'claude-code', options));
  }

  // Process Codex files
  for (const filePath of codexFiles) {
    files.push(processFile(filePath, 'codex', options));
  }

  // Aggregate results
  let totalEventsFound = 0;
  let totalEventsImported = 0;
  let totalDuplicates = 0;
  let skippedFiles = 0;

  for (const f of files) {
    totalEventsFound += f.eventsFound;
    totalEventsImported += f.eventsImported;
    totalDuplicates += f.skippedDuplicate;
    if (f.skippedUnchanged) skippedFiles++;
  }

  return {
    files,
    totalFiles: files.length,
    totalEventsFound,
    totalEventsImported,
    totalDuplicates,
    skippedFiles,
  };
}
