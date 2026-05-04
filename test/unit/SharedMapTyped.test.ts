import { describe, it, expect } from 'vitest';
import SharedMapTyped from '../../src/lib/Shared/SharedMapTyped.js';

const U32_MAX = 0xffffffff;

/** Growable map with plenty of headroom for auto-rehash tests. */
function createMap(initialBucketCapacity: number): SharedMapTyped {
    return SharedMapTyped.createShared({
        initialBucketCapacity,
        maxByteLength: 1 << 22,
    });
}

describe('SharedMapTyped', () => {
    it('from attaches for worker read-only view (writer on main buffer)', () => {
        const owner = createMap(32);
        owner.set(123, 456, 789);
        const worker = SharedMapTyped.from(owner.storage);
        expect(worker.get(123, 456)).toBe(789);
        owner.set(9, 8, 7);
        expect(worker.get(9, 8)).toBe(7);
    });

    it('set/get/has: returns undefined for missing key', () => {
        const m = createMap(32);
        expect(m.get(1, 2)).toBeUndefined();
        expect(m.has(1, 2)).toBe(false);
        m.set(1, 2, 42);
        expect(m.get(1, 2)).toBe(42);
        expect(m.has(1, 2)).toBe(true);
        expect(m.length).toBe(1);
    });

    it('set replaces value for same key pair', () => {
        const m = createMap(16);
        m.set(10, 20, 1);
        m.set(10, 20, 2);
        expect(m.length).toBe(1);
        expect(m.get(10, 20)).toBe(2);
    });

    it('allows (0,0) as a valid key', () => {
        const m = createMap(16);
        m.set(0, 0, 99);
        expect(m.get(0, 0)).toBe(99);
        expect(m.has(0, 0)).toBe(true);
    });

    it('stores unsigned low 32 bits for keys and value', () => {
        const m = createMap(16);
        m.set(U32_MAX, U32_MAX, U32_MAX);
        expect(m.get(U32_MAX, U32_MAX)).toBe(U32_MAX);
        m.set(-1 as unknown as number, 0, -1 as unknown as number);
        expect(m.get(U32_MAX, 0)).toBe(U32_MAX);
    });

    it('set throws TypeError for non-number keys or value', () => {
        const m = createMap(8);
        expect(() => m.set('a' as unknown as number, 0, 1)).toThrow(TypeError);
        expect(() => m.set(0, 'b' as unknown as number, 1)).toThrow(TypeError);
        expect(() => m.set(0, 0, 'x' as unknown as number)).toThrow(TypeError);
    });

    it('delete removes entry and get returns undefined', () => {
        const m = createMap(16);
        m.set(5, 6, 7);
        m.delete(5, 6);
        expect(m.get(5, 6)).toBeUndefined();
        expect(m.length).toBe(0);
    });

    it('delete throws RangeError when key is absent', () => {
        const m = createMap(8);
        expect(() => m.delete(1, 1)).toThrow(RangeError);
    });

    it('auto-rehashes when load exceeds 75% so a 5th insert succeeds in a 4-bucket map', () => {
        const m = createMap(4);
        m.set(0, 0, 1);
        m.set(1, 0, 2);
        m.set(2, 0, 3);
        m.set(3, 0, 4);
        expect(m.length).toBe(4);
        m.set(4, 4, 5);
        expect(m.length).toBe(5);
        expect(m.get(4, 4)).toBe(5);
        expect(m.size).toBeGreaterThan(4);
    });

    it('clear removes all entries', () => {
        const m = createMap(16);
        m.set(1, 1, 1);
        m.set(2, 2, 2);
        m.clear();
        expect(m.length).toBe(0);
        expect(m.get(1, 1)).toBeUndefined();
        expect(m.get(2, 2)).toBeUndefined();
    });

    it('keys() yields every stored key pair', () => {
        const m = createMap(32);
        m.set(1, 10, 100);
        m.set(2, 20, 200);
        const keys = [...m.keys()].map((k) => [k.key1, k.key2] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        expect(keys).toEqual([
            [1, 10],
            [2, 20],
        ]);
    });

    it('map collects callback results', () => {
        const m = createMap(16);
        m.set(1, 0, 10);
        m.set(2, 0, 20);
        const sums = m
            .map((v, k1, k2) => v + k1 + k2)
            .sort((a, b) => a - b);
        expect(sums).toEqual([11, 22]);
    });

    it('reduce folds entries', () => {
        const m = createMap(16);
        m.set(1, 0, 3);
        m.set(2, 0, 5);
        const sum = m.reduce((acc, v) => acc + v, 0);
        expect(sum).toBe(8);
    });

    it('resize moves entries to a new buffer and preserves data', () => {
        const m = createMap(8);
        const before = m.storage.byteLength;
        for (let i = 0; i < 5; i++) {
            m.set(i, i + 1, i + 100);
        }
        expect(m.length).toBe(5);
        m.resize(64);
        expect(m.size).toBe(64);
        expect(m.storage.byteLength).toBeGreaterThan(before);
        expect(m.length).toBe(5);
        for (let i = 0; i < 5; i++) {
            expect(m.get(i, i + 1)).toBe(i + 100);
        }
    });

    it('resize is a no-op when new capacity equals current size', () => {
        const m = createMap(16);
        m.set(1, 1, 42);
        const buf = m.storage;
        m.resize(16);
        expect(m.storage).toBe(buf);
        expect(m.get(1, 1)).toBe(42);
    });

    it('resize throws when new capacity is smaller than entry count', () => {
        const m = createMap(32);
        for (let i = 0; i < 10; i++) {
            m.set(i, 0, i);
        }
        expect(m.length).toBe(10);
        expect(() => m.resize(8)).toThrow(RangeError);
        expect(m.length).toBe(10);
        expect(m.get(9, 0)).toBe(9);
    });

    it('exposes size as max capacity and length as entry count', () => {
        const m = createMap(20);
        expect(m.size).toBe(20);
        expect(m.length).toBe(0);
        m.set(0, 0, 1);
        expect(m.length).toBe(1);
    });

    it('createShared + clone round-trip', () => {
        const a = createMap(8);
        a.set(1, 2, 3);
        const b = a.clone();
        expect(b.storage).not.toBe(a.storage);
        expect(b.get(1, 2)).toBe(3);
    });
});
