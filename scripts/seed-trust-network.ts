#!/usr/bin/env npx tsx
/**
 * Seed heavy-load trust network directly into DB (no server/relay required).
 *
 * Topology:
 * - author -> 100 level-1 nodes
 * - each level-1 -> 100 level-2 nodes (10,000)
 * - each level-2 -> 100 level-3 nodes (1,000,000)
 *
 * All edges:
 * - trust value: 1
 * - context: empty string
 * - content: empty string
 *
 * Usage:
 *   npx tsx scripts/seed-trust-network.ts
 *   TRUST_LOAD_INSERT_PROGRESS_EVERY=50000 npx tsx scripts/seed-trust-network.ts
 *
 * Optional small degree-4/5 sample (100+100 edges): scripts/seed-trust-network-deg45.ts
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { VerifiedEvent } from 'nostr-tools';
import { buildTrustEventTemplate } from '../src/lib/nostr/nip32010.js';
import { closeTrustDb, initTrustDb } from '../src/lib/db/dbManager.js';
import { encodeNpub } from '../src/lib/nostr/nip19.js';
import {
  BRANCHING,
  LEVEL1,
  LEVEL2,
  LEVEL3,
  TOTAL_EDGES,
  authorKey,
  level1Key,
  level2Key,
  level3Key,
} from './load-test-keys.ts';

const INSERT_PROGRESS_EVERY = Math.max(1_000, Number(process.env.TRUST_LOAD_INSERT_PROGRESS_EVERY ?? 25_000));

async function main(): Promise<void> {
  console.log('Seeding heavy-load graph directly into DB');
  console.log(`Topology: ${BRANCHING} -> ${BRANCHING} -> ${BRANCHING}`);
  console.log(`Total edges to insert: ${TOTAL_EDGES.toLocaleString()}`);

  const author = authorKey();
  console.log(`Author pubkey: ${author.pubkey}`);
  console.log(`Author npub:   ${encodeNpub(author.pubkey)}`);
  console.log('');

  const store = await initTrustDb();
  const started = performance.now();
  let inserted = 0;
  let duplicates = 0;
  let attempted = 0;

  try {
    // Level 1: author -> l1
    for (let i = 0; i < LEVEL1; i++) {
      const event = signedTrustEvent(author.sk, level1Key(i).pubkey);
      const ok = await insertIntoDb(store, event);
      attempted++;
      if (ok) inserted++;
      else duplicates++;
    }
    console.log(`Level 1 complete (${LEVEL1.toLocaleString()} attempted)`);

    // Level 2: l1 -> l2
    for (let i = 0; i < LEVEL1; i++) {
      const signer = level1Key(i);
      for (let j = 0; j < BRANCHING; j++) {
        const idx2 = i * BRANCHING + j;
        const event = signedTrustEvent(signer.sk, level2Key(idx2).pubkey);
        const ok = await insertIntoDb(store, event);
        attempted++;
        if (ok) inserted++;
        else duplicates++;
      }
      if ((i + 1) % 10 === 0) {
        console.log(`Level 2 progress: ${((i + 1) * BRANCHING).toLocaleString()}/${LEVEL2.toLocaleString()}`);
      }
    }
    console.log(`Level 2 complete (${LEVEL2.toLocaleString()} attempted)`);

    // Level 3: l2 -> l3
    for (let i2 = 0; i2 < LEVEL2; i2++) {
      const signer = level2Key(i2);
      const base = i2 * BRANCHING;
      for (let k = 0; k < BRANCHING; k++) {
        const idx3 = base + k;
        const event = signedTrustEvent(signer.sk, level3Key(idx3).pubkey);
        const ok = await insertIntoDb(store, event);
        attempted++;
        if (ok) inserted++;
        else duplicates++;

        if (attempted % INSERT_PROGRESS_EVERY === 0) {
          const pct = ((attempted / TOTAL_EDGES) * 100).toFixed(2);
          console.log(
            `Insert progress: ${attempted.toLocaleString()}/${TOTAL_EDGES.toLocaleString()} (${pct}%) ` +
              `inserted=${inserted.toLocaleString()} duplicates=${duplicates.toLocaleString()}`,
          );
        }
      }
    }

    const elapsed = performance.now() - started;
    console.log('');
    console.log(`Done in ${elapsed.toFixed(0)} ms`);
    console.log(`Attempted:  ${attempted.toLocaleString()}`);
    console.log(`Inserted:   ${inserted.toLocaleString()}`);
    console.log(`Duplicates: ${duplicates.toLocaleString()}`);
    console.log('');
    console.log('Now start the server and run heavy-load-test:');
    console.log('  npx . server --database sqlite');
    console.log('  npx tsx scripts/heavy-load-test.ts');
  } finally {
    await closeTrustDb(store);
  }
}

async function insertIntoDb(
  store: { event: (event: VerifiedEvent, options?: Record<string, unknown>) => Promise<void> },
  event: VerifiedEvent,
): Promise<boolean> {
  const opt: Record<string, unknown> = {};
  await store.event(event, opt);
  return (opt as { isInserted?: boolean }).isInserted === true;
}

function signedTrustEvent(sk: Uint8Array, subjectPubkey: string): VerifiedEvent {
  const template = buildTrustEventTemplate({
    subjects: [{ tag: 'p', value: subjectPubkey.toLowerCase() }],
    context: '',
    value: 1,
    content: '',
  });
  return finalizeEvent(template, sk);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
