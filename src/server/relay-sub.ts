import { type VerifiedEvent, type Filter, verifyEvent } from 'nostr-tools';
import { getPool } from '../lib/nostr/pool.js';
import { KIND_TRUST, asTrustEvent } from '../lib/nostr/nip32010.js';
import { TIMESTAMP_NS_SYNC, trackLatestTimestamp, updateLastSeenTimestamp } from '../lib/timestamp.js';
import { getGraph, insertEvent } from '../lib/trust/graphManager.js';
import { chunksOf } from '../lib/utils.js';
import { NostrRelayMsg, NPool, NStore } from '@nostrify/nostrify';
import { Graph } from '../lib/trust/graph/Graph.js';

let eventIDSet = new Set<string>();

const MAX_AUTHOR_CHUNK_SIZE = 100;

export type SubscriptionStatus = {
  eventsReceived: number;
  eventsInserted: number;
  message?: string;
};
export type SubscriptionStatusCallback = (status: SubscriptionStatus) => void;

export type subscriptionOptions = {
  relays: string[];
  since: number | undefined;
  kinds?: number[];
  pool: NPool;
  onStatus?: SubscriptionStatusCallback;
  onEvent?: (event: VerifiedEvent) => Promise<void>;
  onClosed?: (subscriptionID: string, reason: string) => void;
  onEose?: (subscriptionID: string) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
};


/**
 * Start a continuous subscription to relays for kind 32010 events.
 * @param relays - Relay URLs to subscribe to
 * @param since - Optional unix timestamp; only events with created_at >= since are received
 * @param onEvent - Callback for each event (caller should insert to DB and trackLatestTimestamp)
 * @returns Function to request shutdown of the loop
 */
