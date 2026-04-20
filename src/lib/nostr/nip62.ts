import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';

export const KIND_VANISH_REQUEST = 62;
export const NIP62_ALL_RELAYS = 'ALL_RELAYS';

type Nip62Ok = {
  ok: true;
  pubkey: string;
  relayTargets: string[];
};

type Nip62Fail = {
  ok: false;
  reason: string;
};

export type Nip62ValidationResult = Nip62Ok | Nip62Fail;

function getRelayTargets(event: NostrEvent): string[] {
  return event.tags
    .filter((tag) => tag[0] === 'relay' && typeof tag[1] === 'string')
    .map((tag) => tag[1]!.trim())
    .filter((v) => v.length > 0);
}

export function validateNip62Event(host: string, event: NostrEvent): Nip62ValidationResult {
  const relayTargets = getRelayTargets(event);
  if (relayTargets.length === 0) {
    return { ok: false, reason: 'missing NIP-62 relay tag' };
  }

  if (!isNip62TargetingRelay(relayTargets, host)) 
    return { ok: false, reason: 'invalid: NIP-62 relay target mismatch' };
    
  return {
    ok: true,
    pubkey: event.pubkey.toLowerCase(),
    relayTargets,
  };
}

export function isNip62TargetingRelay(relayTargets: string[], host?: string): boolean {
  if (relayTargets.some((r) => r.toUpperCase() === NIP62_ALL_RELAYS)) return true;
  if (!host) return false;
  host = host.toLowerCase();
  return relayTargets.some((target) => target && target.toLowerCase().indexOf(host) >= 0);
}
