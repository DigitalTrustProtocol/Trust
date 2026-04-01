#!/usr/bin/env npx tsx
/**
 * Benchmark: Resolve trust for the last key at degree 3 over ~1M records.
 *
 * NOTE: This benchmark was written for the SQLite backend. With the migration to
 * LevelDB, it needs to be rewritten to use putEvents() with synthesized trust events.
 * Use verify-trust-graph for testing the new implementation.
 *
 * Usage:
 *   TRUST_CONFIG_DIR=bench-trust npx tsx scripts/bench-resolve-1m.ts
 */

console.log(
  'Benchmark script requires migration to LevelDB backend.\n' +
    'Use: npx tsx scripts/verify-trust-graph.ts for testing.\n' +
    'To restore the 1M benchmark, migrate to use putEvents() with synthesized events.',
);
process.exit(0);
