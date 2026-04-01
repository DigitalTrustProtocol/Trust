#!/usr/bin/env npx tsx
/**
 * Query All Events
 *
 * Queries the local relay server for all kind-32010 trust events using a
 * NIP-01 REQ message, then prints each event.
 *
 * Usage:
 *   npx tsx scripts/server/query-all-events.ts
 *   TRUST_RELAY_URL=ws://127.0.0.1:3417/relay npx tsx scripts/server/query-all-events.ts
 *
 * Requires: server already running (`npx . server`)
 */

import type { IncomingMessage } from 'node:http';
import type { NostrEvent } from 'nostr-tools';
import WebSocket from 'ws';

const RELAY_URL = normalizeRelayUrl(process.env.TRUST_RELAY_URL ?? 'ws://localhost:3417/relay');
const CONNECT_TIMEOUT_MS = 15_000;
const SUB_ID = 'query-all-1';

async function main() {
  console.log('🔍 Query All Trust Events\n');
  console.log(`Relay: ${RELAY_URL}\n`);

  await preflightHttp(deriveHttpOrigin(RELAY_URL));

  console.log('Connecting to relay WebSocket…');
  const ws = await openRelay(RELAY_URL, CONNECT_TIMEOUT_MS);

  try {
    const events = await queryRelay(ws, SUB_ID, [{ kinds: [32010] }]);

    console.log(`\nReceived ${events.length} event(s):\n`);
    for (const event of events) {
      printEvent(event);
    }

    if (events.length === 0) {
      console.log('(no events found — publish first with scripts/server/publish-events.ts)');
    }
  } finally {
    ws.close();
  }
}

function printEvent(event: NostrEvent): void {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '?';
  const v = event.tags.find((t) => t[0] === 'v')?.[1] ?? '?';
  const c = event.tags.find((t) => t[0] === 'c')?.[1] ?? '';
  const p = event.tags.find((t) => t[0] === 'p')?.[1] ?? '?';

  console.log(`  id:      ${event.id}`);
  console.log(`  pubkey:  ${event.pubkey}`);
  console.log(`  kind:    ${event.kind}`);
  console.log(`  created: ${new Date(event.created_at * 1000).toISOString()}`);
  console.log(`  subject: ${p}`);
  console.log(`  value:   ${v}`);
  console.log(`  context: ${c || '(global)'}`);
  console.log(`  d-tag:   ${d}`);
  console.log();
}

async function queryRelay(
  ws: WebSocket,
  subId: string,
  filters: object[],
): Promise<NostrEvent[]> {
  return new Promise<NostrEvent[]>((resolve, reject) => {
    const events: NostrEvent[] = [];
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for EOSE')); }, 15_000);

    const onMessage = (raw: WebSocket.RawData) => {
      const data = tryParseJson(raw.toString());
      if (!Array.isArray(data) || data.length === 0) return;

      if (data[0] === 'EVENT' && data[1] === subId) {
        events.push(data[2] as NostrEvent);
        process.stdout.write(`  fetching… ${events.length} event(s)\r`);
      }

      if (data[0] === 'EOSE' && data[1] === subId) {
        cleanup();
        resolve(events);
      }

      if (data[0] === 'CLOSED' && data[1] === subId) {
        cleanup();
        reject(new Error(`Subscription closed by relay: ${data[2]}`));
      }

      if (data[0] === 'NOTICE') {
        console.warn(`  NOTICE: ${data[1]}`);
      }
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

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
