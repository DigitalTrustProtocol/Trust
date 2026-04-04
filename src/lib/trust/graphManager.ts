import { VerifiedEvent } from 'nostr-tools';
import { Packr } from 'msgpackr';
import { Graph } from './graph/Graph.js';
import { getStore, Store } from '../db/dbManager.js';
import { asTrustEvent, isTrustEventValid, KIND_TRUST } from '../nostr/nip32010.js';
import { NStore } from '@nostrify/nostrify';
import { KIND_DELETE_REQUEST_EVENT as KIND_DELETE_REQUEST } from '../nostr/nip09.js';
import { KIND_USER_METADATA } from '../nostr/nip01.js';
import { getPublicKey, getRuntimeConfig, toFocusResolution } from '../../config.js';
import type { FocusAxis, FocusResolution } from '../../config.js';
import { eventAllowedByFocus } from './eventFocus.js';
import { RuntimeContext } from '../runtimeContext.js';

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

export type LoadGraphArg = string | LoadGraphOptions;

export type LoadGraphOptions = {
  author?: string;
  maxDepth?: number;
  focus?: FocusResolution;
};

function normalizeLoadArgs(authorOrOpts?: LoadGraphArg, maxDepthArg?: number): LoadGraphOptions {
  if (authorOrOpts === undefined) {
    return { author: '*', maxDepth: maxDepthArg ?? 3 };
  }
  if (typeof authorOrOpts === 'string') {
    return { author: authorOrOpts, maxDepth: maxDepthArg ?? 3 };
  }
  return {
    ...authorOrOpts,
    maxDepth: authorOrOpts.maxDepth ?? maxDepthArg ?? 3,
  };
}

export async function loadGraph(runtimeContext: RuntimeContext): Promise<Graph> {
  if (graph) return graph;

  //const opts = normalizeLoadArgs(authorOrOpts, maxDepthArg);

  graph = new Graph();

  /*
  let authors =runtimeContext.authors;

  if (author === '*') {
    if (focus?.authors !== undefined && focus.authors !== '') {
      const roots = focus.authors;
      for (const root of roots) {
        await getGraphFromDB(root, maxDepth, store, graph, focus);
      }
    } else {
      await getGraphFromDBAllAuthors(store, graph, focus);
    }
  } else {
    await getGraphFromDB(author, maxDepth, store, graph, focus);
  }
*/
  return graph;
}

export async function insertEvent(event: VerifiedEvent, opts?: { store?: Store; graph?: Graph }): Promise<boolean> {
  const cfg = getRuntimeConfig();
  const focus = cfg ? toFocusResolution(cfg) : null;
  if (focus && !eventAllowedByFocus(event, focus)) {
    return false;
  }

  const store = opts?.store === undefined ? await getStore() : opts?.store;
  const g = opts?.graph === undefined ? graph : opts?.graph;

  if (event.kind === KIND_TRUST) {
    return await insertTrustEvent(event, store, g ?? undefined);
  }
  if (event.kind === KIND_USER_METADATA) {
    return await insertUserMetadataEvent(event, store, g ?? undefined);
  }
  if (event.kind === KIND_DELETE_REQUEST) {
    return await insertDeletionRequestEvent(event, store, g ?? undefined);
  }

  return await insertGenericEvent(event, store);
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

function focusToAllEventsOpts(focus?: FocusResolution | null): { authors?: FocusAxis; contexts?: FocusAxis } | undefined {
  if (!focus) return undefined;
  const o: { authors?: FocusAxis; contexts?: FocusAxis } = {};
  if (focus.authors !== '') o.authors = focus.authors;
  if (focus.contexts !== '') o.contexts = focus.contexts;
  return Object.keys(o).length ? o : undefined;
}

async function getGraphFromDBAllAuthors(
  store: Store,
  g: Graph,
  focus?: FocusResolution | null,
): Promise<void> {
  const evOpts = focusToAllEventsOpts(focus);

  for await (const event of store.allEvents(KIND_TRUST, evOpts)) {
    const trustEvent = asTrustEvent(event as VerifiedEvent);
    if (focus && !eventAllowedByFocus(trustEvent, focus)) continue;
    g.applyTrustEvent(trustEvent);
  }
}

async function getGraphFromDB(
  author: string,
  maxdepth: number,
  store: NStore,
  localGraph: Graph,
  focus?: FocusResolution | null,
): Promise<void> {
  const visited: Set<string> = new Set<string>();

  const queue = [author];
  let degree = 0;
  let nodeIndex = 0;

  while (queue.length > 0 && degree < maxdepth) {
    const degreeLength = queue.length;
    degree++;

    while (nodeIndex < degreeLength) {
      const a = queue[nodeIndex++]!;

      const events = await store.query([{ authors: [a], kinds: [KIND_TRUST] }]);

      for (const event of events) {
        const trustEvent = asTrustEvent(event as VerifiedEvent);
        if (focus && !eventAllowedByFocus(trustEvent, focus)) continue;
        localGraph.applyTrustEvent(trustEvent);
      }

      const subjects = localGraph.trustedSubjects(a);
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
