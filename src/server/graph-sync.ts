import { NostrRelayMsg } from '@nostrify/nostrify';
import type { Filter, VerifiedEvent } from 'nostr-tools';
import { IGraph } from '../lib/trust/graph/Graph.js';
import { insertEvent } from '../lib/trust/graphManager.js';
import { KIND_TRUST } from '../lib/nostr/nip32010.js';
import { RuntimeContext } from '../lib/runtimeContext.js';

export const AUTHOR_CHUNK_SIZE = 100;

export interface GraphSyncResult {
  processedAuthors: number;
  eventsReceived: number;
  eventsInserted: number;
  latestTimestamp: number;
}

export async function runTrustedGraphSync(runtimeContext: RuntimeContext): Promise<GraphSyncResult> {
  const maxDepth = runtimeContext.maxDepth ?? 3;
  const quietTimeoutMs = runtimeContext.quietTimeoutMs ?? 1000;
  const kinds = runtimeContext.kinds ?? [KIND_TRUST];

  const visitedAuthors = new Set<string>();
  let eventsReceived = 0;
  let eventsInserted = 0;
  let latestTimestamp = 0;

  const signal = runtimeContext.abortController?.signal ?? new AbortSignal();

  while (!signal.aborted) {
    const bfsSeeds = bfsSeedsFromAuthor(runtimeContext.authors ?? []);
    const chunk = getUnseenTrustedAuthors(
      visitedAuthors,
      runtimeContext.graph as IGraph,
      bfsSeeds,
      maxDepth,
      runtimeContext.contexts,
    );
    if (!chunk.length) break; // No more unseen trusted authors

    chunk.forEach((author) => visitedAuthors.add(author));

    const filters = createTrustFilters(kinds, chunk, runtimeContext.since, runtimeContext.contexts);
    const iterable = runtimeContext.pool?.req(filters, { signal: runtimeContext.abortController?.signal ?? new AbortSignal() }) as AsyncIterable<NostrRelayMsg>;
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
          const inserted = await insertEvent(event, runtimeContext);  
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

    runtimeContext.logger?.info(`Processed ${visitedAuthors.size} authors. Received ${eventsReceived} events. Inserted ${eventsInserted} events.` as string);
  }

  return {
    processedAuthors: visitedAuthors.size,
    eventsReceived,
    eventsInserted,
    latestTimestamp,
  };
}

/** Comma-separated hex pubkeys; `author` must not be `*` (caller uses subscribe-all path). */
function bfsSeedsFromAuthor(authors: string[]): string[] {
  return authors.map((author) => author.trim().toLowerCase());
}

function getUnseenTrustedAuthors(
  seen: Set<string>,
  graph: IGraph,
  rootAuthors: string[],
  maxDepth: number,
  contexts?: string[],
): string[] {
  const result: string[] = [];

  const queue: Array<{ author: string; depth: number }> = [];
  for (const r of rootAuthors) {
    if (!seen.has(r) && result.length < AUTHOR_CHUNK_SIZE) {
      result.push(r);
    }
    queue.push({ author: r, depth: 0 });
  }

  while (queue.length && result.length < AUTHOR_CHUNK_SIZE) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const trustedList = (() => {
      if (contexts?.length) {
        const acc = new Set<string>();
        for (const c of contexts) {
          for (const t of graph.out(current.author, { context: c, value: 1, subjectType: 'p' })) {
            acc.add(t.subject);
          }
        }
        return acc;
      }
      return new Set(
        graph.out(current.author, { value: 1, subjectType: 'p' }).map((connection) => connection.subject),
      );
    })();
    for (const author of trustedList) {
      queue.push({ author, depth: current.depth + 1 });

      if (!seen.has(author)) {
        result.push(author);
        if(result.length >= AUTHOR_CHUNK_SIZE) break;
      }
    }
  }

  return result;
}

export function createTrustFilters(
  kinds: number[],
  authors?: string[],
  since?: number,
  contexts?: string[],
): Filter[] {
  const filter: Filter = { kinds};

  if (authors?.length) {
    filter.authors = authors;
  }

  if (since !== undefined) {
    filter.since = since;
  }

  if (contexts?.length) {
    filter['#c'] = contexts!;
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
