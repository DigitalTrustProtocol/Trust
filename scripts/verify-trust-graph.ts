#!/usr/bin/env npx tsx
/**
 * Verify Trust Graph
 *
 * Sends signed trust events from test/fixtures/trust-graph.json to a local
 * relay websocket server, then calls POST /v1/resolve and validates each expected case.
 *
 * Usage:
 *   npx tsx scripts/verify-trust-graph.ts
 *   TRUST_GRAPH_FILE=path/to/graph.json TRUST_RELAY_URL=ws://localhost:3417/relay npx tsx scripts/verify-trust-graph.ts
 *   TRUST_RESOLVE_URL=http://localhost:3417/v1/resolve npx tsx scripts/verify-trust-graph.ts
 *   TRUST_RELAY_CONNECT_TIMEOUT_MS=20000 npx tsx scripts/verify-trust-graph.ts
 *
 * Note: `localhost` in the default URL is normalized to 127.0.0.1 to avoid IPv6 hang.
 */

import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19, type NostrEvent, type VerifiedEvent } from 'nostr-tools';
import WebSocket from 'ws';
import { buildTrustEventTemplate } from '../src/lib/nostr/nip32010.js';

const FIXTURE_PATH =
  process.env.TRUST_GRAPH_FILE ?? join(process.cwd(), 'test', 'fixtures', 'trust-graph.json');
const RELAY_URL = normalizeRelayUrl(process.env.TRUST_RELAY_URL ?? 'ws://localhost:3417/relay');
const RESOLVE_URL = process.env.TRUST_RESOLVE_URL ?? deriveResolveUrl(RELAY_URL);
/** Avoid hanging forever on Windows when `localhost` tries IPv6 first and nothing listens on ::1 */
const RELAY_CONNECT_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.TRUST_RELAY_CONNECT_TIMEOUT_MS ?? '15000', 10) || 15_000,
);

interface TrustGraphFixture {
  keys: KeyFixture[];
  connections: {
    from: number | string;
    to: number | string;
    value: number;
    context?: string;
  }[];
  expected: {
    issuer: number | string;
    subject: number | string;
    context?: string;
    degree?: number;
    connected?: boolean;
    trust?: number;
    distrust?: number;
  }[];
}

interface ResolveResult {
  connected: boolean;
  degree: number;
  trust: number;
  distrust: number;
}

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface KeyFixture {
  label?: string;
  privkey: string;
  pubkey: string;
  npub: string;
}

type ExpectedEntry = TrustGraphFixture['expected'][number];

interface RelayMessageOk {
  ok: true;
  eventId: string;
  accepted: boolean;
  reason: string;
}

interface RelayMessageNotice {
  ok: false;
  notice: string;
}

type RelayMessage = RelayMessageOk | RelayMessageNotice;

