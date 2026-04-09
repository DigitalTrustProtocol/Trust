import { sha256 } from '@noble/hashes/sha2';
import { getPublicKey } from 'nostr-tools/pure';

export const BRANCHING = 100;
export const LEVEL1 = BRANCHING;
export const LEVEL2 = BRANCHING * BRANCHING;
export const LEVEL3 = BRANCHING * BRANCHING * BRANCHING;
export const TOTAL_EDGES = LEVEL1 + LEVEL2 + LEVEL3;
export const LOAD_TEST_NAMESPACE = process.env.TRUST_LOAD_NAMESPACE ?? 'trust-heavy-load-v1';

export type DeterministicKey = {
  sk: Uint8Array;
  pubkey: string;
};

export function keyFor(label: string): DeterministicKey {
  const digest = sha256(new TextEncoder().encode(`${LOAD_TEST_NAMESPACE}:${label}`));
  const sk = digest.slice(0, 32);
  const pubkey = getPublicKey(sk).toLowerCase();
  return { sk, pubkey };
}

export function authorKey(): DeterministicKey {
  return keyFor('author');
}

export function level1Key(i: number): DeterministicKey {
  return keyFor(`l1-${i}`);
}

export function level2Key(i: number): DeterministicKey {
  return keyFor(`l2-${i}`);
}

export function level3Key(i: number): DeterministicKey {
  return keyFor(`l3-${i}`);
}
