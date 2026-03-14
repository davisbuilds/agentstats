#!/usr/bin/env tsx

import os from 'node:os';
import path from 'node:path';
import { initSchema } from '../src/db/schema.js';
import { getDb, closeDb } from '../src/db/connection.js';
import { syncAllFiles } from '../src/watcher/index.js';

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function parseArgs(): { claudeDir: string } {
  const args = process.argv.slice(2);
  let claudeDir = path.join(os.homedir(), '.claude');

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--claude-dir': {
        const value = args[++i];
        if (!value) {
          console.error('Missing value for --claude-dir');
          process.exit(1);
        }
        claudeDir = path.resolve(process.cwd(), value);
        break;
      }
      case '--help':
      case '-h':
        console.log(`
AgentMonitor Session Reparse

Usage: pnpm reparse:sessions [options]

Options:
  --claude-dir <path>  Override Claude home directory (default: ~/.claude)
  --help, -h           Show this help message
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return { claudeDir };
}

function cleanText(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '').replace(/\s+/g, ' ').trim();
}

function derivePreviewFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  if (text.includes('<local-command-caveat>')) return null;
  if (text.includes('<command-name>')) return null;
  if (text.includes('<local-command-stdout>')) return null;
  if (text.includes('<local-command-stderr>')) return null;
  return cleanText(text).slice(0, 200) || null;
}

function backfillStaleSessionTitles(): { updated: number; fallbackOnly: number } {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT id
    FROM browsing_sessions
    WHERE first_message LIKE '%<local-command-caveat>%'
       OR first_message LIKE '%<command-name>%'
       OR first_message LIKE '%<local-command-stdout>%'
       OR first_message LIKE '%<local-command-stderr>%'
  `).all() as Array<{ id: string }>;

  const listMessages = db.prepare(`
    SELECT content
    FROM messages
    WHERE session_id = ?
    ORDER BY ordinal
  `);
  const updateSession = db.prepare('UPDATE browsing_sessions SET first_message = ? WHERE id = ?');

  let updated = 0;
  let fallbackOnly = 0;

  const txn = db.transaction(() => {
    for (const session of sessions) {
      const messages = listMessages.all(session.id) as Array<{ content: string }>;
      let preview: string | null = null;

      for (const message of messages) {
        try {
          const blocks = JSON.parse(message.content) as Array<{ type?: string; text?: string }>;
          const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim());
          preview = derivePreviewFromText(textBlock?.text);
        } catch {
          preview = derivePreviewFromText(message.content);
        }

        if (preview) break;
      }

      if (!preview) {
        preview = 'Local command activity';
        fallbackOnly++;
      }

      updateSession.run(preview, session.id);
      updated++;
    }
  });

  txn();
  return { updated, fallbackOnly };
}

const opts = parseArgs();

console.log('AgentMonitor Session Reparse');
console.log(`  Claude dir: ${opts.claudeDir}`);
console.log('  Mode:       force reparse of all session browser files');
console.log('');

initSchema();

const db = getDb();
const stats = syncAllFiles(db, opts.claudeDir, { force: true });
const staleBackfill = backfillStaleSessionTitles();

console.log('Results:');
console.log(`  Files discovered: ${stats.total}`);
console.log(`  Reparsed:         ${stats.parsed}`);
console.log(`  Skipped:          ${stats.skipped}`);
console.log(`  Errors:           ${stats.errors}`);
console.log(`  Titles backfilled:${String(staleBackfill.updated).padStart(2, ' ')}`);
console.log(`  Fallback titles:  ${staleBackfill.fallbackOnly}`);

closeDb();
