import * as nip19 from 'nostr-tools/nip19';

export type Nip19Type = 'npub' | 'nsec' | 'note' | 'nevent' | 'nprofile' | 'naddr';

export interface DecodeResult {
  type: Nip19Type;
  data: ReturnType<typeof nip19.decode>['data'];
}

/**
 * Decode a NIP-19 identifier
 */
export function decode(value: string): DecodeResult {
  const result = nip19.decode(value);
  return {
    type: result.type as Nip19Type,
    data: result.data,
  };
}

/**
 * Encode a public key to npub
 */
export function encodeNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

/**
 * Encode a secret key to nsec
 */
export function encodeNsec(seckey: Uint8Array): string {
  return nip19.nsecEncode(seckey);
}

/**
 * Encode an event ID to note
 */
export function encodeNote(eventId: string): string {
  return nip19.noteEncode(eventId);
}

/**
 * Encode an event pointer to nevent
 */
export function encodeNevent(
  eventId: string,
  relays?: string[],
  author?: string,
  kind?: number
): string {
  return nip19.neventEncode({
    id: eventId,
    relays,
    author,
    kind,
  });
}

/**
 * Encode a profile pointer to nprofile
 */
export function encodeNprofile(pubkey: string, relays?: string[]): string {
  return nip19.nprofileEncode({
    pubkey,
    relays,
  });
}

/**
 * Encode an addressable event to naddr
 */
export function encodeNaddr(
  kind: number,
  pubkey: string,
  identifier: string,
  relays?: string[]
): string {
  return nip19.naddrEncode({
    kind,
    pubkey,
    identifier,
    relays,
  });
}

/**
 * Check if a string is a valid NIP-19 identifier
 */
export function isNip19(value: string): boolean {
  try {
    nip19.decode(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract hex pubkey from npub or nprofile
 */
export function extractPubkey(value: string): string {
  const result = decode(value);
  if (result.type === 'npub') {
    return result.data as string;
  }
  if (result.type === 'nprofile') {
    return (result.data as nip19.ProfilePointer).pubkey;
  }
  throw new Error(`Cannot extract pubkey from ${result.type}`);
}

/**
 * Extract hex event ID from note or nevent
 */
export function extractEventId(value: string): string {
  const result = decode(value);
  if (result.type === 'note') {
    return result.data as string;
  }
  if (result.type === 'nevent') {
    return (result.data as nip19.EventPointer).id;
  }
  throw new Error(`Cannot extract event ID from ${result.type}`);
}
