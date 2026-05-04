import { MemPool, type MemPoolOpts } from '@thi.ng/malloc';
import type { ISharedListItemView } from './SharedListItemView.js';

export type { ISharedListItemView } from './SharedListItemView.js';
export { SharedListItemView } from './SharedListItemView.js';

const LIST_HDR_BYTES = 8;

/** u32[0] = next list id to assign; u32[1 + listId] = malloc user-data ptr (0 = none). */
const DIR_NEXT_ID = 0;

/** `@thi.ng/malloc` pool.js `STATE_END` index in `Uint32Array(buffer, poolStart, …)`. */
const MEMPOOL_STATE_END_U32 = 3;

type GrowableSharedArrayBufferCtor = new (
    byteLength: number,
    options?: { maxByteLength?: number },
) => SharedArrayBuffer;

function createGrowableSharedArrayBuffer(byteLength: number, maxByteLength: number): SharedArrayBuffer {
    const Ctor = SharedArrayBuffer as unknown as GrowableSharedArrayBufferCtor;
    return new Ctor(byteLength, { maxByteLength });
}

function setMemPoolEndByte(buf: ArrayBufferLike, poolStart: number, endByte: number): void {
    const state = new Uint32Array(buf, poolStart, 7);
    state[MEMPOOL_STATE_END_U32] = endByte >>> 0;
}

function readSharedArrayBufferMaxByteLength(sab: SharedArrayBuffer): number | undefined {
    const m = (sab as { maxByteLength?: number }).maxByteLength;
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
}

export interface MSharedListOptions {
    /**
     * Byte offset where {@link MemPool} internal state begins. Bytes `[0, poolStart)`
     * hold the list-id directory. Must be a multiple of 4 and large enough for
     * {@link MemPool} state + alignment (≥ 64 recommended).
     *
     * @defaultValue 65536
     */
    poolStart?: number;
    /** Default initial capacity for {@link MSharedList.createList}. @defaultValue 10 */
    defaultListCapacity?: number;
    /** When full, new capacity is at least `ceil(capacity * growthFactor)`. @defaultValue 2 */
    growthFactor?: number;
    /** Forwarded to {@link MemPool} (e.g. `compact`, `split`, `end`). */
    memPool?: Partial<MemPoolOpts>;
    /**
     * If true, the backing buffer is assumed to already contain a valid
     * {@link MemPool} image (e.g. second thread attaching to the same
     * `SharedArrayBuffer`). Same `poolStart` must be used everywhere.
     */
    skipInitialization?: boolean;
    /**
     * Set when the backing `SharedArrayBuffer` was allocated by {@link MSharedList.createShared}
     * (or a same-sized {@link clone}). Enables {@link growSharedBacking} and automatic in-place
     * growth when malloc runs out of space on the main thread. Do not set manually.
     */
    ownedSharedBacking?: { initialByteLength: number; maxByteLength: number };
}

/** Options for {@link MSharedList.createShared} (allocates a growable-capacity `SharedArrayBuffer`). */
export interface MSharedListCreateSharedOptions extends Omit<MSharedListOptions, 'skipInitialization' | 'ownedSharedBacking'> {
    initialByteLength: number;
    maxByteLength: number;
}

/** Overrides for {@link MSharedList.clone}; omit both for a same-size copy into a new buffer instance. */
export interface MSharedListCloneOptions {
    /** New backing `byteLength` (≥ current `byteLength`; default = current). */
    newByteLength?: number;
    /** Resizable `SharedArrayBuffer` ceiling (≥ `newByteLength`; default = current max or current length). */
    newMaxByteLength?: number;
}

/**
 * Many fixed-size lists in one `ArrayBuffer` / `SharedArrayBuffer`, backed by
 * {@link MemPool} (`@thi.ng/malloc`). Identifiers are numeric list indices and
 * item indices only; one {@link ISharedListItemView} singleton is rebound per
 * read. No `Atomics` — intended for read-mostly / single-writer layouts.
 */
export default class MSharedList<T extends ISharedListItemView> {
    readonly buf: ArrayBufferLike;
    readonly itemByteSize: number;
    private pool: MemPool;
    private dv: DataView;
    private u8: Uint8Array;
    private readonly dir: Uint32Array;
    private readonly poolStart: number;
    private readonly defaultListCapacity: number;
    private readonly growthFactor: number;
    private readonly singleton: T;
    /** Scratch row for {@link shift} after the list body moves (then {@link attachAt}). */
    private readonly _shiftScratch: Uint8Array;
    /** Sizing metadata for {@link clone} when this instance (or its ancestor) used {@link createShared} / clone. */
    private readonly _ownedSharedBacking: { initialByteLength: number; maxByteLength: number } | undefined;