async function main() {
  console.log('🔍 Trust Graph Relay Verification\n');
  console.log(`Fixture: ${FIXTURE_PATH}`);
  console.log(`Relay:   ${RELAY_URL}`);
  console.log(`Resolve: ${RESOLVE_URL}\n`);

  if (!existsSync(FIXTURE_PATH)) {
    console.error(`❌ Fixture not found: ${FIXTURE_PATH}`);
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as TrustGraphFixture;
  if (!fixture.expected || fixture.expected.length === 0) {
    console.error('❌ Fixture has no expected entries.');
    process.exit(1);
  }

  if (!fixture.keys || fixture.keys.length === 0) {
    console.error('❌ Fixture has no keys.');
    process.exit(1);
  }

  const keys = validateAndNormalizeKeys(fixture.keys);
  const byPubkey = new Map(keys.map((key) => [key.pubkey, key]));

  const httpOrigin = deriveHttpOriginFromRelay(RELAY_URL);
  console.log(`Checking Trust HTTP API (${httpOrigin}/v1/ping)…`);
  await preflightHttpServer(httpOrigin);

  console.log(`Connecting to relay WebSocket (timeout ${RELAY_CONNECT_TIMEOUT_MS}ms)…`);
  const relay = await openRelay(RELAY_URL, RELAY_CONNECT_TIMEOUT_MS, { httpHealthOk: true });
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
      await publishToRelay(relay, event);
      published++;
    }

    console.log(`Published ${published} trust events\n`);
  } finally {
    relay.close();
  }

  let passed = 0;
  let failed = 0;

  for (const exp of fixture.expected) {
    const issuerPubkey = resolvePubkey(exp.issuer, keys);
    const subjectPubkey = resolvePubkey(exp.subject, keys);
    const ctx = exp.context !== undefined ? ` (${exp.context || 'global'})` : '';
    const label = `issuer ${exp.issuer} -> subject ${exp.subject}${ctx}`;

    try {
      const result = await resolveFromServer({
        resolveUrl: RESOLVE_URL,
        author: issuerPubkey,
        subject: subjectPubkey,
        context: exp.context,
      });

      const got: ResolveResult = {
        connected: Boolean(result.connected),
        degree: result.degree ?? 0,
        trust: result.trust ?? 0,
        distrust: result.distrust ?? 0,
      };

      const expConnected = exp.connected !== false;
      const expDegree = exp.connected === false ? 0 : (exp.degree ?? 0);
      const expTrust = exp.trust ?? 0;
      const expDistrust = exp.distrust ?? 0;

      const ok =
        got.connected === expConnected &&
        got.degree === expDegree &&
        got.trust === expTrust &&
        got.distrust === expDistrust;

      if (ok) {
        console.log(`✓ ${label}`);
        console.log(
          `  connected=${got.connected} degree=${got.degree} trust=${got.trust} distrust=${got.distrust}`,
        );
        passed++;
      } else {
        console.log(`✗ ${label}`);
        console.log(`  expected: connected=${expConnected} degree=${expDegree} trust=${expTrust} distrust=${expDistrust}`);
        console.log(
          `  got:      connected=${got.connected} degree=${got.degree} trust=${got.trust} distrust=${got.distrust}`,
        );
        failed++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canTreatMissingSubjectAsPass =
        shouldExpectDisconnected(exp) &&
        message.includes('SUBJECT_NOT_FOUND');

      if (canTreatMissingSubjectAsPass) {
        console.log(`✓ ${label}`);
        console.log('  expected disconnected result; API returned SUBJECT_NOT_FOUND');
        passed++;
      } else {
        console.log(`✗ ${label}`);
        console.log(`  error: ${message}`);
        failed++;
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function deriveResolveUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  const host = url.host;
  return `${protocol}//${host}/v1/resolve`;
}

/** Same host as relay URL, for GET /v1/ping before opening WebSocket. */
function deriveHttpOriginFromRelay(relayUrl: string): string {
  const url = new URL(relayUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

/**
 * Fail fast with a clear message when nothing is listening (typical: server not started).
 * Avoids a long WebSocket hang when TCP never connects.
 */
async function preflightHttpServer(httpOrigin: string): Promise<void> {
  const base = httpOrigin.replace(/\/$/, '');
  const pingUrl = `${base}/v1/ping`;
  const ms = Math.min(8_000, RELAY_CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(
        `Expected JSON from ${pingUrl}, got content-type ${ct || '(none)'} body: ${text}`,
      );
    }
    const body = (await res.json()) as { ok?: boolean };
    if (body.ok !== true) {
      throw new Error(`Ping response not ok: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const cause = e.cause instanceof Error ? e.cause.message : '';
    const blob = `${e.name} ${e.message} ${cause}`.toLowerCase();
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    const refused =
      blob.includes('econnrefused') ||
      blob.includes('connection refused') ||
      blob.includes('fetch failed');

    if (timedOut || refused) {
      throw new Error(
        `Cannot reach Trust at ${pingUrl}\n` +
          `  (${e.message}${cause ? ` — ${cause}` : ''})\n\n` +
          `  Start the server in another terminal, then run this script again:\n` +
          `    npx . server\n\n` +
          `  Default listen URL is http://127.0.0.1:3417 (relay: ws://127.0.0.1:3417/relay).\n` +
          `  If you use another host/port, set both:\n` +
          `    TRUST_RELAY_URL=ws://127.0.0.1:<port>/relay\n` +
          `    TRUST_RESOLVE_URL=http://127.0.0.1:<port>/v1/resolve`,
      );
    }
    throw new Error(`Preflight GET ${pingUrl} failed: ${e.message}`);
  }
}

function normalizeRelayUrl(input: string): string {
  const url = new URL(input);
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/relay';
  }
  // Prefer IPv4 loopback: Node often resolves `localhost` to ::1 first; a server
  // bound to 0.0.0.0 may not answer on ::1, leaving the client hanging with no error.
  if (url.hostname === 'localhost') {
    url.hostname = '127.0.0.1';
  }
  return url.toString();
}

function normalizeTrustValue(input: number): 1 | 0 | -1 {
  if (input === 1) return 1;
  if (input === -1) return -1;
  return 0;
}

function validateAndNormalizeKeys(keys: KeyFixture[]): KeyFixture[] {
  return keys.map((key, idx) => {
    if (!key.privkey || !key.pubkey || !key.npub) {
      throw new Error(`Fixture key[${idx}] is missing privkey/pubkey/npub`);
    }

    const derivedPubkey = getPublicKey(hexToBytes(key.privkey)).toLowerCase();
    if (derivedPubkey !== key.pubkey.toLowerCase()) {
      throw new Error(`Fixture key[${idx}] pubkey does not match privkey`);
    }

    const decoded = nip19.decode(key.npub);
    if (decoded.type !== 'npub' || decoded.data.toLowerCase() !== key.pubkey.toLowerCase()) {
      throw new Error(`Fixture key[${idx}] npub does not match pubkey`);
    }

    return {
      ...key,
      privkey: key.privkey.toLowerCase(),
      pubkey: key.pubkey.toLowerCase(),
      npub: key.npub.toLowerCase(),
    };
  });
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

async function openRelay(
  url: string,
  timeoutMs: number,
  opts?: { httpHealthOk?: boolean },
): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(
          new Error(
            `Relay WebSocket timed out after ${timeoutMs}ms: ${url}\n` +
              (opts?.httpHealthOk
                ? '  HTTP GET /v1/ping succeeded, so the process is up — the WebSocket upgrade is stuck.\n' +
                  '  Rebuild and restart the server (npm run build), and ensure src/server/api.ts /relay uses connection.socket.\n'
                : '  Ensure the Trust server is running on the same host:port as RELAY_URL.\n') +
              '  TRUST_RELAY_URL=ws://127.0.0.1:3417/relay  TRUST_RESOLVE_URL=http://127.0.0.1:3417/v1/resolve',
          ),
        );
      });
    }, timeoutMs);

    const onOpen = () => {
      finish(() => {
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
        ws.off('unexpected-response', onUnexpectedResponse);
        resolve(ws);
      });
    };

    const onError = (err: Error) => {
      finish(() => {
        reject(err);
      });
    };

    const onClose = () => {
      finish(() => {
        reject(new Error(`Relay closed before ready: ${url}`));
      });
    };

    const onUnexpectedResponse = (_req: unknown, res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
        finish(() => {
          reject(
            new Error(
              `WebSocket upgrade failed (${res.statusCode ?? '?'} ${res.statusMessage ?? ''}) at ${url}\n` +
                (body ? `  Body: ${body}\n` : '') +
                '  Rebuild/restart the server if you changed relay code (npm run build).',
            ),
          );
        });
      });
    };

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.on('unexpected-response', onUnexpectedResponse);
  });
}

