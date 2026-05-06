import { freemem, totalmem } from 'node:os';
import { MemPool, type MemPoolOpts } from '@thi.ng/malloc';

/**
 * Pool sizing / growth granularity in bytes. A u32 index into 64-byte slots spans at most
 * `2**32 * 64` ≈ 256 GiB, which matches a 32-bit byte offset ceiling for this layout.
 */
export const POOL_PAGE_BYTES = 64;

/** `@thi.ng/malloc` `pool.js` `STATE_END` index in `Uint32Array(buffer, start, …)`. */
const MEMPOOL_STATE_END_U32 = 3;

type GrowableSharedArrayBufferCtor = new (
    byteLength: number,
    options?: { maxByteLength?: number },
) => SharedArrayBuffer;

function createGrowableSharedArrayBuffer(byteLength: number, maxByteLength: number): SharedArrayBuffer {
    const Ctor = SharedArrayBuffer as unknown as GrowableSharedArrayBufferCtor;
    return new Ctor(byteLength, { maxByteLength });
}

function readSharedArrayBufferMaxByteLength(sab: SharedArrayBuffer): number | undefined {
    const m = (sab as { maxByteLength?: number }).maxByteLength;
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
}

function setMemPoolEndByte(buf: ArrayBufferLike, poolStart: number, endByte: number): void {
    const state = new Uint32Array(buf, poolStart, 7);
    state[MEMPOOL_STATE_END_U32] = endByte >>> 0;
}

function alignPoolBytesDown(n: number): number {
    if (!Number.isFinite(n) || n <= 0) {
        return 0;
    }
    return Math.floor(n / POOL_PAGE_BYTES) * POOL_PAGE_BYTES;
}

function alignPoolBytesUp(n: number): number {
    if (!Number.isFinite(n) || n <= 0) {
        return 0;
    }
    return Math.ceil(n / POOL_PAGE_BYTES) * POOL_PAGE_BYTES;
}

/**
 * Best-effort “available” bytes for sizing a shared heap.
 * Uses the smaller of free and total physical memory so the estimate stays bounded.
 */
export function estimateAvailableSystemBytes(): number {
    try {
        const free = freemem();
        const total = totalmem();
        if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) {
            return 64 * 1024 * 1024;
        }
        return Math.min(free, total);
    } catch {
        return 64 * 1024 * 1024;
    }
}

const DEFAULT_INITIAL = 65536;
const DEFAULT_MIN_MAX = POOL_PAGE_BYTES;
/** Default hard cap: 256 GiB (`2**32 * POOL_PAGE_BYTES`). */
const DEFAULT_CAP_MAX = 256 * 1024 * 1024 * 1024;

export interface SharedMemoryPoolOptions extends Partial<Omit<MemPoolOpts, 'buf' | 'size'>> {
    /**
     * Attach to an existing growable (or fixed) `SharedArrayBuffer` image, e.g. in a worker.
     * When set, {@link skipInitialization} must be `true` (same contract as {@link MemPool}).
     */
    backing?: SharedArrayBuffer;
    /**
     * Override {@link estimateAvailableSystemBytes} before applying {@link fractionOfAvailable}.
     * Ignored when {@link backing} is set.
     */
    estimatedAvailableBytes?: number;
    /**
     * Fraction of the estimated available bytes used as resizable `maxByteLength` (default `0.5`).
     * Ignored when {@link backing} is set.
     */
    fractionOfAvailable?: number;
    /**
     * Initial committed `byteLength` for a newly created buffer (default `min(65536, maxByteLength)`).
     * Ignored when {@link backing} is set.
     */
    initialByteLength?: number;
    /** Minimum `maxByteLength` after scaling (default {@link POOL_PAGE_BYTES}). Ignored when {@link backing} is set. */
    minMaxByteLength?: number;
    /** Hard ceiling for `maxByteLength` (default 256 GiB). Ignored when {@link backing} is set. */
    maxMaxByteLength?: number;
}

/**
 * Central {@link MemPool} over one growable {@link SharedArrayBuffer}.
 * On construction (without {@link SharedMemoryPoolOptions.backing}), estimates system memory
 * via {@link estimateAvailableSystemBytes}, sets `maxByteLength` to
 * `floor(fraction × estimate)` (aligned to {@link POOL_PAGE_BYTES}), and starts the pool at
 * `initialByteLength` (also aligned down to a page).
 */
export default class SharedMemoryPool extends MemPool {
    readonly sharedArrayBuffer: SharedArrayBuffer;
    readonly poolMaxByteLength: number;

