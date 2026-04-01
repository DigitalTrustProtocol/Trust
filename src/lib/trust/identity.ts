/**
 * Identity handling for trust graph nodes.
 *
 * Handles metadata for all node types: pubkey (p), event (e), addressable (a),
 * hash (h), URL (r), and NIP-73 external IDs (i). User metadata (kind 0) parsing
 * for pubkey identities; display labels for URLs, hashes, and external IDs.
 */

import type { Event, VerifiedEvent } from 'nostr-tools';
import type { SubjectType, Identity } from '../nostr/nip32010.js';

const KIND_USER_METADATA = 0;

/** NIP-01 kind 0 user metadata fields (JSON content). */
export interface UserMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
  /** Custom fields; NIP-01 allows arbitrary keys. */
  [key: string]: string | undefined;
}

/**
 * Parse NIP-01 kind 0 user metadata from JSON content.
 * Returns null if content is invalid or empty.
 */
export function parseUserMetadata(content: string): UserMetadata | null {
  const trimmed = content?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const result: UserMetadata = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Parse user metadata from a kind 0 event.
 * Uses JSON content (NIP-01 standard); falls back to tags if content is empty
 * (for future NIP-1770 tag-based metadata).
 */
export function parseUserMetadataFromEvent(event: Event): UserMetadata | null {
  if (event.kind !== KIND_USER_METADATA) return null;

  const fromContent = parseUserMetadata(event.content);
  if (fromContent && Object.keys(fromContent).length > 0) return fromContent;

  // Fallback: parse from tags (future NIP-1770 or custom)
  const fromTags = parseUserMetadataFromTags(event.tags);
  return fromTags && Object.keys(fromTags).length > 0 ? fromTags : null;
}

/** Parse user metadata from event tags (tag-based format). */
function parseUserMetadataFromTags(tags: string[][]): UserMetadata | null {
  const result: UserMetadata = {};
  const metaTags = ['name', 'display_name', 'picture', 'banner', 'about', 'website', 'nip05', 'lud06', 'lud16'];
  for (const [name, value] of tags) {
    if (value && metaTags.includes(name.toLowerCase())) {
      result[name.toLowerCase()] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Build an Identity from UserMetadata (for pubkey nodes).
 */
export function identityFromUserMetadata(
  id: string,
  metadata: UserMetadata,
  source: string = 'kind0'
): Identity {
  return {
    value: id,
    tag: 'p',
    type: 'p',
    name: metadata.display_name ?? metadata.name,
    about: metadata.about,
    picture: metadata.picture,
    nip05: metadata.nip05,
    lud16: metadata.lud16 ?? metadata.lud06,
    website: metadata.website,
    banner: metadata.banner,
    source,
  };
}

/**
 * Parse kind 0 event and return Identity for the event's pubkey.
 */
export function parseIdentityFromKind0(event: VerifiedEvent): Identity | null {
  const metadata = parseUserMetadataFromEvent(event);
  if (!metadata) return null;
  const pubkey = event.pubkey.toLowerCase();
  return identityFromUserMetadata(pubkey, metadata, 'kind0');
}

/**
 * Format a human-readable label for non-pubkey identities.
 */
export function formatIdentityLabel(id: string, type: SubjectType): string {
  switch (type) {
    case 'e':
      return `Event ${id.slice(0, 8)}…`;
    case 'a': {
      const parts = id.split(':');
      return parts.length >= 3 ? `a:${parts[0]}:…:${parts[2]}` : id;
    }
    case 'h':
      return `Hash ${id.slice(0, 8)}…`;
    case 'r':
      try {
        const u = new URL(id.startsWith('http') ? id : `https://${id}`);
        return u.hostname || id;
      } catch {
        return id.length > 40 ? `${id.slice(0, 40)}…` : id;
      }
    case 'i':
      return id.length > 40 ? `${id.slice(0, 40)}…` : id;
    case 'p':
    default:
      return id.slice(0, 8) + '…';
  }
}

/**
 * Merge identity metadata; later values override earlier.
 * Useful when combining kind 0 with trust event content.
 */
export function mergeIdentity(target: Identity, source: Partial<Identity>): Identity {
  const result = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== null && v !== '') {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Check if an event is a user metadata event (kind 0).
 */
export function isUserMetadataEvent(event: Event): boolean {
  return event.kind === KIND_USER_METADATA;
}