async function publishToRelay(ws: WebSocket, event: NostrEvent): Promise<void> {
  const timeoutMs = 10_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for relay ACK: ${event.id}`));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = parseRelayMessage(raw);
      if (!message) return;

      if (!message.ok) {
        cleanup();
        reject(new Error(`Relay NOTICE: ${message.notice}`));
        return;
      }

      if (message.eventId !== event.id) return;
      cleanup();
      if (!message.accepted) {
        reject(new Error(`Relay rejected event ${event.id}: ${message.reason}`));
        return;
      }
      resolve();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`Relay closed while publishing ${event.id}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.send(JSON.stringify(['EVENT', event]));
  });
}

function parseRelayMessage(raw: WebSocket.RawData): RelayMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  if (data[0] === 'NOTICE' && typeof data[1] === 'string') {
    return { ok: false, notice: data[1] };
  }
  if (data[0] === 'OK' && typeof data[1] === 'string' && typeof data[2] === 'boolean') {
    return {
      ok: true,
      eventId: data[1],
      accepted: data[2],
      reason: typeof data[3] === 'string' ? data[3] : '',
    };
  }
  return null;
}

async function resolveFromServer(params: {
  resolveUrl: string;
  author: string;
  subject: string;
  context?: string;
}): Promise<Partial<ResolveResult>> {
  const response = await fetch(params.resolveUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      author: params.author,
      subject: params.subject,
      context: params.context,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resolve request failed (${response.status}): ${text}`);
  }

  const ct = response.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const text = await response.text();
    throw new Error(
      `Resolve expected JSON (${params.resolveUrl}) but got ${ct || 'unknown content-type'}: ${text.slice(0, 400)}`,
    );
  }

  const payload = (await response.json()) as unknown;
  return extractResolveResult(payload);
}

function extractResolveResult(payload: unknown): Partial<ResolveResult> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Resolve response is not a JSON object');
  }

  const envelope = payload as ApiEnvelope<Partial<ResolveResult> | Partial<ResolveResult>[]>;
  if (typeof envelope.ok === 'boolean') {
    if (!envelope.ok) {
      const code = envelope.error?.code ? `${envelope.error.code}: ` : '';
      const message = envelope.error?.message ?? 'Unknown API error';
      throw new Error(`Resolve API error: ${code}${message}`);
    }
    const raw = envelope.data;
    if (raw === undefined || raw === null) {
      throw new Error('Resolve API response missing data');
    }
    // POST /v1/resolve returns `{ ok, data: Score[] }` (one score per request for default format).
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        throw new Error('Resolve API returned empty score array');
      }
      return raw[0] as Partial<ResolveResult>;
    }
    if (typeof raw !== 'object') {
      throw new Error('Resolve API data is not an object or array');
    }
    return raw as Partial<ResolveResult>;
  }

  // Backward compatibility for older servers that returned raw score JSON.
  return payload as Partial<ResolveResult>;
}

function shouldExpectDisconnected(exp: ExpectedEntry): boolean {
  const connected = exp.connected ?? false;
  const degree = exp.degree ?? 0;
  const trust = exp.trust ?? 0;
  const distrust = exp.distrust ?? 0;
  return connected === false && degree === 0 && trust === 0 && distrust === 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
