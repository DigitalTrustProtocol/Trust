import { describe, it, expect } from 'vitest';
import SharedMultiList from '../../src/lib/Shared/SharedMultiList.js';

describe('SharedMultiList', () => {
    it('stores uint32 values and reads them back', () => {
        const lists = new SharedMultiList(8, { initialListSlots: 2 });
        const a = lists.insert(0, 11);
        const b = lists.insert(0, 22);
        expect(lists.valueBytes).toBe(4);
        expect(lists.length(0)).toBe(2);
        expect(lists.headIndex(0)).toBe(b);
        expect(lists.nextIndex(0, b)).toBe(a);
        expect(lists.readAt(0, b)).toBe(22);
        expect(lists.readAt(0, a)).toBe(11);
    });

    it('supports from() in another view', () => {
        const owner = new SharedMultiList(4, { initialListSlots: 1 });
        owner.insert(0, 77);
        const worker = SharedMultiList.from(owner.storage);
        expect(worker.readAt(0, worker.headIndex(0)!)).toBe(77);
        worker.insert(0, 99);
        expect(owner.length(0)).toBe(2);
    });

    it('deletes head, middle and tail correctly', () => {
        const lists = new SharedMultiList(8, { initialListSlots: 1 });
        const tail = lists.insert(0, 1);
        const mid = lists.insert(0, 2);
        const head = lists.insert(0, 3);

        lists.delete(0, mid);
        expect(lists.readAt(0, mid)).toBeNull();
        expect(lists.nextIndex(0, head)).toBe(tail);

        lists.delete(0, head);
        expect(lists.headIndex(0)).toBe(tail);

        lists.delete(0, tail);
        expect(lists.length(0)).toBe(0);
        expect(lists.headIndex(0)).toBeNull();
    });

    it('iterates in head-to-tail order', () => {
        const lists = new SharedMultiList(6, { initialListSlots: 1 });
        lists.insert(0, 10);
        lists.insert(0, 20);
        lists.insert(0, 30);
        const vals = [...lists.iterate(0)].map((v) => v.value);
        expect(vals).toEqual([30, 20, 10]);
    });

    it('grows list slots and pool', () => {
        const lists = new SharedMultiList(2, { initialListSlots: 1, maxByteLength: 1 << 18 });
        const beforePool = lists.poolCapacity;
        lists.insert(20, 5);
        lists.insert(20, 6);
        lists.insert(20, 7);
        expect(lists.listCapacity).toBeGreaterThan(20);
        expect(lists.poolCapacity).toBeGreaterThanOrEqual(beforePool * 2);
    });

    it('clearList and clearAll work', () => {
        const lists = new SharedMultiList(6, { initialListSlots: 3 });
        lists.insert(0, 1);
        lists.insert(1, 2);
        lists.clearList(0);
        expect(lists.length(0)).toBe(0);
        expect(lists.length(1)).toBe(1);
        lists.clearAll();
        expect(lists.length(0)).toBe(0);
        expect(lists.length(1)).toBe(0);
        expect(lists.length(2)).toBe(0);
    });
});
