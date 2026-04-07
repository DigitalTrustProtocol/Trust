import { queryEvents } from '../lib/nostr/pool.js';
import { getAvailableRelays } from '../lib/nostr/pool.js';
import { KIND_TRUST } from '../lib/nostr/nip32010.js';
import { logger } from '../lib/logger.js';
import { initRuntimeContext } from './sync.js';

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
  dTag: string;
  relay?: string[];
  json?: boolean;
  source?: 'database' | 'server' | 'relay';
}): Promise<void> {
  const dTag = options.dTag.trim();
  const isJson = options.json ?? false;

  const source = options.source || '';
  let found = false;

  if (source === '' || source === 'database' || source === 'server') {
    const runtimeContext = await initRuntimeContext(options as Record<string, unknown>);
    const store = runtimeContext.store;
    if (!store) throw new Error('Store not loaded');
    const localResults = await store.query([{ kinds: [KIND_TRUST], '#d': [dTag], limit: 1 }]);
    const local = localResults[0] ?? null;
    if (local) {
      if (!isJson) logger.info('Event was found in local database.');
      found = true;
      if (isJson) {
        console.log(JSON.stringify(local));
      } else {
        prettyPrintEvent(local);
      }
    }
  }

  if (!found && (source === 'relay' || source === '')) {
    const relaySelection = await getAvailableRelays(options.relay);
    const relays = relaySelection.selected;
    if (!isJson && relaySelection.offline.length > 0) {
      logger.warn(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
    }
    const events = await queryEvents(
      { kinds: [KIND_TRUST], '#d': [dTag] },
      relays,
    );
    const remote = events[0] ?? null;
    if (remote) {
      if (!isJson) logger.info('Event was found via relays.');
      found = true;
      if (isJson) {
        console.log(JSON.stringify(remote));
      } else {
        prettyPrintEvent(remote);
      }
    }
  }

  if (!found) {
    if (isJson) {
      console.log(JSON.stringify({ error: 'not_found', dTag }));
      process.exitCode = 1;
    } else {
      logger.error(`Event not found: ${dTag}`);
      process.exit(1);
    }
  }
}
