/**
 * Trust event builder for NIP-32010.
 * Computes d-tag and builds kind 32010 event templates.
 *
 * Uses types + pure functions (nostr-tools style) instead of classes.
 */

import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import type { ParsedSubject } from '../trust/subject.js';
import { NostrClientMsg } from '@nostrify/nostrify';
import { RawData } from 'ws';

export const KIND_TRUST = 32010; // Minimum kind for trust events
export const KIND_TRUST_MIN = 32010; // Minimum kind for trust events
export const KIND_TRUST_MAX = 32999; // Maximum kind for trust events
export const MAX_CONTENT_LENGTH = 1024;
export const HEX_64 = /^[a-fA-F0-9]{64}$/;

export const NPUB_TAG = 'p';
export const SUBJECT_TAGS = ['p', 'i'] as const;
export const LEGACY_SUBJECT_TAGS = ['e', 'a', 'h', 'r'] as const;
export const NOSTR_I_TYPES = ['event', 'profile', 'pubkey', 'note', 'addr'] as const;

export type SubjectType = 'p' | 'i';
export type LegacySubjectType = (typeof LEGACY_SUBJECT_TAGS)[number];
export type NostrIType = (typeof NOSTR_I_TYPES)[number];

export type Identity ={
  type: string;
  tag: SubjectType;
  value: string;
  urlHint?: string;
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
  source?: string;
  /** Custom fields; NIP-01 allows arbitrary keys. */
  [key: string]: string | undefined;

}

/** Event with pre-resolved d_tag and context. Plain type, no methods. */
export type ITrustEvent = VerifiedEvent & {
  d_tag: string;
  t_tag?: string;
  p_tag?: string;
  c_tag?: string;
  addressableId: string;
};



export function getTagValueFromTags(event: Event, tag: string): string | undefined {
  return event.tags.find((t) => t[0] === tag)?.[1] ?? undefined;
}

/** Get d-tag from event tags. */
export function getDTagFromTags(event: Event): string {
  return event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
}

/** Get context from event tags. */
export function getContextFromTags(event: Event): string {
  return event.tags.find((t) => t[0] === 'c')?.[1] ?? '';
}


export function getValueFromTags(event: Event): 1 | 0 | -1 {
  const v = event.tags.find((t) => t[0] === 'v')?.[1];
  if (v === '1') return 1;
  if (v === '-1') return -1;
  return 0;
}

/** Get activate (x) tag — Unix timestamp when trust becomes valid. */
export function getActivateFromTags(event: Event): number | undefined {
  const x = event.tags.find((t) => t[0] === 'x')?.[1];
  if (!x) return undefined;
  const n = parseInt(x, 10);
  return isNaN(n) ? undefined : n;
}

/** Get expire (y) tag — Unix timestamp when trust expires. */
export function getExpireFromTags(event: Event): number | undefined {
  const y = event.tags.find((t) => t[0] === 'y')?.[1];
  if (!y) return undefined;
  const n = parseInt(y, 10);
  return isNaN(n) ? undefined : n;
}

export function canonicalizePubkeyValue(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalizeColonSeparatedSegments(value: string): string {
  return value
    .split(':')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(':');
}

export function canonicalizeNostrIValue(type: string, value: string): string {
  const normalizedType = canonicalizeColonSeparatedSegments(type).toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  return `nostr:${normalizedType}:${normalizedValue}`;
}

export function canonicalizeHashIValue(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^0x/, '')
    .replace(/[^a-f0-9]/g, '');
  return `hash:${normalized}`;
}

export function canonicalizeWebIValue(value: string): string {
  const normalized = value.trim();
  if (normalized === '') return 'web:';
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(normalized);
    const withScheme = hasScheme ? normalized : `https://${normalized}`;
    const u = new URL(withScheme);
    const protocol = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    const isDefaultPort = (protocol === 'http:' && u.port === '80') || (protocol === 'https:' && u.port === '443');
    const port = u.port && !isDefaultPort ? `:${u.port}` : '';
    const pathname = (u.pathname || '/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '') || '/';
    const search = u.search;
    return `web:${`${protocol}//${host}${port}${pathname}${search}`.toLowerCase()}`;
  } catch {
    const fallback = normalized
      .toLowerCase()
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '');
    return `web:${fallback}`;
  }
}

