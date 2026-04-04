import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { addIdentityKey, loadPrimarySecretKey } from './identityStore.js';

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: string; // hex
  nsec: string;
  npub: string;
}

/**
 * Generate a new Nostr keypair
 */
export function generateKeyPair(): KeyPair {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);

  return {
    secretKey,
    publicKey,
    nsec: nsecEncode(secretKey),
    npub: npubEncode(publicKey),
  };
}

/** Whether a signing key is available (`identity.json` + `keys/<pub>.key`). */
export function hasSecretKey(): boolean {
  return loadSecretKey() !== null;
}

/** Load the primary secret key from identity storage. Returns null if not found. */
export function loadSecretKey(): Uint8Array | null {
  return loadPrimarySecretKey();
}

/**
 * Load keypair from disk
 * Returns null if secret key not found
 */
export function loadKeyPair(): KeyPair | null {
  const secretKey = loadSecretKey();
  if (!secretKey) {
    return null;
  }

  const publicKey = getPublicKey(secretKey);

  return {
    secretKey,
    publicKey,
    nsec: nsecEncode(secretKey),
    npub: npubEncode(publicKey),
  };
}

/**
 * Get keypair — load existing from identity storage or generate and persist via identity.json + keys/.
 */
export function getOrCreateKeyPair(): { keyPair: KeyPair; isNew: boolean } {
  const existing = loadKeyPair();
  if (existing) {
    return { keyPair: existing, isNew: false };
  }

  const keyPair = generateKeyPair();
  addIdentityKey(keyPair.secretKey);
  return { keyPair, isNew: true };
}
