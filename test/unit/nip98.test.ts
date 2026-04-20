import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import type { FastifyRequest } from 'fastify';
import { validateNip98Auth } from '../../src/lib/nostr/nip98.js';

const SECRET_KEY_HEX = '1'.repeat(64);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildAuthHeader(event: NostrEvent): string {
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

function buildRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    headers: {
      host: 'example.test',
    },
    protocol: 'https',
    url: '/v1/trust',
    method: 'POST',
    body: { subjects: ['npub1test'], value: 1 },
    ...overrides,
  } as FastifyRequest;
}

function buildSignedNip98Event(params: {
  method?: string;
  url?: string;
  body?: unknown;
  createdAt?: number;
}) {
  const method = params.method ?? 'POST';
  const url = params.url ?? 'https://example.test/v1/trust';
  const body = params.body ?? { subjects: ['npub1test'], value: 1 };
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    tags.push(['payload', sha256Hex(JSON.stringify(body))]);
  }

  return finalizeEvent(
    {
      kind: 27235,
      created_at: createdAt,
      tags,
      content: '',
    },
    hexToBytes(SECRET_KEY_HEX),
  );
}

describe('validateNip98Auth', () => {
  const originalEnv = process.env.TRUST_NIP98_MAX_SKEW_SECONDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TRUST_NIP98_MAX_SKEW_SECONDS;
    } else {
      process.env.TRUST_NIP98_MAX_SKEW_SECONDS = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('accepts a valid signed NIP-98 event', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const body = { subjects: ['npub1test'], value: 1 };
    const event = buildSignedNip98Event({
      method: 'POST',
      url: 'https://example.test/v1/trust',
      body,
      createdAt: 1_700_000_000,
    });
    const request = buildRequest({
      body,
      headers: {
        host: 'example.test',
        authorization: buildAuthHeader(event),
      },
    });

    const result = validateNip98Auth(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pubkey).toBe(event.pubkey.toLowerCase());
    expect(result.eventId).toBe(event.id);
    expect(result.createdAt).toBe(event.created_at);
  });

  it('rejects when Authorization header is missing', () => {
    const request = buildRequest();

    const result = validateNip98Auth(request);

    expect(result).toEqual({
      ok: false,
      reason: 'missing Authorization: Nostr header',
    });
  });

  it('rejects stale events outside max skew', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    process.env.TRUST_NIP98_MAX_SKEW_SECONDS = '60';
    const event = buildSignedNip98Event({
      method: 'GET',
      url: 'https://example.test/v1/trust',
      createdAt: 1_699_999_900,
    });
    const request = buildRequest({
      method: 'GET',
      body: undefined,
      headers: {
        host: 'example.test',
        authorization: buildAuthHeader(event),
      },
    });

    const result = validateNip98Auth(request);

    expect(result).toEqual({
      ok: false,
      reason: 'stale NIP-98 event (max skew 60s)',
    });
  });

  it('rejects body methods without payload tag', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: 1_700_000_000,
        tags: [
          ['u', 'https://example.test/v1/trust'],
          ['method', 'POST'],
        ],
        content: '',
      },
      hexToBytes(SECRET_KEY_HEX),
    );
    const request = buildRequest({
      headers: {
        host: 'example.test',
        authorization: buildAuthHeader(event),
      },
    });

    const result = validateNip98Auth(request);

    expect(result).toEqual({
      ok: false,
      reason: 'NIP-98 payload tag required for body methods',
    });
  });

  it('rejects payload hash mismatches', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const event = buildSignedNip98Event({
      method: 'POST',
      url: 'https://example.test/v1/trust',
      body: { subjects: ['npub1test'], value: 1 },
      createdAt: 1_700_000_000,
    });
    const request = buildRequest({
      body: { subjects: ['npub1test'], value: 2 },
      headers: {
        host: 'example.test',
        authorization: buildAuthHeader(event),
      },
    });

    const result = validateNip98Auth(request);

    expect(result).toEqual({
      ok: false,
      reason: 'NIP-98 payload hash mismatch',
    });
  });
});