    constructor(
        buffer: ArrayBufferLike,
        itemViewSingleton: T,
        itemByteSize: number,
        options?: MSharedListOptions,
    ) {
        if (!Number.isInteger(itemByteSize) || itemByteSize < 1) {
            throw new RangeError('MSharedList: itemByteSize must be a positive integer');
        }
        this.buf = buffer;
        this.singleton = itemViewSingleton;
        this.itemByteSize = itemByteSize;
        this.poolStart = options?.poolStart ?? 65536;
        if (this.poolStart < 64 || (this.poolStart & 3) !== 0) {
            throw new RangeError('MSharedList: poolStart must be >= 64 and a multiple of 4');
        }
        this.defaultListCapacity = options?.defaultListCapacity ?? 10;
        const gf = options?.growthFactor ?? 2;
        if (!Number.isFinite(gf) || gf < 1) {
            throw new RangeError('MSharedList: growthFactor must be >= 1');
        }
        this.growthFactor = gf;

        const maxDirWords = this.poolStart >>> 2;
        if (maxDirWords < 3) {
            throw new RangeError('MSharedList: poolStart too small for directory');
        }

        this.pool = new MemPool({
            buf: buffer,
            start: this.poolStart,
            skipInitialization: options?.skipInitialization === true,
            ...options?.memPool,
        });
        this.dv = new DataView(buffer);
        this.u8 = new Uint8Array(buffer);
        this.dir = new Uint32Array(buffer, 0, maxDirWords);
        this._shiftScratch = new Uint8Array(itemByteSize);
        this._ownedSharedBacking = options?.ownedSharedBacking;
    }

    /**
     * Allocate a new resizable `SharedArrayBuffer` and construct the list on the main thread.
     * Workers should attach with {@link from} to the **published** buffer; use {@link clone}
     * to build a larger replacement while readers keep the old reference.
     */
    static createShared<T extends ISharedListItemView>(
        itemViewSingleton: T,
        itemByteSize: number,
        options: MSharedListCreateSharedOptions,
    ): MSharedList<T> {
        const { initialByteLength, maxByteLength, ...pass } = options;
        const poolStart = pass.poolStart ?? 65536;
        if (!Number.isInteger(initialByteLength) || initialByteLength < poolStart) {
            throw new RangeError(
                'MSharedList.createShared: initialByteLength must be an integer ≥ poolStart',
            );
        }
        if (!Number.isInteger(maxByteLength) || maxByteLength < initialByteLength) {
            throw new RangeError(
                'MSharedList.createShared: maxByteLength must be an integer ≥ initialByteLength',
            );
        }
        const sab = createGrowableSharedArrayBuffer(initialByteLength, maxByteLength);
        return new MSharedList(sab, itemViewSingleton, itemByteSize, {
            ...pass,
            poolStart,
            ownedSharedBacking: { initialByteLength, maxByteLength },
        });
    }

    /**
     * Copy the full backing image into a **new** {@link MSharedList} and buffer instance.
     * By default the copy uses the **same** `byteLength` and resizable `maxByteLength` as the source
     * (no implicit growth). Pass {@link MSharedListCloneOptions} to allocate a larger backing store.
     * Workers that still hold the old `SharedArrayBuffer` keep a stable read-only view until you
     * publish the new buffer (e.g. `postMessage`). For in-place growth on the main thread, use
     * {@link growSharedBacking} or rely on auto-grow when {@link createShared} owns the buffer.
     */
    clone(options?: MSharedListCloneOptions): MSharedList<T> {
        const oldBuf = this.buf;
        const oldLen = oldBuf.byteLength;
        const meta = this._ownedSharedBacking;
        const sabMax =
            oldBuf instanceof SharedArrayBuffer ? readSharedArrayBufferMaxByteLength(oldBuf) : undefined;
        const oldMax = meta?.maxByteLength ?? sabMax ?? oldLen;

        const newLen = options?.newByteLength ?? oldLen;
        if (!Number.isInteger(newLen) || newLen < oldLen) {
            throw new RangeError('MSharedList.clone: newByteLength must be an integer ≥ current byteLength');
        }

        let newMax = options?.newMaxByteLength ?? oldMax;
        if (!Number.isInteger(newMax) || newMax < newLen) {
            throw new RangeError('MSharedList.clone: newMaxByteLength must be an integer ≥ newByteLength');
        }

        const src = new Uint8Array(oldBuf, 0, oldLen);
        let nextBuf: ArrayBufferLike;
        if (oldBuf instanceof SharedArrayBuffer) {
            nextBuf = createGrowableSharedArrayBuffer(newLen, newMax);
        } else {
            nextBuf = new ArrayBuffer(newLen);
            newMax = newLen;
        }
        new Uint8Array(nextBuf, 0, oldLen).set(src);
        setMemPoolEndByte(nextBuf, this.poolStart, newLen);

        const initialForMeta = meta?.initialByteLength ?? newLen;
        const nextOpts: MSharedListOptions = {
            poolStart: this.poolStart,
            skipInitialization: true,
            defaultListCapacity: this.defaultListCapacity,
            growthFactor: this.growthFactor,
        };
        if (nextBuf instanceof SharedArrayBuffer) {
            nextOpts.ownedSharedBacking = { initialByteLength: initialForMeta, maxByteLength: newMax };
        }
        return new MSharedList(nextBuf, this.singleton, this.itemByteSize, nextOpts);
    }

