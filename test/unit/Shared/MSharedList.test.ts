import { describe, expect, it } from 'vitest';
import MSharedList, {
    SharedListItemView,
    type ISharedListItemView,
} from '../../../src/lib/Shared/MSharedList.js';

/** `@thi.ng/malloc` / pool.js `STATE_END` index inside `Uint32Array(buf, poolStart, …)`. */
const MEMPOOL_STATE_END_U32 = 3;

function setMemPoolEndByte(buf: ArrayBufferLike, poolStart: number, endByte: number): void {
    const state = new Uint32Array(buf, poolStart, 7);
    state[MEMPOOL_STATE_END_U32] = endByte >>> 0;
}

/** Resizable `SharedArrayBuffer` (second ctor arg) — typed locally for TS `lib` targets without it. */
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

const POOL_START = 4096;

class U32ItemView implements ISharedListItemView {
    private itemIndex = 0;
    private listLength = 0;
    private stride = 4;
    private buf!: ArrayBufferLike;
    private off = 0;
    private dv!: DataView;
    private readonly writeScratch = new Uint8Array(4);

    constructor() {
        this.attachAt(this.writeScratch.buffer, this.writeScratch.byteOffset, 4, 0, 1);
    }

    attachAt(
        buffer: ArrayBufferLike,
        byteOffset: number,
        byteLength: number,
        itemIndex: number,
        listLength: number,
    ): void {
        if (byteLength !== 4) {
            throw new RangeError('U32ItemView: byteLength must be 4');
        }
        this.stride = byteLength;
        this.itemIndex = itemIndex;
        this.listLength = listLength >>> 0;
        this.buf = buffer;
        this.off = byteOffset;
        this.dv = new DataView(buffer, 0, buffer.byteLength);
    }

    nextItem(): ISharedListItemView | undefined {
        if (this.itemIndex + 1 >= this.listLength) {
            return undefined;
        }
        this.itemIndex += 1;
        this.off += this.stride;
        return this;
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return new Uint8Array(this.buf, this.off, this.stride);
    }

    set value(v: number) {
        this.dv.setUint32(this.off, v >>> 0, true);
    }

    get value(): number {
        return this.dv.getUint32(this.off, true);
    }
}

function makeBuf(byteLength = 512 * 1024) {
    return new ArrayBuffer(byteLength);
}

