/**
 * Subject parsing for NIP-32010 trust events.
 * Parses user input into canonical subject representation.
 */

import { decode, extractPubkey, extractEventId } from '../nostr/nip19.js';

export type SubjectTag = 'p' | 'e' | 'a' | 'h' | 'r' | 'i';

export interface ParsedSubject {
  tag: SubjectTag;
  value: string;
  k?: string;
}

const HEX_64 = /^[a-fA-F0-9]{64}$/;

// NIP-33 addressable event: a:kind:pubkey:d
const ADDR_REGEX = /^(\d+):([a-fA-F0-9]{64}):(.+)$/;

function isNip73Id(input: string): { value: string; k: string } | null {
  const s = input.trim().toLowerCase();
  if (s.startsWith('isbn:')) return { value: s.replace(/-/g, ''), k: 'isbn' };
  if (s.startsWith('doi:')) return { value: s, k: 'doi' };
  if (s.startsWith('geo:')) return { value: s, k: 'geo' };
  if (s.startsWith('iso3166:')) return { value: s.toUpperCase(), k: 'iso3166' };
  if (s.startsWith('isan:')) return { value: s.replace(/-/g, ''), k: 'isan' };
  if (s.startsWith('podcast:guid:')) return { value: s, k: 'podcast:guid' };
  if (s.startsWith('podcast:item:guid:')) return { value: s, k: 'podcast:item:guid' };
  if (s.startsWith('podcast:publisher:guid:'))
    return { value: s, k: 'podcast:publisher:guid' };
  if (s.startsWith('bitcoin:tx:')) return { value: s, k: 'bitcoin:tx' };
  if (s.startsWith('bitcoin:address:')) return { value: s, k: 'bitcoin:address' };
  if (s.match(/^ethereum:\d+:tx:/)) return { value: s, k: 'ethereum:tx' };
  if (s.match(/^ethereum:\d+:address:/)) return { value: s, k: 'ethereum:address' };
  if (s.startsWith('#')) return { value: s, k: '#' };
  if (s.startsWith('https://') || s.startsWith('http://')) return { value: s, k: 'web' };
  return null;
}

/**
 * Parse a single subject input into canonical representation.
 * Supports: hex pubkey, hex event id, npub, nprofile, note, nevent, naddr (a tag),
 * URL (r tag), hash (h tag), NIP-73 IDs (isbn:, doi:, geo:, etc.).
 */
export function parseSubject(input: string): ParsedSubject {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Subject input cannot be empty');
  }

  // Hex pubkey (64 chars) - bare hex 64 treated as pubkey
  if (HEX_64.test(trimmed)) {
    return { tag: 'p', value: trimmed.toLowerCase() };
  }

  // NIP-19: npub, nprofile → p
  try {
    const decoded = decode(trimmed);
    if (decoded.type === 'npub' || decoded.type === 'nprofile') {
      const pubkey = extractPubkey(trimmed);
      return { tag: 'p', value: pubkey.toLowerCase() };
    }
    if (decoded.type === 'note' || decoded.type === 'nevent') {
      const eventId = extractEventId(trimmed);
      return { tag: 'e', value: eventId.toLowerCase() };
    }
    if (decoded.type === 'naddr') {
      const data = decoded.data as { kind: number; pubkey: string; identifier: string };
      const aTag = `${data.kind}:${data.pubkey.toLowerCase()}:${data.identifier}`;
      return { tag: 'a', value: aTag };
    }
  } catch {
    // Not NIP-19, continue
  }

  // nostr: URI
  if (trimmed.startsWith('nostr:')) {
    return parseSubject(trimmed.slice(6));
  }

  // NIP-33 a tag: kind:pubkey:d
  const addrMatch = trimmed.match(ADDR_REGEX);
  if (addrMatch) {
    const [, kind, pubkey, d] = addrMatch;
    return { tag: 'a', value: `${kind}:${pubkey.toLowerCase()}:${d}` };
  }

  // URL (r tag)
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const u = new URL(trimmed);
      const normalized = u.origin + u.pathname + u.search; // no fragment
      return { tag: 'r', value: normalized };
    }
  } catch {
    // Invalid URL
  }

  // Hash (h tag) - 64 hex, requires explicit prefix to distinguish from pubkey
  if (trimmed.toLowerCase().startsWith('h:') && HEX_64.test(trimmed.slice(2).trim())) {
    return { tag: 'h', value: trimmed.slice(2).trim().toLowerCase() };
  }

  // NIP-73 external content IDs (i tag)
  const nip73 = isNip73Id(trimmed);
  if (nip73) {
    return { tag: 'i', value: nip73.value, k: nip73.k };
  }

  // Plain URL without scheme - treat as r
  if (trimmed.includes('.') && (trimmed.includes('/') || trimmed.includes('.'))) {
    try {
      const url = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
      const u = new URL(url);
      const normalized = u.origin + u.pathname + u.search;
      return { tag: 'r', value: normalized };
    } catch {
      // fall through
    }
  }

  throw new Error(`Cannot parse subject: ${trimmed}`);
}

/**
 * Parse multiple subject inputs.
 */
export function parseSubjects(inputs: string[]): ParsedSubject[] {
  return inputs.map((input) => parseSubject(input));
}

/**
 * Resolve a target string for query/resolve to canonical identity.
 * Same parsing as parseSubject; returns tag and canonical value for DB lookup.
 */
export function resolveTargetForQuery(target: string): { tag: SubjectTag; value: string } {
  const parsed = parseSubject(target);
  return { tag: parsed.tag, value: parsed.value };
}