    /**
     * In-place `SharedArrayBuffer.prototype.grow` on the **same** buffer reference (same
     * {@link MSharedList} instance). Only for buffers allocated via {@link createShared} on the
     * main thread. Updates the malloc arena `end` and rebuilds the {@link MemPool} view.
     */
    growSharedBacking(targetByteLength: number): void {
        if (!this._ownedSharedBacking) {
            throw new RangeError(
                'MSharedList.growSharedBacking: only supported for buffers created with createShared',
            );
        }
        const sab = this.sharedArrayBuffer;
        if (!sab) {
            throw new RangeError('MSharedList.growSharedBacking: backing buffer is not a SharedArrayBuffer');
        }
        const grow = (sab as { grow?: (n: number) => void }).grow;
        if (typeof grow !== 'function') {
            throw new RangeError('MSharedList.growSharedBacking: SharedArrayBuffer is not growable');
        }
        const cur = sab.byteLength;
        if (!Number.isInteger(targetByteLength) || targetByteLength <= cur) {
            throw new RangeError('MSharedList.growSharedBacking: targetByteLength must be an integer > current length');
        }
        const maxB = readSharedArrayBufferMaxByteLength(sab);
        if (maxB !== undefined && targetByteLength > maxB) {
            throw new RangeError(
                `MSharedList.growSharedBacking: targetByteLength ${targetByteLength} exceeds maxByteLength ${maxB}`,
            );
        }
        grow.call(sab, targetByteLength);
        setMemPoolEndByte(sab, this.poolStart, sab.byteLength);
        this._rebindPoolAndViewsAfterGrow();
    }

    /** Current backing buffer when it is a `SharedArrayBuffer`; otherwise `undefined`. */
    get sharedArrayBuffer(): SharedArrayBuffer | undefined {
        return this.buf instanceof SharedArrayBuffer ? this.buf : undefined;
    }

    /**
     * Attach to an existing buffer (e.g. a worker after `postMessage` transfer or
     * a shared `SharedArrayBuffer`). Does **not** initialize {@link MemPool}; the
     * owner thread must have constructed {@link MSharedList} on the same buffer
     * first. Pass the same `itemByteSize` and `poolStart` (and any `memPool.end`
     * overrides) as the owner.
     */
    static from<T extends ISharedListItemView>(
        buffer: ArrayBufferLike,
        itemViewSingleton: T,
        itemByteSize: number,
        options?: Omit<MSharedListOptions, 'skipInitialization'>,
    ): MSharedList<T> {
        const poolStart = options?.poolStart ?? 65536;
        if (buffer.byteLength < poolStart) {
            throw new RangeError('MSharedList.from: buffer.byteLength must be >= poolStart');
        }
        return new MSharedList(buffer, itemViewSingleton, itemByteSize, {
            ...options,
            skipInitialization: true,
        });
    }

    /** Backing buffer (same reference passed to the constructor). */
    get buffer(): ArrayBufferLike {
        return this.buf;
    }

    /** Underlying allocator; state lives in `buffer` from `poolStart`. */
    get memPool(): MemPool {
        return this.pool;
    }

