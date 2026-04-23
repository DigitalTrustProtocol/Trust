/**
 * Tests for IndexGraph + IndexResolver after migration from Graph / StandardResolver.
 *
 * Kind 32010 events may use legacy wire tags (e, a, h, r); `extractSubjects` stores subjects on
 * `IndexGraph` under canonical ids (see `canonicalizeSubjectValue` in nip32010).
 */

import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import indexResolver from '../../../src/lib/trust/resolvers/IndexResolver.js';
import {
  asTrustEvent,
  buildTrustEventTemplate,
  canonicalizeSubjectValue,
} from '../../../src/lib/nostr/nip32010.js';
import type { ParsedSubject } from '../../../src/lib/trust/subject.js';
import type { EventTemplate } from 'nostr-tools';
import { Graph } from '../../../src/lib/trust/graph/Graph.js';

/** Wire tags allowed on kind 32010 templates; `ParsedSubject` only covers parsed `p` / `i`. */
type TrustWireSubject =
  | ParsedSubject
  | { tag: 'e' | 'a' | 'h' | 'r'; value: string; k?: string };

/** Node id stored in `IndexGraph` after `applyTrustEvent` (matches `extractSubjects`). */
function graphSubjectId(sub: TrustWireSubject): string {
  return canonicalizeSubjectValue(sub.tag, sub.value);
}

/** Deterministic secp256k1 secret key (valid range) for tests. */
function sk(fill: number): Uint8Array {
  const k = new Uint8Array(32);
  k.fill(fill);
  return k;
}

const SK_AUTHOR = sk(0x41);
const SK_BRIDGE = sk(0x42);
const SK_TARGET_P = sk(0x43);

const PUB_AUTHOR = getPublicKey(SK_AUTHOR).toLowerCase();
const PUB_BRIDGE = getPublicKey(SK_BRIDGE).toLowerCase();
const PUB_TARGET_P = getPublicKey(SK_TARGET_P).toLowerCase();

const T0 = 1_700_000_000;

function signTrust(template: EventTemplate, secret: Uint8Array) {
  return asTrustEvent(
    finalizeEvent({ ...template, created_at: T0 }, secret)
  );
}

function edgeAuthorTrustsBridge(graph: Graph, context?: string) {
  const template = buildTrustEventTemplate({
    subjects: [{ tag: 'p', value: PUB_BRIDGE }],
    value: 1,
    ...(context !== undefined ? { context } : {}),
  });
  graph.applyTrustEvent(signTrust(template, SK_AUTHOR));
}

/** Bridge trusts `target`; graph: author → bridge → canonical subject node. */
function buildTwoHopGraph(target: TrustWireSubject, context?: string) {
  const graph = new Graph();
  edgeAuthorTrustsBridge(graph, context);

  const template = buildTrustEventTemplate({
    subjects: [target as unknown as ParsedSubject],
    context,
    value: 1,
  });
  graph.applyTrustEvent(signTrust(template, SK_BRIDGE));
  return graph;
}

/** Assert trust edges exist at the context buckets used by `IndexGraph.applyTrustEvent`. */
function expectTwoHopTopology(
  graph: Graph,
  author: string,
  bridge: string,
  canonicalSubjectId: string,
  ctx: string,
  /** Context bucket for the *target* subject (`p` vs `i` per `applyTrustEvent`). */
  subjectContext: 'p' | 'i'
) {
  const authorIdx = graph.nodesIndex.get(author);
  const bridgeIdx = graph.nodesIndex.get(bridge);
  const subjectIdx = graph.nodesIndex.get(canonicalSubjectId);
  expect(authorIdx, 'author node index').toBeDefined();
  expect(bridgeIdx, 'bridge node index').toBeDefined();
  expect(subjectIdx, 'subject node index').toBeDefined();

  const authorNode = graph.getNode(author);
  const bridgeNode = graph.getNode(bridge);
  const subjectNode = graph.getNode(canonicalSubjectId);
  expect(authorNode).toBeTruthy();
  expect(bridgeNode).toBeTruthy();
  expect(subjectNode).toBeTruthy();

  const pCtx = graph.getContextIndex(ctx, 'p');
  const iCtx = graph.getContextIndex(ctx, 'i');
  expect(pCtx, 'p-context bucket').toBeDefined();
  expect(iCtx, 'i-context bucket').toBeDefined();

  // Author → bridge (subject tag p uses p-context).
  const incomingToBridge = bridgeNode!.getIn([pCtx!]);
  expect(incomingToBridge.get(authorIdx!)).toBeDefined();

  const subjectCtxIdx = graph.getContextIndex(ctx, subjectContext);
  expect(subjectCtxIdx, `${subjectContext}-context for subject`).toBeDefined();
  const incomingToSubject = subjectNode!.getIn([subjectCtxIdx!]);
  expect(incomingToSubject.get(bridgeIdx!)).toBeDefined();
}

