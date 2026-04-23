#!/usr/bin/env npx tsx
/**
 * Add a small degree-4 and degree-5 layer on top of the heavy-load graph.
 *
 * Prerequisite: run the main seed first so paths to degree-3 nodes exist:
 *   npx tsx scripts/seed-trust-network.ts
 *
 * This script:
 * - Takes the first 100 level-3 nodes (indices 0..99).
 * - Adds 100 degree-4 nodes: l3[i] -> l4[i].
 * - Adds 100 degree-5 nodes: l4[i] -> l5[i].
 *
 * Then prints the author and sample degree 3 / 4 / 5 pubkeys (npub + hex) for
 * resolve testing from the author. Use resolve with --max-depth 5 for degree-5.
 *
 * Usage:
 *   npx tsx scripts/seed-trust-network-deg45.ts
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { VerifiedEvent } from 'nostr-tools';
import { buildTrustEventTemplate } from '../src/lib/nostr/nip32010.js';
import { closeTrustDb, initTrustDb } from '../src/lib/db/dbManager.js';
import { encodeNpub } from '../src/lib/nostr/nip19.js';
import {
  authorKey,
  level3Key,
  level4Key,
  level5Key,
} from './load-test-keys.ts';

const DEG45_COUNT = 100;
const SAMPLE_INDEX = 0;

async function main(): Promise<void> {
  console.log('Seeding degree-4 and degree-5 extension (100 + 100 edges)');
  console.log(`Prerequisite: trust graph already seeded through degree 3 (seed-trust-network.ts)`);
  console.log('');

  const author = authorKey();
  const store = await initTrustDb();
  const started = performance.now();
  let inserted = 0;
  let duplicates = 0;
  let attempted = 0;

  try {
    for (let i = 0; i < DEG45_COUNT; i++) {
      const signer3 = level3Key(i);
      const target4 = level4Key(i);
      const ev4 = signedTrustEvent(signer3.sk, target4.pubkey);
      attempted++;
      if (await insertIntoDb(store, ev4)) inserted++;
      else duplicates++;
    }
    console.log(`Degree 4: ${DEG45_COUNT} edges attempted (l3[0..99] -> l4[0..99])`);

    for (let i = 0; i < DEG45_COUNT; i++) {
      const signer4 = level4Key(i);
      const target5 = level5Key(i);
      const ev5 = signedTrustEvent(signer4.sk, target5.pubkey);
      attempted++;
      if (await insertIntoDb(store, ev5)) inserted++;
      else duplicates++;
    }
    console.log(`Degree 5: ${DEG45_COUNT} edges attempted (l4[0..99] -> l5[0..99])`);

    const elapsed = performance.now() - started;
    console.log('');
    console.log(`Done in ${elapsed.toFixed(0)} ms`);
    console.log(`Attempted:  ${attempted}`);
    console.log(`Inserted:   ${inserted}`);
    console.log(`Duplicates: ${duplicates}`);
    console.log('');

    const l3 = level3Key(SAMPLE_INDEX);
    const l4 = level4Key(SAMPLE_INDEX);
    const l5 = level5Key(SAMPLE_INDEX);

    console.log('Test identities (sample index ' + SAMPLE_INDEX + '; all pairs use the same index i for l3/l4/l5)');
    console.log('');
    console.log('Author (root)');
    console.log(`  pubkey: ${author.pubkey}`);
    console.log(`  npub:   ${encodeNpub(author.pubkey)}`);
    console.log('');
    console.log('Degree 3 subject (first of the 100 extended branches)');
    console.log(`  pubkey: ${l3.pubkey}`);
    console.log(`  npub:   ${encodeNpub(l3.pubkey)}`);
    console.log('');
    console.log('Degree 4 subject');
    console.log(`  pubkey: ${l4.pubkey}`);
    console.log(`  npub:   ${encodeNpub(l4.pubkey)}`);
    console.log('');
    console.log('Degree 5 subject');
    console.log(`  pubkey: ${l5.pubkey}`);
    console.log(`  npub:   ${encodeNpub(l5.pubkey)}`);
    console.log('');
    console.log('Example resolve from author (depth must be 5 for the degree-5 node):');
    console.log(`  npx . resolve ${l3.pubkey} ${author.pubkey} --max-depth 5`);
    console.log(`  npx . resolve ${l4.pubkey} ${author.pubkey} --max-depth 5`);
    console.log(`  npx . resolve ${l5.pubkey} ${author.pubkey} --max-depth 5`);
    console.log('');
    console.log('Or start the server and use /v1/resolve with maxDepth: 5 in the JSON body.');
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
