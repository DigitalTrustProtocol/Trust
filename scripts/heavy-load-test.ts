#!/usr/bin/env npx tsx
/**
 * Heavy resolve benchmark against a running local Trust server.
 *
 * This script does NOT seed data.
 * Seed first with:
 *   npx tsx scripts/seed-trust-network.ts
 *
 * Then start server and run:
 *   npx . server --database sqlite
 *   npx tsx scripts/heavy-load-test.ts
 */

import {
  LEVEL3,
  authorKey,
  level3Key,
} from './load-test-keys.ts';

const BASE_URL = (process.env.TRUST_LOAD_BASE_URL ?? 'http://127.0.0.1:3417').replace(/\/$/, '');
const RESOLVE_URL = process.env.TRUST_LOAD_RESOLVE_URL ?? `${BASE_URL}/resolve`;
const HEALTH_URL = process.env.TRUST_LOAD_HEALTH_URL ?? `${BASE_URL}/health`;
const CONCURRENT_RESOLVE_REQUESTS = Math.max(1, Number(process.env.TRUST_LOAD_CONCURRENT_REQUESTS ?? 1_000));

type ResolveData = {
  connected?: boolean;
  degree?: number;
  trust?: number;
  distrust?: number;
};

type ApiEnvelope<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

type ResolveStats = {
  totalMs: number;
  avgMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  failures: number;
  success: number;
};

async function main(): Promise<void> {
  await preflight();

  const author = authorKey();
  const singleSubject = level3Key(LEVEL3 - 1).pubkey;
  const concurrentSubjects = Array.from(
    { length: CONCURRENT_RESOLVE_REQUESTS },
    (_, i) => level3Key(Math.floor(LEVEL3 / 2) + i).pubkey,
  );

  console.log('Heavy load resolve benchmark');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Resolve URL: ${RESOLVE_URL}`);
  console.log(`Author: ${author.pubkey}`);
  console.log(`Single test subject: ${singleSubject}`);
  console.log(`Concurrent requests: ${CONCURRENT_RESOLVE_REQUESTS}`);
  console.log('');

  await runSingleResolve(author.pubkey, singleSubject);
  console.log('');
  await runConcurrentResolve(author.pubkey, concurrentSubjects);
}

async function preflight(): Promise<void> {
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Health check failed (${res.status}): ${body}`);
  }
}

async function runSingleResolve(author: string, subject: string): Promise<void> {
  const t0 = nowMs();
  const result = await resolve(author, subject);
  const elapsed = nowMs() - t0;

  console.log('Single resolve benchmark');
  console.log(`connected=${Boolean(result.connected)} degree=${result.degree ?? 0} trust=${result.trust ?? 0} distrust=${result.distrust ?? 0}`);
  console.log(`duration_ms=${elapsed.toFixed(2)}`);
}

async function runConcurrentResolve(author: string, subjects: string[]): Promise<void> {
  const stats = await measureConcurrentResolves(author, subjects);

  console.log(`Concurrent resolve benchmark (${subjects.length} requests)`);
  console.log(`wall_clock_ms=${stats.totalMs.toFixed(2)}`);
  console.log(
    `avg_ms=${stats.avgMs.toFixed(2)} min_ms=${stats.minMs.toFixed(2)} p50_ms=${stats.p50Ms.toFixed(2)} ` +
      `p95_ms=${stats.p95Ms.toFixed(2)} p99_ms=${stats.p99Ms.toFixed(2)} max_ms=${stats.maxMs.toFixed(2)}`,
  );
  console.log(`success=${stats.success} failures=${stats.failures}`);
}

async function measureConcurrentResolves(author: string, subjects: string[]): Promise<ResolveStats> {
  const allStart = nowMs();

  const outcomes = await Promise.all(
    subjects.map(async (subject) => {
      const t0 = nowMs();
      try {
        const data = await resolve(author, subject);
        return {
          durationMs: nowMs() - t0,
          ok: data.connected === true && data.degree === 3,
        };
      } catch {
        return {
          durationMs: nowMs() - t0,
          ok: false,
        };
      }
    }),
  );

  const totalMs = nowMs() - allStart;
  const durations = outcomes.map((o) => o.durationMs).sort((a, b) => a - b);
  const success = outcomes.filter((o) => o.ok).length;
  const failures = outcomes.length - success;

  return {
    totalMs,
    avgMs: average(durations),
    minMs: durations[0] ?? 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations[durations.length - 1] ?? 0,
    failures,
    success,
  };
}

async function resolve(author: string, subject: string): Promise<ResolveData> {
  const response = await fetch(RESOLVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      author,
      subject,
      context: '',
      maxDepth: 3,
      format: 'default',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Resolve failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as unknown;
  return extractResolveData(payload);
}

function extractResolveData(payload: unknown): ResolveData {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Resolve response is not an object');
  }

  const envelope = payload as ApiEnvelope<ResolveData>;
  if (typeof envelope.ok === 'boolean') {
    if (!envelope.ok) {
      throw new Error(envelope.error?.message ?? 'Resolve API returned error');
    }
    if (!envelope.data || typeof envelope.data !== 'object') {
      throw new Error('Resolve API response missing data');
    }
    return envelope.data;
  }

  return payload as ResolveData;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const n of values) sum += n;
  return sum / values.length;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(sortedValues.length * p)));
  return sortedValues[idx] ?? 0;
}

function nowMs(): number {
  return performance.now();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
