import { kvKeyLatestSyncTime, kvKeyLastSeenSyncTime } from './db/kv.js';
import { kvGet, kvSet } from './db/kv.js';
import type { VerifiedEvent } from 'nostr-tools';
import { logger } from './logger.js';

/** Namespace for relay sync / incremental fetch cursors (`latest_timestamp:sync`, `last_seen_timestamp:sync`). */
export const SYNC_TIME_NS_SYNC = 'sync' as const;

export async function getLatestSyncTime(namespace: string): Promise<number | undefined> {
  const val = await kvGet(kvKeyLatestSyncTime(namespace));
  return val !== undefined ? parseInt(val, 10) : undefined;
}

export async function setLatestSyncTime(namespace: string, ts: number): Promise<void> {
  await kvSet(kvKeyLatestSyncTime(namespace), String(ts));
}

export async function getLastSeenSyncTime(namespace: string): Promise<number | undefined> {
  const val = await kvGet(kvKeyLastSeenSyncTime(namespace));
  return val !== undefined ? parseInt(val, 10) : undefined;
}

export async function setLastSeenSyncTime(namespace: string, ts: number): Promise<void> {
  await kvSet(kvKeyLastSeenSyncTime(namespace), String(ts));
}

export async function updateLastSeenSyncTime(namespace: string, createdAt: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const capped = Math.min(createdAt, now);
  const current = await getLastSeenSyncTime(namespace);
  const next = capped + 1;
  if (current === undefined || next > current) {
    await setLastSeenSyncTime(namespace, next);
  }
}

/**
 * Resolve a --since or --until value.
 * - If "latest", resolve to the stored latest sync time for `namespace`.
 * - If a numeric string, parse as integer (unix seconds).
 */
export async function resolveSyncTimeParam(
  value: string | undefined,
  namespace: string,
): Promise<number | undefined> {
  if (value === undefined) return undefined;

  if (value === 'latest') {
    const ts = await getLatestSyncTime(namespace);
    if (ts === undefined) {
      logger.error('No "latest" sync time stored. Use `trust sync-time --set <value>` to set one.');
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
 * Track the latest created_at from a set of query results for `namespace`.
 * Updates last_seen to max(created_at) + 1 when greater than stored.
 */
export async function trackLatestSyncTime(namespace: string, events: VerifiedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const maxCreatedAt = Math.max(...events.map((e) => e.created_at));
  if (maxCreatedAt) await updateLastSeenSyncTime(namespace, maxCreatedAt);
  return maxCreatedAt;
}

/**
 * Promote last_seen + 1 to latest for `namespace`.
 * @returns The new latest sync time, or undefined if last_seen was not set.
 */
export async function rollForwardSyncTime(namespace: string): Promise<number | undefined> {
  const lastSeen = await getLastSeenSyncTime(namespace);
  if (lastSeen === undefined) return undefined;
  const next = lastSeen + 1;
  await setLatestSyncTime(namespace, next);
  return next;
}
