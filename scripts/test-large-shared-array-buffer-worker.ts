/**
 * Worker: fill a disjoint range of the SharedArrayBuffer with 1.
 * Loaded by test-large-shared-array-buffer.ts via worker_threads.
 *
 * One Uint8Array view of the full buffer (required to address bytes in JS);
 * writes use `start` and `length` — no second view with byteOffset/length.
 */

import { parentPort, workerData } from 'node:worker_threads';

type Payload = {
  sab: SharedArrayBuffer;
  /** Byte index in the SharedArrayBuffer where this job starts. */
  start: number;
  /** Number of bytes to write. */
  length: number;
  jobIndex: number;
};

const { sab, start, length, jobIndex } = workerData as Payload;
const end = start + length;

const u8 = new Uint8Array(sab);
const t0 = performance.now();
u8.fill(1, start, end);
const t1 = performance.now();

parentPort!.postMessage({
  ok: true,
  jobIndex,
  start,
  length,
  ms: t1 - t0,
});
