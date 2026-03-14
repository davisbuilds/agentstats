import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { parseSessionMessages, insertParsedSession } from '../parser/claude-code.js';

// --- File hashing ---

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// --- Discover session files ---

export function discoverSessionFiles(claudeDir: string): string[] {
  const projectsDir = path.join(claudeDir, 'projects');
  const files: string[] = [];

  if (!fs.existsSync(projectsDir)) return files;

  for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(projectsDir, projectEntry.name);

    for (const fileEntry of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (fileEntry.isFile() && fileEntry.name.endsWith('.jsonl')) {
        files.push(path.join(projectPath, fileEntry.name));
      }
    }
  }

  return files.sort();
}

// --- Sync a single session file ---

export type SyncResult = 'parsed' | 'skipped' | 'error';

interface SyncOptions {
  force?: boolean;
}

export function syncSessionFile(db: Database.Database, filePath: string, options: SyncOptions = {}): SyncResult {
  try {
    const stat = fs.statSync(filePath);
    const fileHash = hashFile(filePath);

    // Check watched_files for existing record
    const existing = db.prepare(
      'SELECT file_hash FROM watched_files WHERE file_path = ?'
    ).get(filePath) as { file_hash: string } | undefined;

    if (!options.force && existing && existing.file_hash === fileHash) {
      return 'skipped';
    }

    // Read and parse the file
    const content = fs.readFileSync(filePath, 'utf-8');
    const sessionId = path.basename(filePath, '.jsonl');
    const parsed = parseSessionMessages(content, sessionId, filePath);

    // Skip files with no messages (non-interactive sessions)
    if (parsed.messages.length === 0) {
      // Still record in watched_files to skip on next scan
      db.prepare(`
        INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
        VALUES (?, ?, ?, 'skipped', datetime('now'))
        ON CONFLICT(file_path) DO UPDATE SET
          file_hash = excluded.file_hash,
          file_mtime = excluded.file_mtime,
          status = 'skipped',
          last_parsed_at = datetime('now')
      `).run(filePath, fileHash, stat.mtime.toISOString());
      return 'skipped';
    }

    // Insert parsed data
    insertParsedSession(db, parsed, filePath, stat.size, fileHash);

    // Update watched_files
    db.prepare(`
      INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
      VALUES (?, ?, ?, 'parsed', datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET
        file_hash = excluded.file_hash,
        file_mtime = excluded.file_mtime,
        status = 'parsed',
        last_parsed_at = datetime('now')
    `).run(filePath, fileHash, stat.mtime.toISOString());

    return 'parsed';
  } catch (err) {
    console.error(`[watcher] Failed to sync ${filePath}:`, err);
    try {
      db.prepare(`
        INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
        VALUES (?, ?, ?, 'error', datetime('now'))
        ON CONFLICT(file_path) DO UPDATE SET
          status = 'error',
          last_parsed_at = datetime('now')
      `).run(filePath, 'error', '');
    } catch (dbErr) {
      console.error(`[watcher] Failed to record error state for ${filePath}:`, dbErr);
    }
    return 'error';
  }
}

// --- Sync all discovered files ---

export interface SyncStats {
  parsed: number;
  skipped: number;
  errors: number;
  total: number;
}

export function syncAllFiles(db: Database.Database, claudeDir: string, options: SyncOptions = {}): SyncStats {
  const files = discoverSessionFiles(claudeDir);
  const stats: SyncStats = { parsed: 0, skipped: 0, errors: 0, total: files.length };

  for (const filePath of files) {
    const result = syncSessionFile(db, filePath, options);
    stats[result === 'parsed' ? 'parsed' : result === 'skipped' ? 'skipped' : 'errors']++;
  }

  return stats;
}
