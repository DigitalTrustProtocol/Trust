import { describe, expect, it } from 'vitest';
import SharedList from '../../../src/lib/Shared/SharedList.js';
import { EdgeItemView } from '../../../src/lib/trust/graph/EdgeItemView.js';

describe('EdgeView', () => {
    it('encodes/decodes nodeIndex and trustIndex', () => {
        const v = new EdgeItemView();
        v.nodeIndex = 1234;
        v.trustIndex = 56_789;
        expect(v.nodeIndex).toBe(1234);
        expect(v.trustIndex).toBe(56_789);
    });

    it('update(nodeIndex, trustIndex) writes both fields', () => {
        const v = new EdgeItemView();
        v.update(7, 99);
        expect(v.nodeIndex).toBe(7);
        expect(v.trustIndex).toBe(99);
    });

    it('attachAt rebinds to existing storage', () => {
        const row = new Uint8Array(EdgeItemView.SIZE);
        const a = new EdgeItemView();
        a.update(9, 42);
        row.set(a.bytes);
        const b = new EdgeItemView();
        b.attachAt(row.buffer, row.byteOffset, EdgeItemView.SIZE, 0, 1);
        expect(b.nodeIndex).toBe(9);
        expect(b.trustIndex).toBe(42);
    });
});

describe('EdgeView with SharedList', () => {
    it('reads many rows correctly after repeated push', () => {
        const edgeSingleton = new EdgeItemView();
        const list = SharedList.createShared(edgeSingleton, EdgeItemView.SIZE, {
            initialCapacity: 4,
            maxByteLength: 1 << 20,
        });
        const n = 25;
        for (let i = 0; i < n; i++) {
            const row = new EdgeItemView();
            row.update(10_000 + i, 3000 + i);
            list.add(row);
        }
        expect(list.length).toBe(n);
        for (let i = 0; i < n; i++) {
            const v = list.itemAt(i)!;
            expect(v.nodeIndex).toBe(10_000 + i);
            expect(v.trustIndex).toBe(3000 + i);
        }
    });

    it('keeps EdgeView DataView valid after SharedList capacity growth (single reused view)', () => {
        let shared: EdgeItemView | undefined;
        const list = SharedList.createShared((shared ??= new EdgeItemView()), EdgeItemView.SIZE, {
            initialCapacity: 1,
            maxByteLength: 1 << 18,
        });
        const byteLengthAfterInit = list.storage.byteLength;

        const count = 24;
        for (let i = 0; i < count; i++) {
            const row = new EdgeItemView();
            row.update(i * 13, 500 + i);
            list.add(row);
        }

        expect(list.length).toBe(count);
        expect(list.storage.byteLength).toBeGreaterThan(byteLengthAfterInit);

        for (let i = 0; i < count; i++) {
            const v = list.itemAt(i)!;
            expect(v).toBe(shared);
            expect(v.nodeIndex).toBe(i * 13);
            expect(v.trustIndex).toBe(500 + i);
        }
    });

    it('re-reads first row after growth (attach + new backing byteLength)', () => {
        const list = SharedList.createShared(new EdgeItemView(), EdgeItemView.SIZE, {
            initialCapacity: 2,
            maxByteLength: 1 << 18,
        });
        {
            const row = new EdgeItemView();
            row.update(1, 11);
            list.add(row);
        }
        expect(list.itemAt(0)!.nodeIndex).toBe(1);
        expect(list.itemAt(0)!.trustIndex).toBe(11);

        for (let i = 0; i < 20; i++) {
            const row = new EdgeItemView();
            row.update(100 + i, 200 + i);
            list.add(row);
        }

        expect(list.length).toBe(21);
        expect(list.itemAt(0)!.nodeIndex).toBe(1);
        expect(list.itemAt(0)!.trustIndex).toBe(11);
        expect(list.itemAt(20)!.nodeIndex).toBe(100 + 19);
        expect(list.itemAt(20)!.trustIndex).toBe(200 + 19);
    });
});
