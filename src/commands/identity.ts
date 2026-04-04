import { decode } from 'nostr-tools/nip19';
import { generateSecretKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { logger } from '../lib/logger.js';
import { addIdentityKey, listIdentityKeys, removeIdentityKey, setPrimaryIdentity } from '../lib/identityStore.js';
import { PATHS } from '../config.js';
import { existsSync } from 'node:fs';

function parseIncomingSecret(raw: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith('nsec1')) {
    const d = decode(t);
    if (d.type !== 'nsec') throw new Error('Expected nsec bech32');
    return d.data;
  }
  if (/^[0-9a-f]{64}$/i.test(t)) {
    return hexToBytes(t);
  }
  throw new Error('Secret must be 64 hex chars or nsec1...');
}

export async function identityListCommand(options: { json?: boolean }): Promise<void> {
  const rows = listIdentityKeys();
  if (rows.length === 0 && existsSync(PATHS.secretKey) && !existsSync(PATHS.identity)) {
    logger.info('Using legacy secret.key only; run `trust identity import --secret <hex|nsec>` to create identity.json.');
  }
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const k of rows) {
    const star = k.primary ? ' (primary)' : '';
    console.log(`${k.npub}  ${k.publicKey}${star}${k.label ? `  ${k.label}` : ''}`);
  }
}

export async function identityImportCommand(options: { secret: string; label?: string }): Promise<void> {
  const sk = parseIncomingSecret(options.secret);
  const { publicKey, npub } = addIdentityKey(sk, options.label);
  logger.info(`Imported key ${npub}`);
  logger.info(`Hex: ${publicKey}`);
}

export async function identityGenerateCommand(options: { label?: string }): Promise<void> {
  const sk = generateSecretKey();
  const { npub } = addIdentityKey(sk, options.label);
  logger.info(`Generated new key ${npub}`);
}

export async function identityPrimaryCommand(pubkeyOrNpub: string): Promise<void> {
  let hex = pubkeyOrNpub.trim();
  if (hex.startsWith('npub1')) {
    const d = decode(hex);
    if (d.type !== 'npub') throw new Error('Expected npub');
    hex = d.data;
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('Provide 64-char hex pubkey or npub1...');
  }
  setPrimaryIdentity(hex.toLowerCase());
  logger.info(`Primary signing identity set to ${hex.toLowerCase()}`);
}

export async function identityRemoveCommand(pubkeyOrNpub: string): Promise<void> {
  let hex = pubkeyOrNpub.trim();
  if (hex.startsWith('npub1')) {
    const d = decode(hex);
    if (d.type !== 'npub') throw new Error('Expected npub');
    hex = d.data;
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('Provide 64-char hex pubkey or npub1...');
  }
  removeIdentityKey(hex.toLowerCase());
  logger.info(`Removed ${hex.toLowerCase()}`);
}
