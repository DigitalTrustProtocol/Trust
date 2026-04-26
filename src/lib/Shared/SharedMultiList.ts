const NIL = 0xffffffff;
const VALUE_BYTES = 4;

const HDR_WORDS = 6;
const OFF_HDR = 4;

const H = {
    listSlots: 0,
    poolSlots: 1,
    valueBytes: 2,
    freeHead: 3,
    _pad4: 4,
    _pad5: 5,
} as const;

function align4(n: number): number {
    return (n + 3) & ~3;
}

function layoutOffsets(listSlots: number, poolSlots: number, valueBytes: number) {
    let off = OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT;
    const headsByteOffset = off;
    off += listSlots * Uint32Array.BYTES_PER_ELEMENT;
    const lengthsByteOffset = off;
    off += listSlots * Uint32Array.BYTES_PER_ELEMENT;
    off = align4(off);
    const nextByteOffset = off;
    off += poolSlots * Uint32Array.BYTES_PER_ELEMENT;
    const dataByteOffset = off;
    off += poolSlots * valueBytes;
    return { headsByteOffset, lengthsByteOffset, nextByteOffset, dataByteOffset, totalBytes: off };
}

export interface SharedMultiListEntry {
    index: number;
    value: number;
}

export interface SharedMultiListOptions {
    initialListSlots?: number;
    maxByteLength?: number;
}

export default class SharedMultiList {
    public storage!: SharedArrayBuffer;
    private mutex!: Int32Array;
    hdr!: Uint32Array;
    heads!: Uint32Array;
    listLengths!: Uint32Array;
    next!: Uint32Array;
    data32!: Uint32Array;

    constructor(initialPoolSlots: number, options?: SharedMultiListOptions) {
        if (!Number.isInteger(initialPoolSlots) || initialPoolSlots < 1) {
            throw new RangeError('SharedMultiList: initialPoolSlots must be a positive integer');
        }

        const list0 = Math.max(1, options?.initialListSlots ?? 8);
        const layout0 = layoutOffsets(list0, initialPoolSlots, VALUE_BYTES);
        const minMax = Math.max(layout0.totalBytes * 4, layout0.totalBytes + 4096);
        const maxB = Math.max(options?.maxByteLength ?? minMax, layout0.totalBytes);

        this.storage = new SharedArrayBuffer(layout0.totalBytes, { maxByteLength: maxB });
        this.mutex = new Int32Array(this.storage, 0, 1);
        this.hdr = new Uint32Array(this.storage, OFF_HDR, HDR_WORDS);
        Atomics.store(this.hdr, H.listSlots, list0 >>> 0);
        Atomics.store(this.hdr, H.poolSlots, initialPoolSlots >>> 0);
        Atomics.store(this.hdr, H.valueBytes, VALUE_BYTES);
        Atomics.store(this.hdr, H.freeHead, 0);
        Atomics.store(this.hdr, H._pad4, 0);
        Atomics.store(this.hdr, H._pad5, 0);
        this._rebindViews();
        for (let i = 0; i < list0; i++) {
            Atomics.store(this.heads, i, NIL);
            Atomics.store(this.listLengths, i, 0);
        }
        this._initFreeChain(0, initialPoolSlots);
    }

    static from(storage: SharedArrayBuffer): SharedMultiList {
        const minBytes = OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (storage.byteLength < minBytes) {
            throw new RangeError('SharedMultiList.from: buffer too small for header');
        }
        const hdr = new Uint32Array(storage, OFF_HDR, HDR_WORDS);
        const L = Atomics.load(hdr, H.listSlots) >>> 0;
        const P = Atomics.load(hdr, H.poolSlots) >>> 0;
        const vb = Atomics.load(hdr, H.valueBytes) >>> 0;
        if (L < 1 || P < 1 || vb !== VALUE_BYTES) {
            throw new RangeError('SharedMultiList.from: invalid header');
        }
        const need = layoutOffsets(L, P, vb).totalBytes;
        if (need > storage.byteLength) {
            throw new RangeError('SharedMultiList.from: buffer byteLength is smaller than embedded layout');
        }
        const inst = Object.create(SharedMultiList.prototype) as SharedMultiList;
        inst.storage = storage;
        inst.mutex = new Int32Array(storage, 0, 1);
        inst.hdr = hdr;
        inst._rebindViews();
        return inst;
    }

    get valueBytes(): number {
        return VALUE_BYTES;
    }

    get listCapacity(): number {
        return Atomics.load(this.hdr, H.listSlots);
    }

    get poolCapacity(): number {
        return Atomics.load(this.hdr, H.poolSlots);
    }

    get maxByteLength(): number {
        return this.storage.maxByteLength;
    }

    get byteLength(): number {
        return this.storage.byteLength;
    }

