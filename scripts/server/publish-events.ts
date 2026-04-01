#!/usr/bin/env npx tsx
/**
 * Publish Events
 *
 * Reads the 21 trust events from test/fixtures/trust-graph.json,
 * signs each one, and publishes them to the local relay server.
 *
 * Usage:
 *   npx tsx scripts/server/publish-events.ts
 *   TRUST_RELAY_URL=ws://127.0.0.1:3417/relay npx tsx scripts/server/publish-events.ts
 *
 * Requires: server already running (`npx . server`)
 */

import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19, type NostrEvent, type VerifiedEvent } from 'nostr-tools';
import WebSocket from 'ws';
import { buildTrustEventTemplate } from '../../src/lib/nostr/nip32010.js';

const FIXTURE_PATH =
  process.env.TRUST_GRAPH_FILE ?? join(process.cwd(), 'test', 'fixtures', 'trust-graph.json');
const RELAY_URL = normalizeRelayUrl(process.env.TRUST_RELAY_URL ?? 'ws://localhost:3417/relay');
const CONNECT_TIMEOUT_MS = 15_000;

interface KeyFixture {
  label?: string;
  privkey: string;
  pubkey: string;
  npub: string;
}

interface Connection {
  from: string;
  to: string;
  value: number;
  context?: string;
}

interface TrustGraphFixture {
  keys: KeyFixture[];
  connections: Connection[];
}

async function main() {
  console.log('📤 Publish Trust Events\n');
  console.log(`Fixture: ${FIXTURE_PATH}`);
  console.log(`Relay:   ${RELAY_URL}\n`);

  if (!existsSync(FIXTURE_PATH)) {
    console.error(`❌ Fixture not found: ${FIXTURE_PATH}`);
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as TrustGraphFixture;
  const keys = validateKeys(fixture.keys);
  const byPubkey = new Map(keys.map((k) => [k.pubkey, k]));

  await preflightHttp(deriveHttpOrigin(RELAY_URL));

  console.log(`Connecting to relay WebSocket…`);
  const ws = await openRelay(RELAY_URL, CONNECT_TIMEOUT_MS);

  try {
    let published = 0;
    for (const conn of fixture.connections) {
      const fromPubkey = resolvePubkey(conn.from, keys);
      const toPubkey = resolvePubkey(conn.to, keys);
      const signer = byPubkey.get(fromPubkey);
      if (!signer) {
        throw new Error(`No signing key found for from=${fromPubkey}`);
      }

      const value = normalizeTrustValue(conn.value);
      const template = buildTrustEventTemplate({
        subjects: [{ tag: 'p', value: toPubkey }],
        context: conn.context,
        value,
      });
      const event = finalizeEvent(template, hexToBytes(signer.privkey)) as VerifiedEvent;

      process.stdout.write(
        `  [${published + 1}/${fixture.connections.length}] ${signer.label ?? fromPubkey.slice(0, 8)} -> ${toPubkey.slice(0, 8)} (${conn.context || 'global'}, ${value > 0 ? '+' : ''}${value})… `,
      );
      await publishToRelay(ws, event);
      console.log('✓');
      published++;
    }

    console.log(`\n✅ Published ${published} trust events.`);
  } finally {
    ws.close();
  }
}

function normalizeTrustValue(input: number): 1 | 0 | -1 {
  if (input === 1) return 1;
  if (input === -1) return -1;
  return 0;
}

function resolvePubkey(value: string | number, keys: KeyFixture[]): string {
  if (typeof value === 'number') {
    const key = keys[value];
    if (!key) throw new Error(`Fixture references missing key index: ${value}`);
    return key.pubkey;
  }
  if (value.startsWith('npub1')) {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'npub') throw new Error(`Expected npub value, got ${decoded.type}`);
    return decoded.data.toLowerCase();
  }
  return value.toLowerCase();
}

function validateKeys(keys: KeyFixture[]): KeyFixture[] {
  return keys.map((key, idx) => {
    if (!key.privkey || !key.pubkey) {
      throw new Error(`Fixture key[${idx}] is missing privkey/pubkey`);
    }
    const derived = getPublicKey(hexToBytes(key.privkey)).toLowerCase();
    if (derived !== key.pubkey.toLowerCase()) {
      throw new Error(`Fixture key[${idx}] pubkey does not match privkey`);
    }
    return { ...key, privkey: key.privkey.toLowerCase(), pubkey: key.pubkey.toLowerCase() };
  });
}

function normalizeRelayUrl(input: string): string {
  const url = new URL(input);
  if (!url.pathname || url.pathname === '/') url.pathname = '/relay';
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

function deriveHttpOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

async function preflightHttp(origin: string): Promise<void> {
  const healthUrl = `${origin}/health`;
  console.log(`Checking server health (${healthUrl})…`);
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('Server is up.\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach server at ${healthUrl}: ${msg}\n  Start with: npx . server`,
    );
  }
}

async function openRelay(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => finish(() => { try { ws.terminate(); } catch { /**/ } reject(new Error(`WebSocket timed out: ${url}`)); }), timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.on('open', () => finish(() => { ws.removeAllListeners('error'); ws.removeAllListeners('close'); ws.removeAllListeners('unexpected-response'); resolve(ws); }));
    ws.on('error', (err) => finish(() => reject(err)));
    ws.on('close', () => finish(() => reject(new Error(`Relay closed before open: ${url}`))));
    ws.on('unexpected-response', (_req: unknown, res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const body = Buffer.concat(chunks).toString().slice(0, 500); finish(() => reject(new Error(`WebSocket upgrade failed (${res.statusCode}): ${body}`))); });
    });
  });
}

async function publishToRelay(ws: WebSocket, event: NostrEvent): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ACK: ${event.id}`)); }, 10_000);

    const onMessage = (raw: WebSocket.RawData) => {
      const data = tryParseJson(raw.toString());
      if (!Array.isArray(data) || data.length === 0) return;
      if (data[0] === 'NOTICE') { cleanup(); reject(new Error(`NOTICE: ${data[1]}`)); return; }
      if (data[0] === 'OK' && data[1] === event.id) {
        cleanup();
        if (!data[2]) { reject(new Error(`Event rejected: ${data[3]}`)); return; }
        resolve();
      }
    };

    const onError = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error(`Relay closed while publishing ${event.id}`)); };

    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('error', onError); ws.off('close', onClose); };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.send(JSON.stringify(['EVENT', event]));
  });
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
