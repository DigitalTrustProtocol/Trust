import { VerifiedEvent } from 'nostr-tools';
import { Packr } from 'msgpackr';
import os from 'node:os';
import { Graph } from './graph/Graph.js';
import { getStore, Store } from '../db/dbManager.js';
import { asTrustEvent, isTrustEventValid, KIND_TRUST } from '../nostr/nip32010.js';
import { KIND_DELETE_REQUEST_EVENT as KIND_DELETE_REQUEST } from '../nostr/nip09.js';
import { KIND_USER_METADATA } from '../nostr/nip01.js';
import { RuntimeContext } from '../runtimeContext.js';
import { createTrustFilters } from '../../server/graph-sync.js';

const packr = new Packr({ structuredClone: false });
const BYTES_PER_MILLION_NODES = 1024 * 1024 * 1024;
const NODES_PER_MEMORY_GB = 1_000_000;

let graph: Graph | null = null;

export type GraphLoadMode = 'all-authors' | 'author-perspective';

export interface GraphLoadPreflight {
  requestedMode: GraphLoadMode;
  selectedMode: GraphLoadMode;
  trustEventCount: number;
  estimatedNodeCount: number;
  estimatedRequiredBytes: number;
  memory: {
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
    processHeapUsedBytes: number;
    processRssBytes: number;
  };
  hasEnoughMemoryForAllAuthors: boolean;
}

export function getLoadedGraph(): Graph | null {
  return graph;
}

export function clearGraphMemory(): void {
  graph = null;
}

export async function getGraph(): Promise<Graph | null> {
  return graph;
}

export async function preflightGraphLoad(runtimeContext: RuntimeContext): Promise<GraphLoadPreflight> {
  const store = runtimeContext.store ?? (await getStore(runtimeContext));
  runtimeContext.store = store;

  const kinds = runtimeContext.kinds?.length ? runtimeContext.kinds : [KIND_TRUST];
  const countRes = await store.count([{ kinds }]);
  const trustEventCount = countRes.count ?? 0;
  const estimatedNodeCount = trustEventCount;
  const estimatedRequiredBytes = Math.ceil((estimatedNodeCount / NODES_PER_MEMORY_GB) * BYTES_PER_MILLION_NODES);

  const freeBytes = os.freemem();
  const availableBytes = freeBytes;
  const memoryUsage = process.memoryUsage();
  const requestedMode: GraphLoadMode = runtimeContext.authors?.length ? 'author-perspective' : 'all-authors';
  const hasEnoughMemoryForAllAuthors = availableBytes >= estimatedRequiredBytes;

  let selectedMode: GraphLoadMode = requestedMode;
  if (requestedMode === 'all-authors' && !hasEnoughMemoryForAllAuthors) {
    selectedMode = 'author-perspective';
  }
  if (requestedMode === 'author-perspective' && !hasEnoughMemoryForAllAuthors) {
    throw new Error(
      `Insufficient memory for author-perspective graph load: estimated ${estimatedRequiredBytes} bytes for ~${estimatedNodeCount} nodes, available ${availableBytes} bytes.`,
    );
  }

  return {
    requestedMode,
    selectedMode,
    trustEventCount,
    estimatedNodeCount,
    estimatedRequiredBytes,
    memory: {
      totalBytes: os.totalmem(),
      freeBytes,
      availableBytes,
      processHeapUsedBytes: memoryUsage.heapUsed,
      processRssBytes: memoryUsage.rss,
    },
    hasEnoughMemoryForAllAuthors,
  };
}

export async function loadGraph(runtimeContext: RuntimeContext): Promise<Graph> {
  if (graph) return graph;

  graph = new Graph();
  runtimeContext.graph = graph;

  const preflight = await preflightGraphLoad(runtimeContext);
  const authors = runtimeContext.authors;

  if (preflight.selectedMode === 'author-perspective') {
    if (authors?.length) {
      await getGraphFromDB(runtimeContext);
    } else {
      await getGraphFromDB({
        ...runtimeContext,
        authors: [runtimeContext.primaryPubkey],
      });
    }
  } else {
    await getGraphFromDBAllAuthors(runtimeContext);
  }

  return graph;
}

