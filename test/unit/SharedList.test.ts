import { describe, expect, it } from 'vitest';
import SharedList, { type SharedListView } from '../../src/lib/Shared/SharedList.js';
import { NodeView } from '../../src/lib/trust/graph/Node.js';

function bytes(...n: number[]) {
    return new Uint8Array(n);
}

class MyRowView implements SharedListView {
    private dv!: DataView;
    private b: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    attach(b: Uint8Array<ArrayBufferLike>): void {
        this.b = b;
        this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return this.b;
    }

    get hi(): number {
        return this.dv.getUint16(0, true);
    }

    get lo(): number {
        return this.dv.getUint16(2, true);
    }
}

describe('SharedList', () => {
    it('push and readAt use fixed-size rows', () => {
        const list = new SharedList(2, 4);
        list.push(bytes(1, 0, 2, 0));
        list.push(bytes(3, 0, 4, 0));
        expect(list.length).toBe(2);
        expect([...list.readAt(0)!]).toEqual([1, 0, 2, 0]);
    });

    it('delete swaps in the last row', () => {
        const list = new SharedList(4, 4);
        list.push(bytes(1, 0, 1, 0));
        list.push(bytes(2, 0, 2, 0));
        list.push(bytes(3, 0, 3, 0));
        list.delete(1);
        expect(list.length).toBe(2);
        expect([...list.readAt(1)!]).toEqual([3, 0, 3, 0]);
    });

    it('typed views are reused', () => {
        const list = new SharedList<MyRowView>(2, 4, { createView: () => new MyRowView() });
        list.push(bytes(5, 0, 6, 0));
        list.push(bytes(7, 0, 8, 0));
        const first = list.itemAt(0)!;
        const second = list.itemAt(1)!;
        expect(first).toBe(second);
        expect(second.hi).toBe(7);
        expect(second.lo).toBe(8);
    });

    it('from binds to the same storage', () => {
        const owner = new SharedList(2, 4);
        owner.push(bytes(9, 0, 10, 0));
        const worker = SharedList.from(owner.storage);
        expect([...worker.readAt(0)!]).toEqual([9, 0, 10, 0]);
    });

    it('unsafeReadAt/unsafeItemAt/unsafeIterateItems match safe reads when no deletes happen', () => {
        const list = new SharedList<MyRowView>(8, 4, { createView: () => new MyRowView() });
        list.push(bytes(1, 0, 2, 0));
        list.push(bytes(3, 0, 4, 0));
        list.push(bytes(5, 0, 6, 0));

        expect([...list.unsafeReadAt(1)!]).toEqual([...list.readAt(1)!]);

        const safe = list.itemAt(2)!;
        const unsafe = list.unsafeItemAt(2)!;
        expect(unsafe).toBe(safe);
        expect(unsafe.hi).toBe(5);
        expect(unsafe.lo).toBe(6);

        const safeRows = [...list.iterateItems()].map((e) => ({ i: e.index, hi: e.item.hi, lo: e.item.lo }));
        const unsafeRows = [...list.unsafeIterateItems()].map((e) => ({ i: e.index, hi: e.item.hi, lo: e.item.lo }));
        expect(unsafeRows).toEqual(safeRows);
    });

    it('works with NodeView and many items', () => {
        const total = 5000;
        const list = new SharedList<NodeView>(8, NodeView.SIZE, {
            maxByteLength: 1 << 22,
            createView: () => new NodeView('0000000000000000000000000000000000000000000000000000000000000000', 'p'),
        });

        // Add NodeView instances through SharedList.add()
        for (let i = 0; i < total; i++) {
            const id = i.toString(16).padStart(64, '0');
            const type = i & 1 ? 'i' : 'p';
            const node = new NodeView(id, type);
            list.add(node);
        }

        expect(list.length).toBe(total);
        expect(list.capacity).toBeGreaterThanOrEqual(total);

        let seen = 0;
        let sample0Type: string | null = null;
        let sampleMidType: string | null = null;
        let sampleLastType: string | null = null;
        const mid = Math.floor(total / 2);

        for (const { index, item } of list.iterateItems()) {
            if (index === 0) sample0Type = item.type;
            if (index === mid) sampleMidType = item.type;
            if (index === total - 1) sampleLastType = item.type;
            seen++;
        }

        expect(seen).toBe(total);
        const first = list.itemAt(0);
        const second = list.itemAt(1);
        expect(first).toBeTruthy();
        expect(second).toBe(first); // reused NodeView instance
        expect(typeof first?.id).toBe('string');
        expect(sample0Type === 'p' || sample0Type === 'i').toBe(true);
        expect(sampleMidType === 'p' || sampleMidType === 'i').toBe(true);
        expect(sampleLastType === 'p' || sampleLastType === 'i').toBe(true);
    });
});
