import { describe, expect, it } from 'vitest';
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import {
  KIND_VANISH_REQUEST,
  NIP62_ALL_RELAYS,
  isNip62TargetingRelay,
  validateNip62Event,
} from '../../src/lib/nostr/nip62.js';

const SECRET_KEY_HEX = '2'.repeat(64);

function buildSignedNip62Event(params: {
  relayTags?: string[];
} = {}): NostrEvent {
  const relayTags = params.relayTags ?? ['ws://localhost:3417/relay'];

  return finalizeEvent(
    {
      kind: KIND_VANISH_REQUEST,
      created_at: 1_700_000_000,
      tags: relayTags.map((relay) => ['relay', relay]),
      content: 'vanish request',
    },
    hexToBytes(SECRET_KEY_HEX),
  );
}

describe('validateNip62Event', () => {
  it('accepts a valid signed NIP-62 event', () => {
    const event = buildSignedNip62Event({
      relayTags: ['ws://localhost:3417/relay', NIP62_ALL_RELAYS],
    });

    const result = validateNip62Event('localhost', event);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pubkey).toBe(event.pubkey.toLowerCase());
    expect(result.relayTargets).toEqual(['ws://localhost:3417/relay', NIP62_ALL_RELAYS]);
  });

  it('rejects events without relay tags', () => {
    const event = finalizeEvent(
      {
        kind: KIND_VANISH_REQUEST,
        created_at: 1_700_000_000,
        tags: [],
        content: 'vanish request',
      },
      hexToBytes(SECRET_KEY_HEX),
    );

    const result = validateNip62Event('localhost', event);

    expect(result).toEqual({
      ok: false,
      reason: 'missing NIP-62 relay tag',
    });
  });

  it('rejects when relay targets do not match current host', () => {
    const event = buildSignedNip62Event({
      relayTags: ['wss://other-relay.example/relay'],
    });

    const result = validateNip62Event('localhost', event);

    expect(result).toEqual({
      ok: false,
      reason: 'invalid: NIP-62 relay target mismatch',
    });
  });
});

describe('isNip62TargetingRelay', () => {
  it('accepts ALL_RELAYS targeting', () => {
    const result = isNip62TargetingRelay([NIP62_ALL_RELAYS], 'ws://localhost:3417/relay');
    expect(result).toBe(true);
  });

  it('accepts relay targeting by matching domain only', () => {
    const result = isNip62TargetingRelay(['wss://LOCALHOST/relay'], 'localhost');
    expect(result).toBe(true);
  });

  it('rejects when relay URL is not targeted', () => {
    const result = isNip62TargetingRelay(['ws://other-relay/relay'], 'ws://localhost:3417/relay');
    expect(result).toBe(false);
  });
});
