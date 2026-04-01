import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { PATHS } from '../config.js';

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
 * Check if a secret key file exists
 */
export function hasSecretKey(): boolean {
  return existsSync(PATHS.secretKey);
}

/**
 * Load the secret key from disk
 * Returns null if not found
 */
export function loadSecretKey(): Uint8Array | null {
  if (!existsSync(PATHS.secretKey)) {
    return null;
  }

  const content = readFileSync(PATHS.secretKey, 'utf-8').trim();

  // Support both hex and nsec formats
  if (content.startsWith('nsec1')) {
    const decoded = hexToBytes(content);
    // nsec decode - we need to handle this differently
    // For now, we store as hex, so this branch is for backwards compat
    throw new Error('nsec format not yet supported for storage, please use hex');
  }

  // Hex format (64 characters)
  if (/^[0-9a-f]{64}$/i.test(content)) {
    return hexToBytes(content);
  }

  throw new Error('Invalid secret key format in ' + PATHS.secretKey);
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
