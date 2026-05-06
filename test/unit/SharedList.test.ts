import { describe, expect, it } from 'vitest';
import SharedList, {
    SharedListItemView,
    Uint8SharedList,
    buildUint8SharedListStorage,
    type ISharedListItemView,
} from '../../src/lib/Shared/SharedList.js';
import SharedMemoryPool from '../../src/lib/Shared/SharedMemoryPool.js';

const SHARED_LIST_CTRL_PTR_INDEX = 1;

function sharedListPtr(storage: SharedArrayBuffer): number {
    return new Uint32Array(storage, 0, 16)[SHARED_LIST_CTRL_PTR_INDEX] >>> 0;
}
import { NodeView } from '../../src/lib/trust/graph/Node.js';

function bytes(...n: number[]) {
    return new Uint8Array(n);
}

class MyRowView implements ISharedListItemView {
    private dv!: DataView;
    private b: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    attach(b: Uint8Array<ArrayBufferLike>): void {
        this.b = b;
        this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }

    attachAt(
        buffer: ArrayBufferLike,
        byteOffset: number,
        byteLength: number,
        _itemIndex: number,
        _listLength: number,
    ): void {
        this.attach(new Uint8Array(buffer, byteOffset, byteLength));
    }

    nextItem(): this | undefined {
        return undefined;
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
        const list = SharedList.createShared(4, { initialCapacity: 2 });
        list.push(bytes(1, 0, 2, 0));
        list.push(bytes(3, 0, 4, 0));
        expect(list.length).toBe(2);
        expect([...list.readAt(0)!]).toEqual([1, 0, 2, 0]);
    });

    it('delete swaps in the last row', () => {
        const list = SharedList.createShared(4, { initialCapacity: 4 });
        list.push(bytes(1, 0, 1, 0));
        list.push(bytes(2, 0, 2, 0));
        list.push(bytes(3, 0, 3, 0));
        list.delete(1);
        expect(list.length).toBe(2);
        expect([...list.readAt(1)!]).toEqual([3, 0, 3, 0]);
    });

    it('typed views are reused', () => {
        const rowView = new MyRowView();
        const list = SharedList.createShared<MyRowView>(4, { initialCapacity: 2, itemViewSingleton: rowView });
        list.push(bytes(5, 0, 6, 0));
        list.push(bytes(7, 0, 8, 0));
        const first = list.itemAt(0)!;
        const second = list.itemAt(1)!;
        expect(first).toBe(second);
        expect(second.hi).toBe(7);
        expect(second.lo).toBe(8);
    });

    it('from binds to the same storage', () => {
        const owner = SharedList.createShared(4, { initialCapacity: 2 });
        owner.push(bytes(9, 0, 10, 0));
        const worker = SharedList.from(
            SharedMemoryPool.from(owner.storage, { start: 64 }),
            sharedListPtr(owner.storage),
        );
        expect([...worker.readAt(0)!]).toEqual([9, 0, 10, 0]);
    });

    it('unsafeReadAt/unsafeItemAt/unsafeIterateItems match safe reads when no deletes happen', () => {
        const rowView = new MyRowView();
        const list = SharedList.createShared<MyRowView>(4, { initialCapacity: 8, itemViewSingleton: rowView });
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
        const nodeSingleton = new NodeView(
            '0000000000000000000000000000000000000000000000000000000000000000',
            'p',
        );
        const list = SharedList.createShared<NodeView>(NodeView.SIZE, {
            initialCapacity: 8,
            maxByteLength: 1 << 22,
            itemViewSingleton: nodeSingleton,
        });

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
        expect(second).toBe(first);
        expect(typeof first?.id).toBe('string');
        expect(sample0Type === 'p' || sample0Type === 'i').toBe(true);
        expect(sampleMidType === 'p' || sampleMidType === 'i').toBe(true);
        expect(sampleLastType === 'p' || sampleLastType === 'i').toBe(true);
    });

    it('clone copies layout and preserves items', () => {
        const v = new SharedListItemView(4);
        const a = SharedList.createShared<SharedListItemView>(4, {
            initialCapacity: 2,
            maxByteLength: 4096,
            itemViewSingleton: v,
        });
        a.push(bytes(1, 0, 0, 0));
        const b = a.clone();
        expect(b.storage).not.toBe(a.storage);
        expect(b.length).toBe(1);
        expect(b.itemAt(0)!.u32).toBe(1);
    });

    it('growSharedBacking expands buffer for createShared-owned lists', () => {
        const v = new SharedListItemView(4);
        const list = SharedList.createShared(4, { initialCapacity: 1, maxByteLength: 65536, itemViewSingleton: v });
        const before = list.storage.byteLength;
        list.growSharedBacking(before + 1024);
        expect(list.storage.byteLength).toBe(before + 1024);
    });
});

