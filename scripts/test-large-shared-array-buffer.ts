#!/usr/bin/env npx tsx
/**
 * Smoke test: allocate a very large SharedArrayBuffer and write 1 to every byte
 * using one worker_threads worker per logical CPU. Each job receives `start` and
 * `length` and writes into the same SharedArrayBuffer via one full-buffer view
 * and `fill(1, start, start + length)` (no offset/length sub-views).
 * Intended for Node.js only (not the browser).
 *
 * Default size is 96 GiB — this commits real physical RAM when filled; ensure the
 * machine has enough free memory. Override with SAB_TEST_GIB (e.g. `SAB_TEST_GIB=1`
 * for a 1 GiB allocation on a smaller box).
 *
 * Optional: SAB_WORKERS=n to use n workers instead of min(cores, byteLength).
 *
 * Usage:
 *   npx tsx scripts/test-large-shared-array-buffer.ts
 *   SAB_TEST_GIB=1 npx tsx scripts/test-large-shared-array-buffer.ts
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

type SabFillWorkerPayload = {
  sab: SharedArrayBuffer;
  start: number;
  length: number;
  jobIndex: number;
};

const GIB = 1024 ** 3;

function formatBytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${n} B`;
}

function memLine(label: string): void {
  const m = process.memoryUsage();
  console.log(`${label}:`, {
    rss: formatBytes(m.rss),
    heapTotal: formatBytes(m.heapTotal),
    heapUsed: formatBytes(m.heapUsed),
    external: formatBytes(m.external),
    arrayBuffers: formatBytes(m.arrayBuffers),
  });
}

/** Disjoint ranges covering [0, byteLength). */
function splitRanges(byteLength: number, numWorkers: number): { start: number; end: number }[] {
  const n = Math.max(1, Math.min(numWorkers, byteLength));
  const chunk = Math.ceil(byteLength / n);
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunk;
    if (start >= byteLength) break;
    const end = Math.min(start + chunk, byteLength);
    ranges.push({ start, end });
  }
  return ranges;
}

function runWorker(payload: SabFillWorkerPayload): Promise<{ ms: number; jobIndex: number }> {
  const workerFile = fileURLToPath(
    new URL('./test-large-shared-array-buffer-worker.ts', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new Worker(workerFile, {
      workerData: payload,
      execArgv: process.execArgv,
    });
    const finish = (err: Error | null, value?: { ms: number; jobIndex: number }) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value!);
    };
    w.on('message', (msg: { ok?: boolean; ms?: number; jobIndex?: number }) => {
      if (msg?.ok && typeof msg.ms === 'number' && typeof msg.jobIndex === 'number') {
        finish(null, { ms: msg.ms, jobIndex: msg.jobIndex });
      } else {
        finish(new Error(`Unexpected worker message: ${JSON.stringify(msg)}`));
      }
    });
    w.on('error', (err) => finish(err));
    w.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`Worker ${payload.jobIndex} exited with code ${code}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const gib = Math.max(1, Math.floor(Number(process.env.SAB_TEST_GIB ?? 96)));
  const byteLength = gib * GIB;

  if (byteLength > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `byteLength ${byteLength} exceeds Number.MAX_SAFE_INTEGER; reduce SAB_TEST_GIB`,
    );
  }

  const cpuCount = os.cpus().length;
  const envWorkers = process.env.SAB_WORKERS?.trim();
  const numWorkers =
    envWorkers !== undefined && envWorkers !== ''
      ? Math.max(1, Math.floor(Number(envWorkers)))
      : cpuCount;

  console.log('Large SharedArrayBuffer smoke test (parallel workers)');
  console.log(`Target size: ${gib} GiB (${formatBytes(byteLength)})`);
  console.log(`Logical CPUs: ${cpuCount}, workers: ${numWorkers} (disjoint slices)`);
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  console.log('');

  memLine('memoryUsage (before)');
  console.log('Allocating SharedArrayBuffer…');

  let sab: SharedArrayBuffer;
  try {
    sab = new SharedArrayBuffer(byteLength);
  } catch (err) {
    console.error('Allocation failed:', err);
    throw err;
  }

  memLine('memoryUsage (after alloc, before fill)');
  console.log(`sab.byteLength = ${sab.byteLength}`);
  console.log('');

  const ranges = splitRanges(byteLength, numWorkers);
  const sliceBytes = ranges.map((r) => r.end - r.start);
  const minSlice = Math.min(...sliceBytes);
  const maxSlice = Math.max(...sliceBytes);
  console.log(
    `Spawning ${ranges.length} workers; slice length min ${formatBytes(minSlice)} max ${formatBytes(maxSlice)}`,
  );
  console.log('Writing 1 to every byte (parallel fill, may take a while)…');

  const t0 = performance.now();
  const results = await Promise.all(
    ranges.map((range, jobIndex) =>
      runWorker({
        sab,
        start: range.start,
        length: range.end - range.start,
        jobIndex,
      }),
    ),
  );
  const t1 = performance.now();

  const wallMs = t1 - t0;
  const maxWorkerMs = Math.max(...results.map((r) => r.ms));
  console.log(`Wall-clock time: ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`Slowest worker fill: ${(maxWorkerMs / 1000).toFixed(2)} s (per-job CPU time)`);
  console.log('');

  memLine('memoryUsage (after fill)');

  const u8 = new Uint8Array(sab);
  const last = byteLength - 1;
  const mid = Math.floor(byteLength / 2);
  if (u8[0] !== 1 || u8[mid] !== 1 || u8[last] !== 1) {
    throw new Error(
      `Verification failed: expected 1 at start/mid/end, got ${u8[0]}, ${u8[mid]}, ${u8[last]}`,
    );
  }
  console.log('OK: start, middle, and last byte are 1');

  console.log('');
  console.log('Done. All workers wrote disjoint regions of the same SharedArrayBuffer.');
}

await main();
