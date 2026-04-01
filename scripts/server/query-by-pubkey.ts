#!/usr/bin/env npx tsx
/**
 * Query By Pubkey
 *
 * Queries the local relay server for all kind-32010 trust events authored by
 * (or targeting) a specific pubkey. Pass the pubkey as the first argument
 * (hex or npub). Defaults to the "primary" key from the trust-graph fixture.
 *
 * Usage:
 *   npx tsx scripts/server/query-by-pubkey.ts [pubkey|npub]
 *   npx tsx scripts/server/query-by-pubkey.ts b17501e4111503c741cd02aa3936b28b46fb1d69b9e9097e2721bef98b9c6857
 *   npx tsx scripts/server/query-by-pubkey.ts npub1k96sreq3z5puwswdq24rjd4j3dr0k8tfh85sjl38yxl0nzuudpts43u6a0
 *   TRUST_RELAY_URL=ws://127.0.0.1:3417/relay npx tsx scripts/server/query-by-pubkey.ts
 *
 * Requires: server already running (`npx . server`)
 */

import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { nip19, type NostrEvent } from 'nostr-tools';
import WebSocket from 'ws';

const RELAY_URL = normalizeRelayUrl(process.env.TRUST_RELAY_URL ?? 'ws://localhost:3417/relay');
const CONNECT_TIMEOUT_MS = 15_000;

// Default: primary key from the fixture
const DEFAULT_PUBKEY = 'b17501e4111503c741cd02aa3936b28b46fb1d69b9e9097e2721bef98b9c6857';

async function main() {
  const rawArg = process.argv[2];
  const pubkey = rawArg ? resolvePubkeyArg(rawArg) : DEFAULT_PUBKEY;

  console.log('🔍 Query Trust Events By Pubkey\n');
  console.log(`Relay:  ${RELAY_URL}`);
  console.log(`Author: ${pubkey}\n`);

  await preflightHttp(deriveHttpOrigin(RELAY_URL));

  console.log('Connecting to relay WebSocket…');
  const ws = await openRelay(RELAY_URL, CONNECT_TIMEOUT_MS);

  try {
    // Query events authored by this pubkey (they issued the trust)
    const authorEvents = await queryRelay(ws, 'by-author', [{ kinds: [32010], authors: [pubkey] }]);
    console.log(`\n📝 Events authored by ${pubkey.slice(0, 12)}… (${authorEvents.length}):\n`);
    for (const event of authorEvents) printEvent(event);

    // Query events targeting this pubkey (p-tag filter)
    const targetEvents = await queryRelay(ws, 'by-target', [{ kinds: [32010], '#p': [pubkey] }]);
    console.log(`\n🎯 Events targeting ${pubkey.slice(0, 12)}… (${targetEvents.length}):\n`);
    for (const event of targetEvents) printEvent(event);

    const total = authorEvents.length + targetEvents.length;
    if (total === 0) {
      console.log('(no events found — publish first with scripts/server/publish-events.ts)');
    }
  } finally {
    ws.close();
  }
}

function resolvePubkeyArg(arg: string): string {
  if (arg.startsWith('npub1')) {
    const decoded = nip19.decode(arg);
    if (decoded.type !== 'npub') throw new Error(`Expected npub, got ${decoded.type}`);
    return decoded.data.toLowerCase();
  }
  return arg.toLowerCase();
}

function printEvent(event: NostrEvent): void {
  const v = event.tags.find((t) => t[0] === 'v')?.[1] ?? '?';
  const c = event.tags.find((t) => t[0] === 'c')?.[1] ?? '';
  const p = event.tags.find((t) => t[0] === 'p')?.[1] ?? '?';

  console.log(`  id:      ${event.id}`);
  console.log(`  author:  ${event.pubkey}`);
  console.log(`  subject: ${p}`);
  console.log(`  value:   ${v}`);
  console.log(`  context: ${c || '(global)'}`);
  console.log(`  created: ${new Date(event.created_at * 1000).toISOString()}`);
  console.log();
}

async function queryRelay(ws: WebSocket, subId: string, filters: object[]): Promise<NostrEvent[]> {
  return new Promise<NostrEvent[]>((resolve, reject) => {
    const events: NostrEvent[] = [];
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for EOSE')); }, 15_000);

    const onMessage = (raw: WebSocket.RawData) => {
      const data = tryParseJson(raw.toString());
      if (!Array.isArray(data) || data.length === 0) return;

      if (data[0] === 'EVENT' && data[1] === subId) events.push(data[2] as NostrEvent);
      if (data[0] === 'EOSE' && data[1] === subId) { cleanup(); resolve(events); }
      if (data[0] === 'CLOSED' && data[1] === subId) { cleanup(); reject(new Error(`Subscription closed: ${data[2]}`)); }
      if (data[0] === 'NOTICE') console.warn(`  NOTICE: ${data[1]}`);
    };

    const onError = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('Relay closed before EOSE')); };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
      ws.send(JSON.stringify(['CLOSE', subId]));
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.send(JSON.stringify(['REQ', subId, ...filters]));
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
    throw new Error(`Cannot reach server at ${healthUrl}: ${msg}\n  Start with: npx . server`);
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
      res.on('end', () => finish(() => reject(new Error(`WebSocket upgrade failed (${res.statusCode}): ${Buffer.concat(chunks).toString().slice(0, 500)}`))));
    });
  });
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

// Show fixture pubkeys for reference
function printFixtureKeys(): void {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'trust-graph.json');
  if (!existsSync(fixturePath)) return;
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      keys: { label?: string; pubkey: string; npub: string }[];
    };
    console.log('Available pubkeys from fixture:');
    for (const key of fixture.keys) {
      console.log(`  ${(key.label ?? 'unknown').padEnd(30)} ${key.pubkey}`);
    }
    console.log();
  } catch {
    // ignore
  }
}

if (process.argv.includes('--list')) {
  printFixtureKeys();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
