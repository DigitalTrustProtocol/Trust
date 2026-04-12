import { sha256 } from '@noble/hashes/sha2';
import { getPublicKey } from 'nostr-tools/pure';
import { encodeNpub } from '../src/lib/nostr/nip19';

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

/** Extra load-test keys for degree-4/5 extensions (see seed-trust-network-deg45.ts). */
export function level4Key(i: number): DeterministicKey {
  return keyFor(`l4-${i}`);
}

export function level5Key(i: number): DeterministicKey {
  return keyFor(`l5-${i}`);
}

async function main(): Promise<void> {
  console.log('Loading test keys');
  console.log(`Branching: ${BRANCHING}`);
  console.log(`Level 1: ${LEVEL1}`);
  console.log(`Level 2: ${LEVEL2}`);
  console.log(`Level 3: ${LEVEL3}`);
  console.log(`Total edges: ${TOTAL_EDGES}`);
  console.log(`Load test namespace: ${LOAD_TEST_NAMESPACE}`);
  console.log('');
  console.log('Author key:');
  console.log(`  pubkey: ${authorKey().pubkey}`);
  console.log(`  npub:   ${encodeNpub(authorKey().pubkey)}`);
  console.log('');

  console.log('Level 1 keys:');
  for (let i = 0; i < 10; i++) {
    console.log(`  pubkey: ${level1Key(i).pubkey}`);
    console.log(`  npub:   ${encodeNpub(level1Key(i).pubkey)}`);
  }
  console.log('');

  console.log('Level 2 keys:');
  for (let i = 0; i < 10; i++) {
    console.log(`  pubkey: ${level2Key(i).pubkey}`);
    console.log(`  npub:   ${encodeNpub(level2Key(i).pubkey)}`);
  }
  console.log('');
  
  console.log('Level 3 keys:');
  for (let i = 0; i < 10; i++) {
    console.log(`  pubkey: ${level3Key(i).pubkey}`);
    console.log(`  npub:   ${encodeNpub(level3Key(i).pubkey)}`);
  }
  console.log('');

  console.log('Level 4 keys:');
  for (let i = 0; i < 10; i++) {
    console.log(`  pubkey: ${level4Key(i).pubkey}`);
    console.log(`  npub:   ${encodeNpub(level4Key(i).pubkey)}`);
  }
  console.log('');
  
  console.log('Level 5 keys:');
  for (let i = 0; i < 10; i++) {
    console.log(`  pubkey: ${level5Key(i).pubkey}`);
    console.log(`  npub:   ${encodeNpub(level5Key(i).pubkey)}`);
  }
  console.log('');
  
  
  
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