export async function insertEvent(event: VerifiedEvent, runtimeContext: RuntimeContext): Promise<boolean> {
  const {store, graph } = runtimeContext;

  if (event.kind === KIND_TRUST) {
    return await insertTrustEvent(event, store!, graph!);
  }
  if (event.kind === KIND_USER_METADATA) {
    return await insertUserMetadataEvent(event, store!, graph!);
  }
  if (event.kind === KIND_DELETE_REQUEST) {
    return await insertDeletionRequestEvent(event, store!, graph!);
  }

  return await insertGenericEvent(event, store!);
}

async function insertGenericEvent(event: VerifiedEvent, store?: Store): Promise<boolean> {
  const opt: Record<string, unknown> = {};
  await store?.event(event, opt);
  return (opt as { isInserted?: boolean }).isInserted ?? false;
}

async function insertDeletionRequestEvent(
  event: VerifiedEvent,
  store?: Store,
  graphInst?: Graph,
): Promise<boolean> {
  const opt: Record<string, unknown> = {};
  await store?.event(event, opt);
  void graphInst;
  return (opt as { isInserted?: boolean }).isInserted ?? false;
}

async function insertTrustEvent(event: VerifiedEvent, store?: Store, graphInst?: Graph): Promise<boolean> {
  const trustEvent = asTrustEvent(event);
  if (!isTrustEventValid(trustEvent)) return false;

  const opt: Record<string, unknown> = {};
  await store?.event(trustEvent, opt);

  let inserted = (opt as { isInserted?: boolean }).isInserted ?? false;
  const deleted = (opt as { isDeleted?: boolean }).isDeleted ?? false;

  if (graphInst && inserted) {
    inserted = graphInst.applyTrustEvent(trustEvent);
  }

  if (graphInst && deleted) {
    graphInst.removeTrustEvent(trustEvent);
  }

  return inserted;
}

async function insertUserMetadataEvent(event: VerifiedEvent, store?: Store, graphInst?: Graph): Promise<boolean> {
  const opt: Record<string, unknown> = {};
  await store?.event(event, opt);

  const inserted = (opt as { isInserted?: boolean }).isInserted ?? false;

  if (graphInst && inserted) {
    graphInst.applyUserMetadataEvent(event);
  }

  return inserted;
}

async function getGraphFromDBAllAuthors(runtimeContext: RuntimeContext): Promise<void> {
  const {graph, store, kinds, authors, contexts, abortController} = runtimeContext;

  for await (const event of store!.allEvents(
    kinds,
    authors ?? [],
    contexts ?? [],
    abortController?.signal ?? new AbortSignal(),
  )) {
    if (abortController?.signal?.aborted) break;
    const trustEvent = asTrustEvent(event as VerifiedEvent);
    graph!.applyTrustEvent(trustEvent);
  }
}
async function getGraphFromDB(runtimeContext: RuntimeContext): Promise<void> {
  const visited: Set<string> = new Set<string>();

  const { graph, store, kinds, authors, contexts, since, maxDepth } = runtimeContext;
  const queue = [...(authors ?? [])];
  let depth = 0;
  let nodeIndex = 0;

  while (queue.length > 0 && depth < maxDepth) {
    const queueLength = queue.length;
    depth++;

    while (nodeIndex < queueLength) {
      const a = queue[nodeIndex++]!;

      const filters = createTrustFilters(kinds, [a], since, contexts); // TODO: Possible to use multiple authors! Maybe batching is faster?!
      const events = await store!.query(filters);

      for (const event of events) {
        const trustEvent = asTrustEvent(event as VerifiedEvent);
        graph!.applyTrustEvent(trustEvent);
      }

      const subjects = graph!.trustedSubjects(a);
      for (const subject of subjects) {
        if (!visited.has(subject)) {
          visited.add(subject);
          queue.push(subject);
        }
      }
    }
  }
}

/** Apply a trust event already in the DB to an in-memory graph (no DB write). */
export function applyTrustEventToGraph(event: VerifiedEvent, graphInst: Graph): boolean {
  const trustEvent = asTrustEvent(event);
  if (!isTrustEventValid(trustEvent)) return false;
  return graphInst.applyTrustEvent(trustEvent);
}

/** Remove a trust event from the graph (e.g. after DB delete) using packed raw row. */
export function removeTrustEventFromGraphPacked(rawEvent: Uint8Array, graphInst: Graph): boolean {
  const ev = packr.unpack(rawEvent) as VerifiedEvent;
  const trustEvent = asTrustEvent(ev);
  if (!isTrustEventValid(trustEvent)) return false;
  return graphInst.removeTrustEvent(trustEvent);
}
