import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { PATHS } from '../config.js';
import { loadPrimarySecretKey } from './identityStore.js';

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

/**
 * Whether a signing key is available (legacy `secret.key`, `identity.json`, or `keys/*.key`).
 */
export function hasSecretKey(): boolean {
  return loadSecretKey() !== null;
}

/**
 * Load the primary secret key (identity.json + keys/ or legacy secret.key).
 * Returns null if not found
 */
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
 * Save a secret key to disk (hex format)
 */
export function saveSecretKey(secretKey: Uint8Array): void {
  const dir = dirname(PATHS.secretKey);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const hex = bytesToHex(secretKey);
  writeFileSync(PATHS.secretKey, hex + '\n', { mode: 0o600 });
}

/**
 * Get keypair - load existing or generate new
 */
export function getOrCreateKeyPair(): { keyPair: KeyPair; isNew: boolean } {
  const existing = loadKeyPair();
  if (existing) {
    return { keyPair: existing, isNew: false };
  }

  const keyPair = generateKeyPair();
  saveSecretKey(keyPair.secretKey);
  return { keyPair, isNew: true };
}
