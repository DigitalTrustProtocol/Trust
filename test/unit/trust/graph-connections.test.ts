import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools';
import {
  asTrustEvent,
  buildTrustEventTemplate,
} from '../../../src/lib/nostr/nip32010.js';
import { Graph } from '../../../src/lib/trust/graph/Graph.js';

function sk(fill: number): Uint8Array {
  const k = new Uint8Array(32);
  k.fill(fill);
  return k;
}

const SK_AUTHOR = sk(0x51);
const SK_TARGET = sk(0x52);
const SK_OTHER = sk(0x53);

const PUB_AUTHOR = getPublicKey(SK_AUTHOR).toLowerCase();
const PUB_TARGET = getPublicKey(SK_TARGET).toLowerCase();
const PUB_OTHER = getPublicKey(SK_OTHER).toLowerCase();

function signTrust(template: EventTemplate, secret: Uint8Array) {
  return asTrustEvent(
    finalizeEvent({ ...template, created_at: 1_700_000_000 }, secret)
  );
}

describe('Graph trust connections', () => {
  it('lists outgoing and incoming trust connection payloads', () => {
    const graph = new Graph();
    const event = signTrust(
      buildTrustEventTemplate({
        subjects: [{ tag: 'p', value: PUB_TARGET }],
        context: 'development',
        value: 1,
        content: 'works well together',
      }),
      SK_AUTHOR,
    );

    graph.applyTrustEvent(event);

    const out = graph.out(PUB_AUTHOR, { context: 'development' });
    expect(out).toHaveLength(1);
    expect(out[0]!.author).toBe(PUB_AUTHOR);
    expect(out[0]!.subject).toBe(PUB_TARGET);
    expect(out[0]!.subjectType).toBe('p');
    expect(out[0]!.edge.value).toBe(1);
    expect(out[0]!.edge.context).toBe('development');
    expect(out[0]!.edge.content).toBe('works well together');

    const incoming = graph.in(PUB_TARGET, { context: 'development' });
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.author).toBe(PUB_AUTHOR);
    expect(incoming[0]!.subject).toBe(PUB_TARGET);
  });

  it('filters by trust value and subject type', () => {
    const graph = new Graph();
    graph.applyTrustEvent(signTrust(
      buildTrustEventTemplate({
        subjects: [{ tag: 'p', value: PUB_TARGET }],
        value: -1,
      }),
      SK_AUTHOR,
    ));
    graph.applyTrustEvent(signTrust(
      buildTrustEventTemplate({
        subjects: [{ tag: 'p', value: PUB_OTHER }],
        value: 1,
      }),
      SK_AUTHOR,
    ));

    const distrusted = graph.out(PUB_AUTHOR, { value: -1, subjectType: 'p' });
    expect(distrusted.map((c) => c.subject)).toEqual([PUB_TARGET]);
    expect(graph.out(PUB_AUTHOR, { value: 1, subjectType: 'p' }).map((c) => c.subject)).toEqual([PUB_OTHER]);
  });

  it('uses hierarchical context lookup from specific to general', () => {
    const graph = new Graph();
    graph.applyTrustEvent(signTrust(
      buildTrustEventTemplate({
        subjects: [{ tag: 'p', value: PUB_TARGET }],
        context: 'development',
        value: 1,
      }),
      SK_AUTHOR,
    ));

    expect(graph.out(PUB_AUTHOR, { context: 'development:web' })).toHaveLength(1);
    expect(graph.out(PUB_AUTHOR, { context: 'commerce' })).toHaveLength(0);
  });
});