describe('IndexGraph (trust topology)', () => {
  it('stores author → bridge → p subject', () => {
    const target: TrustWireSubject = { tag: 'p', value: PUB_TARGET_P };
    const graph = buildTwoHopGraph(target);
    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(target), '', 'p');
  });

  it('stores author → bridge → e subject (canonical nostr:event id)', () => {
    const eventId = `${PUB_BRIDGE.slice(0, 32)}00ff00ff00ff00ff00ff00ff00ff00ff`;
    const target: TrustWireSubject = { tag: 'e', value: eventId };
    const graph = buildTwoHopGraph(target);
    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(target), '', 'i');
  });

  it('stores author → bridge → a subject (canonical nostr:addr)', () => {
    const aVal = `0:${PUB_BRIDGE}:trust-resolver-test-d`;
    const target: TrustWireSubject = { tag: 'a', value: aVal };
    const graph = buildTwoHopGraph(target);
    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(target), '', 'i');
  });

  it('stores author → bridge → h subject (canonical hash:)', () => {
    const hash = `${PUB_BRIDGE.slice(0, 32)}112233445566778899aabbccddeeff00`;
    const target: TrustWireSubject = { tag: 'h', value: hash };
    const graph = buildTwoHopGraph(target);
    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(target), '', 'i');
  });

  it('stores author → bridge → r subject (canonical web:)', () => {
    const url = 'https://example.com/trust-resolver-r-target';
    const target: TrustWireSubject = { tag: 'r', value: url };
    const graph = buildTwoHopGraph(target);
    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(target), '', 'i');
  });

  it('stores author → bridge → i subject', () => {
    const subj: ParsedSubject = {
      tag: 'i',
      value: 'isbn:9780000000001',
      k: 'isbn',
    };
    const graph = buildTwoHopGraph(subj);
    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(subj), '', 'i');
  });

  it('stores two-hop edges with non-empty context on both hops', () => {
    const graph = new Graph();
    const ctx = 'development';
    edgeAuthorTrustsBridge(graph, ctx);

    const eventId = 'f'.repeat(64);
    const target: TrustWireSubject = { tag: 'e', value: eventId };
    const templateBT = buildTrustEventTemplate({
      subjects: [target as unknown as ParsedSubject],
      context: ctx,
      value: 1,
    });
    graph.applyTrustEvent(signTrust(templateBT, SK_BRIDGE));

    expectTwoHopTopology(graph, PUB_AUTHOR, PUB_BRIDGE, graphSubjectId(target), ctx, 'i');
  });
});

describe('IndexResolver', () => {
  it('marks connected when author and subject are the same pubkey', () => {
    const graph = new Graph();
    const template = buildTrustEventTemplate({
      subjects: [{ tag: 'p', value: PUB_AUTHOR }],
      value: 1,
    });
    graph.applyTrustEvent(signTrust(template, SK_AUTHOR));

    const scores = indexResolver.resolve(PUB_AUTHOR, PUB_AUTHOR, { graph });
    expect(scores).toHaveLength(1);
    expect(scores[0]!.connected).toBe(true);
  });
});
