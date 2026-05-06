import { totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import SharedMemoryPool, {
    POOL_PAGE_BYTES,
    estimateAvailableSystemBytes,
} from '../../../src/lib/Shared/SharedMemoryPool.js';

type GrowableSharedArrayBufferCtor = new (
    byteLength: number,
    options?: { maxByteLength?: number },
) => SharedArrayBuffer;

function createGrowableSharedArrayBuffer(byteLength: number, maxByteLength: number): SharedArrayBuffer {
    const Ctor = SharedArrayBuffer as unknown as GrowableSharedArrayBufferCtor;
    return new Ctor(byteLength, { maxByteLength });
}

function environmentSupportsGrowableSharedArrayBuffer(): boolean {
    if (typeof SharedArrayBuffer === 'undefined') return false;
    try {
        const b = createGrowableSharedArrayBuffer(256, 512);
        return typeof (b as SharedArrayBuffer & { grow?: (n: number) => void }).grow === 'function';
    } catch {
        return false;
    }
}

describe('estimateAvailableSystemBytes', () => {
    it('returns a positive finite value bounded by total system memory', () => {
        const est = estimateAvailableSystemBytes();
        expect(est).toBeGreaterThan(0);
        expect(Number.isFinite(est)).toBe(true);
        expect(est).toBeLessThanOrEqual(totalmem());
    });
});

describe('POOL_PAGE_BYTES', () => {
    it('is 64 for u32 slot addressing', () => {
        expect(POOL_PAGE_BYTES).toBe(64);
    });
});

describe('SharedMemoryPool', () => {
    it('sizes maxByteLength to a multiple of POOL_PAGE_BYTES and clamps to maxMaxByteLength', () => {
        const cap = 128 * POOL_PAGE_BYTES;
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: 10_000,
            fractionOfAvailable: 1,
            maxMaxByteLength: cap,
            initialByteLength: POOL_PAGE_BYTES,
        });
        expect(pool.poolMaxByteLength).toBe(cap);
        expect(pool.poolMaxByteLength % POOL_PAGE_BYTES).toBe(0);
        expect((pool.sharedArrayBuffer as { maxByteLength?: number }).maxByteLength).toBe(cap);
    });

    it('aligns initial committed byteLength down to a page', () => {
        const max = 4096;
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: max * 4,
            fractionOfAvailable: 1,
            maxMaxByteLength: max,
            initialByteLength: 100,
        });
        expect(pool.sharedArrayBuffer.byteLength % POOL_PAGE_BYTES).toBe(0);
        expect(pool.sharedArrayBuffer.byteLength).toBe(64);
    });

    it('defaults initial to min(65536, max) when max is smaller', () => {
        const max = 8192;
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: max * 2,
            fractionOfAvailable: 1,
            maxMaxByteLength: max,
        });
        expect(pool.sharedArrayBuffer.byteLength).toBe(max);
    });

    it('applies fractionOfAvailable to the estimate', () => {
        const est = 1_000_000;
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: est,
            fractionOfAvailable: 0.25,
            maxMaxByteLength: est,
            initialByteLength: POOL_PAGE_BYTES,
        });
        const expectedMax = Math.floor(est * 0.25 / POOL_PAGE_BYTES) * POOL_PAGE_BYTES;
        expect(pool.poolMaxByteLength).toBe(expectedMax);
    });

    it('throws when fractionOfAvailable is outside (0, 1]', () => {
        expect(() => new SharedMemoryPool({ estimatedAvailableBytes: 1e6, fractionOfAvailable: 0 })).toThrow(
            RangeError,
        );
        expect(() => new SharedMemoryPool({ estimatedAvailableBytes: 1e6, fractionOfAvailable: 1.1 })).toThrow(
            RangeError,
        );
    });

    it('throws when minMaxByteLength is below POOL_PAGE_BYTES', () => {
        expect(
            () =>
                new SharedMemoryPool({
                    estimatedAvailableBytes: 1e6,
                    minMaxByteLength: 32,
                }),
        ).toThrow(RangeError);
    });

    it('throws when minMaxByteLength > maxMaxByteLength', () => {
        expect(
            () =>
                new SharedMemoryPool({
                    estimatedAvailableBytes: 1e9,
                    minMaxByteLength: 2000,
                    maxMaxByteLength: 1000,
                }),
        ).toThrow(RangeError);
    });

    it('throws when backing is set without skipInitialization: true', () => {
        const sab = createGrowableSharedArrayBuffer(POOL_PAGE_BYTES, 4096);
        expect(
            () =>
                new SharedMemoryPool({
                    backing: sab,
                    skipInitialization: false,
                }),
        ).toThrow(/skipInitialization/);
    });

    it('from() attaches with the same MemPool image as the owner (start 0)', () => {
        const owner = new SharedMemoryPool({
            estimatedAvailableBytes: 256 * 1024,
            fractionOfAvailable: 1,
            maxMaxByteLength: 256 * 1024,
            initialByteLength: 128 * 1024,
        });
        const worker = SharedMemoryPool.from(owner.sharedArrayBuffer, { start: 0 });
        expect(worker.buf).toBe(owner.buf);
        expect(worker.stats().total).toBe(owner.stats().total);
        expect(worker.stats().top).toBe(owner.stats().top);
    });

    it('attach() delegates to from()', () => {
        const owner = new SharedMemoryPool({
            estimatedAvailableBytes: 96 * 1024,
            fractionOfAvailable: 1,
            maxMaxByteLength: 96 * 1024,
            initialByteLength: 64 * 1024,
        });
        const a = SharedMemoryPool.attach(owner.sharedArrayBuffer, { start: 0 });
        const b = SharedMemoryPool.from(owner.sharedArrayBuffer, { start: 0 });
        expect(a.stats().available).toBe(b.stats().available);
    });

    it('malloc and free work on a fresh pool', () => {
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: 256 * 1024,
            fractionOfAvailable: 1,
            maxMaxByteLength: 256 * 1024,
            initialByteLength: 64 * 1024,
        });
        const p = pool.malloc(128);
        expect(p).toBeGreaterThan(0);
        expect(pool.free(p)).toBe(true);
    });

    it('exposes buf and sharedArrayBuffer as the same backing', () => {
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: 128 * 1024,
            fractionOfAvailable: 1,
            maxMaxByteLength: 128 * 1024,
            initialByteLength: 64 * 1024,
        });
        expect(pool.buf).toBe(pool.sharedArrayBuffer);
    });
});

