/**
 * Regression tests for trustResolver: minimum 2-hop (degree-2) paths through the graph,
 * with a distinct target subject for each NIP-32010 subject tag (p, e, a, h, r, i).
 */

import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { Graph } from '../../../src/lib/trust/graph/Graph.js';
import trustResolver from '../../../src/lib/trust/resolvers/trustResolver.js';
import { asTrustEvent, buildTrustEventTemplate } from '../../../src/lib/nostr/nip32010.js';
import type { ParsedSubject } from '../../../src/lib/trust/subject.js';
import type { EventTemplate } from 'nostr-tools';

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

/** Author trusts bridge pubkey (general context, v=1). */
function edgeAuthorTrustsBridge(graph: Graph) {
  const template = buildTrustEventTemplate({
    subjects: [{ tag: 'p', value: PUB_BRIDGE }],
    value: 1,
  });
  graph.applyTrustEvent(signTrust(template, SK_AUTHOR));
}

/**
 * Bridge trusts the given subject; builds graph: author → bridge → target (2 hops).
 */
function buildTwoHopGraph(target: ParsedSubject, context?: string) {
  const graph = new Graph();
  edgeAuthorTrustsBridge(graph);

  const template = buildTrustEventTemplate({
    subjects: [target],
    context,
    value: 1,
  });
  graph.applyTrustEvent(signTrust(template, SK_BRIDGE));
  return graph;
}

function expectConnectedDegree2(
  graph: Graph,
  author: string,
  subjectId: string,
  opts?: { context?: string }
) {
  const scores = trustResolver.resolve(author, subjectId, {
    graph,
    context: opts?.context ?? '',
    followTrustThreshold: 1,
  });
  const score = scores[0]!;
  expect(score.connected, `expected connection to subject ${subjectId.slice(0, 12)}…`).toBe(
    true
  );
  expect(score.count).toBeGreaterThan(0);
  expect(score.degree).toBe(2);
  expect(score.trustValue).toBeGreaterThanOrEqual(1);
}

describe('trustResolver (graph strategy)', () => {
  it('resolves 2-hop trust for subject tag p (pubkey)', () => {
    const graph = buildTwoHopGraph({ tag: 'p', value: PUB_TARGET_P });
    expectConnectedDegree2(graph, PUB_AUTHOR, PUB_TARGET_P);
  });

  it('resolves 2-hop trust for subject tag e (event id)', () => {
    const eventId = `${PUB_BRIDGE.slice(0, 32)}00ff00ff00ff00ff00ff00ff00ff00ff`;
    const graph = buildTwoHopGraph({ tag: 'e', value: eventId });
    expectConnectedDegree2(graph, PUB_AUTHOR, eventId);
  });

  it('resolves 2-hop trust for subject tag a (addressable / replaceable)', () => {
    const aVal = `0:${PUB_BRIDGE}:trust-resolver-test-d`;
    const graph = buildTwoHopGraph({ tag: 'a', value: aVal });
    expectConnectedDegree2(graph, PUB_AUTHOR, aVal.toLowerCase());
  });

  it('resolves 2-hop trust for subject tag h (content hash)', () => {
    const hash = `${PUB_BRIDGE.slice(0, 32)}112233445566778899aabbccddeeff00`;
    const graph = buildTwoHopGraph({ tag: 'h', value: hash });
    expectConnectedDegree2(graph, PUB_AUTHOR, hash);
  });

  it('resolves 2-hop trust for subject tag r (URL)', () => {
    const url = 'https://example.com/trust-resolver-r-target';
    const graph = buildTwoHopGraph({ tag: 'r', value: url });
    expectConnectedDegree2(graph, PUB_AUTHOR, url.toLowerCase());
  });

  it('resolves 2-hop trust for subject tag i (external id + k scheme)', () => {
    const subj: ParsedSubject = {
      tag: 'i',
      value: 'isbn:9780000000001',
      k: 'isbn',
    };
    const graph = buildTwoHopGraph(subj);
    expectConnectedDegree2(graph, PUB_AUTHOR, subj.value.toLowerCase());
  });

  it('resolves 2-hop trust with non-empty context on both hops', () => {
    const graph = new Graph();
    const ctx = 'development';
    const templateAB = buildTrustEventTemplate({
      subjects: [{ tag: 'p', value: PUB_BRIDGE }],
      context: ctx,
      value: 1,
    });
    graph.applyTrustEvent(signTrust(templateAB, SK_AUTHOR));

    const eventId = 'f'.repeat(64);
    const templateBT = buildTrustEventTemplate({
      subjects: [{ tag: 'e', value: eventId }],
      context: ctx,
      value: 1,
    });
    graph.applyTrustEvent(signTrust(templateBT, SK_BRIDGE));

    expectConnectedDegree2(graph, PUB_AUTHOR, eventId, { context: ctx });
  });
});
