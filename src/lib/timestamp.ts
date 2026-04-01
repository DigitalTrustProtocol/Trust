import { KV_KEYS } from './db/kv.js';
import { kvGet, kvSet } from './db/kv.js';
import type { VerifiedEvent } from 'nostr-tools';
import { logger } from './logger.js';


export async function getLatestTimestamp(): Promise<number | undefined> {
  const val = await kvGet(KV_KEYS.LATEST_TIMESTAMP);
  return val !== undefined ? parseInt(val, 10) : undefined;
}

export async function setLatestTimestamp(ts: number): Promise<void> {
  await kvSet(KV_KEYS.LATEST_TIMESTAMP, String(ts));
}

export async function getLastSeenTimestamp(): Promise<number | undefined> {
  const val = await kvGet(KV_KEYS.LAST_SEEN_TIMESTAMP);
  return val !== undefined ? parseInt(val, 10) : undefined;
}

export async function setLastSeenTimestamp(ts: number): Promise<void> {
  await kvSet(KV_KEYS.LAST_SEEN_TIMESTAMP, String(ts));
}

export async function updateLastSeenTimestamp(createdAt: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const capped = Math.min(createdAt, now);
  const current = await getLastSeenTimestamp();
  const next = capped + 1;
  if (current === undefined || next > current) {
    await setLastSeenTimestamp(next);
  }
}


/**
 * Resolve a --since or --until value.
 * - If "latest", resolve to the stored latest_timestamp from the key/value store.
 * - If a numeric string, parse as integer (unix seconds).
 * - Returns undefined if the value is not provided or "latest" has no stored value.
 */
export async function resolveTimestampParam(value: string | undefined): Promise<number | undefined> {
  if (value === undefined) return undefined;

  if (value === 'latest') {
    const ts = await getLatestTimestamp();
    if (ts === undefined) {
      logger.error('No "latest" timestamp stored. Use `trust timestamp <value>` to set one.');
      process.exit(1);
    }
    return ts;
  }

  const num = parseInt(value, 10);
  if (isNaN(num)) {
    logger.error(`Invalid timestamp value "${value}". Must be a unix timestamp or "latest".`);
    process.exit(1);
  }
  return num;
}

/**
 * Track the latest created_at from a set of query results.
 * Updates last_seen_timestamp to max(created_at) + 1 of the returned events,
 * but only if that value is greater than what is already stored.
 * Caps at current time so a malformed or future-dated event cannot push the cursor.
 * Use `trust timestamp --rollforward` to promote last_seen to latest when ready.
 */
export async function trackLatestTimestamp(events: VerifiedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const maxCreatedAt = Math.max(...events.map(e => e.created_at));
  if (maxCreatedAt) await updateLastSeenTimestamp(maxCreatedAt);
  return maxCreatedAt;
}

/**
 * Promote last_seen + 1 to latest. Call before starting relay subscription
 * so the server starts from the most recent processed point.
 * No-op if last_seen is not set.
 * @returns The new latest timestamp, or undefined if last_seen was not set.
 */
export async function rollForwardTimestamp(): Promise<number | undefined> {
  const lastSeen = await getLastSeenTimestamp();
  if (lastSeen === undefined) return undefined;
  const next = lastSeen + 1;
  await setLatestTimestamp(next);
  return next;
}
