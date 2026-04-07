import {
  getLatestSyncTime,
  setLatestSyncTime,
  getLastSeenSyncTime,
  setLastSeenSyncTime,
  SYNC_TIME_NS_SYNC,
} from '../lib/syncTime.js';
import { logger } from '../lib/logger.js';
import { initRuntimeContext } from './sync.js';

import { getRuntimeConfig } from '../config.js';
import { getRuntimeContext, setupStore } from '../lib/runtimeContext.js';

/**
 * View or update stored sync-time cursors (latest / last seen) for incremental fetching.
 *
 * Options:
 *   --get            Print the raw latest sync time value
 *   --set <value>    Set the latest sync time to a specific unix value
 *   --setLastSeen <value>  Set the last seen sync time to a specific unix value
 *   --rollforward    Set latest to last_seen + 1 (promotes last seen to latest, +1 to avoid duplicate fetch)
 *   --json           Print both values as a JSON object
 *   (no options)     Print a human-readable status of both sync times
 */
export async function syncTimeCommand(options: {
  get?: boolean;
  set?: string;
  setLastSeen?: string;
  rollforward?: boolean;
  json?: boolean;
}): Promise<void> {
  //const runtimeContext = await initRuntimeContext(options as Record<string, unknown>);
  const cfg = getRuntimeConfig(options as Record<string, unknown>);
  const runtimeContext = await getRuntimeContext(cfg);
  await setupStore(runtimeContext);
  const store = runtimeContext.store;
  if (!store) throw new Error('Store not loaded');

  // --set <value>
  if (options.set !== undefined) {
    const num = parseInt(options.set, 10);
    if (isNaN(num)) {
      logger.error(`Invalid sync time value "${options.set}". Must be a unix timestamp.`);
      process.exit(1);
    }
    await setLatestSyncTime(SYNC_TIME_NS_SYNC, num);
    logger.info(`Latest sync time set to ${num} (${new Date(num * 1000).toLocaleString()})`);
    return;
  }

  // --setLastSeen <value>
  if (options.setLastSeen !== undefined) {
    const num = parseInt(options.setLastSeen, 10);
    if (isNaN(num)) {
      logger.error(`Invalid sync time value "${options.setLastSeen}". Must be a unix timestamp.`);
      process.exit(1);
    }
    await setLastSeenSyncTime(SYNC_TIME_NS_SYNC, num);
    logger.info(`Last seen sync time set to ${num} (${new Date(num * 1000).toLocaleString()})`);
    return;
  }

  // --rollforward: promote last_seen + 1 → latest
  if (options.rollforward) {
    const lastSeen = await getLastSeenSyncTime(SYNC_TIME_NS_SYNC);
    const next = lastSeen !== undefined ? lastSeen + 1 : 0;
    await setLatestSyncTime(SYNC_TIME_NS_SYNC, next);
    logger.info(`Latest sync time rolled forward to ${next} (${new Date(next * 1000).toLocaleString()})`);
    return;
  }

  // --get: print raw latest sync time value
  if (options.get) {
    const latest = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
    if (latest === undefined) {
      console.log('not set');
    } else {
      console.log(String(latest));
    }
    return;
  }

  // --json: output both values as JSON
  if (options.json) {
    const latest = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
    const lastSeen = await getLastSeenSyncTime(SYNC_TIME_NS_SYNC);
    console.log(JSON.stringify({
      latest: latest ?? null,
      lastSeen: lastSeen ?? null,
    }, null, 2));
    return;
  }

  // Default: human-readable status
  const latest = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
  const lastSeen = await getLastSeenSyncTime(SYNC_TIME_NS_SYNC);

  console.log('\nSync time status:');
  if (latest !== undefined) {
    console.log(`  Latest (used by --since latest): ${latest} (${new Date(latest * 1000).toLocaleString()})`);
  } else {
    console.log('  Latest (used by --since latest): not set');
  }

  if (lastSeen !== undefined) {
    console.log(`  Last seen (auto-tracked):        ${lastSeen} (${new Date(lastSeen * 1000).toLocaleString()})`);
  } else {
    console.log('  Last seen (auto-tracked):        not set');
  }
  console.log('');
}