describe('MSharedList', () => {
    it('createList, push, getItem singleton, length, pop', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList(2);
        expect(lid).toBe(0);
        expect(m.length(lid)).toBe(0);
        expect(m.capacity(lid)).toBe(2);
        item.value = 11;
        m.push(lid, item);
        item.value = 22;
        m.push(lid, item);
        expect(m.length(lid)).toBe(2);
        const a = m.getItem(lid, 0);
        const b = m.getItem(lid, 1);
        expect(a).toBe(b);
        expect(a).toBe(item);
        expect(m.getItem(lid, 0).value).toBe(11);
        expect(m.getItem(lid, 1).value).toBe(22);
        const last = m.pop(lid);
        expect(last).toBe(item);
        expect(last!.value).toBe(22);
        expect(m.length(lid)).toBe(1);
        expect(m.getItem(lid, 0).value).toBe(11);
    });

    it('grows capacity when pushing past max (like JS arrays)', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START, defaultListCapacity: 2 });
        const lid = m.createList(2);
        item.value = 1;
        m.push(lid, item);
        item.value = 2;
        m.push(lid, item);
        expect(m.capacity(lid)).toBe(2);
        item.value = 3;
        m.push(lid, item);
        expect(m.length(lid)).toBe(3);
        expect(m.capacity(lid)).toBeGreaterThanOrEqual(3);
        expect(m.getItem(lid, 2).value).toBe(3);
    });

    it('iterateItems rebinds singleton', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList();
        for (let v = 1; v <= 3; v++) {
            item.value = v;
            m.push(lid, item);
        }
        const values: number[] = [];
        for (const v of m.items(lid)) {
            expect(v).toBe(item);
            values.push(v.value);
        }
        expect(values).toEqual([1, 2, 3]);
    });

    it('shift and unshift', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList();
        item.value = 1;
        m.push(lid, item);
        item.value = 2;
        m.push(lid, item);
        const first = m.shift(lid);
        expect(first).toBe(item);
        expect(first!.value).toBe(1);
        expect(m.length(lid)).toBe(1);
        expect(m.getItem(lid, 0).value).toBe(2);
        const zero = new U32ItemView();
        zero.value = 0;
        m.unshift(lid, zero);
        expect(m.length(lid)).toBe(2);
        expect(m.getItem(lid, 0).value).toBe(0);
        expect(m.getItem(lid, 1).value).toBe(2);
    });

    it('splice delete and insert', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const insA = new U32ItemView();
        const insB = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList(8);
        for (let v = 10; v <= 50; v += 10) {
            item.value = v;
            m.push(lid, item);
        }
        expect(m.length(lid)).toBe(5);
        insA.value = 99;
        insB.value = 100;
        const del = m.splice(lid, 1, 2, insA, insB);
        expect(del).toBe(2);
        expect(m.length(lid)).toBe(5);
        const vals: number[] = [];
        for (const x of m.items(lid)) {
            vals.push(x.value);
        }
        expect(vals).toEqual([10, 99, 100, 40, 50]);
    });

    it('sliceList and copyList', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const a = m.createList();
        item.value = 1;
        m.push(a, item);
        item.value = 2;
        m.push(a, item);
        const b = m.sliceList(a, 1, 2);
        expect(m.length(b)).toBe(1);
        expect(m.getItem(b, 0).value).toBe(2);
        const c = m.copyList(a);
        expect(m.length(c)).toBe(2);
        expect(m.getItem(c, 0).value).toBe(1);
        expect(m.getItem(c, 1).value).toBe(2);
    });

    it('MSharedList.from attaches like a worker (skipInitialization)', () => {
        const buf = makeBuf();
        const v1 = new U32ItemView();
        const v2 = new U32ItemView();
        const owner = new MSharedList(buf, v1, 4, { poolStart: POOL_START });
        const lid = owner.createList();
        v1.value = 42;
        owner.push(lid, v1);

        const reader = MSharedList.from(buf, v2, 4, { poolStart: POOL_START });
        expect(reader.length(lid)).toBe(1);
        expect(reader.getItem(lid, 0).value).toBe(42);
    });

    it('SharedArrayBuffer attach path', () => {
        const buf = new SharedArrayBuffer(256 * 1024);
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList();
        item.value = 7;
        m.push(lid, item);
        expect(m.getItem(lid, 0).value).toBe(7);
    });

    it('createShared rejects initialByteLength smaller than poolStart', () => {
        const item = new U32ItemView();
        expect(() =>
            MSharedList.createShared(item, 4, {
                poolStart: POOL_START,
                initialByteLength: POOL_START - 1,
                maxByteLength: POOL_START + 4096,
            }),
        ).toThrow(RangeError);
    });

    it('createShared allocates resizable SharedArrayBuffer', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 8 * 1024;
        const max = pool + 64 * 1024;
        const item = new U32ItemView();
        const m = MSharedList.createShared(item, 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        const sab = m.sharedArrayBuffer;
        expect(sab).toBeDefined();
        expect(sab!.byteLength).toBe(initial);
        const cap = (sab as { maxByteLength?: number }).maxByteLength;
        expect(cap).toBe(max);
    });

    it('clone copies heap; reader on old SharedArrayBuffer still sees stable data', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 4 * 1024;
        const max = pool + 128 * 1024;
        const item = new U32ItemView();
        const owner = MSharedList.createShared(item, 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        const lid = owner.createList();
        item.value = 7;
        owner.push(lid, item);

        const oldSab = owner.sharedArrayBuffer!;
        const reader = MSharedList.from(oldSab, new U32ItemView(), 4, { poolStart: pool });
        expect(reader.getItem(lid, 0).value).toBe(7);

        const newLen = initial * 2;
        const newMax = max * 2;
        const grown = owner.clone({ newByteLength: newLen, newMaxByteLength: newMax });
        expect(grown.sharedArrayBuffer).not.toBe(oldSab);
        expect(grown.sharedArrayBuffer!.byteLength).toBe(newLen);
        expect(reader.getItem(lid, 0).value).toBe(7);

        const lid2 = grown.createList();
        item.value = 99;
        grown.push(lid2, item);
        expect(grown.getItem(lid2, 0).value).toBe(99);
    });

    it('clone() without options uses same byteLength and max (new buffer instance)', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 8 * 1024;
        const max = pool + 64 * 1024;
        const item = new U32ItemView();
        const m = MSharedList.createShared(item, 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        const lid = m.createList();
        item.value = 3;
        m.push(lid, item);
        const c = m.clone();
        expect(c.sharedArrayBuffer).not.toBe(m.sharedArrayBuffer);
        expect(c.sharedArrayBuffer!.byteLength).toBe(initial);
        expect((c.sharedArrayBuffer as { maxByteLength?: number }).maxByteLength).toBe(max);
        expect(c.getItem(lid, 0).value).toBe(3);
    });

    it('growSharedBacking grows in place on same MSharedList instance', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 4 * 1024;
        const max = pool + 128 * 1024;
        const item = new U32ItemView();
        const m = MSharedList.createShared(item, 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        const sab = m.sharedArrayBuffer!;
        const doubled = initial * 2;
        m.growSharedBacking(doubled);
        expect(m.sharedArrayBuffer).toBe(sab);
        expect(sab.byteLength).toBe(doubled);
        const lid = m.createList();
        item.value = 42;
        m.push(lid, item);
        expect(m.getItem(lid, 0).value).toBe(42);
    });

    it('createShared auto-grows backing when heap is exhausted (owned buffer)', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 192;
        const max = pool + 128 * 1024;
        const item = new U32ItemView();
        const m = MSharedList.createShared(item, 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        let n = 0;
        for (; n < 400; n++) {
            m.createList(10);
        }
        expect(n).toBeGreaterThan(5);
        expect(m.sharedArrayBuffer!.byteLength).toBeGreaterThan(initial);
    });

    it('createShared stops growing at maxByteLength then createList throws (out of buffer)', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 192;
        const max = pool + 4096;
        const item = new U32ItemView();
        const m = MSharedList.createShared(item, 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        expect(() => {
            while (true) {
                m.createList(10);
            }
        }).toThrow(RangeError);
        expect(m.sharedArrayBuffer!.byteLength).toBe(max);
        expect(() => m.createList(10)).toThrow(RangeError);
    });

    it('growSharedBacking throws when target exceeds maxByteLength', () => {
        if (!environmentSupportsGrowableSharedArrayBuffer()) return;
        const pool = POOL_START;
        const initial = pool + 2048;
        const max = pool + 8192;
        const m = MSharedList.createShared(new U32ItemView(), 4, {
            poolStart: pool,
            initialByteLength: initial,
            maxByteLength: max,
        });
        expect(() => m.growSharedBacking(max + 1)).toThrow(RangeError);
        expect(m.sharedArrayBuffer!.byteLength).toBe(initial);
    });

    it('fixed ArrayBuffer: createList fails when heap is full (no auto-grow)', () => {
        const pool = POOL_START;
        const buf = new ArrayBuffer(pool + 256);
        const m = new MSharedList(buf, new U32ItemView(), 4, { poolStart: pool });
        expect(() => {
            while (true) {
                m.createList(10);
            }
        }).toThrow(RangeError);
    });

    it('clone on plain ArrayBuffer produces larger ArrayBuffer', () => {
        const item = new U32ItemView();
        const buf = makeBuf(65536);
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList();
        item.value = 5;
        m.push(lid, item);
        const grown = m.clone({ newByteLength: 65536 * 2, newMaxByteLength: 65536 * 2 });
        expect(grown.buffer).not.toBe(buf);
        expect(grown.buffer.byteLength).toBe(65536 * 2);
        expect(grown.getItem(lid, 0).value).toBe(5);
    });

    it('destroyList frees slot', () => {
        const buf = makeBuf();
        const item = new U32ItemView();
        const m = new MSharedList(buf, item, 4, { poolStart: POOL_START });
        const lid = m.createList();
        m.destroyList(lid);
        expect(() => m.length(lid)).toThrow(RangeError);
    });
});