    /** Next list id that {@link createList} will assign (also the current count of created lists). */
    get nextListId(): number {
        return this.dir[DIR_NEXT_ID] >>> 0;
    }

    /**
     * Allocate a new list with given initial capacity (default 10). Length starts at 0.
     * @returns Opaque 32-bit list index.
     */
    createList(initialCapacity: number = this.defaultListCapacity): number {
        if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
            throw new RangeError('MSharedList.createList: initialCapacity must be a positive integer');
        }
        const id = this.dir[DIR_NEXT_ID] >>> 0;
        const maxId = (this.poolStart >>> 2) - 2;
        if (id > maxId) {
            throw new RangeError('MSharedList.createList: directory full (increase poolStart)');
        }
        const bytes = LIST_HDR_BYTES + initialCapacity * this.itemByteSize;
        let ptr = this.pool.malloc(bytes);
        if (!ptr && this._tryAutoGrowSharedBacking()) {
            ptr = this.pool.malloc(bytes);
        }
        if (!ptr) {
            throw new RangeError('MSharedList.createList: malloc failed (out of memory)');
        }
        this.dv.setUint32(ptr, 0, true);
        this.dv.setUint32(ptr + 4, initialCapacity >>> 0, true);
        this.dir[1 + id] = ptr >>> 0;
        this.dir[DIR_NEXT_ID] = (id + 1) >>> 0;
        return id >>> 0;
    }

    /** Release list storage back to the pool. The index must not be used afterward. */
    destroyList(listIndex: number): void {
        const ptr = this._listPtrOrThrow(listIndex);
        this.pool.free(ptr);
        this.dir[1 + (listIndex >>> 0)] = 0;
    }

    length(listIndex: number): number {
        const ptr = this._listPtrOrThrow(listIndex);
        return this.dv.getUint32(ptr, true);
    }

    capacity(listIndex: number): number {
        const ptr = this._listPtrOrThrow(listIndex);
        return this.dv.getUint32(ptr + 4, true);
    }

    /** Truncate; does not shrink allocated capacity. */
    clear(listIndex: number): void {
        const ptr = this._listPtrOrThrow(listIndex);
        this.dv.setUint32(ptr, 0, true);
    }

    /**
     * Bind {@link singleton} to the item at `itemIndex` and return it.
     */
    getItem(listIndex: number, itemIndex: number): T {
        const ptr = this._listPtrOrThrow(listIndex);
        const len = this.dv.getUint32(ptr, true);
        if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= len) {
            throw new RangeError('MSharedList.getItem: itemIndex out of range');
        }
        const off = ptr + LIST_HDR_BYTES + itemIndex * this.itemByteSize;
        this.singleton.attachAt(this.buf, off, this.itemByteSize, itemIndex, len);
        return this.singleton;
    }

    /** Yields the same singleton instance each step, rebound via {@link ISharedListItemView.attachAt}. */
    *items(listIndex: number): Generator<T, void, undefined> {
        const n = this.length(listIndex);
        for (let i = 0; i < n; i++) {
            yield this.getItem(listIndex, i);
        }
    }


    /**
     * Append a row. `item.bytes` must match {@link itemByteSize}; avoid mutating
     * `item` while it is still bound to a live list slot via {@link getItem}.
     */
    push(listIndex: number, item: ISharedListItemView): void {
        const ptr = this._listPtrOrThrow(listIndex);
        let len = this.dv.getUint32(ptr, true);
        let cap = this.dv.getUint32(ptr + 4, true);
        if (len >= cap) {
            const newCap = this._growCapacity(cap, len + 1);
            this._reallocListBlock(listIndex, newCap);
        }
        const p2 = this.dir[1 + (listIndex >>> 0)] >>> 0;
        const dstOff = p2 + LIST_HDR_BYTES + len * this.itemByteSize;
        this._copyBytes(item.bytes, dstOff);
        this.dv.setUint32(p2, len + 1, true);
    }

    pop(listIndex: number): T | undefined {
        const ptr = this._listPtrOrThrow(listIndex);
        const len = this.dv.getUint32(ptr, true);
        if (len === 0) return undefined;
        const last = len - 1;
        const out = this.getItem(listIndex, last);
        this.dv.setUint32(ptr, last, true);
        return out;
    }

    /**
     * Remove index 0. The row is copied into an internal scratch buffer, then the
     * singleton is {@link ISharedListItemView.attachAt} there so it stays valid after
     * the list body moves; the next {@link getItem} / {@link items} rebinds to shared storage.
     */
    shift(listIndex: number): T | undefined {
        const ptr = this._listPtrOrThrow(listIndex);
        const len = this.dv.getUint32(ptr, true);
        if (len === 0) return undefined;
        const base = ptr + LIST_HDR_BYTES;
        this._copyU8ToScratch(this._shiftScratch, base, this.itemByteSize);
        this.singleton.attachAt(
            this._shiftScratch.buffer,
            this._shiftScratch.byteOffset,
            this.itemByteSize,
            0,
            1,
        );
        const span = (len - 1) * this.itemByteSize;
        if (span > 0) {
            this.u8.copyWithin(base, base + this.itemByteSize, base + this.itemByteSize + span);
        }
        this.dv.setUint32(ptr, len - 1, true);
        return this.singleton;
    }

    /** Prepend a row (same `item.bytes` constraints as {@link push}). */
    unshift(listIndex: number, item: ISharedListItemView): void {
        const ptr = this._listPtrOrThrow(listIndex);
        let len = this.dv.getUint32(ptr, true);
        let cap = this.dv.getUint32(ptr + 4, true);
        if (len >= cap) {
            const newCap = this._growCapacity(cap, len + 1);
            this._reallocListBlock(listIndex, newCap);
        }
        const p2 = this.dir[1 + (listIndex >>> 0)] >>> 0;
        const base = p2 + LIST_HDR_BYTES;
        for (let i = len; i > 0; i--) {
            const from = base + (i - 1) * this.itemByteSize;
            const to = base + i * this.itemByteSize;
            this.u8.copyWithin(to, from, from + this.itemByteSize);
        }
        this._copyBytes(item.bytes, base);
        this.dv.setUint32(p2, len + 1, true);
    }

    /**
     * Remove `deleteCount` items at `start`, optionally insert `insertItems` in place.
     * @returns Number of elements removed.
     */
    splice(
        listIndex: number,
        start: number,
        deleteCount: number,
        ...insertItems: ISharedListItemView[]
    ): number {
        const ptr = this._listPtrOrThrow(listIndex);
        let len = this.dv.getUint32(ptr, true);
        if (!Number.isInteger(start)) start = 0;
        if (start < 0) start = Math.max(0, len + start);
        if (start > len) start = len;
        if (!Number.isInteger(deleteCount) || deleteCount < 0) {
            throw new RangeError('MSharedList.splice: deleteCount must be a non-negative integer');
        }
        const del = Math.min(deleteCount, len - start);
        const ins = insertItems.length;
        const newLen = len - del + ins;

        let cap = this.dv.getUint32(ptr + 4, true);
        if (newLen > cap) {
            const newCap = this._growCapacity(cap, newLen);
            this._reallocListBlock(listIndex, newCap);
        }
        const p2 = this.dir[1 + (listIndex >>> 0)] >>> 0;
        const base = p2 + LIST_HDR_BYTES;
        const tailFrom = start + del;
        const tailLen = len - tailFrom;
        const tailBytes = tailLen * this.itemByteSize;
        const insertBytes = ins * this.itemByteSize;
        const gapStart = base + start * this.itemByteSize;
        const gapEnd = gapStart + insertBytes;

        if (tailBytes > 0) {
            this.u8.copyWithin(gapEnd, base + tailFrom * this.itemByteSize, base + len * this.itemByteSize);
        }
        let w = gapStart;
        for (const it of insertItems) {
            this._copyBytes(it.bytes, w);
            w += this.itemByteSize;
        }
        this.dv.setUint32(p2, newLen, true);
        return del;
    }

    /**
     * Copy the range `[begin, end)` into a new list (like `Array.prototype.slice`).
     * @returns New list index.
     */
    sliceList(listIndex: number, begin = 0, end?: number): number {
        const len = this.length(listIndex);
        const e = end === undefined ? len : end;
        let b = begin < 0 ? Math.max(0, len + begin) : Math.min(begin, len);
        let e2 = e < 0 ? Math.max(0, len + e) : Math.min(e, len);
        if (b > e2) {
            const t = b;
            b = e2;
            e2 = t;
        }
        const n = e2 - b;
        const nid = this.createList(Math.max(n, this.defaultListCapacity));
        if (n === 0) return nid >>> 0;
        const srcPtr = this._listPtrOrThrow(listIndex);
        const dstPtr = this.dir[1 + nid] >>> 0;
        const srcOff = srcPtr + LIST_HDR_BYTES + b * this.itemByteSize;
        const byteCount = n * this.itemByteSize;
        this.u8.copyWithin(dstPtr + LIST_HDR_BYTES, srcOff, srcOff + byteCount);
        this.dv.setUint32(dstPtr, n, true);
        return nid >>> 0;
    }

    /** Copy items from `sourceList` into a new list; returns the new list index. */
    copyList(sourceListIndex: number): number {
        const srcPtr = this._listPtrOrThrow(sourceListIndex);
        const len = this.dv.getUint32(srcPtr, true);
        const cap = this.dv.getUint32(srcPtr + 4, true);
        const nid = this.createList(Math.max(len, this.defaultListCapacity, cap));
        if (len === 0) return nid;
        const dstPtr = this.dir[1 + nid] >>> 0;
        const nBytes = len * this.itemByteSize;
        const src0 = srcPtr + LIST_HDR_BYTES;
        this.u8.copyWithin(dstPtr + LIST_HDR_BYTES, src0, src0 + nBytes);
        this.dv.setUint32(dstPtr, len, true);
        return nid >>> 0;
    }

    private _listPtrOrThrow(listIndex: number): number {
        const ptr = this.dir[1 + (listIndex >>> 0)] >>> 0;
        if (ptr === 0) {
            throw new RangeError('MSharedList: unknown or destroyed listIndex');
        }
        return ptr;
    }

    private _growCapacity(cap: number, minNeeded: number): number {
        let c = cap;
        while (c < minNeeded) {
            const step = Math.max(1, Math.ceil(c * this.growthFactor));
            c = Math.max(c + 1, step);
        }
        return c >>> 0;
    }

    private _reallocListBlock(listIndex: number, newCapacity: number): void {
        const id = listIndex >>> 0;
        const oldPtr = this.dir[1 + id] >>> 0;
        const newBytes = LIST_HDR_BYTES + newCapacity * this.itemByteSize;
        let newPtr = this.pool.realloc(oldPtr, newBytes);
        if (!newPtr && this._tryAutoGrowSharedBacking()) {
            newPtr = this.pool.realloc(oldPtr, newBytes);
        }
        if (!newPtr) {
            throw new RangeError('MSharedList: realloc failed (out of memory)');
        }
        this.dv.setUint32(newPtr + 4, newCapacity >>> 0, true);
        this.dir[1 + id] = newPtr >>> 0;
    }

    private _copyBytes(src: Uint8Array<ArrayBufferLike>, dstByteOffset: number): void {
        if (src.byteLength !== this.itemByteSize) {
            throw new RangeError(
                `MSharedList: item bytes length ${src.byteLength} !== itemByteSize ${this.itemByteSize}`,
            );
        }
        this.u8.set(src, dstByteOffset);
    }

    /** Copy from {@link u8} at `srcOff` into `dst` (separate buffer); no `subarray`. */
    private _copyU8ToScratch(dst: Uint8Array, srcOff: number, byteCount: number): void {
        const src = this.u8;
        for (let i = 0; i < byteCount; i++) {
            dst[i] = src[srcOff + i];
        }
    }

    /** One doubling step (or up to `maxByteLength`) for owned growable SABs when malloc/realloc OOM. */
    private _tryAutoGrowSharedBacking(): boolean {
        if (!this._ownedSharedBacking) {
            return false;
        }
        return this._growSharedBackingOneStep();
    }

    private _growSharedBackingOneStep(): boolean {
        const sab = this.sharedArrayBuffer;
        if (!sab) {
            return false;
        }
        const grow = (sab as { grow?: (n: number) => void }).grow;
        if (typeof grow !== 'function') {
            return false;
        }
        const maxB = readSharedArrayBufferMaxByteLength(sab);
        if (maxB === undefined || maxB <= sab.byteLength) {
            return false;
        }
        const cur = sab.byteLength;
        const next = Math.min(maxB, Math.max(cur + 1, cur * 2));
        if (next <= cur) {
            return false;
        }
        grow.call(sab, next);
        setMemPoolEndByte(sab, this.poolStart, sab.byteLength);
        this._rebindPoolAndViewsAfterGrow();
        return true;
    }

    private _rebindPoolAndViewsAfterGrow(): void {
        this.dv = new DataView(this.buf);
        this.u8 = new Uint8Array(this.buf);
        this.pool = new MemPool({
            buf: this.buf,
            start: this.poolStart,
            skipInitialization: true,
        });
    }
}