    length(listIndex: number): number {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            return Atomics.load(this.listLengths, listIndex);
        } finally {
            this._unlock();
        }
    }

    insert(listIndex: number, value: number): number {
        this._assertListIndex(listIndex);
        this._assertValue(value);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            const node = this._allocNode();
            if (node === NIL) throw new RangeError('SharedMultiList: node pool is full (maxByteLength too small)');
            Atomics.store(this.data32, node, value >>> 0);
            while (true) {
                const h = Atomics.load(this.heads, listIndex);
                Atomics.store(this.next, node, h);
                if (Atomics.compareExchange(this.heads, listIndex, h, node) === h) {
                    Atomics.add(this.listLengths, listIndex, 1);
                    return node >>> 0;
                }
            }
        } finally {
            this._unlock();
        }
    }

    delete(listIndex: number, itemIndex: number): void {
        this._assertListIndex(listIndex);
        const item = itemIndex >>> 0;
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            if (!this._reachableFromHead(listIndex, item)) {
                throw new RangeError(`SharedMultiList: itemIndex ${item} is not on list ${listIndex} or list is empty`);
            }
            const h = Atomics.load(this.heads, listIndex);
            if (h === item) {
                Atomics.store(this.heads, listIndex, Atomics.load(this.next, item));
                this._freeNode(item);
                Atomics.sub(this.listLengths, listIndex, 1);
                return;
            }
            let cur = h;
            while (cur !== NIL) {
                const nxt = Atomics.load(this.next, cur);
                if (nxt === item) {
                    Atomics.store(this.next, cur, Atomics.load(this.next, item));
                    this._freeNode(item);
                    Atomics.sub(this.listLengths, listIndex, 1);
                    return;
                }
                cur = nxt;
            }
            throw new RangeError(`SharedMultiList: internal delete failed for itemIndex ${item}`);
        } finally {
            this._unlock();
        }
    }

    headIndex(listIndex: number): number | null {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            const h = Atomics.load(this.heads, listIndex);
            return h === NIL ? null : h >>> 0;
        } finally {
            this._unlock();
        }
    }

    nextIndex(listIndex: number, nodeIndex: number): number | null {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            if (!this._reachableFromHead(listIndex, nodeIndex)) return null;
            const n = Atomics.load(this.next, nodeIndex >>> 0);
            return n === NIL ? null : n >>> 0;
        } finally {
            this._unlock();
        }
    }

    readAt(listIndex: number, nodeIndex: number): number | null {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            if (!this._reachableFromHead(listIndex, nodeIndex)) return null;
            return Atomics.load(this.data32, nodeIndex >>> 0) >>> 0;
        } finally {
            this._unlock();
        }
    }

    *iterate(listIndex: number): Generator<SharedMultiListEntry, void, undefined> {
        let cur = this.headIndex(listIndex);
        if (cur === null) return;
        while (cur !== NIL) {
            const index = cur >>> 0;
            const value = Atomics.load(this.data32, index) >>> 0;
            cur = Atomics.load(this.next, cur);
            yield { index, value };
        }
    }

    *values(listIndex: number): Generator<number, void, undefined> {
        let cur = this.headIndex(listIndex);
        if (cur === null) return;
        while (cur !== NIL) {
            const index = cur >>> 0;
            const value = Atomics.load(this.data32, index) >>> 0;
            cur = Atomics.load(this.next, cur);
            yield value;
        }
    }

    *entries(listIndex: number): Generator<SharedMultiListEntry, void, undefined> {
        yield* this.iterate(listIndex);
    }

    clearList(listIndex: number): void {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            while (true) {
                const h = Atomics.load(this.heads, listIndex);
                if (h === NIL) break;
                Atomics.store(this.heads, listIndex, Atomics.load(this.next, h));
                this._freeNode(h);
                Atomics.sub(this.listLengths, listIndex, 1);
            }
        } finally {
            this._unlock();
        }
    }

    clearAll(): void {
        const n = this.listCapacity;
        for (let i = 0; i < n; i++) this.clearList(i);
    }

    /* eslint-disable no-constant-condition */
    private _lock(): void {
        while (true) {
            if (Atomics.exchange(this.mutex, 0, 1) === 0) return;
            Atomics.wait(this.mutex, 0, 1);
        }
    }

    private _unlock(): void {
        const v = Atomics.exchange(this.mutex, 0, 0);
        if (v !== 1) throw new Error('SharedMultiList: mutex desync');
        Atomics.notify(this.mutex, 0);
    }
    /* eslint-enable no-constant-condition */

    private _assertListIndex(listIndex: number): void {
        if (!Number.isInteger(listIndex) || listIndex < 0) {
            throw new RangeError('SharedMultiList: listIndex must be a non-negative integer');
        }
    }

    private _assertValue(value: number): void {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
            throw new RangeError('SharedMultiList: value must be an unsigned 32-bit integer');
        }
    }

    private _rebindViews(): void {
        const L = Atomics.load(this.hdr, H.listSlots);
        const P = Atomics.load(this.hdr, H.poolSlots);
        const o = layoutOffsets(L, P, VALUE_BYTES);
        this.heads = new Uint32Array(this.storage, o.headsByteOffset, L);
        this.listLengths = new Uint32Array(this.storage, o.lengthsByteOffset, L);
        this.next = new Uint32Array(this.storage, o.nextByteOffset, P);
        this.data32 = new Uint32Array(this.storage, o.dataByteOffset, P);
    }

    private _initFreeChain(from: number, count: number): void {
        if (count <= 0) return;
        const to = from + count;
        for (let i = from; i < to - 1; i++) Atomics.store(this.next, i, (i + 1) >>> 0);
        Atomics.store(this.next, to - 1, NIL);
        Atomics.store(this.hdr, H.freeHead, from >>> 0);
    }

    private _ensureListSlot(listIndex: number): void {
        const need = (listIndex >>> 0) + 1;
        const L = Atomics.load(this.hdr, H.listSlots);
        if (need <= L) return;
        const P = Atomics.load(this.hdr, H.poolSlots);
        const oldLayout = layoutOffsets(L, P, VALUE_BYTES);
        const newLayout = layoutOffsets(need, P, VALUE_BYTES);
        if (newLayout.totalBytes > this.storage.maxByteLength) {
            throw new RangeError('SharedMultiList: maxByteLength exceeded while growing list table');
        }
        if (newLayout.totalBytes > this.storage.byteLength) this.storage.grow(newLayout.totalBytes);
        const u8 = new Uint8Array(this.storage);
        const moveLen = oldLayout.totalBytes - oldLayout.nextByteOffset;
        if (moveLen > 0) u8.copyWithin(newLayout.nextByteOffset, oldLayout.nextByteOffset, oldLayout.totalBytes);
        Atomics.store(this.hdr, H.listSlots, need >>> 0);
        this._rebindViews();
        for (let i = L; i < need; i++) {
            Atomics.store(this.heads, i, NIL);
            Atomics.store(this.listLengths, i, 0);
        }
    }

    private _growPool(minPool: number): void {
        const L = Atomics.load(this.hdr, H.listSlots);
        const P = Atomics.load(this.hdr, H.poolSlots);
        if (minPool <= P) return;
        const oldLayout = layoutOffsets(L, P, VALUE_BYTES);
        const newLayout = layoutOffsets(L, minPool, VALUE_BYTES);
        if (newLayout.totalBytes > this.storage.maxByteLength) {
            throw new RangeError('SharedMultiList: maxByteLength exceeded while growing pool');
        }
        if (newLayout.totalBytes > this.storage.byteLength) this.storage.grow(newLayout.totalBytes);
        const u8 = new Uint8Array(this.storage);
        const payloadBytes = P * VALUE_BYTES;
        if (payloadBytes > 0) {
            u8.copyWithin(newLayout.dataByteOffset, oldLayout.dataByteOffset, oldLayout.dataByteOffset + payloadBytes);
        }
        Atomics.store(this.hdr, H.poolSlots, minPool >>> 0);
        this._rebindViews();
        const fh = Atomics.load(this.hdr, H.freeHead);
        for (let i = P; i < minPool - 1; i++) Atomics.store(this.next, i, (i + 1) >>> 0);
        Atomics.store(this.next, minPool - 1, fh >>> 0);
        Atomics.store(this.hdr, H.freeHead, P >>> 0);
    }

    private _allocNode(): number {
        while (true) {
            const fh = Atomics.load(this.hdr, H.freeHead);
            if (fh === NIL) {
                const P = Atomics.load(this.hdr, H.poolSlots);
                const L = Atomics.load(this.hdr, H.listSlots);
                const Pnew = P * 2;
                if (layoutOffsets(L, Pnew, VALUE_BYTES).totalBytes <= this.storage.maxByteLength) {
                    this._growPool(Pnew);
                    continue;
                }
                return NIL;
            }
            const nx = Atomics.load(this.next, fh);
            if (Atomics.compareExchange(this.hdr, H.freeHead, fh, nx) === fh) {
                return fh >>> 0;
            }
        }
    }

    private _freeNode(idx: number): void {
        const i = idx >>> 0;
        while (true) {
            const fh = Atomics.load(this.hdr, H.freeHead);
            Atomics.store(this.next, i, fh);
            if (Atomics.compareExchange(this.hdr, H.freeHead, fh, i) === fh) return;
        }
    }

    private _reachableFromHead(listIndex: number, nodeIndex: number): boolean {
        const t = nodeIndex >>> 0;
        let cur = Atomics.load(this.heads, listIndex);
        while (cur !== NIL) {
            if (cur === t) return true;
            cur = Atomics.load(this.next, cur);
        }
        return false;
    }
}