export function canonicalizeExtIValue(value: string): string {
  return `ext:${value.trim().toLowerCase()}`;
}

export function canonicalizeEmailIValue(value: string): string {
  return `email:${value.trim().toLowerCase()}`;
}

/**
 * Canonicalize context scopes:
 * - trim surrounding whitespace
 * - remove empty segments
 * - keep ':' only between non-empty segments
 * - lowercase for deterministic matching/derivation
 */
export function canonicalizeContextScope(context?: string | null): string {
  if (context === undefined || context === null) return '';
  const normalized = context.trim().toLowerCase();
  if (normalized === '') return '';
  return canonicalizeColonSeparatedSegments(normalized);
}

export function canonicalizeTypedSubjectIValue(value: string): string {
  const raw = value.trim().replace(/\s*:\s*/g, ':');
  const iMatch = raw.match(/^([^:]+):(.*)$/s);
  if (!iMatch) return raw.toLowerCase();

  const kind = iMatch[1]!.trim().toLowerCase();
  const rest = (iMatch[2] ?? '').trim();

  if (kind === 'nostr') {
    const nostrMatch = rest.match(/^([^:]+):(.*)$/s);
    if (!nostrMatch) return `nostr:${canonicalizeColonSeparatedSegments(rest).toLowerCase()}`;
    return canonicalizeNostrIValue(nostrMatch[1]!, nostrMatch[2] ?? '');
  }
  if (kind === 'hash') return canonicalizeHashIValue(rest);
  if (kind === 'web') return canonicalizeWebIValue(rest);
  if (kind === 'ext') return canonicalizeExtIValue(rest);
  if (kind === 'email') return canonicalizeEmailIValue(rest);

  return `${kind}:${rest.toLowerCase()}`;
}

export function canonicalizeLegacySubjectToI(tagName: LegacySubjectType, value: string): string {
  const normalized = value.trim();
  switch (tagName) {
    case 'e':
      return canonicalizeNostrIValue('event', normalized);
    case 'a':
      return canonicalizeNostrIValue('addr', normalized);
    case 'h':
      return canonicalizeHashIValue(normalized);
    case 'r':
      return canonicalizeWebIValue(normalized);
    default:
      return normalized.toLowerCase();
  }
}

export function canonicalizeSubjectValue(tagName: string, value: string): string {
  if (tagName === 'p') return canonicalizePubkeyValue(value);
  if (tagName === 'i') return canonicalizeTypedSubjectIValue(value);
  if (LEGACY_SUBJECT_TAGS.includes(tagName as LegacySubjectType)) {
    return canonicalizeLegacySubjectToI(tagName as LegacySubjectType, value);
  }
  return value.trim().toLowerCase();
}

/** Extract subject tags (p, i) from event. */
export function extractSubjects(event: Event): Identity[] {
  const tags = event.tags;
  const subjects: Identity[] = [];

  for (const tag of tags) {
    const [tagName, value, urlHint, nameHint] = tag; // Case sensitive tag name
    if (!tagName || !value) continue;
    const isSubject = SUBJECT_TAGS.includes(tagName as (typeof SUBJECT_TAGS)[number]);
    const isLegacySubject = LEGACY_SUBJECT_TAGS.includes(tagName as LegacySubjectType);
    if (!isSubject && !isLegacySubject) continue;

    const canonical = canonicalizeSubjectValue(tagName, value);
    switch (tagName) {
      case 'p':
        subjects.push({ type: 'p', tag: 'p', value: canonical, urlHint, name: nameHint, source: 'tags' });
        break;
      case 'i':
      case 'e':
      case 'a':
      case 'h':
      case 'r':
        // Legacy subject tags are normalized into typed i-subjects for compatibility.
        subjects.push({ type: 'i', tag: 'i', value: canonical, urlHint, name: nameHint, source: 'tags' });
        break;
      default:
        break;
    }
  }
  return subjects;
}

/** Return true if event has a valid d-tag. */
export function isTrustEventValid(event: ITrustEvent): boolean {
  return event.d_tag !== undefined && event.d_tag !== null && event.d_tag !== '';
}

/**
 * Mutates the event in place, adding d_tag and context. Returns the same object.
 * Idempotent: safe to call multiple times on the same event.
 */