describe('SharedMemoryPool.growSharedBacking', () => {
    it('grows backing and increases allocator end (growable SAB only)', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) {
            return;
        }
        const initial = 16 * POOL_PAGE_BYTES;
        const max = 256 * POOL_PAGE_BYTES;
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: max,
            fractionOfAvailable: 1,
            maxMaxByteLength: max,
            initialByteLength: initial,
        });
        const before = pool.sharedArrayBuffer.byteLength;
        const availBefore = pool.stats().available;
        pool.growSharedBacking(before + 1);
        expect(pool.sharedArrayBuffer.byteLength).toBeGreaterThan(before);
        expect(pool.sharedArrayBuffer.byteLength % POOL_PAGE_BYTES).toBe(0);
        expect(pool.stats().available).toBeGreaterThanOrEqual(availBefore);
        expect(pool.stats().total).toBe(pool.sharedArrayBuffer.byteLength);
    });

    it('throws when target is not greater than current length', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) {
            return;
        }
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: 128 * 1024,
            fractionOfAvailable: 1,
            maxMaxByteLength: 128 * 1024,
            initialByteLength: 64 * 1024,
        });
        const len = pool.sharedArrayBuffer.byteLength;
        expect(() => pool.growSharedBacking(len)).toThrow(RangeError);
        expect(() => pool.growSharedBacking(len - 1)).toThrow(RangeError);
    });

    it('throws when aligned growth exceeds maxByteLength', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) {
            return;
        }
        const max = 4 * POOL_PAGE_BYTES;
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: max,
            fractionOfAvailable: 1,
            maxMaxByteLength: max,
            initialByteLength: 2 * POOL_PAGE_BYTES,
        });
        expect(() => pool.growSharedBacking(max + 1)).toThrow(/maxByteLength/);
    });
});
