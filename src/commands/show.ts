import { getPool } from '../lib/nostr/pool.js';
import { KIND_TRUST } from '../lib/nostr/nip32010.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../config.js';
import { withLocalServerRelay } from '../lib/server-state.js';
import { NPool } from '@nostrify/nostrify';
import { getStore, closeStore } from '../lib/db/dbManager.js';
import type { Store } from '../lib/db/dbManager.js';

/** After the first relay sends EOSE, wait this long (ms) for stragglers before aborting the pool query. */
const SHOW_QUERY_EOSE_STRAGGLER_MS = 2_000;

function prettyPrintEvent(event: {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content?: string;
  tags: string[][];
}) {
  console.log('Event:');
  console.log(`  id:         ${event.id}`);
  console.log(`  pubkey:     ${event.pubkey}`);
  console.log(`  kind:       ${event.kind}`);
  console.log(
    `  created_at: ${event.created_at} (${new Date(event.created_at * 1000).toISOString()})`
  );
  if (event.content) {
    console.log(`  content:    ${event.content}`);
  }
  console.log('  tags:');
  for (const tag of event.tags) {
    console.log(`    ${JSON.stringify(tag)}`);
  }
}

export async function showTrustCommand(options: {
  dTag: string,
  relays?: string[],
  source?: 'relay' | 'database',
  json?: boolean
}): Promise<void> {
  const dTag = options.dTag.trim();
  const isJson = options.json ?? false;
  const source = options.source ?? 'relay';

  let pool: NPool | null = null;
  let store: Store | null = null;

  try {
    if (source === 'database') {
      // Query the local store by `d` tag. This lets `trust show` work offline and matches e2e expectations.
      const cfg = getRuntimeConfig({ ...options, authors: '*' });
      store = await getStore(cfg);
      const events = await store.query([{ kinds: [KIND_TRUST], '#d': [dTag] }], {});
      const local = events[0] ?? null;

      if (local) {
        if (isJson) console.log(JSON.stringify(local, null, 2));
        else prettyPrintEvent(local);
        return;
      }

      if (isJson) {
        console.log(JSON.stringify({ error: 'not_found', dTag }, null, 2));
      } else {
        logger.info('Event not found');
      }
      process.exitCode = 1;
      return;
    }

    let requestedRelays: string[] = options.relays ?? [];
    if (requestedRelays.length === 0) {
      const config = getRuntimeConfig(options);
      requestedRelays = withLocalServerRelay(config.relays);
    }

    pool = getPool(SHOW_QUERY_EOSE_STRAGGLER_MS, requestedRelays); // 2 seconds timeout
    const events = await pool.query([{ kinds: [KIND_TRUST], '#d': [dTag] }], { relays: requestedRelays });

    const remote = events[0] ?? null;
    if (remote) {
      if (isJson) {
        console.log(JSON.stringify(remote, null, 2));
      } else {
        prettyPrintEvent(remote);
      }
    } else {
      if (isJson) {
        console.log(JSON.stringify({ error: 'not_found', dTag }, null, 2));
      } else {
        logger.info(`Event not found`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error(error);
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.close();
    }
    if (store) {
      await closeStore(store);
    }
  }
}
