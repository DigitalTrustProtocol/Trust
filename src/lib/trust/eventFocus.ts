import type { NostrEvent } from 'nostr-tools';
import { getContextFromTags, KIND_TRUST } from '../nostr/nip32010.js';
import type { FocusAxis, FocusResolution } from '../../config.js';

export function eventAuthorMatches(authors: FocusAxis, pubkey: string): boolean {
  const pk = pubkey.toLowerCase();
  if (authors === '') return true;
  return authors.includes(pk);
}

export function trustContextMatches(contexts: FocusAxis, contextTag: string): boolean {
  if (contexts === '') return true;
  const c = contextTag ?? '';
  return contexts.includes(c);
}

/**
 * Whether an event may be stored / applied to the graph under the current focus.
 * Authors axis applies to every kind; for kind 32010, the context axis also applies.
 */
export function eventAllowedByFocus(event: NostrEvent, focus: FocusResolution): boolean {
  if (!eventAuthorMatches(focus.authors, event.pubkey)) {
    return false;
  }
  if (event.kind !== KIND_TRUST) {
    return true;
  }
  const ctx = getContextFromTags(event);
  return trustContextMatches(focus.contexts, ctx);
}
