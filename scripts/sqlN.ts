#!/usr/bin/env npx tsx

import { existsSync, rmSync } from 'node:fs';
import type { NostrEvent } from '@nostrify/types';
import { createNSQLiteStore } from '../src/lib/db/NSQLite.js';
import { KIND_TRUST } from '../src/lib/nip32010.js';

type BenchConfig = {
  dbPath: string;
  rows: number;
  updateRows: number;
  authorCount: number;
  batchSize: number;
  multiReads: number;
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseConfig(argv: string[]): BenchConfig {
  const map = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.split('=');
    if (inlineValue !== undefined) {
      map.set(key, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      map.set(key, next);
      i++;
    } else {
      map.set(key, 'true');
    }
  }

  return {
    dbPath: map.get('--db') ?? './nostr-bench.db',
    rows: parseNumber(map.get('--rows'), 1_000),
    updateRows: parseNumber(map.get('--update-rows'), 100),
    authorCount: parseNumber(map.get('--authors'), 1000),
    batchSize: parseNumber(map.get('--batch-size'), 1000),
    multiReads: parseNumber(map.get('--reads'), 100_000),
  };
}

function toHex(input: number, len: number): string {
  return input.toString(16).padStart(len, '0').slice(-len);
}

function makePubkey(index: number): string {
  return toHex(index, 64);
}

function makeEventId(authorIndex: number, slotIndex: number, updateRevision: number): string {
  const a = toHex(authorIndex, 16);
  const s = toHex(slotIndex, 40);
  const r = toHex(updateRevision, 8);
  return `${a}${s}${r}`;
}

function makeTrustEvent(authorIndex: number, slotIndex: number, createdAt: number, revision: number): NostrEvent {
  const pubkey = makePubkey(authorIndex);
  const subject = makePubkey(slotIndex + 1_000_000);
  const dTag = `bench-${subject}`;

  return {
    id: makeEventId(authorIndex, slotIndex, revision),
    pubkey,
    created_at: createdAt,
    kind: KIND_TRUST,
    tags: [
      ['d', dTag],
      ['v', '1'],
      ['c', 'bench'],
      ['p', subject],
    ],
    content: '',
    sig: '0'.repeat(128),
  };
}

function elapsedMs(start: number): number {
  return performance.now() - start;
}

function printRate(label: string, items: number, ms: number): void {
  const sec = ms / 1000;
  const rate = sec > 0 ? items / sec : 0;
  console.log(`${label}: ${items.toLocaleString()} in ${sec.toFixed(3)}s (${Math.round(rate).toLocaleString()}/s)`);
}

async function insertScenario(
  store: Awaited<ReturnType<typeof createNSQLiteStore>>,
  rows: number,
  authorCount: number,
  batchSize: number,
): Promise<void> {
  console.log('\nScenario 1: Insert trust events');
  const start = performance.now();
  let inserted = 0;
  let createdAt = 1_700_000_000;

  while (inserted < rows) {
    const take = Math.min(batchSize, rows - inserted);
    await store.transaction(async (txStore) => {
      for (let i = 0; i < take; i++) {
        const global = inserted + i;
        const authorIndex = global % authorCount;
        const slotIndex = Math.floor(global / authorCount);
        const event = makeTrustEvent(authorIndex, slotIndex, createdAt++, 1);
        await txStore.event(event);
      }
    });

    inserted += take;
    if (inserted % 100_000 === 0 || inserted === rows) {
      process.stdout.write(`\r  inserted ${inserted.toLocaleString()} / ${rows.toLocaleString()}`);
    }
  }
  process.stdout.write('\n');
  printRate('Insert throughput', rows, elapsedMs(start));
}

async function updateScenario(
  store: Awaited<ReturnType<typeof createNSQLiteStore>>,
  rowsToUpdate: number,
  authorCount: number,
  batchSize: number,
  startCreatedAt: number,
): Promise<void> {
  console.log('\nScenario 2: Update existing replaceable/addressable trust events');
  const start = performance.now();
  let updated = 0;
  let createdAt = startCreatedAt;

  while (updated < rowsToUpdate) {
    const take = Math.min(batchSize, rowsToUpdate - updated);
    await store.transaction(async (txStore) => {
      for (let i = 0; i < take; i++) {
        const global = updated + i;
        const authorIndex = global % authorCount;
        const slotIndex = Math.floor(global / authorCount);
        const event = makeTrustEvent(authorIndex, slotIndex, createdAt++, 2);
        await txStore.event(event);
      }
    });

    updated += take;
    if (updated % 100_000 === 0 || updated === rowsToUpdate) {
      process.stdout.write(`\r  updated ${updated.toLocaleString()} / ${rowsToUpdate.toLocaleString()}`);
    }
  }
  process.stdout.write('\n');
  printRate('Update throughput', rowsToUpdate, elapsedMs(start));
}

async function singleAuthorReadScenario(
  store: Awaited<ReturnType<typeof createNSQLiteStore>>,
  authorIndex: number,
): Promise<void> {
  console.log('\nScenario 3: Read events for one specific author');
  const pubkey = makePubkey(authorIndex);
  const start = performance.now();
  const events = await store.query([{ kinds: [KIND_TRUST], authors: [pubkey] }]);
  const ms = elapsedMs(start);
  printRate(`Author read (${pubkey.slice(0, 8)}...)`, events.length, ms);
}

async function manyAuthorsReadScenario(
  store: Awaited<ReturnType<typeof createNSQLiteStore>>,
  authorCount: number,
  reads: number,
): Promise<void> {
  console.log(`\nScenario 4: ${reads.toLocaleString()} reads from different authors`);
  const start = performance.now();
  let totalEvents = 0;

  for (let i = 0; i < reads; i++) {
    const authorIndex = i % authorCount;
    const pubkey = makePubkey(authorIndex);
    const events = await store.query([{ kinds: [KIND_TRUST], authors: [pubkey] }], { limit: 200 });
    totalEvents += events.length;
  }

  const ms = elapsedMs(start);
  const readOpsPerSec = reads / (ms / 1000);
  console.log(
    `Read ops: ${reads.toLocaleString()} in ${(ms / 1000).toFixed(3)}s (${Math.round(readOpsPerSec).toLocaleString()} reads/s)`,
  );
  console.log(`Total events returned across reads: ${totalEvents.toLocaleString()}`);
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));

  console.log('NSQLite trust-event performance benchmark');
  console.log(`DB: ${cfg.dbPath}`);
  console.log(`Rows: ${cfg.rows.toLocaleString()}`);
  console.log(`Update rows: ${cfg.updateRows.toLocaleString()}`);
  console.log(`Authors: ${cfg.authorCount.toLocaleString()}`);
  console.log(`Batch size: ${cfg.batchSize.toLocaleString()}`);
  console.log(`Multi-author reads: ${cfg.multiReads.toLocaleString()}`);

  //if (existsSync(cfg.dbPath)) {
    //rmSync(cfg.dbPath);
  //}

  const store = await createNSQLiteStore(cfg.dbPath);
  try {
    await insertScenario(store, cfg.rows, cfg.authorCount, cfg.batchSize);
    await updateScenario(store, cfg.updateRows, cfg.authorCount, cfg.batchSize, 1_800_000_000);
    await singleAuthorReadScenario(store, 0);
    await manyAuthorsReadScenario(store, cfg.authorCount, cfg.multiReads);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
  