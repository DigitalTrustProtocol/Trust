import { NPool, NostrRelayMsg } from '@nostrify/nostrify';
import type { Filter, VerifiedEvent } from 'nostr-tools';
import { Graph } from '../lib/trust/graph/Graph.js';
import { insertEvent } from '../lib/trust/graphManager.js';
import { KIND_TRUST } from '../lib/nostr/nip32010.js';
import { Store } from '../lib/db/dbManager.js';

export const AUTHOR_CHUNK_SIZE = 100;

export interface GraphSyncParams {
  host: string;
  port: number;
  author: string;
  pool: NPool;
  store: Store;
  graph: Graph;
  relays: string[];
  since?: number;
  maxDepth?: number;
  kinds?: number[];
  context?: string;
  syncIntervalSeconds?: number;
  quietTimeoutMs?: number;
  json?: boolean;
  abortController?: AbortController;
  statusCallback?: (status: GraphSyncResult) => void;
}

export interface GraphSyncResult {
  processedAuthors: number;
  eventsReceived: number;
  eventsInserted: number;
  latestTimestamp: number;
}

export async function runTrustedGraphSync(params: GraphSyncParams): Promise<GraphSyncResult> {
  const maxDepth = params.maxDepth ?? 3;
  const quietTimeoutMs = params.quietTimeoutMs ?? 1000;
  const kinds = params.kinds ?? [KIND_TRUST];

  const visitedAuthors = new Set<string>();
  let eventsReceived = 0;
  let eventsInserted = 0;
  let latestTimestamp = 0;

  const rootAuthor = params.author;
  const signal = params.abortController?.signal ?? new AbortSignal();

  while (!signal.aborted) {
    const chunk = getUnseenTrustedAuthors(visitedAuthors, params.graph, rootAuthor, maxDepth, params.context);
    if (!chunk.length) break; // No more unseen trusted authors

    chunk.forEach((author) => visitedAuthors.add(author));

    const filters = createTrustFilters(chunk, kinds, params.since, params.context);
    const iterable = params.pool.req(filters, { signal: params.abortController?.signal ?? new AbortSignal() }) as AsyncIterable<NostrRelayMsg>;
    const iterator = iterable[Symbol.asyncIterator]();
    let timedOut = false;

    try {
      while (!signal.aborted) {
        const next = await nextWithTimeout(iterator, quietTimeoutMs);
        if (next === 'timeout') {
          timedOut = true;
          break;
        }
        if (next.done) break;

        const msg = next.value;
        const [type] = msg;

        if (type === 'EVENT') {
          const event = msg[2] as VerifiedEvent;

          eventsReceived++;
          const inserted = await insertEvent(event, { store: params.store, graph: params.graph });
          if (inserted) {
            eventsInserted++;
            latestTimestamp = Math.max(latestTimestamp, event.created_at);
          }
          continue;
        }

        if (type === 'EOSE' || type === 'CLOSED') {
          break;
        }
      }
    } finally {
      //if (timedOut && !reqAbortController.signal.aborted) {
        //reqAbortController.abort('quiet-timeout');
      //}
      await iterator.return?.();
      //params.signal?.removeEventListener('abort', onParentAbort);
    }

    params.statusCallback?.({
      processedAuthors: visitedAuthors.size,
      eventsReceived,
      eventsInserted,
      latestTimestamp,
    });
  }

  return {
    processedAuthors: visitedAuthors.size,
    eventsReceived,
    eventsInserted,
    latestTimestamp,
  };
}


function getUnseenTrustedAuthors(seen: Set<string>, graph: Graph, rootAuthor: string, maxDepth: number, context?: string): string[] {
  const result: string[] = [];

  if(!seen.has(rootAuthor)) {
    result.push(rootAuthor);
  }

  const queue: Array<{ author: string; depth: number }> = [{ author: rootAuthor, depth: 0 }];

  while (queue.length && result.length < AUTHOR_CHUNK_SIZE) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const trusted = graph.trustedSubjects(current.author, context, true);
    for (const author of trusted) {
      queue.push({ author, depth: current.depth + 1 });

      if (!seen.has(author)) {
        result.push(author);
        if(result.length >= AUTHOR_CHUNK_SIZE) break;
      }
    }
  }

  return result;
}

function createTrustFilters(authors: string[], kinds: number[], since?: number, context?: string): Filter[] {
  const filter: Filter = {
    kinds,
    authors,
  };

  if (since !== undefined) {
    filter.since = since;
  }

  if (context !== undefined) {
    filter['#c'] = [context, ''];
  }

  return [filter];
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | 'timeout'> {
  if (timeoutMs <= 0) return iterator.next();

  return new Promise<IteratorResult<T> | 'timeout'>((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    iterator
      .next()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
