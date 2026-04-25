const NIL = 0xffffffff;

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

/**
 * Many singly-linked lists in one **growable** `SharedArrayBuffer` (`{ maxByteLength }` + `grow()`).
 * There is **no fixed list count**: `listIndex` is any non-negative integer; the head table grows
 * when you use a larger index. A shared node pool also grows (by doubling) until `maxByteLength`
 * is hit. All operations are serialized with one mutex so layout moves (`copyWithin`) cannot race
 * head / `next` / payload access.
 *
 * **Grow vs copy:** `grow()` keeps the same `SharedArrayBuffer` object and extends `byteLength`.
 * Relayout still uses `copyWithin` to slide the pool when the head table or `next[]` grows, so
 * payload bytes may move inside the SAB even though no new `SharedArrayBuffer` is allocated.
 *
 * @example
 * ```ts
 * const lists = new SharedLinkedList(32, 5, { initialListSlots: 2, maxByteLength: 512 * 1024 });
 * lists.insert(100, new Uint8Array([1, 2, 3, 4, 5]));
 * ```
 *
 * In a worker, receive the same `SharedArrayBuffer` (e.g. from `postMessage`) and call
 * {@link SharedLinkedList.from} to attach without allocating a new buffer.
 *
 * **Typed items:** pass `createItem` in options to use a custom view type `T` implementing
 * {@link SharedLinkedListItemView}. The list keeps **one** instance of `T` and calls
 * {@link SharedLinkedListItemView.attach} with the payload subarray for {@link itemAt} and
 * {@link iterateItems}. Each call rebinds that instance; do not stash `item` across a later call
 * on the same list unless you copy data out first.
 */

/** Payload slice for one node; length is always {@link SharedLinkedList.valueBytes}. */
export interface SharedLinkedListItemView {
    attach(bytes: Uint8Array<ArrayBufferLike>): void;
}

/** Default item view: {@link attach} then read the current row via {@link bytes}. */
export class SharedLinkedListBytesView implements SharedLinkedListItemView {
    private _bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    attach(bytes: Uint8Array<ArrayBufferLike>): void {
        this._bytes = bytes;
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return this._bytes;
    }
}

export interface SharedLinkedListEntry {
    index: number;
    value: Uint8Array;
}

export interface SharedLinkedListItemEntry<T extends SharedLinkedListItemView> {
    index: number;
    item: T;
}

export interface SharedLinkedListOptions<T extends SharedLinkedListItemView = SharedLinkedListBytesView> {
    initialListSlots?: number;
    maxByteLength?: number;
    /** Factory for the single reused `T` (see class doc). Required for custom `T` when not using the default bytes view. */
    createItem?: () => T;
}

export default class SharedLinkedList<T extends SharedLinkedListItemView = SharedLinkedListBytesView> {
    storage!: SharedArrayBuffer;
    private mutex!: Int32Array;
    hdr!: Uint32Array;
    heads!: Uint32Array;
    listLengths!: Uint32Array;
    next!: Uint32Array;
    data!: Uint8Array;

    private _reuseItem: T;

    valueByteSize: number;

