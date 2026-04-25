import { describe, it, expect } from 'vitest';
import SharedLinkedList, {
    type SharedLinkedListItemView,
} from '../../src/lib/Shared/SharedLinkedList.js';

function bytes(...n: number[]) {
    return new Uint8Array(n);
}

/** Example row view: two little-endian uint16 fields in 4-byte nodes (see `SharedLinkedList` typed items). */
class MyRowView implements SharedLinkedListItemView {
    private dv!: DataView;

    attach(b: Uint8Array<ArrayBufferLike>): void {
        this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }

    get hi(): number {
        return this.dv.getUint16(0, true);
    }

    get lo(): number {
        return this.dv.getUint16(2, true);
    }
}

describe('SharedLinkedList', () => {
    describe('constructor', () => {
        it('exposes valueBytes, poolCapacity, listCapacity, and buffer bounds', () => {
            const lists = new SharedLinkedList(32, 5, { initialListSlots: 4, maxByteLength: 256 * 1024 });
            expect(lists.valueBytes).toBe(5);
            expect(lists.poolCapacity).toBe(32);
            expect(lists.listCapacity).toBe(4);
            expect(lists.length(0)).toBe(0);
            expect(lists.maxByteLength).toBeGreaterThanOrEqual(lists.byteLength);
        });

        it('rejects invalid initialPoolSlots', () => {
            expect(() => new SharedLinkedList(0, 1)).toThrow(RangeError);
        });

        it('rejects invalid valueBytesPerItem', () => {
            expect(() => new SharedLinkedList(4, 0)).toThrow(RangeError);
        });

        it('clamps maxByteLength up to at least the initial layout size', () => {
            const lists = new SharedLinkedList(4, 2, { initialListSlots: 2, maxByteLength: 32 });
            expect(lists.maxByteLength).toBeGreaterThanOrEqual(lists.byteLength);
        });
    });

    describe('from', () => {
        it('rebinds to an existing buffer and shares state with the creator', () => {
            const owner = new SharedLinkedList(8, 2, { initialListSlots: 2 });
            owner.insert(0, bytes(9, 9));
            const workerView = SharedLinkedList.from(owner.storage);
            expect(workerView.valueBytes).toBe(2);
            expect(workerView.poolCapacity).toBe(owner.poolCapacity);
            expect(workerView.listCapacity).toBe(owner.listCapacity);
            expect(workerView.length(0)).toBe(1);
            expect([...workerView.readAt(0, workerView.headIndex(0)!)!]).toEqual([9, 9]);
            workerView.insert(0, bytes(1, 2));
            expect(owner.length(0)).toBe(2);
        });

        it('throws when buffer is too small for header', () => {
            const sab = new SharedArrayBuffer(4);
            expect(() => SharedLinkedList.from(sab)).toThrow(RangeError);
        });

        it('throws when header layout does not fit in buffer', () => {
            const owner = new SharedLinkedList(4, 1, { initialListSlots: 2 });
            const hdr = new Uint32Array(owner.storage, 4, 6);
            hdr[0] = 10_000_000;
            expect(() => SharedLinkedList.from(owner.storage)).toThrow(RangeError);
        });
    });

    describe('insert / delete', () => {
        it('insert prepends; delete(head) removes newest first', () => {
            const lists = new SharedLinkedList(8, 3, { initialListSlots: 2 });
            lists.insert(0, bytes(1, 2, 3));
            lists.insert(0, bytes(4, 5, 6));
            expect(lists.length(0)).toBe(2);
            const head = lists.headIndex(0)!;
            lists.delete(0, head);
            expect(lists.length(0)).toBe(1);
            expect([...lists.readAt(0, lists.headIndex(0)!)!]).toEqual([1, 2, 3]);
            lists.delete(0, lists.headIndex(0)!);
            expect(lists.length(0)).toBe(0);
        });

        it('delete removes middle node and keeps chain', () => {
            const lists = new SharedLinkedList(8, 2, { initialListSlots: 1 });
            const tail = lists.insert(0, bytes(1, 1));
            const mid = lists.insert(0, bytes(2, 2));
            const head = lists.insert(0, bytes(3, 3));
            expect(lists.headIndex(0)).toBe(head);
            lists.delete(0, mid);
            expect(lists.length(0)).toBe(2);
            expect(lists.nextIndex(0, head)).toBe(tail);
            expect([...lists.readAt(0, tail)!]).toEqual([1, 1]);
        });

        it('delete removes tail (only predecessor update)', () => {
            const lists = new SharedLinkedList(8, 1, { initialListSlots: 1 });
            const a = lists.insert(0, bytes(1));
            const b = lists.insert(0, bytes(2));
            const c = lists.insert(0, bytes(3));
            lists.delete(0, a);
            expect(lists.length(0)).toBe(2);
            expect(lists.headIndex(0)).toBe(c);
            expect(lists.nextIndex(0, c)).toBe(b);
            expect(lists.nextIndex(0, b)).toBeNull();
        });

        it('keeps lists isolated by listIndex', () => {
            const lists = new SharedLinkedList(12, 2, { initialListSlots: 3 });
            lists.insert(0, bytes(1, 0));
            const onlyOn1 = lists.insert(1, bytes(2, 0));
            lists.insert(2, bytes(3, 0));
            lists.delete(1, onlyOn1);
            expect(lists.length(0)).toBe(1);
            expect(lists.length(1)).toBe(0);
            expect(lists.length(2)).toBe(1);
        });

        it('delete throws when itemIndex is not on that list', () => {
            const lists = new SharedLinkedList(8, 1, { initialListSlots: 2 });
            const on0 = lists.insert(0, bytes(9));
            lists.insert(1, bytes(1));
            expect(() => lists.delete(1, on0)).toThrow(RangeError);
        });

        it('delete throws when itemIndex is not in the pool chain', () => {
            const lists = new SharedLinkedList(4, 1, { initialListSlots: 1 });
            lists.insert(0, bytes(1));
            expect(() => lists.delete(0, 99)).toThrow(RangeError);
        });

        it('allows reusing pool slots after delete', () => {
            const lists = new SharedLinkedList(2, 1, { initialListSlots: 1, maxByteLength: 1 << 16 });
            const a = lists.insert(0, bytes(1));
            lists.delete(0, a);
            lists.insert(0, bytes(2));
            expect(lists.length(0)).toBe(1);
            expect([...lists.readAt(0, lists.headIndex(0)!)!]).toEqual([2]);
        });
    });

    describe('navigation', () => {
        it('headIndex is null for empty list', () => {
            const lists = new SharedLinkedList(4, 1, { initialListSlots: 1 });
            expect(lists.headIndex(0)).toBeNull();
        });

        it('nextIndex and readAt follow head → tail', () => {
            const lists = new SharedLinkedList(8, 2, { initialListSlots: 1 });
            const a = lists.insert(0, bytes(1, 1));
            const bIdx = lists.insert(0, bytes(2, 2));
            const c = lists.insert(0, bytes(3, 3));
            expect(lists.headIndex(0)).toBe(c);
            expect(lists.nextIndex(0, c)).toBe(bIdx);
            expect(lists.nextIndex(0, bIdx)).toBe(a);
            expect(lists.nextIndex(0, a)).toBeNull();
            expect([...lists.readAt(0, bIdx)!]).toEqual([2, 2]);
        });

        it('readAt returns null when node is not on the list', () => {
            const lists = new SharedLinkedList(8, 1, { initialListSlots: 1 });
            lists.insert(0, bytes(1));
            expect(lists.readAt(0, 2)).toBeNull();
        });
    });

    describe('iteration', () => {
        it('iterate walks from head to tail (forward order)', () => {
            const lists = new SharedLinkedList(6, 1, { initialListSlots: 1 });
            lists.insert(0, bytes(3));
            lists.insert(0, bytes(2));
            lists.insert(0, bytes(1));
            const rows = [...lists.iterate(0)].map((e) => [...e.value]);
            expect(rows).toEqual([[1], [2], [3]]);
        });

        it('entries matches iterate for the same list', () => {
            const lists = new SharedLinkedList(6, 1, { initialListSlots: 1 });
            lists.insert(0, bytes(7));
            lists.insert(0, bytes(8));
            const fromIterate = [...lists.iterate(0)].map((e) => ({ i: e.index, v: [...e.value] }));
            const fromEntries = [...lists.entries(0)].map((e) => ({ i: e.index, v: [...e.value] }));
            expect(fromEntries).toEqual(fromIterate);
        });
    });

    describe('typed item (MyRowView reuse)', () => {
        it('itemAt rebinds one instance; read typed fields before the next call', () => {
            const lists = new SharedLinkedList<MyRowView>(8, 4, {
                initialListSlots: 1,
                createItem: () => new MyRowView(),
            });
            const lo = lists.insert(0, bytes(0x05, 0, 0x07, 0));
            const hi = lists.insert(0, bytes(0x01, 0, 0x02, 0));
            const a = lists.itemAt(0, hi)!;
            expect(a.hi).toBe(1);
            expect(a.lo).toBe(2);
            const b = lists.itemAt(0, lo)!;
            expect(b).toBe(a);
            expect(b.hi).toBe(5);
            expect(b.lo).toBe(7);
        });

        it('iterateItems yields the same item reference each time (read fields inside the loop)', () => {
            const lists = new SharedLinkedList<MyRowView>(6, 4, {
                initialListSlots: 1,
                createItem: () => new MyRowView(),
            });
            lists.insert(0, bytes(1, 0, 2, 0));
            lists.insert(0, bytes(3, 0, 4, 0));
            const snap: { index: number; hi: number; lo: number }[] = [];
            let shared: MyRowView | undefined;
            for (const e of lists.iterateItems(0)) {
                if (shared === undefined) shared = e.item;
                else expect(e.item).toBe(shared);
                snap.push({ index: e.index, hi: e.item.hi, lo: e.item.lo });
            }
            expect(snap).toEqual([
                { index: expect.any(Number), hi: 3, lo: 4 },
                { index: expect.any(Number), hi: 1, lo: 2 },
            ]);
        });

        it('from accepts createItem for the worker-side MyRowView', () => {
            const owner = new SharedLinkedList<MyRowView>(4, 4, {
                initialListSlots: 1,
                createItem: () => new MyRowView(),
            });
            owner.insert(0, bytes(9, 0, 10, 0));
            const w = SharedLinkedList.from(owner.storage, () => new MyRowView());
            const row = w.itemAt(0, w.headIndex(0)!)!;
            expect(row.hi).toBe(9);
            expect(row.lo).toBe(10);
        });
    });

    describe('growth', () => {
        it('extends list table when listIndex exceeds initialListSlots', () => {
            const lists = new SharedLinkedList(8, 1, { initialListSlots: 2, maxByteLength: 1 << 20 });
            const h = lists.insert(50, bytes(7));
            expect(lists.listCapacity).toBeGreaterThan(50);
            expect(lists.length(50)).toBe(1);
            lists.delete(50, h);
            expect(lists.length(50)).toBe(0);
        });

        it('doubles pool when exhausted until maxByteLength', () => {
            const lists = new SharedLinkedList(2, 1, { initialListSlots: 1, maxByteLength: 1 << 18 });
            const before = lists.poolCapacity;
            lists.insert(0, bytes(1));
            lists.insert(0, bytes(2));
            lists.insert(0, bytes(3));
            expect(lists.poolCapacity).toBeGreaterThanOrEqual(before * 2);
            expect(lists.byteLength).toBeGreaterThanOrEqual(before);
            lists.delete(0, lists.headIndex(0)!);
            expect(lists.length(0)).toBe(2);
        });

        it('insert throws when pool cannot grow within maxByteLength', () => {
            const probe = new SharedLinkedList(1, 2, { initialListSlots: 1, maxByteLength: 1 << 20 });
            const exactCap = probe.byteLength;
            const lists = new SharedLinkedList(1, 2, { initialListSlots: 1, maxByteLength: exactCap });
            lists.insert(0, bytes(1, 2));
            expect(() => lists.insert(0, bytes(3, 4))).toThrow(RangeError);
        });
    });

    describe('validation', () => {
        it('insert throws when payload size does not match valueBytes', () => {
            const lists = new SharedLinkedList(4, 2, { initialListSlots: 1 });
            expect(() => lists.insert(0, bytes(1))).toThrow(RangeError);
        });

        it('length rejects negative listIndex', () => {
            const lists = new SharedLinkedList(4, 1, { initialListSlots: 1 });
            expect(() => lists.length(-1)).toThrow(RangeError);
        });
    });

    describe('clearList / clearAll', () => {
        it('clearList drains one list; clearAll drains every slot', () => {
            const lists = new SharedLinkedList(6, 1, { initialListSlots: 2 });
            lists.insert(0, bytes(1));
            lists.insert(1, bytes(2));
            lists.clearList(0);
            expect(lists.length(0)).toBe(0);
            expect(lists.length(1)).toBe(1);
            lists.clearAll();
            expect(lists.length(1)).toBe(0);
        });

        it('clearAll is safe when some lists are already empty', () => {
            const lists = new SharedLinkedList(4, 1, { initialListSlots: 3 });
            lists.insert(1, bytes(9));
            lists.clearAll();
            expect(lists.length(0)).toBe(0);
            expect(lists.length(1)).toBe(0);
            expect(lists.length(2)).toBe(0);
        });
    });
});
