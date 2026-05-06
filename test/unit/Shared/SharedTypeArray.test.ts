import { describe, expect, it } from 'vitest';
import SharedMemoryPool from '../../../src/lib/Shared/SharedMemoryPool.js';
import { SharedListItemView } from '../../../src/lib/Shared/SharedListItemView.js';
import SharedTypeArray from '../../../src/lib/Shared/SharedTypeArray.js';

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

function u32Item(v: number): SharedListItemView {
    const item = new SharedListItemView(4);
    item.u32 = v >>> 0;
    return item;
}

describe('SharedTypeArray', () => {
    it('createInPool + push/get store and read values', () => {
        const pool = createTestPool();
        const arr = SharedTypeArray.createInPool(pool, {
            initialCapacity: 2,
            itemViewSingleton: new SharedListItemView(4),
        });

        expect(arr.length).toBe(0);
        expect(arr.capacity).toBe(2);
        expect(arr.itemByteSize).toBe(4);

        arr.push(u32Item(11));
        arr.push(u32Item(22));

        expect(arr.length).toBe(2);
        expect(arr.get(0)?.u32).toBe(11);
        expect(arr.get(1)?.u32).toBe(22);
        expect(arr.get(2)).toBeUndefined();
    });

    it('reuses the same singleton instance for get()', () => {
        const pool = createTestPool();
        const arr = SharedTypeArray.createInPool(pool, {
            initialCapacity: 2,
            itemViewSingleton: new SharedListItemView(4),
        });
        arr.push(u32Item(100));
        arr.push(u32Item(200));

        const first = arr.get(0);
        const second = arr.get(1);

        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(first).toBe(second);
        expect(second?.u32).toBe(200);
    });

    it('items() iterates all values and reuses singleton instance', () => {
        const pool = createTestPool();
        const arr = SharedTypeArray.createInPool(pool, {
            initialCapacity: 3,
            itemViewSingleton: new SharedListItemView(4),
        });
        arr.push(u32Item(1));
        arr.push(u32Item(2));
        arr.push(u32Item(3));

        const seenValues: number[] = [];
        const seenRefs = new Set<SharedListItemView>();
        for (const item of arr.items()) {
            seenValues.push(item.u32);
            seenRefs.add(item);
        }

        expect(seenValues).toEqual([1, 2, 3]);
        expect(seenRefs.size).toBe(1);
    });

    it('from() attaches to the same pooled block by pointer', () => {
        const pool = createTestPool();
        const owner = SharedTypeArray.createInPool(pool, {
            initialCapacity: 2,
            itemViewSingleton: new SharedListItemView(4),
        });
        owner.push(u32Item(7));
        owner.push(u32Item(8));

        const reader = SharedTypeArray.from<SharedListItemView>(pool, owner.arrayPtr);
        expect(reader.length).toBe(2);
        expect(reader.get(0)?.u32).toBe(7);
        expect(reader.get(1)?.u32).toBe(8);

        owner.set(1, u32Item(9));
        expect(reader.get(1)?.u32).toBe(9);
    });

    it('resize grows capacity and keeps data', () => {
        const pool = createTestPool();
        const arr = SharedTypeArray.createInPool(pool, {
            initialCapacity: 1,
            itemViewSingleton: new SharedListItemView(4),
        });
        arr.push(u32Item(10));
        arr.resize(4);
        arr.push(u32Item(20));

        expect(arr.capacity).toBe(4);
        expect(arr.length).toBe(2);
        expect(arr.get(0)?.u32).toBe(10);
        expect(arr.get(1)?.u32).toBe(20);
    });

    it('throws when from() default singleton item size mismatches stored itemByteSize', () => {
        const pool = createTestPool();
        const owner = SharedTypeArray.createInPool(pool, {
            initialCapacity: 2,
            itemViewSingleton: new SharedListItemView(8),
        });
        owner.push(new SharedListItemView(8));

        expect(() => SharedTypeArray.from<SharedListItemView>(pool, owner.arrayPtr)).toThrow(
            /itemViewSingleton\.itemByteSize .* does not match stored itemByteSize/,
        );
    });

    it('validates indices and resize constraints', () => {
        const pool = createTestPool();
        const arr = SharedTypeArray.createInPool(pool, {
            initialCapacity: 2,
            itemViewSingleton: new SharedListItemView(4),
        });
        arr.push(u32Item(1));

        expect(() => arr.get(-1)).toThrow(RangeError);
        expect(() => arr.set(-1, u32Item(1))).toThrow(RangeError);
        expect(() => arr.set(2, u32Item(2))).toThrow(RangeError);
        expect(() => arr.resize(0)).toThrow(RangeError);
        expect(() => arr.resize(arr.length - 1)).toThrow(RangeError);
    });
});
