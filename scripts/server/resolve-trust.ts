#!/usr/bin/env npx tsx
/**
 * Resolve Trust
 *
 * Resolves the trust score from an issuer (author) to a subject by calling
 * the server's POST /v1/resolve endpoint.
 *
 * Usage:
 *   npx tsx scripts/server/resolve-trust.ts [issuer] [subject] [context]
 *
 *   # Defaults: primary -> direct key, context "dev"
 *   npx tsx scripts/server/resolve-trust.ts
 *
 *   # Custom pubkeys
 *   npx tsx scripts/server/resolve-trust.ts \
 *     b17501e4111503c741cd02aa3936b28b46fb1d69b9e9097e2721bef98b9c6857 \
 *     2ddb93f387f3de55a5c9277732a4b47998e88e3862fe25232cf12bba8e7714e8 \
 *     dev
 *
 *   # Run all expected resolutions from the fixture
 *   npx tsx scripts/server/resolve-trust.ts --all
 *
 *   TRUST_RESOLVE_URL=http://127.0.0.1:3417/v1/resolve npx tsx scripts/server/resolve-trust.ts
 *
 * Requires: server already running (`npx . server`) with events published.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { nip19 } from 'nostr-tools';

const BASE_URL = normalizeBaseUrl(process.env.TRUST_RESOLVE_URL ?? 'http://localhost:3417');
const RESOLVE_URL = `${BASE_URL}/v1/resolve`;

// Fixture defaults
const PRIMARY   = 'b17501e4111503c741cd02aa3936b28b46fb1d69b9e9097e2721bef98b9c6857'; // primary
const DIRECT    = '2ddb93f387f3de55a5c9277732a4b47998e88e3862fe25232cf12bba8e7714e8'; // direct
const DEFAULT_CONTEXT = 'commerce';

interface ResolveResult {
  connected?: boolean;
  degree?: number;
  trust?: number;
  distrust?: number;
  [key: string]: unknown;
}

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface Expected {
  issuer: string | number;
  subject: string | number;
  context?: string;
  connected?: boolean;
  degree?: number;
  trust?: number;
  distrust?: number;
}

async function main() {
  const runAll = process.argv.includes('--all');

  if (runAll) {
    await runAllExpected();
    return;
  }

  const issuer  = resolveArg(process.argv[2]) ?? PRIMARY;
  const subject = resolveArg(process.argv[3]) ?? DIRECT;
  const context = process.argv[4] ?? DEFAULT_CONTEXT;

  console.log('🔗 Resolve Trust\n');
  console.log(`Server:  ${BASE_URL}`);
  console.log(`Issuer:  ${issuer}`);
  console.log(`Subject: ${subject}`);
  console.log(`Context: ${context || '(global)'}\n`);

  await preflightHttp(BASE_URL);

  const result = await resolveFromServer({ issuer, subject, context });

  console.log('Result:');
  console.log(`  connected: ${result.connected}`);
  console.log(`  degree:    ${result.degree}`);
  console.log(`  trust:     ${result.trust}`);
  console.log(`  distrust:  ${result.distrust}`);
  console.log();
  console.log('Full response:');
  console.log(JSON.stringify(result, null, 2));
}

async function runAllExpected(): Promise<void> {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'trust-graph.json');
  if (!existsSync(fixturePath)) {
    console.error(`❌ Fixture not found: ${fixturePath}`);
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    keys: { label?: string; pubkey: string }[];
    expected: Expected[];
  };

  const keys = fixture.keys;

  console.log('🔗 Resolve Trust — All Expected Cases\n');
  console.log(`Server:  ${BASE_URL}`);
  console.log(`Cases:   ${fixture.expected.length}\n`);

  await preflightHttp(BASE_URL);

  let passed = 0;
  let failed = 0;

  for (const exp of fixture.expected) {
    const issuer  = resolvePubkeyFromFixture(exp.issuer, keys);
    const subject = resolvePubkeyFromFixture(exp.subject, keys);
    const context = exp.context ?? '';

    const issuerLabel  = findLabel(exp.issuer, keys);
    const subjectLabel = findLabel(exp.subject, keys);
    const ctx = context ? ` (${context})` : ' (global)';
    const label = `${issuerLabel} -> ${subjectLabel}${ctx}`;

    try {
      const result = await resolveFromServer({ issuer, subject, context });

      const expConnected = exp.connected !== false;
      const expDegree    = exp.connected === false ? 0 : (exp.degree ?? 0);
      const expTrust     = exp.trust ?? 0;
      const expDistrust  = exp.distrust ?? 0;

      const ok =
        Boolean(result.connected) === expConnected &&
        (result.degree ?? 0) === expDegree &&
        (result.trust ?? 0) === expTrust &&
        (result.distrust ?? 0) === expDistrust;

      if (ok) {
        console.log(`  ✓ ${label}`);
        console.log(`    connected=${result.connected} degree=${result.degree} trust=${result.trust} distrust=${result.distrust}`);
        passed++;
      } else {
        console.log(`  ✗ ${label}`);
        console.log(`    expected: connected=${expConnected} degree=${expDegree} trust=${expTrust} distrust=${expDistrust}`);
        console.log(`    got:      connected=${result.connected} degree=${result.degree} trust=${result.trust} distrust=${result.distrust}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ✗ ${label}`);
      console.log(`    error: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function resolveFromServer(params: {
  issuer: string;
  subject: string;
  context?: string;
}): Promise<ResolveResult> {
  const body: Record<string, unknown> = {
    author: params.issuer,
    subject: params.subject,
  };
  if (params.context !== undefined) body['context'] = params.context;

  const res = await fetch(RESOLVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resolve failed (${res.status}): ${text}`);
  }

  const payload = (await res.json()) as unknown;
  return extractResolveResult(payload);
}

function extractResolveResult(payload: unknown): ResolveResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Resolve response is not a JSON object');
  }

  const envelope = payload as ApiEnvelope<ResolveResult | ResolveResult[]>;
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

    if (Array.isArray(raw)) {
      const first = raw[0];
      if (!first || typeof first !== 'object') {
        throw new Error('Resolve API returned empty score array');
      }
      return first as ResolveResult;
    }

    if (typeof raw !== 'object') {
      throw new Error('Resolve API data is not an object or array');
    }
    return raw as ResolveResult;
  }

  // Backward compatibility for older servers that returned raw score JSON.
  return payload as ResolveResult;
}

function resolvePubkeyFromFixture(value: string | number, keys: { pubkey: string }[]): string {
  if (typeof value === 'number') {
    const key = keys[value];
    if (!key) throw new Error(`Key index out of range: ${value}`);
    return key.pubkey;
  }
  if (value.startsWith('npub1')) {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'npub') throw new Error(`Expected npub, got ${decoded.type}`);
    return decoded.data.toLowerCase();
  }
  return value.toLowerCase();
}

function findLabel(value: string | number, keys: { label?: string; pubkey: string }[]): string {
  if (typeof value === 'number') return keys[value]?.label ?? `key[${value}]`;
  const match = keys.find((k) => k.pubkey.toLowerCase() === value.toLowerCase());
  return match?.label ?? value.slice(0, 12) + '…';
}

function resolveArg(arg: string | undefined): string | null {
  if (!arg) return null;
  if (arg.startsWith('npub1')) {
    const decoded = nip19.decode(arg);
    if (decoded.type !== 'npub') throw new Error(`Expected npub, got ${decoded.type}`);
    return decoded.data.toLowerCase();
  }
  return arg.toLowerCase();
}

function normalizeBaseUrl(input: string): string {
  // If it looks like just a relay WebSocket URL, convert to HTTP
  const url = new URL(input.replace(/^ws(s?):/, 'http$1:'));
  // Strip optional resolve path to normalize origin.
  url.pathname = '/';
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/$/, '');
}

async function preflightHttp(origin: string): Promise<void> {
  const healthUrl = `${origin}/v1/ping`;
  console.log(`Checking server health (${healthUrl})...`);
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('Server is up.\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach server at ${healthUrl}: ${msg}\n  Start with: npx . server`);
  }
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
