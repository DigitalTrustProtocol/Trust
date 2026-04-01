import { initTrustDb } from '../lib/db/dbManager.js';
import {
  getLatestTimestamp,
  setLatestTimestamp,
  getLastSeenTimestamp,
  setLastSeenTimestamp,
} from '../lib/timestamp.js';
import { logger } from '../lib/logger.js';

/**
 * View or update the stored timestamps.
 *
 * Options:
 *   --get            Print the raw latest timestamp value
 *   --set <value>    Set the latest timestamp to a specific unix value
 *   --setLastSeen <value>  Set the last seen timestamp to a specific unix value
 *   --rollforward    Set latest to last_seen + 1 (promotes last seen to latest, +1 to avoid duplicate fetch)
 *   --json           Print both timestamps as a JSON object
 *   (no options)     Print a human-readable status of both timestamps
 */
export async function timestampCommand(options: {
  get?: boolean;
  set?: string;
  setLastSeen?: string;
  rollforward?: boolean;
  json?: boolean;
}): Promise<void> {
  await initTrustDb();

  // --set <value>
  if (options.set !== undefined) {
    const num = parseInt(options.set, 10);
    if (isNaN(num)) {
      logger.error(`Invalid timestamp value "${options.set}". Must be a unix timestamp.`);
      process.exit(1);
    }
    await setLatestTimestamp(num);
    logger.info(`Latest timestamp set to ${num} (${new Date(num * 1000).toLocaleString()})`);
    return;
  }

  // --setLastSeen <value>
  if (options.setLastSeen !== undefined) {
    const num = parseInt(options.setLastSeen, 10);
    if (isNaN(num)) {
      logger.error(`Invalid timestamp value "${options.setLastSeen}". Must be a unix timestamp.`);
      process.exit(1);
    }
    await setLastSeenTimestamp(num);
    logger.info(`Last seen timestamp set to ${num} (${new Date(num * 1000).toLocaleString()})`);
    return;
  }

  // --rollforward: promote last_seen + 1 → latest
  if (options.rollforward) {
    const lastSeen = await getLastSeenTimestamp();
    const next = lastSeen !== undefined ? lastSeen + 1 : 0;
    await setLatestTimestamp(next);
    logger.info(`Latest timestamp rolled forward to ${next} (${new Date(next * 1000).toLocaleString()})`);
    return;
  }

  // --get: print raw latest timestamp value
  if (options.get) {
    const latest = await getLatestTimestamp();
    if (latest === undefined) {
      console.log('not set');
    } else {
      console.log(String(latest));
    }
    return;
  }

  // --json: output both values as JSON
  if (options.json) {
    const latest = await getLatestTimestamp();
    const lastSeen = await getLastSeenTimestamp();
    console.log(JSON.stringify({
      latest: latest ?? null,
      lastSeen: lastSeen ?? null,
    }, null, 2));
    return;
  }

  // Default: human-readable status
  const latest = await getLatestTimestamp();
  const lastSeen = await getLastSeenTimestamp();

  console.log('\nTimestamp status:');
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
