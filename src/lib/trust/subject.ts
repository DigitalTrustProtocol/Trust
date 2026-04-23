/**
 * Subject parsing for NIP-32010 trust events.
 * Parses user input into canonical subject representation.
 */

import { decode, extractPubkey, extractEventId } from '../nostr/nip19.js';

export type SubjectTag = 'p' | 'i';

export interface ParsedSubject {
  tag: SubjectTag;
  value: string;
  k?: string;
}

const HEX_64 = /^[a-fA-F0-9]{64}$/;

/** Optional legacy/explicit `tag:value` prefix used for input parsing. */
const EXPLICIT_SUBJECT = /^([pehari]):([\s\S]+)$/i;

/** `pubkey:<hex|npub|…>` — same as `p:` (identity subject, no `k`). */
const PUBKEY_PREFIX = /^pubkey:([\s\S]+)$/i;

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

function eventSubjectFromNip19Decoded(
  decoded: ReturnType<typeof decode>,
  eventIdLower: string
): ParsedSubject {
  if (decoded.type === 'note') {
    return { tag: 'i', value: `node:${eventIdLower}` };
  }
  if (decoded.type === 'nevent') {
    return { tag: 'i', value: `nevent:${eventIdLower}` };
  }
  throw new Error('internal: expected note or nevent');
}

function parseForcedPubkey(rest: string): ParsedSubject {
  const t = rest.trim();
  if (!t) throw new Error('Subject value cannot be empty after p: or pubkey:');
  if (HEX_64.test(t)) return { tag: 'p', value: t.toLowerCase() };
  try {
    const decoded = decode(t);
    if (decoded.type === 'npub' || decoded.type === 'nprofile') {
      return { tag: 'p', value: extractPubkey(t).toLowerCase() };
    }
  } catch {
    /* not NIP-19 */
  }
  if (t.toLowerCase().startsWith('nostr:')) return parseForcedPubkey(t.slice(6));
  throw new Error(`Cannot parse pubkey subject: ${t}`);
}

function parseForcedEvent(rest: string): ParsedSubject {
  const t = rest.trim();
  if (!t) throw new Error('Subject value cannot be empty after e:');
  if (HEX_64.test(t)) return { tag: 'i', value: `nevent:${t.toLowerCase()}` };
  try {
    const decoded = decode(t);
    if (decoded.type === 'note' || decoded.type === 'nevent') {
      return eventSubjectFromNip19Decoded(decoded, extractEventId(t).toLowerCase());
    }
  } catch {
    /* not NIP-19 */
  }
  if (t.toLowerCase().startsWith('nostr:')) return parseForcedEvent(t.slice(6));
  throw new Error(`Cannot parse event subject: ${t}`);
}

function parseForcedAddressable(rest: string): ParsedSubject {
  const t = rest.trim();
  if (!t) throw new Error('Subject value cannot be empty after a:');
  try {
    const decoded = decode(t);
    if (decoded.type === 'naddr') {
      const data = decoded.data as { kind: number; pubkey: string; identifier: string };
      const aTag = `${data.kind}:${data.pubkey.toLowerCase()}:${data.identifier}`;
      return { tag: 'i', value: `naddressable:${aTag}` };
    }
  } catch {
    /* not naddr */
  }
  const addrMatch = t.match(ADDR_REGEX);
  if (addrMatch) {
    const [, kind, pubkey, d] = addrMatch;
    return { tag: 'i', value: `naddressable:${kind}:${pubkey.toLowerCase()}:${d}` };
  }
  throw new Error(`Cannot parse addressable (a) subject: ${t}`);
}

function parseForcedHash(rest: string): ParsedSubject {
  const t = rest.trim();
  if (!t) throw new Error('Subject value cannot be empty after h:');
  if (!HEX_64.test(t)) {
    throw new Error(`h tag subject must be 64 hex characters: ${t}`);
  }
  return { tag: 'i', value: `hash:${t.toLowerCase()}` };
}

function parseForcedUrl(rest: string): ParsedSubject {
  const t = rest.trim();
  if (!t) throw new Error('Subject value cannot be empty after r:');
  const withScheme = t.startsWith('http://') || t.startsWith('https://') ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    const normalized = (u.origin + u.pathname + u.search).toLowerCase();
    return { tag: 'i', value: `url:${normalized}` };
  } catch {
    throw new Error(`Cannot parse URL subject: ${t}`);
  }
}

