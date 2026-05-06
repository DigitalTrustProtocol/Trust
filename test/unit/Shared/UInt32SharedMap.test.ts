import { describe, it, expect } from 'vitest';
import SharedMemoryPool from '../../../src/lib/Shared/SharedMemoryPool.js';
import UInt32SharedMap, { UINT32_MAX } from '../../../src/lib/Shared/UInt32SharedMap.js';

/** Pool sized for several small maps + rehash headroom (no reliance on machine RAM estimate). */
function createTestPool(): SharedMemoryPool {
    const initial = 256 * 1024;
    const max = 4 * 1024 * 1024;
    return new SharedMemoryPool({
        initialByteLength: initial,
        minMaxByteLength: initial,
        fractionOfAvailable: 1,
        estimatedAvailableBytes: max,
        maxMaxByteLength: max,
    });
}

describe('UInt32SharedMap', () => {
    it('set/get/has: missing key is undefined', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 32 });
        expect(m.get(1)).toBeUndefined();
        expect(m.has(1)).toBe(false);
        m.set(1, 42);
        expect(m.get(1)).toBe(42);
        expect(m.has(1)).toBe(true);
        expect(m.length).toBe(1);
    });

    it('set replaces value for same key', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        m.set(10, 1);
        m.set(10, 2);
        expect(m.length).toBe(1);
        expect(m.get(10)).toBe(2);
    });

    it('allows key 0 and stores low 32 bits', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        m.set(0, 99);
        expect(m.get(0)).toBe(99);
        m.set(-1 as unknown as number, UINT32_MAX);
        expect(m.get(UINT32_MAX)).toBe(UINT32_MAX);
    });

    it('delete removes entry', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        m.set(5, 7);
        m.delete(5);
        expect(m.get(5)).toBeUndefined();
        expect(m.length).toBe(0);
    });

    it('delete throws when key absent', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 8 });
        expect(() => m.delete(99)).toThrow(RangeError);
    });

    it('from() attaches second view to same table as writer', () => {
        const pool = createTestPool();
        const owner = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 32 });
        owner.set(123, 456);
        const reader = UInt32SharedMap.from(pool, owner.tablePtr);
        expect(reader.get(123)).toBe(456);
        owner.set(9, 8);
        expect(reader.get(9)).toBe(8);
    });

    it('entries() yields all key/value pairs in one pass', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        m.set(1, 10);
        m.set(2, 20);
        m.set(3, 30);
        const pairs = [...m.entries()];
        expect(pairs.length).toBe(3);
        const asMap = new Map(pairs);
        expect(asMap.get(1)).toBe(10);
        expect(asMap.get(2)).toBe(20);
        expect(asMap.get(3)).toBe(30);
    });

    it('clear empties only that map', () => {
        const pool = createTestPool();
        const a = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        const b = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        a.set(1, 100);
        b.set(1, 200);
        a.clear();
        expect(a.get(1)).toBeUndefined();
        expect(b.get(1)).toBe(200);
    });

    it('auto-rehash: fifth insert in 4-bucket map succeeds', () => {
        const pool = createTestPool();
        const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 4 });
        m.set(0, 1);
        m.set(1, 2);
        m.set(2, 3);
        m.set(3, 4);
        m.set(4, 5);
        expect(m.length).toBe(5);
        expect(m.get(4)).toBe(5);
        expect(m.get(0)).toBe(1);
    });

    it('multiple maps on one pool: distinct tablePtr and no cross-map data conflict', () => {
        const pool = createTestPool();

        const mapCount = 5;
        const keysPerMap = 50;
        const maps: UInt32SharedMap[] = [];
        const ptrs: number[] = [];

        for (let i = 0; i < mapCount; i++) {
            const m = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 32 });
            maps.push(m);
            ptrs.push(m.tablePtr);
        }

        const uniquePtrs = new Set(ptrs);
        expect(uniquePtrs.size).toBe(mapCount);

        for (let mi = 0; mi < mapCount; mi++) {
            const m = maps[mi]!;
            for (let k = 0; k < keysPerMap; k++) {
                const value = (mi + 1) * 1_000_000 + k;
                m.set(k >>> 0, value >>> 0);
            }
        }

        for (let mi = 0; mi < mapCount; mi++) {
            const m = maps[mi]!;
            for (let k = 0; k < keysPerMap; k++) {
                const want = (mi + 1) * 1_000_000 + k;
                expect(m.get(k)).toBe(want);
            }
        }

        for (let mi = 0; mi < mapCount; mi++) {
            for (let other = 0; other < mapCount; other++) {
                if (other === mi) continue;
                const m = maps[mi]!;
                const otherMap = maps[other]!;
                const probeKey = 7;
                expect(m.get(probeKey)).not.toBe(otherMap.get(probeKey));
            }
        }

        const victim = maps[2]!;
        for (let k = 0; k < keysPerMap; k++) {
            victim.set(k >>> 0, 9_999_000 + k);
        }
        for (let mi = 0; mi < mapCount; mi++) {
            if (mi === 2) continue;
            const m = maps[mi]!;
            for (let k = 0; k < keysPerMap; k++) {
                const want = (mi + 1) * 1_000_000 + k;
                expect(m.get(k)).toBe(want);
            }
        }
        for (let k = 0; k < keysPerMap; k++) {
            expect(victim.get(k)).toBe(9_999_000 + k);
        }
    });

    it('destroy frees table; other maps on pool stay valid', () => {
        const pool = createTestPool();
        const a = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        const b = UInt32SharedMap.createInPool(pool, { initialBucketCapacity: 16 });
        a.set(1, 111);
        b.set(2, 222);
        const bPtr = b.tablePtr;
        a.destroy();
        const b2 = UInt32SharedMap.from(pool, bPtr);
        expect(b2.get(2)).toBe(222);
    });
});
