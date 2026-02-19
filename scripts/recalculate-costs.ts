#!/usr/bin/env tsx
/**
 * Recalculate cost_usd for all events that have model + token counts.
 * Useful when pricing JSON is updated or historical data lacks costs.
 *
 * Usage: pnpm run recalculate-costs [--dry-run]
 */

import { initSchema } from '../src/db/schema.js';
import { getDb, closeDb } from '../src/db/connection.js';
import { pricingRegistry } from '../src/pricing/index.js';

const dryRun = process.argv.includes('--dry-run');

initSchema();
const db = getDb();

interface EventRow {
  id: number;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
}

// Find all events with a model and any token counts
const events = db.prepare(`
  SELECT id, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd
  FROM events
  WHERE model IS NOT NULL
    AND (tokens_in > 0 OR tokens_out > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0)
`).all() as EventRow[];

console.log(`Found ${events.length} events with model + token data`);

if (events.length === 0) {
  console.log('Nothing to recalculate.');
  closeDb();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE events SET cost_usd = ? WHERE id = ?
`);

let updated = 0;
let skippedUnknown = 0;
let skippedSame = 0;

const recalculate = db.transaction(() => {
  for (const event of events) {
    const cost = pricingRegistry.calculate(event.model, {
      input: event.tokens_in,
      output: event.tokens_out,
      cacheRead: event.cache_read_tokens,
      cacheWrite: event.cache_write_tokens,
    });

    if (cost === null) {
      skippedUnknown++;
      continue;
    }

    // Round to 10 decimal places to avoid floating-point noise
    const rounded = Math.round(cost * 1e10) / 1e10;
    const existing = event.cost_usd !== null ? Math.round(event.cost_usd * 1e10) / 1e10 : null;

    if (existing === rounded) {
      skippedSame++;
      continue;
    }

    if (!dryRun) {
      update.run(rounded, event.id);
    }
    updated++;
  }
});

recalculate();

console.log(`\nResults${dryRun ? ' (dry run)' : ''}:`);
console.log(`  Updated:         ${updated}`);
console.log(`  Unchanged:       ${skippedSame}`);
console.log(`  Unknown model:   ${skippedUnknown}`);

closeDb();