function parseForcedExternalId(rest: string): ParsedSubject {
  const t = rest.trim();
  if (!t) throw new Error('Subject value cannot be empty after i:');
  const nip73 = isNip73Id(t);
  if (nip73) {
    return { tag: 'i', value: `ext:${nip73.value}`, k: nip73.k };
  }
  throw new Error(`Cannot parse external id (i) subject: ${t}`);
}

/**
 * Parse a single subject input into canonical representation.
 *
 * **Optional prefix** `p:`, `pubkey:`, `e:`, `a:`, `h:`, `r:`, or `i:` can force input interpretation.
 * Bare 64-char hex is treated as a **`hash:`** typed `i` value (use `p:` / `pubkey:` to disambiguate).
 *
 * `note` / `nevent` / `naddr` are converted to typed `i` values:
 * `node:<event_hex>`, `nevent:<event_hex>`, `naddressable:<kind>:<pubkey>:<d>`.
 * URLs, hashes, and NIP-73 IDs are also normalized into typed `i` values.
 */
export function parseSubject(input: string): ParsedSubject {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Subject input cannot be empty');
  }

  const explicit = trimmed.match(EXPLICIT_SUBJECT);
  if (explicit) {
    const tag = explicit[1]!.toLowerCase();
    const rest = explicit[2]!;
    switch (tag) {
      case 'p':
        return parseForcedPubkey(rest);
      case 'e':
        return parseForcedEvent(rest);
      case 'a':
        return parseForcedAddressable(rest);
      case 'h':
        return parseForcedHash(rest);
      case 'r':
        return parseForcedUrl(rest);
      case 'i':
        return parseForcedExternalId(rest);
      default:
        break;
    }
  }

  const pubkeyPref = trimmed.match(PUBKEY_PREFIX);
  if (pubkeyPref) {
    return parseForcedPubkey(pubkeyPref[1]!);
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
      return eventSubjectFromNip19Decoded(decoded, eventId.toLowerCase());
    }
    if (decoded.type === 'naddr') {
      const data = decoded.data as { kind: number; pubkey: string; identifier: string };
      const aTag = `${data.kind}:${data.pubkey.toLowerCase()}:${data.identifier}`;
      return { tag: 'i', value: `naddressable:${aTag}` };
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
    return { tag: 'i', value: `naddressable:${kind}:${pubkey.toLowerCase()}:${d}` };
  }

  // URL
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const u = new URL(trimmed);
      const normalized = (u.origin + u.pathname + u.search).toLowerCase(); // no fragment
      return { tag: 'i', value: `url:${normalized}` };
    }
  } catch {
    // Invalid URL
  }

  // NIP-73 external content IDs (i tag)
  const nip73 = isNip73Id(trimmed);
  if (nip73) {
    return { tag: 'i', value: `ext:${nip73.value}`, k: nip73.k };
  }

  // Plain URL without scheme
  if (trimmed.includes('.') && (trimmed.includes('/') || trimmed.includes('.'))) {
    try {
      const url = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
      const u = new URL(url);
      const normalized = (u.origin + u.pathname + u.search).toLowerCase();
      return { tag: 'i', value: `url:${normalized}` };
    } catch {
      // fall through
    }
  }

  // Bare 64-char hex -> content hash typed i value.
  if (HEX_64.test(trimmed)) {
    return { tag: 'i', value: `hash:${trimmed.toLowerCase()}` };
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
 * Resolve a trust **subject** for resolve/query APIs.
 */
export function resolveTargetForQuery(target: string): { tag: SubjectTag; value: string } {
  const trimmed = target.trim();
  if (HEX_64.test(trimmed)) {
    return { tag: 'p', value: trimmed.toLowerCase() };
  }
  const parsed = parseSubject(target);
  return { tag: parsed.tag, value: parsed.value };
}

/**
 * Parse input that must denote an **author** pubkey. Bare 64-hex is treated as `p` (same as
 * `whoami` hex); this differs from `parseSubject`, where bare hex is an `h` hash.
 */
export function parseAuthorPubkeyInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Author input cannot be empty');
  }
  if (HEX_64.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const parsed = parseSubject(trimmed);
  if (parsed.tag !== 'p') {
    throw new Error('Author must be a pubkey (npub or hex)');
  }
  return parsed.value;
}