export async function startRelaySubscription(
  options: subscriptionOptions,
 
): Promise<void> {

  const { pool, signal } = options;
  
  const { since, onEvent, onClosed, onEose, onError } = options;
  const filters: Filter[] = [
    since !== undefined ? { kinds: options.kinds ?? [KIND_TRUST], since } : { kinds: options.kinds ?? [KIND_TRUST] },
  ];
  
  try {
    for await (const msg of pool.req(filters, options)) {
      if (msg[0] === 'EOSE') {
        if(onEose?.(msg[1] as string)) break;
      }
      if (msg[0] === 'EVENT') onEvent?.(msg[2] as VerifiedEvent);
      if (msg[0] === 'CLOSED') {
        if(onClosed?.(msg[1] as string, msg[2] as string)) break;
      }
    }
  } catch (error) {
    if(signal?.aborted) return;
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

export interface AuthorGraphSubscriptionOptions {
  /**
   * Relay URLs to subscribe to.
   */
  relays: string[];
  /**
   * Event kinds to subscribe to. Defaults to [32010] (trust events) but
   * callers may include additional related kinds (e.g. 32011, 32012).
   */
  kinds?: number[];
  /**
   * Optional unix timestamp; only events with created_at >= since are received.
   */
  since?: number;
  /**
   * Optional trust context to filter on (c tag). When provided,
   * only trust events in this context (and generic/global context \"\") are considered.
   */
  context?: string;
  /**
   * Maximum graph depth (degrees of trust) from the root author.
   * The NIP-32010/11/12 docs recommend depth 3.
   * Currently this implementation only uses the root author directly;
   * future versions may expand out to additional authors.
   */
  maxDepth?: number;
  /**
   * Whether to keep the subscription open for streaming new events.
   * When false, callers may choose to close after initial EOSE.
   */
  stayOpen?: boolean;
  /**
   * Maximum number of concurrent open subscriptions across relays.
   * This implementation uses a single subscription per call; the option
   * exists so callers and future implementations can enforce stricter limits.
   */
  maxOpenSubscriptions?: number;
  signal?: AbortSignal;

}

/**
 * Start a selective subscription for kind 32010 events **from a single author perspective**.
 *
 * This helper is intended to support the graph-based sync strategy described in NIP-32011
 * and NIP-32012: start from one author, pull their trust events, then expand the graph
 * outward by following trusted pubkeys up to a small depth (e.g. 3).  This first
 * implementation constrains the stream to a single root author (and optional context)
 * so that a client does not have to subscribe to *all* trust events globally.
 *
 * NOTE: today this function is effectively a thin wrapper that limits the subscription to
 * the root author (and optional context). Future implementations may expand the authors
 * set dynamically based on the incoming events and `maxDepth`/`maxOpenSubscriptions`.
 */
export async function startAuthorGraphSubscription(
  rootAuthors: string[],
  options: AuthorGraphSubscriptionOptions,
  onEvent: (event: VerifiedEvent) => void,
  onClosed: (subscriptionID: string, reason: string) => void = () => {},
  onEose: (subscriptionID: string) => void = () => {},
  onError: (error: Error) => void = () => {},
): Promise<() => void> {
  const pool = getPool();
  const { relays, since, context } = options;
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : [32010];

  const baseFilter: Filter = {
    kinds,
    authors: rootAuthors.map(author => author),
  };

  //let filters = [baseFilter];

  const filters: Filter[] = [
    since !== undefined ? { ...baseFilter, since } : baseFilter,
  ];

  // When a specific context is requested, we still want to include generic/global
  // trust (empty context) because that is considered global trust; the event
  // handler can decide how to interpret it.
  if (context && context.length > 0) {
    filters[0] = {
      ...filters[0],
      '#c': [context, ''],
    } as Filter;
  }

  let stopped = false;

  try {
    const iterable = pool.req(filters, { relays }) as AsyncIterable<unknown>;
    
    for await (const msg of iterable) {
      if (stopped) {
        break;
      }

      const [type, subscriptionID, payload] = msg as NostrRelayMsg;

      switch (type) {
        case 'EVENT':
          const event = payload as VerifiedEvent;
          if (kinds.includes(event.kind)) {
            onEvent( canonicalizeEvent(event) );
          }
          break;
        case 'EOSE':
          stopped = true;
          onEose( subscriptionID );
          break;
        case 'CLOSED':
          stopped = true;
          let reason = payload as string;
          onClosed( subscriptionID, reason );
          break;
        default:
          continue;
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    onError(err instanceof Error ? err : new Error(String(err)));
  }

  return async () => {
    stopped = true;
  };
}

function canonicalizeEvent(event: VerifiedEvent): VerifiedEvent {
  event.pubkey = event.pubkey.toLowerCase().trim();
  return event;
}


export async function iterativeTrustEventSubscription(
  author: string,
  options: AuthorGraphSubscriptionOptions,
): Promise<() => void> {
  let stopped = false;
  let maxDepth = options.maxDepth ?? 3;
  let subscription: () => void = () => { };


  let queue = [author];
  let visitedSubject = new Set<string>();
  let visitedEvent = new Set<string>();
  let nodeIndex = 0;
  let depth = 0;
  while (depth <= maxDepth && nodeIndex < queue.length && !stopped) {
    let degreeLength = queue.length;
    depth++;

    let subqueue = queue.slice(nodeIndex, degreeLength); //.filter(subject => !visitedSubject.has(subject));
    nodeIndex = degreeLength;

    //subqueue.forEach(subject => visitedSubject.add(subject));
    let chunks = chunksOf(subqueue, 100);

    for (const chunk of chunks) {
      if (stopped) break;
      subscription = await startAuthorGraphSubscription(chunk, options, async (event) => {
        if (visitedEvent.has(event.id)) return; // already inserted

        let inserted = await insertEvent(event);
        if (inserted) {
          visitedEvent.add(event.id);
          queue.push(event.pubkey);
          await trackLatestTimestamp(TIMESTAMP_NS_SYNC, [event]);
        }
      });
    }
  }

  return async () => {
    if (subscription) {
      subscription();
    }
    stopped = true;
  };
}

export async function queryAuthorGraph(
  author: string,
  store: NStore,
  graph: Graph,
  options: AuthorGraphSubscriptionOptions,
): Promise<void> {
  let depth = 0;
  let nodeIndex = 0;
  let maxDepth = options.maxDepth ?? 3;
  let visitedAuthor = new Set<string>();
  let queue = [author];
  let timestamp: number = 0;
  let opts = { relays: options.relays, signal: options.signal };

  while (queue.length > 0 && depth <= maxDepth) {
    if (options.signal?.aborted) break;
    let degreeLength = queue.length;
    depth++;

    let subqueue = queue.slice(nodeIndex, degreeLength);
    let authors = subqueue.filter(subject => !visitedAuthor.has(subject));
    if (authors.length === 0) break; // No new authors to visit
    authors.forEach(author => visitedAuthor.add(author)); // Mark as visited
    let authorChunks = chunksOf(authors, MAX_AUTHOR_CHUNK_SIZE);

    for (const chunk of authorChunks) {
      let filters = createTrustFilter(chunk, options);
      let events = await store.query(filters, opts); // Closes all subscriptions to the relays
      if (options.signal?.aborted) break;

      for (const event of events) {
        let trustEvent = asTrustEvent(event as VerifiedEvent);
        let inserted = await insertEvent(trustEvent);
        if (inserted) {
          timestamp = Math.max(timestamp, trustEvent.created_at);
      
          // Find the subjects of the the author and add them to the queue
          let subjects = graph.trustedSubjects(event.pubkey);
          subjects.forEach(subject => {
            if (visitedAuthor.has(subject)) return;
            visitedAuthor.add(subject);

            queue.push(subject);
          });

        }
      }
    }
  }

  if (timestamp > 0) {
    await updateLastSeenTimestamp(TIMESTAMP_NS_SYNC, timestamp);
  }
}

/*
export async function subscribeToGraph(
  author: string,
  pool: NPool,
  graph: Graph,
  stor: NStore, // Database store
  options: AuthorGraphSubscriptionOptions,
): Promise<void> {


  // Idea is to subscribe to the graph and then insert the events into the database
  // and then update the graph with the new events
  // and then subscribe to the graph again and so on until the graph have no more new authors to visit
  let maxDepth = options?.maxDepth ?? 3;
  let depth = 0;
  let visitedAuthor = new Set<string>();
  let queue = [author];
  let timestamp: number = 0;
  let opts = { relays: options.relays, signal: options.signal };
  let nodeIndex = 0;

  while (queue.length > 0 && depth <= maxDepth) {
    if (options.signal?.aborted) break;

    if (options.signal?.aborted) break;
    let degreeLength = queue.length;
    depth++;

    let subqueue = queue.slice(nodeIndex, degreeLength);
    let authors = subqueue.filter(subject => !visitedAuthor.has(subject));
    if (authors.length === 0) break; // No new authors to visit
    authors.forEach(author => visitedAuthor.add(author)); // Mark as visited
    let authorChunks = chunksOf(authors, MAX_AUTHOR_CHUNK_SIZE);
    nodeIndex = degreeLength;

    for (const chunk of authorChunks) {
      
      let filters = createTrustFilter(chunk, options);
      let request = await pool.req(filters, opts); // Closes all subscriptions to the relays

      for await (const event of request) { 
        if (event[0] === 'EVENT') {
          let trustEvent = asTrustEvent(event[2] as VerifiedEvent);
          let inserted = await insertEvent(trustEvent, { store: stor, graph: graph });
          if (inserted) {
            timestamp = Math.max(timestamp, trustEvent.created_at);
          }
        }
        if (event[0] === 'EOSE') {
          break;
        }
        if (event[0] === 'CLOSED') {
          break;
        }
      }




  }
}




*/


function getAuthorsByDegree(baseAuthor: string, depth: number, graph: Graph): string[] {
  return [];
}


function createTrustFilter(authors: string[], options: AuthorGraphSubscriptionOptions): Filter[] {
  let filter: Filter = {
    kinds: [KIND_TRUST],
    authors: authors,
  }
  if (options.since !== undefined) filter.since = options.since;
  if (options.context !== undefined) filter['#c'] = [options.context, ''];
  return [filter];
}