const growableSabDescribe = environmentSupportsGrowableSharedArrayBuffer()
    ? describe
    : describe.skip;

growableSabDescribe('MSharedList + growable SharedArrayBuffer', () => {
    it('allows new lists after SharedArrayBuffer.grow and MemPool END update', () => {
        const pool = POOL_START;
        const initialTotal = pool + 192;
        const maxTotal = pool + 64 * 1024;
        const sab = createGrowableSharedArrayBuffer(initialTotal, maxTotal);
        const item = new U32ItemView();
        const m = new MSharedList(sab, item, 4, { poolStart: pool });

        expect(() => {
            while (true) {
                m.createList(10);
            }
        }).toThrow(RangeError);

        const nextBefore = m.nextListId;
        const expanded = pool + 24 * 1024;
        (sab as SharedArrayBuffer & { grow(n: number): void }).grow(expanded);
        expect(sab.byteLength).toBe(expanded);

        setMemPoolEndByte(sab, pool, sab.byteLength);
        m.createList(10);
        expect(m.nextListId).toBe(nextBefore + 1);

        const lastId = m.nextListId - 1;
        item.value = 1;
        m.push(lastId, item);
        expect(m.getItem(lastId, 0).value).toBe(1);
    });
});

describe('IMSharedListItemView.nextItem', () => {
    it('U32ItemView: returns undefined when already on the sole row', () => {
        const buf = makeBuf();
        const v = new U32ItemView();
        const m = new MSharedList(buf, v, 4, { poolStart: POOL_START });
        const lid = m.createList();
        v.value = 99;
        m.push(lid, v);
        m.getItem(lid, 0);
        expect(v.value).toBe(99);
        expect(v.nextItem()).toBeUndefined();
    });

    it('U32ItemView: advances off by stride and reads following rows', () => {
        const buf = makeBuf();
        const v = new U32ItemView();
        const m = new MSharedList(buf, v, 4, { poolStart: POOL_START });
        const lid = m.createList();
        v.value = 1;
        m.push(lid, v);
        v.value = 2;
        m.push(lid, v);
        v.value = 3;
        m.push(lid, v);
        m.getItem(lid, 0);
        expect(v.value).toBe(1);
        expect(v.nextItem()).toBe(v);
        expect(v.value).toBe(2);
        expect(v.nextItem()).toBe(v);
        expect(v.value).toBe(3);
        expect(v.nextItem()).toBeUndefined();
    });

    it('U32ItemView: starting mid-list, nextItem only walks remaining rows', () => {
        const buf = makeBuf();
        const v = new U32ItemView();
        const m = new MSharedList(buf, v, 4, { poolStart: POOL_START });
        const lid = m.createList(8);
        for (let i = 1; i <= 5; i++) {
            v.value = i * 10;
            m.push(lid, v);
        }
        m.getItem(lid, 2);
        expect(v.value).toBe(30);
        expect(v.nextItem()).toBe(v);
        expect(v.value).toBe(40);
        expect(v.nextItem()).toBe(v);
        expect(v.value).toBe(50);
        expect(v.nextItem()).toBeUndefined();
    });

    it('MSharedListItemView: same nextItem contract as U32ItemView', () => {
        const buf = makeBuf();
        const row = new SharedListItemView(4);
        const m = new MSharedList(buf, row, 4, { poolStart: POOL_START });
        const lid = m.createList(8);
        row.u32 = 11;
        m.push(lid, row);
        row.u32 = 22;
        m.push(lid, row);
        row.u32 = 33;
        m.push(lid, row);
        m.getItem(lid, 0);
        expect(row.u32).toBe(11);
        expect(row.nextItem()).toBe(row);
        expect(row.u32).toBe(22);
        expect(row.nextItem()).toBe(row);
        expect(row.u32).toBe(33);
        expect(row.nextItem()).toBeUndefined();
    });
});
