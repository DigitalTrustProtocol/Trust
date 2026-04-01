#!/usr/bin/env npx tsx
/**
 * Benchmark: Graph load from DB with 1M nodes
 *
 * Creates a test DB with:
 *   - 1 issuer (key from config)
 *   - 100 degree-1 nodes (issuer trusts each)
 *   - 10,000 degree-2 nodes (each degree-1 trusts 100)
 *   - 1,000,000 degree-3 nodes (each degree-2 trusts 100)
 *
 * Total: 1,010,101 nodes, 1,010,100 trust events
 *
 * Measures: Time to load issuer + first degree (100 subjects + edges) via getGraphFromDB(issuer, 1)
 *
 * Usage:
 *   npm run bench:load-graph-1m
 *
 * Uses trust/ config dir (same trust.db and issuer as bench-load-full-graph).
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { loadSecretKey } from '../src/lib/keys.js';
import { initTrustDb, closeTrustDb, getStore } from '../src/lib/db/dbManager.js';
import { loadGraphFromDB } from '../src/lib/trust/graphManager.js';
import { PATHS } from '../src/config.js';
import type { VerifiedEvent } from 'nostr-tools';

const DEGREE1 = 100;
const DEGREE2 = 100;
const DEGREE3 = 100;

// Node indices: 0=issuer, 1-100=deg1, 101-10100=deg2, 10101-1010100=deg3
const IDX_DEG1_START = 1;
const IDX_DEG1_END = 100;
const IDX_DEG2_START = 101;
const IDX_DEG2_END = 10100;
const IDX_DEG3_START = 10101;
const IDX_DEG3_END = 1010100;

function makePubkey(index: number): string {
  return index.toString(16).padStart(64, '0').toLowerCase();
}

function makeTrustEvent(issuerPubkey: string, subjectPubkey: string, context: string): VerifiedEvent {
  const dTag = `${subjectPubkey}|${context}`;
  return {
    id: randomBytes(32).toString('hex'),
    pubkey: issuerPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 32010,
    tags: [
      ['d', dTag],
      ['v', '1'],
      ['c', context],
      ['p', subjectPubkey],
    ],
    content: '',
    sig: '0'.repeat(128),
  } as VerifiedEvent;
}

async function main() {
  console.log('📊 Graph Load Benchmark (1M nodes)\n');
  console.log(`Config dir: ${PATHS.configDir}`);
  console.log(`DB path: ${PATHS.trustDb}\n`);

  // Ensure issuer key exists (load before changing dir)
  const primarySk = loadSecretKey();
  if (!primarySk) {
    console.error('❌ No secret key. Run: trust init --skip-profile');
    process.exit(1);
  }

  const issuerPubkey = getPublicKey(primarySk).toLowerCase();
  console.log(`Issuer: ${issuerPubkey.slice(0, 16)}...\n`);

  // Ensure config dir exists; clear only DB and cache (preserve secret.key)
  mkdirSync(PATHS.configDir, { recursive: true });
  if (existsSync(PATHS.trustDb)) rmSync(PATHS.trustDb);
  if (existsSync(PATHS.graphCache)) rmSync(PATHS.graphCache, { recursive: true });

  await initTrustDb();
  const store = await getStore();

  async function putEvents(events: VerifiedEvent[]): Promise<void> {
    for (const event of events) {
      await store.event(event);
    }
  }

  // Generate all pubkeys (1,010,101)
  console.log('Generating 1,010,101 pubkeys...');
  const pubkeys: string[] = [issuerPubkey];
  for (let i = 1; i <= IDX_DEG3_END; i++) {
    pubkeys.push(makePubkey(i));
  }
  console.log('Done.\n');

  // Build events in batches
  const BATCH = 5000;
  let events: VerifiedEvent[] = [];
  let totalEvents = 0;

  console.log('Inserting trust events...');

  // Degree 1: issuer -> 100
  for (let i = IDX_DEG1_START; i <= IDX_DEG1_END; i++) {
    events.push(makeTrustEvent(issuerPubkey, pubkeys[i]!, 'bench'));
    if (events.length >= BATCH) {
      await putEvents(events);
      totalEvents += events.length;
      process.stdout.write(`\r  ${totalEvents.toLocaleString()} / 1,010,100`);
      events = [];
    }
  }

  // Degree 2: each of 100 -> 100
  for (let from = IDX_DEG1_START; from <= IDX_DEG1_END; from++) {
    const startTo = IDX_DEG2_START + (from - IDX_DEG1_START) * DEGREE2;
    for (let j = 0; j < DEGREE2; j++) {
      const to = startTo + j;
      if (to > IDX_DEG2_END) break;
      events.push(makeTrustEvent(pubkeys[from]!, pubkeys[to]!, 'bench'));
      if (events.length >= BATCH) {
        await putEvents(events);
        totalEvents += events.length;
        process.stdout.write(`\r  ${totalEvents.toLocaleString()} / 1,010,100`);
        events = [];
      }
    }
  }

  // Degree 3: each of 10,000 -> 100
  for (let from = IDX_DEG2_START; from <= IDX_DEG2_END; from++) {
    const startTo = IDX_DEG3_START + (from - IDX_DEG2_START) * DEGREE3;
    for (let j = 0; j < DEGREE3; j++) {
      const to = startTo + j;
      if (to > IDX_DEG3_END) break;
      events.push(makeTrustEvent(pubkeys[from]!, pubkeys[to]!, 'bench'));
      if (events.length >= BATCH) {
        await putEvents(events);
        totalEvents += events.length;
        process.stdout.write(`\r  ${totalEvents.toLocaleString()} / 1,010,100`);
        events = [];
      }
    }
  }

  if (events.length > 0) {
    await putEvents(events);
    totalEvents += events.length;
  }

  console.log(`\r  ${totalEvents.toLocaleString()} events inserted.     \n`);

  // Remove graph cache so we load from DB
  if (existsSync(PATHS.graphCache)) {
    rmSync(PATHS.graphCache, { recursive: true });
  }

  // Benchmark: load issuer + first degree (maxDepth=1)
  console.log('Benchmark: loadGraphFromDB(issuer, maxDepth=1)');
  console.log('  (issuer + 100 subjects + their edges)\n');

  const start = performance.now();
  const graph = await loadGraphFromDB(issuerPubkey, 1);
  const elapsed = performance.now() - start;

  const nodeCount = graph.nodes.size;
  const edgeCount = graph.edges.size;

  console.log(`✅ Loaded in ${(elapsed / 1000).toFixed(3)}s`);
  console.log(`   Nodes: ${nodeCount.toLocaleString()}`);
  console.log(`   Edges: ${edgeCount.toLocaleString()}`);
  console.log(`\nExpected: ~101 nodes (issuer + 100), ~100 edges`);

  await closeTrustDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
