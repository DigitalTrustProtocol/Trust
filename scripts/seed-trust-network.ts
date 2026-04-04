#!/usr/bin/env npx tsx
/**
 * Seed Trust Network
 *
 * Generates 100 keys and creates a trust network with varied scenarios.
 * Uses the primary key from ./trust (or TRUST_CONFIG_DIR) as the root identity.
 * Posts trust events to relays and inserts into the local DB.
 *
 * Usage:
 *   TRUST_CONFIG_DIR=trust npx tsx scripts/seed-trust-network.ts
 *   # Or with default ~/.trust:
 *   npx tsx scripts/seed-trust-network.ts
 *
 * Scenarios covered:
 *   - Trust chains (primary -> cluster leads -> members)
 *   - Context differentiation (development, commerce, security)
 *   - Distrust (spam ring)
 *   - Batch trust/distrust
 *   - Neutral / revocation
 *   - Hub-and-spoke (highly trusted nodes)
 */

// Set config dir before any imports that use config
if (!process.env.TRUST_CONFIG_DIR) {
  process.env.TRUST_CONFIG_DIR = 'trust';
}

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { finalizeEvent } from 'nostr-tools/pure';
import type { ParsedSubject } from '../src/lib/trust/subject.js';
import { buildTrustEventTemplate } from '../src/lib/nostr/nip32010.js';
import { initTrustDb } from '../src/lib/db/dbManager.js';
import { insertEvent, loadGraph } from '../src/lib/trust/graphManager.js';
import { publishEvent } from '../src/lib/relays.js';
import { loadSecretKey } from '../src/lib/keys.js';
import { closePool } from '../src/lib/relays.js';
import { closeTrustDb } from '../src/lib/db/dbManager.js';
import { DEFAULT_RELAYS } from '../src/config.js';
import { PATHS } from '../src/config.js';

const NUM_KEYS = 100;
const RELAYS = DEFAULT_RELAYS;
const FIXTURE_PATH =
  process.env.TRUST_GRAPH_FILE ?? join(process.cwd(), 'test', 'fixtures', 'trust-graph.json');

interface TrustGraphFixture {
  keys: { label?: string }[];
  connections: { from: number; to: number; value: number; context: string }[];
  expected?: { issuer: number; subject: number; context?: string; degree?: number; connected?: boolean }[];
}

interface Key {
  secretKey: Uint8Array;
  pubkey: string;
  index: number;
}

function makeSubject(pubkey: string): ParsedSubject {
  return { tag: 'p', value: pubkey.toLowerCase() };
}

function signAndFinalize(template: ReturnType<typeof buildTrustEventTemplate>, sk: Uint8Array) {
  return finalizeEvent(template, sk);
}

