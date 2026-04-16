import { NPool, NRelay1, NRelay1Opts } from '@nostrify/nostrify';
import type { VerifiedEvent, Filter } from 'nostr-tools';
import { DEFAULT_RELAYS, DEFAULT_REMOTE_RELAYS } from '../../config.js';
import { RelayProbeOptions, RelaySelection, selectAvailableRelays } from './relayManager.js';

const DEFAULT_RELAY_PUBLISH_TIMEOUT_MS = 2_000;

/** Resolve relay list: use provided relays or fall back to DEFAULT_RELAYS. */
export function getRelays(relayOpt?: string[] | string | undefined): string[] {
  if(process.env.TRUST_E2E_OFFLINE === '1') {
    return [];
  }
  if(typeof relayOpt === 'string') {
    return [relayOpt];
  }
  return relayOpt && relayOpt.length > 0 ? relayOpt : DEFAULT_REMOTE_RELAYS;
}

/**
 * Resolve relays and pre-filter by online availability.
 * Falls back to requested relays if all probes fail.
 */
export async function getAvailableRelays(
  relayOpt?: string[],
  options: RelayProbeOptions = {},
): Promise<RelaySelection> {
  return selectAvailableRelays(getRelays(relayOpt), options);
}


let pool: NPool | null = null;
export let connectionErrors: Map<string, number> = new Map();
export let logMessages: string[] = [];

export interface RelayPublishFailure {
  relay: string;
  error: string;
}

export interface PublishReport {
  attempted: string[];
  successful: string[];
  failed: RelayPublishFailure[];
}

/**
 * Get or create the relay pool
 */
export function getPool(
  eoseTimeout: number = 0,
  relays: string[] = DEFAULT_RELAYS,
): NPool {
  if(pool) {
    return pool;
  }


  let localpool = new NPool({
    open: (url: string) => {
      
      const opts: NRelay1Opts = {
        log: (log: any) => {
          const relayUrl = url;
          const logEntry = {
            ts: new Date().toISOString(),
            relayUrl,
            ...log,
          };
          logMessages.push(JSON.stringify(logEntry));
          /*
          if (log.level === 'warn' || log.level === 'error') {
            connectionErrors.set(relayUrl, (connectionErrors.get(relayUrl) || 0) + 1);
          }
          */
        }
      };
      return new NRelay1(url, opts);
      //return new NRelay1(url);
    },
    reqRouter: async (filters) => {
      //let openRelays = getOpenRelays();
      //console.log("openRelays", openRelays);
      //let openRelays : string[] = [];
      //openRelays.push("wss://relay.donotexist.io");
      return new Map(relays.map((url: string) => [url, filters]));
    },
    eventRouter: async () => relays,
    eoseTimeout
  });
  pool = localpool;

 
  return localpool;
}

/**
 * Publish an event to relays
 * Returns detailed per-relay publish result.
 */
export async function publishEventWithReport(
  event: VerifiedEvent,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishReport> {
  if (process.env.TRUST_E2E_OFFLINE === '1') {
    return {
      attempted: relays,
      successful: relays,
      failed: [],
    };
  }
  const pool = getPool(0, relays);
  const attempted = [...new Set(relays)];
  const timeoutMsRaw = Number(process.env.TRUST_RELAY_PUBLISH_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? timeoutMsRaw
    : DEFAULT_RELAY_PUBLISH_TIMEOUT_MS;

  const withTimeout = <T>(promise: Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Publish timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };

  const results = await Promise.all(attempted.map(async (relay) => {
    try {
      await withTimeout(pool.event(event, { relays: [relay] }));
      return { relay, ok: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { relay, ok: false as const, error: message };
    }
  }));

  return {
    attempted,
    successful: results.filter((result) => result.ok).map((result) => result.relay),
    failed: results
      .filter((result) => !result.ok)
      .map((result) => ({ relay: result.relay, error: result.error })),
  };
}

/**
 * Publish an event to relays
 * Returns array of relay URLs that accepted the event.
 */
export async function publishEvent(
  event: VerifiedEvent,
  relays: string[] = DEFAULT_RELAYS
): Promise<string[]> {
  const report = await publishEventWithReport(event, relays);
  return report.successful;
}

/**
 * Query events from relays
 */
export async function queryEvents(
  filter: Filter | Filter[],
  relays: string[] = DEFAULT_RELAYS
): Promise<VerifiedEvent[]> {
  const pool = getPool();
  const filters = Array.isArray(filter) ? filter : [filter];

  // Use NPool.query() which handles deduplication and replaceable events
  const events = await pool.query(filters, { relays });
  return events as VerifiedEvent[];
}

/**
 * Query a single event by ID
 */
export async function queryEventById(
  id: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<VerifiedEvent | null> {
  const events = await queryEvents({ ids: [id] }, relays);
  return events[0] || null;
}

/**
 * Close the pool and all connections
 */
export async function closePool(localPool?: NPool): Promise<void> {
  const poolToClose = localPool ?? pool;
  if (poolToClose) {
    await poolToClose.close();
  }
  pool = null;
}
