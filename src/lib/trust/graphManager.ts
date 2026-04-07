import { VerifiedEvent } from 'nostr-tools';
import { Packr } from 'msgpackr';
import { Graph } from './graph/Graph.js';
import { getStore, Store } from '../db/dbManager.js';
import { asTrustEvent, isTrustEventValid, KIND_TRUST } from '../nostr/nip32010.js';
import { KIND_DELETE_REQUEST_EVENT as KIND_DELETE_REQUEST } from '../nostr/nip09.js';
import { KIND_USER_METADATA } from '../nostr/nip01.js';
import { RuntimeContext } from '../runtimeContext.js';
import { createTrustFilters } from '../../server/graph-sync.js';

const packr = new Packr({ structuredClone: false });

let graph: Graph | null = null;

export function getLoadedGraph(): Graph | null {
  return graph;
}

export function clearGraphMemory(): void {
  graph = null;
}

export async function getGraph(): Promise<Graph | null> {
  return graph;
}


export async function loadGraph(runtimeContext: RuntimeContext): Promise<Graph> {
  if (graph) return graph;

  graph = new Graph();
  runtimeContext.graph = graph;

  const authors = runtimeContext.authors;

  if(authors?.length) {
    await getGraphFromDB(runtimeContext);
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
