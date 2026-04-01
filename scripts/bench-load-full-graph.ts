#!/usr/bin/env npx tsx
/**
 * Benchmark: Full graph load from DB via loadGraphFromDB
 *
 * Loads the complete graph from issuer (all degrees) using the iterative
 * getGraphFromDB. Uses trust/ config dir (same trust.db and issuer as bench-load-graph-1m).
 *
 * Reports: load time, node count, edge count
 *
 * Usage:
 *   npm run bench:load-full-graph
 */

import { existsSync, rmSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools/pure';
import { loadSecretKey } from '../src/lib/keys.js';
import { initTrustDb, closeTrustDb } from '../src/lib/db/dbManager.js';
import { loadGraphFromDB } from '../src/lib/trust/graphManager.js';
import { PATHS } from '../src/config.js';

async function main() {
  console.log('📊 Full Graph Load Benchmark\n');
  console.log(`Config dir: ${PATHS.configDir}`);
  console.log(`DB path: ${PATHS.trustDb}\n`);

  const primarySk = loadSecretKey();
  if (!primarySk) {
    console.error('❌ No secret key. Run: trust init --skip-profile');
    process.exit(1);
  }

  if (!existsSync(PATHS.trustDb)) {
    console.error('❌ Trust DB not found. Ensure trust.db exists in config dir.');
    process.exit(1);
  }

  const issuerPubkey = getPublicKey(primarySk).toLowerCase();
  console.log(`Issuer: ${issuerPubkey.slice(0, 16)}...\n`);

  // Remove graph cache so we load from DB
  if (existsSync(PATHS.graphCache)) {
    rmSync(PATHS.graphCache, { recursive: true });
  }

  await initTrustDb();

  // Load full graph (maxDepth=3: issuer→100→10k→1M; processing 10k adds 1M via events)
  console.log('Loading full graph via loadGraphFromDB(issuer, maxDepth=3)...\n');

  const start = performance.now();
  const graph = await loadGraphFromDB(issuerPubkey, 3);
  const elapsed = performance.now() - start;

  const nodeCount = graph.nodes.size;
  const edgeCount = graph.edges.size;

  console.log('─'.repeat(50));
  console.log('RESULTS');
  console.log('─'.repeat(50));
  console.log(`Load time:     ${(elapsed / 1000).toFixed(3)}s`);
  console.log(`Nodes:         ${nodeCount.toLocaleString()}`);
  console.log(`Edges:         ${edgeCount.toLocaleString()}`);
  console.log(`Nodes/sec:     ${(nodeCount / (elapsed / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Edges/sec:     ${(edgeCount / (elapsed / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log('─'.repeat(50));

  // Save graph to file for bench-load-from-file
  const saveStart = performance.now();
  const saved = await graph.saveToFile();
  const saveElapsed = performance.now() - saveStart;
  if (saved) {
    console.log(`\nSaved to ${PATHS.graphCache} in ${(saveElapsed / 1000).toFixed(3)}s`);
  }

  await closeTrustDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
