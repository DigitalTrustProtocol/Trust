import {
  getLatestSyncTime,
  setLatestSyncTime,
  getLastSeenSyncTime,
  setLastSeenSyncTime,
  SYNC_TIME_NS_SYNC,
} from '../lib/syncTime.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../config.js';
import { closeTrustDb, getStore } from '../lib/db/dbManager.js';

export async function syncTimeCommand(options: {
  get?: boolean;
  set?: string;
  setLastSeen?: string;
  rollforward?: boolean;
  reset?: boolean;
  json?: boolean;
}): Promise<void> {
  const cfg = getRuntimeConfig(options as Record<string, unknown>);
  const store = await getStore(cfg);
  if (!store) throw new Error('Store not loaded');

  try {
    if (options.reset) {
      await setLatestSyncTime(SYNC_TIME_NS_SYNC, 0);
      await setLastSeenSyncTime(SYNC_TIME_NS_SYNC, 0);
      logger.info('Sync cursor reset — next sync will start from the beginning');
      return;
    }

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

    if (options.rollforward) {
      const lastSeen = await getLastSeenSyncTime(SYNC_TIME_NS_SYNC);
      const next = lastSeen !== undefined ? lastSeen + 1 : 0;
      await setLatestSyncTime(SYNC_TIME_NS_SYNC, next);
      logger.info(`Latest sync time rolled forward to ${next} (${new Date(next * 1000).toLocaleString()})`);
      return;
    }

    if (options.get) {
      const latest = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
      if (latest === undefined) {
        console.log('not set');
      } else {
        console.log(String(latest));
      }
      return;
    }

    if (options.json) {
      const latest = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
      const lastSeen = await getLastSeenSyncTime(SYNC_TIME_NS_SYNC);
      console.log(JSON.stringify({
        latest: latest ?? null,
        lastSeen: lastSeen ?? null,
      }, null, 2));
      return;
    }

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
  } finally {
    await closeTrustDb(store);
  }
}