async function main() {
  console.log('🌱 Trust Network Seeder\n');
  console.log(`Config dir: ${PATHS.configDir}`);
  console.log(`Relays: ${RELAYS.join(', ')}\n`);

  // Load primary key from ./trust
  const primarySk = loadSecretKey();
  if (!primarySk) {
    console.error('❌ No secret key found. Run `trust init` first or ensure ./trust/secret.key exists.');
    process.exit(1);
  }

  const primaryPubkey = getPublicKey(primarySk).toLowerCase();
  console.log(`Primary key (index 0): ${primaryPubkey.slice(0, 16)}...`);

  let fixture: TrustGraphFixture | null = null;
  if (existsSync(FIXTURE_PATH)) {
    console.log(`Loading graph from ${FIXTURE_PATH}...`);
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as TrustGraphFixture;
  }

  const numKeys = fixture ? fixture.keys.length : NUM_KEYS;

  // Build keys: primary = index 0, rest generated
  const keys: Key[] = [
    { secretKey: primarySk, pubkey: primaryPubkey, index: 0 },
    ...Array.from({ length: numKeys - 1 }, (_, i) => {
      const sk = generateSecretKey();
      return {
        secretKey: sk,
        pubkey: getPublicKey(sk).toLowerCase(),
        index: i + 1,
      };
    }),
  ];

  console.log(`Generated ${keys.length} keys total.\n`);

  // Initialize DB and graph
  console.log('Initializing trust database...');
  await initTrustDb();
  console.log('Loading graph...');
  await loadGraph();
  const events: { event: ReturnType<typeof signAndFinalize>; desc: string }[] = [];

  if (fixture) {
    // Build from fixture connections
    console.log(`Creating ${fixture.connections.length} trust events from fixture...`);
    for (const conn of fixture.connections) {
      const fromKey = keys[conn.from];
      const toKey = keys[conn.to];
      if (!fromKey || !toKey) continue;
      const value = conn.value === 0 || conn.value === 1 || conn.value === -1 ? conn.value : 0;
      const template = buildTrustEventTemplate({
        subjects: [makeSubject(toKey.pubkey)],
        context: conn.context,
        value,
        content: `Fixture: ${conn.from}->${conn.to}`,
      });
      events.push({
        event: signAndFinalize(template, fromKey.secretKey),
        desc: `key ${conn.from} -> key ${conn.to} (${conn.value}, ${conn.context})`,
      });
    }
  } else {
  // --- Scenario 1: Primary trusts cluster leads (indices 1-5) in "development"
  console.log('Scenario 1: Primary trusts cluster leads (dev)...');
  for (let i = 1; i <= 5; i++) {
    const template = buildTrustEventTemplate({
      subjects: [makeSubject(keys[i]!.pubkey)],
      context: 'development',
      value: 1,
      content: `Trusted lead for development cluster ${i}`,
    });
    events.push({
      event: signAndFinalize(template, primarySk),
      desc: `primary trusts key ${i} (dev)`,
    });
  }

  // --- Scenario 2: Primary trusts leads 1-3 in "commerce" (subset)
  console.log('Scenario 2: Primary trusts subset in commerce...');
  for (let i = 1; i <= 3; i++) {
    const template = buildTrustEventTemplate({
      subjects: [makeSubject(keys[i]!.pubkey)],
      context: 'commerce',
      value: 1,
      content: `Trusted for commerce`,
    });
    events.push({
      event: signAndFinalize(template, primarySk),
      desc: `primary trusts key ${i} (commerce)`,
    });
  }

  // --- Scenario 3: Cluster leads trust their members (chains)
  // Lead 1 -> 10-19, Lead 2 -> 20-29, Lead 3 -> 30-39, etc.
  console.log('Scenario 3: Cluster leads trust members...');
  for (let lead = 1; lead <= 5; lead++) {
    const start = 10 + (lead - 1) * 10;
    const end = start + 10;
    for (let m = start; m < end && m < keys.length; m++) {
      const template = buildTrustEventTemplate({
        subjects: [makeSubject(keys[m]!.pubkey)],
        context: 'development',
        value: 1,
        content: `Cluster member`,
      });
      events.push({
        event: signAndFinalize(template, keys[lead]!.secretKey),
        desc: `lead ${lead} trusts key ${m}`,
      });
    }
  }

  // --- Scenario 4: Spam ring - keys 80-89 distrusted by primary (batch)
  console.log('Scenario 4: Batch distrust (spam ring)...');
  const spamPubkeys = keys.slice(80, 90).map((k) => k.pubkey);
  const spamSubjects = spamPubkeys.map((p) => makeSubject(p));
  const batchTemplate = buildTrustEventTemplate({
    subjects: spamSubjects,
    context: 'spam',
    value: -1,
    content: 'Known spam botnet',
  });
  events.push({
    event: signAndFinalize(batchTemplate, primarySk),
    desc: 'primary batch distrusts keys 80-89',
  });

  // --- Scenario 5: Key 50 distrusted by primary (security)
  console.log('Scenario 5: Individual distrust...');
  const distrustTemplate = buildTrustEventTemplate({
    subjects: [makeSubject(keys[50]!.pubkey)],
    context: 'security',
    value: -1,
    content: 'Security incident',
  });
  events.push({
    event: signAndFinalize(distrustTemplate, primarySk),
    desc: 'primary distrusts key 50 (security)',
  });

  // --- Scenario 6: Cross-trust between leads
  console.log('Scenario 6: Cross-trust between leads...');
  for (let i = 1; i <= 5; i++) {
    for (let j = 1; j <= 5; j++) {
      if (i !== j) {
        const template = buildTrustEventTemplate({
          subjects: [makeSubject(keys[j]!.pubkey)],
          context: 'development',
          value: 1,
        });
        events.push({
          event: signAndFinalize(template, keys[i]!.secretKey),
          desc: `lead ${i} trusts lead ${j}`,
        });
      }
    }
  }

  // --- Scenario 7: Hub - key 1 is trusted by many members (10-19)
  console.log('Scenario 7: Hub (members trust lead 1)...');
  for (let m = 10; m <= 19; m++) {
    const template = buildTrustEventTemplate({
      subjects: [makeSubject(keys[1]!.pubkey)],
      context: 'development',
      value: 1,
    });
    events.push({
      event: signAndFinalize(template, keys[m]!.secretKey),
      desc: `member ${m} trusts lead 1`,
    });
  }

  // --- Scenario 8: Neutral (revocation) - primary revokes trust for key 4 in commerce
  console.log('Scenario 8: Neutral/revocation...');
  const neutralTemplate = buildTrustEventTemplate({
    subjects: [makeSubject(keys[4]!.pubkey)],
    context: 'commerce',
    value: 0,
    content: 'Revoked commerce trust',
  });
  events.push({
    event: signAndFinalize(neutralTemplate, primarySk),
    desc: 'primary revokes commerce trust for key 4',
  });
  }

  // --- Publish to relays and insert into DB
  console.log(`\n📤 Publishing ${events.length} events to relays...`);

  let published = 0;
  let inserted = 0;

  for (const { event, desc } of events) {
    try {
      const accepted = await publishEvent(event, RELAYS);
      if (accepted.length > 0) {
        published++;
      }
      await insertEvent(event);
      inserted++;
    } catch (err) {
      console.error(`  ⚠️  Failed ${desc}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n✅ Published to relays: ${published}/${events.length}`);
  console.log(`✅ Inserted into DB: ${inserted}/${events.length}`);
  console.log(`\nTrust database: ${PATHS.trustDb}`);

  const { encodeNpub } = await import('../src/lib/nostr/nip19.js');

  if (fixture) {
    const resolvedPath = join(PATHS.configDir, 'trust-graph-seeded.json');
    const resolved = {
      keys: keys.map((k, i) => ({
        index: i,
        label: fixture!.keys[i]?.label,
        pubkey: k.pubkey,
        npub: encodeNpub(k.pubkey),
      })),
      connections: fixture.connections,
      expected: fixture.expected,
    };
    writeFileSync(resolvedPath, JSON.stringify(resolved, null, 2));
    console.log(`\nResolved graph: ${resolvedPath}`);
  }

  console.log('\nSample keys for testing (use TRUST_CONFIG_DIR=trust):');
  console.log(`  Key 0 (primary):  ${encodeNpub(keys[0]!.pubkey)} - issuer`);
  if (fixture && keys.length > 1) {
    console.log(`  Key 1 (direct):   ${encodeNpub(keys[1]!.pubkey)}`);
    if (keys.length > 9) console.log(`  Key 9 (unconn):   ${encodeNpub(keys[9]!.pubkey)}`);
    if (keys.length > 11) console.log(`  Key 11 (distrust): ${encodeNpub(keys[11]!.pubkey)}`);
  } else {
    console.log(`  Key 1 (lead):     ${encodeNpub(keys[1]!.pubkey)}`);
    if (keys[50]) console.log(`  Key 50:           ${encodeNpub(keys[50]!.pubkey)} - distrusted`);
    if (keys[80]) console.log(`  Key 80:           ${encodeNpub(keys[80]!.pubkey)} - spam`);
  }
  console.log('\nNext steps:');
  console.log('  TRUST_CONFIG_DIR=trust trust add <npub> -v 1 -c dev');
  console.log('  TRUST_CONFIG_DIR=trust trust resolve <subject-npub> [issuer-npub] -c dev');
  console.log('  TRUST_CONFIG_DIR=trust trust query <npub>');
}

main()
  .then(async () => {
    closePool();
    await closeTrustDb();
  })
  .catch(async (err) => {
    console.error(err);
    closePool();
    await closeTrustDb();
    process.exit(1);
  });
