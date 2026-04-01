import { NPool, NRelay1, NRelay1Opts } from '@nostrify/nostrify';
import type { VerifiedEvent, Filter, NostrEvent } from 'nostr-tools';
import { DEFAULT_RELAYS } from '../../config.js';
import { RelayProbeOptions, RelaySelection, selectAvailableRelays } from './relayManager.js';

/** Resolve relay list: use provided relays or fall back to DEFAULT_RELAYS. */
export function getRelays(relayOpt?: string[]): string[] {
  return relayOpt && relayOpt.length > 0 ? relayOpt : DEFAULT_RELAYS;
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
 * Returns array of relay URLs that accepted the event
 */
export async function publishEvent(
  event: VerifiedEvent,
  relays: string[] = DEFAULT_RELAYS
): Promise<string[]> {
  if (process.env.TRUST_E2E_OFFLINE === '1') {
    return relays;
  }
  const pool = getPool();




  try {
    // NPool.event() uses the eventRouter, but we can override with specific relays
    await pool.event(event, { relays });
    // If successful, all relays that accepted are returned
    // NPool.event() fulfills if ANY relay accepted
    return relays;
  } catch (error) {
    // All relays rejected
    return [];
  }
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
  if (localPool) {
    await localPool.close();
  }
  pool = null;
}
