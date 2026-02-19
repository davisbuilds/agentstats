#!/usr/bin/env tsx
/**
 * Import historical logs from Claude Code and Codex into AgentStats.
 *
 * Usage:
 *   pnpm run import                          # import all sources
 *   pnpm run import --source claude-code     # Claude Code only
 *   pnpm run import --source codex           # Codex only
 *   pnpm run import --dry-run                # preview without importing
 *   pnpm run import --force                  # re-import even if unchanged
 *   pnpm run import --from 2026-01-01        # filter by date
 *   pnpm run import --to 2026-02-01          # filter by date
 */

import { initSchema } from '../src/db/schema.js';
import { closeDb } from '../src/db/connection.js';
import { runImport, type ImportSource } from '../src/import/index.js';

// ─── Parse CLI args ─────────────────────────────────────────────────────

function parseArgs(): {
  source: ImportSource;
  from?: Date;
  to?: Date;
  dryRun: boolean;
  force: boolean;
} {
  const args = process.argv.slice(2);
  let source: ImportSource = 'all';
  let from: Date | undefined;
  let to: Date | undefined;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':
        source = args[++i] as ImportSource;
        if (!['claude-code', 'codex', 'all'].includes(source)) {
          console.error(`Invalid source: ${source}. Must be claude-code, codex, or all.`);
          process.exit(1);
        }
        break;
      case '--from': {
        const d = new Date(args[++i]);
        if (Number.isNaN(d.getTime())) {
          console.error(`Invalid --from date: ${args[i]}`);
          process.exit(1);
        }
        from = d;
        break;
      }
      case '--to': {
        const d = new Date(args[++i]);
        if (Number.isNaN(d.getTime())) {
          console.error(`Invalid --to date: ${args[i]}`);
          process.exit(1);
        }
        to = d;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--help':
      case '-h':
        console.log(`
AgentStats Historical Import

Usage: pnpm run import [options]

Options:
  --source <type>   Import source: claude-code, codex, all (default: all)
  --from <date>     Only import events after this ISO date
  --to <date>       Only import events before this ISO date
  --dry-run         Preview import without writing to database
  --force           Re-import files even if hash hasn't changed
  --help, -h        Show this help message
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}. Use --help for usage.`);
        process.exit(1);
    }
  }

  return { source, from, to, dryRun, force };
}

// ─── Main ───────────────────────────────────────────────────────────────

const opts = parseArgs();

console.log(`AgentStats Historical Import`);
console.log(`  Source:   ${opts.source}`);
if (opts.from) console.log(`  From:     ${opts.from.toISOString()}`);
if (opts.to) console.log(`  To:       ${opts.to.toISOString()}`);
if (opts.dryRun) console.log(`  Mode:     DRY RUN (no database writes)`);
if (opts.force) console.log(`  Force:    re-importing all files`);
console.log('');

initSchema();

const result = runImport({
  source: opts.source,
  from: opts.from,
  to: opts.to,
  dryRun: opts.dryRun,
  force: opts.force,
});

// Display per-file results
for (const f of result.files) {
  if (f.skippedUnchanged) {
    console.log(`  SKIP  ${f.path} (unchanged)`);
  } else if (f.eventsFound === 0) {
    console.log(`  EMPTY ${f.path}`);
  } else {
    const tag = opts.dryRun ? 'FOUND' : 'DONE ';
    console.log(`  ${tag} ${f.path}: ${f.eventsImported} events${f.skippedDuplicate > 0 ? `, ${f.skippedDuplicate} duplicates` : ''}`);
  }
}

console.log(`
Results${opts.dryRun ? ' (dry run)' : ''}:
  Files scanned:     ${result.totalFiles}
  Files skipped:     ${result.skippedFiles}
  Events found:      ${result.totalEventsFound}
  Events imported:   ${result.totalEventsImported}
  Duplicates:        ${result.totalDuplicates}
`);

closeDb();
