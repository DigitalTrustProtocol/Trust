import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';

const NIP98_KIND = 27235;
const DEFAULT_MAX_SKEW_SECONDS = 60;

type Nip98Ok = {
  ok: true;
  pubkey: string;
  eventId: string;
  createdAt: number;
};

type Nip98Fail = {
  ok: false;
  reason: string;
};

export type Nip98ValidationResult = Nip98Ok | Nip98Fail;

function getSingleTagValue(tags: string[][], key: string): string | undefined {
  const t = tags.find((tag) => tag[0] === key && typeof tag[1] === 'string');
  return t?.[1];
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildExpectedAbsoluteUrl(request: FastifyRequest): string {
  const host = request.headers.host;
  if (!host) return '';
  return `${request.protocol}://${host}${request.url}`;
}

function isBodyMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export function validateNip98Auth(request: FastifyRequest): Nip98ValidationResult {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return { ok: false, reason: 'missing Authorization: Nostr header' };
  }

  const b64 = authHeader.slice('Nostr '.length).trim();
  if (!b64) return { ok: false, reason: 'empty NIP-98 authorization payload' };

  let event: NostrEvent;
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    event = JSON.parse(decoded) as NostrEvent;
  } catch {
    return { ok: false, reason: 'invalid NIP-98 payload encoding' };
  }

  if (!verifyEvent(event)) {
    return { ok: false, reason: 'invalid NIP-98 signature' };
  }
  if (event.kind !== NIP98_KIND) {
    return { ok: false, reason: `invalid NIP-98 kind (expected ${NIP98_KIND})` };
  }

  const now = Math.floor(Date.now() / 1000);
  const maxSkew = Number(process.env.TRUST_NIP98_MAX_SKEW_SECONDS || DEFAULT_MAX_SKEW_SECONDS);
  if (Math.abs(now - event.created_at) > maxSkew) {
    return { ok: false, reason: `stale NIP-98 event (max skew ${maxSkew}s)` };
  }

  const methodTag = getSingleTagValue(event.tags as string[][], 'method');
  const requestMethod = request.method.toUpperCase();
  if (!methodTag || methodTag.toUpperCase() !== requestMethod) {
    return { ok: false, reason: 'NIP-98 method tag mismatch' };
  }

  const urlTag = getSingleTagValue(event.tags as string[][], 'u');
  const expectedUrl = buildExpectedAbsoluteUrl(request);
  if (!urlTag || !expectedUrl || urlTag !== expectedUrl) {
    return { ok: false, reason: 'NIP-98 URL tag mismatch' };
  }

  const payloadTag = getSingleTagValue(event.tags as string[][], 'payload');
  if (isBodyMethod(requestMethod)) {
    if (!payloadTag) {
      return { ok: false, reason: 'NIP-98 payload tag required for body methods' };
    }
    const bodyString = request.body === undefined ? '' : JSON.stringify(request.body);
    const digest = sha256Hex(bodyString);
    if (digest !== payloadTag) {
      return { ok: false, reason: 'NIP-98 payload hash mismatch' };
    }
  }

  return {
    ok: true,
    pubkey: event.pubkey.toLowerCase(),
    eventId: event.id,
    createdAt: event.created_at,
  };
}