    constructor(opts?: SharedMemoryPoolOptions) {
        const {
            backing,
            estimatedAvailableBytes,
            fractionOfAvailable = 0.5,
            initialByteLength: initialOpt,
            minMaxByteLength = DEFAULT_MIN_MAX,
            maxMaxByteLength = DEFAULT_CAP_MAX,
            ...memOpts
        } = opts ?? {};

        let sab: SharedArrayBuffer;
        let poolMax: number;
        let skipInitialization: boolean;

        if (backing !== undefined) {
            if (opts?.skipInitialization !== true) {
                throw new RangeError(
                    'SharedMemoryPool: when `backing` is set, `skipInitialization: true` is required (same as MemPool)',
                );
            }
            sab = backing;
            poolMax = readSharedArrayBufferMaxByteLength(sab) ?? sab.byteLength;
            skipInitialization = true;
        } else {
            const estimate = estimatedAvailableBytes ?? estimateAvailableSystemBytes();
            if (!Number.isFinite(estimate) || estimate <= 0) {
                throw new RangeError('SharedMemoryPool: estimatedAvailableBytes must be a positive finite number');
            }
            if (!Number.isFinite(fractionOfAvailable) || fractionOfAvailable <= 0 || fractionOfAvailable > 1) {
                throw new RangeError('SharedMemoryPool: fractionOfAvailable must be in (0, 1]');
            }
            if (minMaxByteLength < POOL_PAGE_BYTES) {
                throw new RangeError(`SharedMemoryPool: minMaxByteLength must be >= ${POOL_PAGE_BYTES}`);
            }
            if (minMaxByteLength > maxMaxByteLength) {
                throw new RangeError('SharedMemoryPool: minMaxByteLength must be <= maxMaxByteLength');
            }
            let maxByteLength = alignPoolBytesDown(Math.floor(estimate * fractionOfAvailable));
            maxByteLength = Math.max(minMaxByteLength, Math.min(maxByteLength, maxMaxByteLength));
            let initial = initialOpt ?? Math.min(DEFAULT_INITIAL, maxByteLength);
            if (!Number.isInteger(initial)) {
                throw new RangeError('SharedMemoryPool: initialByteLength must be an integer');
            }
            initial = Math.min(Math.max(initial, POOL_PAGE_BYTES), maxByteLength);
            initial = alignPoolBytesDown(initial);
            if (initial < POOL_PAGE_BYTES) {
                throw new RangeError(
                    `SharedMemoryPool: aligned initialByteLength must be >= ${POOL_PAGE_BYTES} (maxByteLength=${maxByteLength})`,
                );
            }
            sab = createGrowableSharedArrayBuffer(initial, maxByteLength);
            poolMax = maxByteLength;
            skipInitialization = false;
        }

        super({
            buf: sab,
            skipInitialization,
            ...memOpts,
        });

        this.sharedArrayBuffer = sab;
        this.poolMaxByteLength = poolMax;
    }

    /**
     * Attach to a pool image initialized on the main thread (typical worker entry).
     * Pass the same {@link MemPoolOpts.start} and other MemPool options as the creator.
     */
    static from(
        buffer: SharedArrayBuffer,
        memOpts?: Partial<Omit<MemPoolOpts, 'buf' | 'size'>>,
    ): SharedMemoryPool {
        return new SharedMemoryPool({
            ...memOpts,
            backing: buffer,
            skipInitialization: true,
        });
    }

    /** Same as {@link SharedMemoryPool.from}. */
    static attach(
        buffer: SharedArrayBuffer,
        memOpts?: Partial<Omit<MemPoolOpts, 'buf' | 'size'>>,
    ): SharedMemoryPool {
        return SharedMemoryPool.from(buffer, memOpts);
    }

    /** `SharedArrayBuffer.prototype.grow` then widen the allocator `end` to the new `byteLength`. */
    growSharedBacking(targetByteLength: number): void {
        const sab = this.sharedArrayBuffer;
        const grow = (sab as { grow?: (n: number) => void }).grow;
        if (typeof grow !== 'function') {
            throw new RangeError('SharedMemoryPool.growSharedBacking: buffer is not growable');
        }
        const cur = sab.byteLength;
        if (!Number.isInteger(targetByteLength) || targetByteLength <= cur) {
            throw new RangeError(
                'SharedMemoryPool.growSharedBacking: targetByteLength must be an integer > current byteLength',
            );
        }
        const maxB = readSharedArrayBufferMaxByteLength(sab);
        let grownTo = alignPoolBytesUp(targetByteLength);
        if (grownTo <= cur) {
            grownTo = cur + POOL_PAGE_BYTES;
        }
        if (maxB !== undefined && grownTo > maxB) {
            throw new RangeError(
                `SharedMemoryPool.growSharedBacking: aligned size ${grownTo} exceeds maxByteLength ${maxB}`,
            );
        }
        grow.call(sab, grownTo);
        setMemPoolEndByte(sab, this.start, sab.byteLength);
        this.rebindViewsAfterGrow();
    }

    private rebindViewsAfterGrow(): void {
        this.u8 = new Uint8Array(this.buf);
        this.u32 = new Uint32Array(this.buf);
        this.state = new Uint32Array(this.buf, this.start, 7);
    }
}