export function asTrustEvent(event: Event): ITrustEvent {
  const e = event as ITrustEvent;
  e.d_tag = getTagValueFromTags(event, 'd') ?? '';
  e.t_tag = getTagValueFromTags(event, 't');
  e.p_tag = getTagValueFromTags(event, 'p');
  e.c_tag = getTagValueFromTags(event, 'c');

  e.addressableId = event.pubkey + e.d_tag; // the author and d_tag are the replacementId, as multiple events can have the same d_tag from different authors

  return e;
}

/**
 * Canonical UTF-8 string for d-tag derivation (before hex-vs-hash decision).
 * - `p`: lowercase 64-char hex (tag value)
 * - `i`: normalized typed subject id (e.g. `nostr:event:<value>`, `nostr:note:<value>`, `nostr:addr:<value>`, `hash:<hex>`, `web:<url>`, `ext:<id>`)
 */
export function canonicalStringForDTagPreimage(sub: ParsedSubject): string {
  switch (sub.tag) {
    case 'p':
      return sub.value.toLowerCase();
    case 'i':
      return sub.value.toLowerCase();
    default:
      return sub.value;
  }
}

/**
 * Per-subject material for `d`: 64 lowercase hex chars.
 * If the canonical preimage is itself 64 hex characters, use it verbatim.
 * Otherwise: SHA-256(UTF-8(preimage)) → lowercase hex.
 */
export function dTagSubjectFragmentHex(sub: ParsedSubject): string {
  const pre = canonicalStringForDTagPreimage(sub);
  if (HEX_64.test(pre)) {
    return pre.toLowerCase();
  }
  return bytesToHex(sha256(new TextEncoder().encode(pre)));
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

/** Drop duplicate 64-hex fragments (case: already lowercase); first occurrence order kept. */
function uniqueFragmentsInOrder(fragments: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fragments) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/**
 * Compute the d-tag for a trust event.
 * Each subject yields a 64-char lowercase hex fragment (raw hex id or SHA-256 of canonical preimage).
 * Before XOR, **identical fragments are deduplicated** (same 64-hex string appears once) so duplicate
 * subjects cannot cancel via F ⊕ F. Single unique fragment: that fragment; multiple unique: XOR of
 * their 32-byte decodes. Append `|context` when context is non-empty.
 *
 * Output format (NIP-32010): `<hex(64)>[|context]` — no kind prefix; use `kinds: [32010]`.
 */
export function computeDTag(subjects: ParsedSubject[], context?: string): string {
  if (subjects.length === 0) {
    throw new Error('At least one subject required');
  }

  const fragments = subjects.map((s) => dTagSubjectFragmentHex(s));
  const unique = uniqueFragmentsInOrder(fragments);
  let base: string;

  if (unique.length === 1) {
    base = unique[0]!;
  } else {
    let acc = hexToBytes(unique[0]!);
    for (let i = 1; i < unique.length; i++) {
      acc = xorBytes(acc, hexToBytes(unique[i]!));
    }
    base = bytesToHex(acc);
  }

  const canonicalContext = canonicalizeContextScope(context);
  if (canonicalContext !== '') return `${base}|${canonicalContext}`;
  return base;
}

export interface BuildTrustEventParams {
  subjects: ParsedSubject[];
  context?: string;
  value: 1 | 0 | -1;
  content?: string;
}

/**
 * Build a kind 32010 event template.
 * Enforces content ≤ 1024 chars, value ∈ {1, 0, -1}.
 */
export function buildTrustEventTemplate(params: BuildTrustEventParams): EventTemplate {
  const { subjects, context, value, content = '' } = params;
  const canonicalContext = canonicalizeContextScope(context);

  if (subjects.length === 0) {
    throw new Error('At least one subject required');
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Content must not exceed ${MAX_CONTENT_LENGTH} characters`);
  }

  if (value !== 1 && value !== 0 && value !== -1) {
    throw new Error('Value must be 1, 0, or -1');
  }

  const d = computeDTag(subjects, canonicalContext);

  const tags: string[][] = [['d', d], ['v', String(value)]];

  if (canonicalContext !== '') {
    tags.push(['c', canonicalContext]);
  }

  // Subject tags: p, i
  for (const subj of subjects) {
    tags.push([subj.tag, subj.value]);
  }

  return {
    kind: KIND_TRUST,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}