describe('SharedList.from (second view on same buffer)', () => {
    it('mirrors the owner on the same storage for reads', () => {
        const rowView = new MyRowView();
        const owner = SharedList.createShared<MyRowView>(4, { initialCapacity: 4, itemViewSingleton: rowView });
        owner.push(bytes(1, 0, 2, 0));
        owner.push(bytes(3, 0, 4, 0));
        const reader = SharedList.from(
            SharedMemoryPool.from(owner.storage, { start: 64 }),
            sharedListPtr(owner.storage),
        );
        expect(reader.length).toBe(2);
        expect([...reader.readAt(0)!]).toEqual([1, 0, 2, 0]);
        expect([...reader.readAt(1)!]).toEqual([3, 0, 4, 0]);
        const heads: number[] = [];
        for (const e of reader.iterateItems()) {
            heads.push(e.item.bytes[0]!);
        }
        expect(heads).toEqual([1, 3]);
    });

    it('rebind picks up capacity growth from the owner', () => {
        const owner = SharedList.createShared(4, {
            initialCapacity: 2,
            maxByteLength: 1 << 16,
        });
        owner.push(bytes(1, 0, 0, 0));
        const reader = SharedList.from(
            SharedMemoryPool.from(owner.storage, { start: 64 }),
            sharedListPtr(owner.storage),
        );
        expect(reader.capacity).toBe(2);
        owner.push(bytes(2, 0, 0, 0));
        owner.push(bytes(3, 0, 0, 0));
        expect(reader.capacity).toBeGreaterThan(2);
        reader.rebind();
        expect([...reader.readAt(2)!]).toEqual([3, 0, 0, 0]);
    });

    it('second view can push and grow on the same buffer (main-thread sequential use)', () => {
        const seed = SharedList.createShared(4, {
            initialCapacity: 1,
            maxByteLength: 1 << 12,
        });
        const other = SharedList.from(
            SharedMemoryPool.from(seed.storage, { start: 64 }),
            sharedListPtr(seed.storage),
        );
        expect(other.length).toBe(0);
        other.push(bytes(1, 0, 2, 0));
        other.push(bytes(3, 0, 4, 0));
        expect(other.length).toBe(2);
        expect([...other.readAt(0)!]).toEqual([1, 0, 2, 0]);
        expect([...other.readAt(1)!]).toEqual([3, 0, 4, 0]);
    });
});

describe('SharedList.appendBuffer', () => {
    it('writes in place when there is room', () => {
        const list = SharedList.createShared(4, { initialCapacity: 4 });
        const dataOff = 16;
        const end = list.appendBuffer(dataOff, new Uint8Array([10, 11, 12]));
        expect(end).toBe(19);
        expect([...new Uint8Array(list.storage).subarray(dataOff, 19)]).toEqual([10, 11, 12]);
        expect(list.storage.byteLength).toBeGreaterThanOrEqual(32);
    });

    it('grows the buffer when the tail does not fit', () => {
        const list = SharedList.createShared(4, {
            initialCapacity: 1,
            maxByteLength: 256,
        });
        const tail = list.storage.byteLength;
        const payload = new Uint8Array(16).fill(7);
        const end = list.appendBuffer(tail, payload);
        expect(end).toBe(tail + 16);
        expect(list.storage.byteLength).toBeGreaterThanOrEqual(tail + 16);
        expect(new Uint8Array(list.storage, tail, 16).every((b) => b === 7)).toBe(true);
    });

    it('throws when append would exceed maxByteLength', () => {
        const list = SharedList.createShared(4, {
            initialCapacity: 1,
            maxByteLength: 24,
        });
        const tail = list.storage.byteLength;
        expect(() => list.appendBuffer(tail, new Uint8Array(9))).toThrow(RangeError);
    });
});

describe('Uint8SharedList', () => {
    it('push appends bytes and grows when full', () => {
        const list = new Uint8SharedList(2, { maxByteLength: 256 });
        expect(list.length).toBe(0);
        expect(list.push(1)).toBe(0);
        expect(list.push(2)).toBe(1);
        expect(list.push(300)).toBe(2);
        expect(list.length).toBe(3);
        expect(list.get(0)).toBe(1);
        expect(list.get(1)).toBe(2);
        expect(list.get(2)).toBe(44);
    });

    it('get returns byte values 0..255 and values() iterates', () => {
        const sab = buildUint8SharedListStorage(8, [1, 300, 255, 0]);
        const list = Uint8SharedList.from(sab);
        expect(list.length).toBe(4);
        expect(list.capacity).toBe(8);
        expect(list.get(0)).toBe(1);
        expect(list.get(1)).toBe(44);
        expect(list.get(2)).toBe(255);
        expect(list.get(3)).toBe(0);
        expect(list.get(4)).toBe(undefined);
        expect([...list.values()]).toEqual([1, 44, 255, 0]);
    });

    it('allows empty logical list with spare capacity', () => {
        const sab = buildUint8SharedListStorage(4, []);
        const list = Uint8SharedList.from(sab);
        expect(list.length).toBe(0);
        expect(list.capacity).toBe(4);
        expect(list.get(0)).toBe(undefined);
    });

    it('rebind refreshes byte view after buffer grow', () => {
        const sab = buildUint8SharedListStorage(2, [10, 20], { maxByteLength: 4096 });
        const list = Uint8SharedList.from(sab);
        expect(list.get(1)).toBe(20);
        const ctrl = new Uint32Array(sab, 0, 16);
        const ptr = ctrl[2] >>> 0;
        const hdr = new Uint32Array(sab, ptr, 2);
        hdr[1] = 4;
        hdr[0] = 4;
        const cur = sab.byteLength;
        (sab as SharedArrayBuffer & { grow(n: number): void }).grow(Math.max(cur + 64, ptr + 8 + 4));
        const data = new Uint8Array(sab, ptr + 8, 4);
        data.set([10, 20, 30, 40]);
        list.rebind();
        expect(list.get(2)).toBe(30);
        expect(list.get(3)).toBe(40);
    });
});
