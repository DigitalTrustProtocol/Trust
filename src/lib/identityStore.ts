import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { PATHS } from '../config.js';

export const IDENTITY_VERSION = 1;

export type IdentityKeyEntry = {
  publicKey: string;
  /** Human-readable label */
  label?: string;
};

export type IdentityFile = {
  version: typeof IDENTITY_VERSION;
  /** Lowercase hex pubkey used for signing when no per-key override */
  primary: string;
  keys: IdentityKeyEntry[];
};

export function identityPathForPubkey(pubkeyLower: string): string {
  return join(PATHS.keysDir, `${pubkeyLower}.key`);
}

export function loadIdentityFile(): IdentityFile | null {
  if (!existsSync(PATHS.identity)) return null;
  try {
    const raw = readFileSync(PATHS.identity, 'utf8');
    return JSON.parse(raw) as IdentityFile;
  } catch {
    return null;
  }
}

export function saveIdentityFile(data: IdentityFile): void {
  if (!existsSync(PATHS.configDir)) {
    mkdirSync(PATHS.configDir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(PATHS.keysDir)) {
    mkdirSync(PATHS.keysDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(PATHS.identity, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Resolve primary pubkey: identity.json, else secret.key. */
export function getPrimaryPublicKeyHex(): string | null {
  const id = loadIdentityFile();
  if (id?.primary) return id.primary.toLowerCase();
  if (!existsSync(PATHS.secretKey)) return null;
  try {
    const content = readFileSync(PATHS.secretKey, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/i.test(content)) {
      const sk = hexToBytes(content);
      return getPublicKey(sk).toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Load secret key bytes for the primary identity.
 * Order: identity.primary → keys/<pub>.key → legacy secret.key
 */
export function loadPrimarySecretKey(): Uint8Array | null {
  const id = loadIdentityFile();
  if (id?.primary) {
    const p = id.primary.toLowerCase();
    const perKey = identityPathForPubkey(p);
    if (existsSync(perKey)) {
      return readSecretKeyFile(perKey);
    }
  }
  if (existsSync(PATHS.secretKey)) {
    return readSecretKeyFile(PATHS.secretKey);
  }
  return null;
}

function readSecretKeyFile(path: string): Uint8Array {
  const content = readFileSync(path, 'utf-8').trim();
  if (content.startsWith('nsec1')) {
    throw new Error(`nsec format not yet supported for storage in ${path}, please use hex`);
  }
  if (!/^[0-9a-f]{64}$/i.test(content)) {
    throw new Error(`Invalid secret key format in ${path}`);
  }
  return hexToBytes(content);
}

export function writeSecretKeyFile(path: string, secretKey: Uint8Array): void {
  const dir = PATHS.configDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(PATHS.keysDir)) mkdirSync(PATHS.keysDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${bytesToHex(secretKey)}\n`, { mode: 0o600 });
}

export function addIdentityKey(secretKey: Uint8Array, label?: string): { publicKey: string; npub: string } {
  const publicKey = getPublicKey(secretKey).toLowerCase();
  const path = identityPathForPubkey(publicKey);
  writeSecretKeyFile(path, secretKey);

  let id = loadIdentityFile();
  if (!id) {
    id = {
      version: IDENTITY_VERSION,
      primary: publicKey,
      keys: [{ publicKey, label }],
    };
  } else {
    if (!id.keys.some((k) => k.publicKey === publicKey)) {
      id.keys.push({ publicKey, label });
    }
    if (!id.primary) id.primary = publicKey;
  }
  saveIdentityFile(id);
  return { publicKey, npub: npubEncode(publicKey) };
}

export function setPrimaryIdentity(publicKeyLower: string): void {
  const id = loadIdentityFile();
  if (!id) {
    throw new Error('No identity.json; run `trust identity add` first.');
  }
  const pk = publicKeyLower.toLowerCase();
  if (!id.keys.some((k) => k.publicKey === pk)) {
    throw new Error(`Unknown public key ${pk}; add it first.`);
  }
  id.primary = pk;
  saveIdentityFile(id);
}

export function removeIdentityKey(publicKeyLower: string): void {
  const pk = publicKeyLower.toLowerCase();
  const id = loadIdentityFile();
  if (!id) return;
  id.keys = id.keys.filter((k) => k.publicKey !== pk);
  const path = identityPathForPubkey(pk);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  if (id.primary === pk) {
    id.primary = id.keys[0]?.publicKey ?? '';
  }
  if (!id.keys.length) {
    if (existsSync(PATHS.identity)) unlinkSync(PATHS.identity);
    return;
  }
  if (!id.primary) id.primary = id.keys[0]!.publicKey;
  saveIdentityFile(id);
}

export function listIdentityKeys(): Array<IdentityKeyEntry & { npub: string; primary: boolean }> {
  const id = loadIdentityFile();
  if (!id) return [];
  const primary = id.primary?.toLowerCase() ?? '';
  return id.keys.map((k) => ({
    ...k,
    npub: npubEncode(k.publicKey),
    primary: k.publicKey === primary,
  }));
}

export function listKeyFilesOnDisk(): string[] {
  if (!existsSync(PATHS.keysDir)) return [];
  return readdirSync(PATHS.keysDir).filter((f) => f.endsWith('.key'));
}