    constructor(initialPoolSlots: number, valueBytesPerItem: number, options?: SharedLinkedListOptions<T>) {
        if (!Number.isInteger(initialPoolSlots) || initialPoolSlots < 1) {
            throw new RangeError('SharedLinkedList: initialPoolSlots must be a positive integer');
        }
        if (!Number.isInteger(valueBytesPerItem) || valueBytesPerItem < 1 || valueBytesPerItem > 1_048_576) {
            throw new RangeError('SharedLinkedList: valueBytesPerItem must be an integer in [1, 1048576]');
        }

        const list0 = Math.max(1, options?.initialListSlots ?? 8);
        const layout0 = layoutOffsets(list0, initialPoolSlots, valueBytesPerItem);
        const minMax = Math.max(layout0.totalBytes * 4, layout0.totalBytes + 4096);
        const maxB = Math.max(options?.maxByteLength ?? minMax, layout0.totalBytes);

        if (maxB < layout0.totalBytes) {
            throw new RangeError('SharedLinkedList: maxByteLength is smaller than the initial layout');
        }

        this.valueByteSize = valueBytesPerItem;
        this._reuseItem = (options?.createItem?.() ?? (new SharedLinkedListBytesView() as unknown as T)) as T;
        this.storage = new SharedArrayBuffer(layout0.totalBytes, { maxByteLength: maxB });

        this.mutex = new Int32Array(this.storage, 0, 1);
        this.hdr = new Uint32Array(this.storage, OFF_HDR, HDR_WORDS);

        Atomics.store(this.hdr, H.listSlots, list0 >>> 0);
        Atomics.store(this.hdr, H.poolSlots, initialPoolSlots >>> 0);
        Atomics.store(this.hdr, H.valueBytes, valueBytesPerItem >>> 0);
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

    /**
     * Attach to an existing buffer produced by {@link SharedLinkedList}'s constructor (same layout
     * and header). Typical use: main thread creates the list, transfers or shares the
     * `SharedArrayBuffer`, worker calls `SharedLinkedList.from(sab)`.
     *
     * Optional `createItem` matches the constructor: same factory used for the single reused `T`.
     */
    static from(storage: SharedArrayBuffer): SharedLinkedList<SharedLinkedListBytesView>;
    static from<T extends SharedLinkedListItemView>(storage: SharedArrayBuffer, createItem: () => T): SharedLinkedList<T>;
    static from<T extends SharedLinkedListItemView>(
        storage: SharedArrayBuffer,
        createItem?: () => T,
    ): SharedLinkedList<T> | SharedLinkedList<SharedLinkedListBytesView> {
        const minBytes = OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (storage.byteLength < minBytes) {
            throw new RangeError('SharedLinkedList.from: buffer too small for header');
        }
        const mutex = new Int32Array(storage, 0, 1);
        const hdr = new Uint32Array(storage, OFF_HDR, HDR_WORDS);
        const L = Atomics.load(hdr, H.listSlots) >>> 0;
        const P = Atomics.load(hdr, H.poolSlots) >>> 0;
        const vb = Atomics.load(hdr, H.valueBytes) >>> 0;

        if (L < 1 || P < 1) {
            throw new RangeError('SharedLinkedList.from: invalid listSlots or poolSlots in header');
        }
        if (vb < 1 || vb > 1_048_576) {
            throw new RangeError('SharedLinkedList.from: invalid valueBytes in header');
        }

        const need = layoutOffsets(L, P, vb).totalBytes;
        if (need > storage.byteLength) {
            throw new RangeError('SharedLinkedList.from: buffer byteLength is smaller than embedded layout');
        }

        const inst = Object.create(SharedLinkedList.prototype) as SharedLinkedList<T>;
        inst.storage = storage;
        inst.mutex = mutex;
        inst.hdr = hdr;
        inst.valueByteSize = vb;
        inst._reuseItem = (createItem?.() ?? (new SharedLinkedListBytesView() as unknown as T)) as T;
        inst._rebindViews();
        return inst as SharedLinkedList<T>;
    }

    get listCapacity(): number {
        return Atomics.load(this.hdr, H.listSlots);
    }

    get poolCapacity(): number {
        return Atomics.load(this.hdr, H.poolSlots);
    }

    get valueBytes(): number {
        return this.valueByteSize;
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

    /* eslint-disable no-constant-condition */
    private _lock(): void {
        while (true) {
            if (Atomics.exchange(this.mutex, 0, 1) === 0) return;
            Atomics.wait(this.mutex, 0, 1);
        }
    }

    private _unlock(): void {
        const v = Atomics.exchange(this.mutex, 0, 0);
        if (v !== 1) throw new Error('SharedLinkedList: mutex desync');
        Atomics.notify(this.mutex, 0);
    }
    /* eslint-enable no-constant-condition */

    private _assertListIndex(listIndex: number): void {
        if (!Number.isInteger(listIndex) || listIndex < 0) {
            throw new RangeError('SharedLinkedList: listIndex must be a non-negative integer');
        }
    }

    private _rebindViews(): void {
        const L = Atomics.load(this.hdr, H.listSlots);
        const P = Atomics.load(this.hdr, H.poolSlots);
        const vb = Atomics.load(this.hdr, H.valueBytes);
        const o = layoutOffsets(L, P, vb);
        this.heads = new Uint32Array(this.storage, o.headsByteOffset, L);
        this.listLengths = new Uint32Array(this.storage, o.lengthsByteOffset, L);
        this.next = new Uint32Array(this.storage, o.nextByteOffset, P);
        this.data = new Uint8Array(this.storage, o.dataByteOffset, P * vb);
    }

    private _initFreeChain(from: number, count: number): void {
        if (count <= 0) return;
        const to = from + count;
        for (let i = from; i < to - 1; i++) Atomics.store(this.next, i, (i + 1) >>> 0);
        Atomics.store(this.next, to - 1, NIL);
        Atomics.store(this.hdr, H.freeHead, from >>> 0);
    }

    private _assertPayload(bytes: Uint8Array): void {
        if (bytes.length !== this.valueByteSize) {
            throw new RangeError(
                `SharedLinkedList: payload must be exactly ${this.valueByteSize} bytes, got ${bytes.length}`,
            );
        }
    }

    private _dataOffset(index: number): number {
        return (index >>> 0) * this.valueByteSize;
    }

    private _copyOut(index: number): Uint8Array {
        const offset = this._dataOffset(index);
        return this.data.subarray(offset, offset + this.valueByteSize);
    }

    private _ensureListSlot(listIndex: number): void {
        const need = (listIndex >>> 0) + 1;
        const L = Atomics.load(this.hdr, H.listSlots);
        if (need <= L) return;

        const P = Atomics.load(this.hdr, H.poolSlots);
        const vb = Atomics.load(this.hdr, H.valueBytes);
        const Lnew = need;
        const oldLayout = layoutOffsets(L, P, vb);
        const newLayout = layoutOffsets(Lnew, P, vb);
        if (newLayout.totalBytes > this.storage.maxByteLength) {
            throw new RangeError('SharedLinkedList: maxByteLength exceeded while growing list table');
        }
        if (newLayout.totalBytes > this.storage.byteLength) {
            this.storage.grow(newLayout.totalBytes);
        }

        const u8 = new Uint8Array(this.storage);
        const moveLen = oldLayout.totalBytes - oldLayout.nextByteOffset;
        if (moveLen > 0) {
            u8.copyWithin(newLayout.nextByteOffset, oldLayout.nextByteOffset, oldLayout.totalBytes);
        }

        Atomics.store(this.hdr, H.listSlots, Lnew >>> 0);
        this._rebindViews();
        for (let i = L; i < Lnew; i++) {
            Atomics.store(this.heads, i, NIL);
            Atomics.store(this.listLengths, i, 0);
        }
    }

    private _growPool(minPool: number): void {
        const L = Atomics.load(this.hdr, H.listSlots);
        let P = Atomics.load(this.hdr, H.poolSlots);
        const vb = Atomics.load(this.hdr, H.valueBytes);
        if (minPool <= P) return;

        const Pnew = minPool;
        const oldLayout = layoutOffsets(L, P, vb);
        const newLayout = layoutOffsets(L, Pnew, vb);
        if (newLayout.totalBytes > this.storage.maxByteLength) {
            throw new RangeError('SharedLinkedList: maxByteLength exceeded while growing pool');
        }
        if (newLayout.totalBytes > this.storage.byteLength) {
            this.storage.grow(newLayout.totalBytes);
        }

        const u8 = new Uint8Array(this.storage);
        const payloadBytes = P * vb;
        if (payloadBytes > 0) {
            u8.copyWithin(newLayout.dataByteOffset, oldLayout.dataByteOffset, oldLayout.dataByteOffset + payloadBytes);
        }

        Atomics.store(this.hdr, H.poolSlots, Pnew >>> 0);
        this._rebindViews();

        const fh = Atomics.load(this.hdr, H.freeHead);
        for (let i = P; i < Pnew - 1; i++) Atomics.store(this.next, i, (i + 1) >>> 0);
        Atomics.store(this.next, Pnew - 1, fh >>> 0);
        Atomics.store(this.hdr, H.freeHead, P >>> 0);
    }

    private _allocNode(): number {
        while (true) {
            const fh = Atomics.load(this.hdr, H.freeHead);
            if (fh === NIL) {
                const P = Atomics.load(this.hdr, H.poolSlots);
                const L = Atomics.load(this.hdr, H.listSlots);
                const vb = Atomics.load(this.hdr, H.valueBytes);
                const Pnew = P * 2;
                if (layoutOffsets(L, Pnew, vb).totalBytes <= this.storage.maxByteLength) {
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
            if (Atomics.compareExchange(this.hdr, H.freeHead, fh, i) === fh) {
                return;
            }
        }
    }

    /**
     * Insert `payload` at the front of `listIndex` (newest node becomes the head).
     * @returns Pool slot index (`itemIndex`) for use with {@link delete} / {@link readAt}.
     */
    insert(listIndex: number, payload: Uint8Array): number {
        this._assertListIndex(listIndex);
        this._assertPayload(payload);

        this._lock();
        try {
            this._ensureListSlot(listIndex);

            const node = this._allocNode();
            if (node === NIL) throw new RangeError('SharedLinkedList: node pool is full (maxByteLength too small)');

            const offset = this._dataOffset(node);
            this.data.set(payload, offset);

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

    /**
     * Remove the node `itemIndex` from `listIndex`’s list (must be on that list).
     * @throws RangeError if the node is not in the list or indices are invalid.
     */
    delete(listIndex: number, itemIndex: number): void {
        this._assertListIndex(listIndex);
        const item = itemIndex >>> 0;

        this._lock();
        try {
            this._ensureListSlot(listIndex);
            if (!this._reachableFromHead(listIndex, item)) {
                throw new RangeError(
                    `SharedLinkedList: itemIndex ${item} is not on list ${listIndex} or list is empty`,
                );
            }

            const h = Atomics.load(this.heads, listIndex);
            if (h === item) {
                const nx = Atomics.load(this.next, item);
                Atomics.store(this.heads, listIndex, nx);
                this._freeNode(item);
                Atomics.sub(this.listLengths, listIndex, 1);
                return;
            }

            let cur = h;
            while (cur !== NIL) {
                const nxt = Atomics.load(this.next, cur);
                if (nxt === item) {
                    const after = Atomics.load(this.next, item);
                    Atomics.store(this.next, cur, after);
                    this._freeNode(item);
                    Atomics.sub(this.listLengths, listIndex, 1);
                    return;
                }
                cur = nxt;
            }
            throw new RangeError(`SharedLinkedList: internal delete failed for itemIndex ${item}`);
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

    readAt(listIndex: number, nodeIndex: number): Uint8Array | null {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            if (!this._reachableFromHead(listIndex, nodeIndex)) return null;
            return this._copyOut(nodeIndex >>> 0);
        } finally {
            this._unlock();
        }
    }

    /**
     * Binds the single reused item view {@link T} to this node’s payload and returns it.
     * The next `itemAt` / `iterateItems` step overwrites the same instance.
     */
    itemAt(listIndex: number, nodeIndex: number): T | null {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            if (!this._reachableFromHead(listIndex, nodeIndex)) return null;
            const slice = this._copyOut(nodeIndex >>> 0);
            this._reuseItem.attach(slice);
            return this._reuseItem;
        } finally {
            this._unlock();
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

    *iterate(listIndex: number): Generator<SharedLinkedListEntry, void, undefined> {
        let cur = this.headIndex(listIndex);
        if (cur === null) return;
        while (cur !== NIL) {
            const index = cur >>> 0;
            const value = this._copyOut(index);
            cur = Atomics.load(this.next, cur);
            yield { index, value };
        }
    }

    *entries(listIndex: number): Generator<SharedLinkedListEntry, void, undefined> {
        yield* this.iterate(listIndex);
    }

    /**
     * Like {@link iterate} but yields the reused {@link T} (same object every yield; only
     * `index` differs — read properties before the next iteration).
     */
    *iterateItems(listIndex: number): Generator<SharedLinkedListItemEntry<T>, void, undefined> {
        let cur = this.headIndex(listIndex);
        if (cur === null) return;
        while (cur !== NIL) {
            const index = cur >>> 0;
            this._reuseItem.attach(this._copyOut(index));
            cur = Atomics.load(this.next, cur);
            yield { index, item: this._reuseItem };
        }
    }

    *entryItems(listIndex: number): Generator<SharedLinkedListItemEntry<T>, void, undefined> {
        yield* this.iterateItems(listIndex);
    }

    clearList(listIndex: number): void {
        this._assertListIndex(listIndex);
        this._lock();
        try {
            this._ensureListSlot(listIndex);
            while (true) {
                const h = Atomics.load(this.heads, listIndex);
                if (h === NIL) break;
                const nx = Atomics.load(this.next, h);
                Atomics.store(this.heads, listIndex, nx);
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
}
