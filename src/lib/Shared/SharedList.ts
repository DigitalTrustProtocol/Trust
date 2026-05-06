import { SharedListItemView, type ISharedListItemView } from './SharedListItemView.js';
import SharedMemoryPool from './SharedMemoryPool.js';

export type { ISharedListItemView, SharedListView } from './SharedListItemView.js';
export { SharedListItemView } from './SharedListItemView.js';

const HDR_WORDS = 3;
const OFF_HDR = 4;
const SHARED_LIST_POOL_START = 64;
const CTRL_LIST_PTR = 1; // u32[1] at byte offset 4

const H = {
    count: 0,
    capacity: 1,
    itemBytes: 2,
} as const;

function align4(n: number): number {
    return (n + 3) & ~3;
}

function layoutOffsets(capacity: number, itemBytes: number) {
    const dataByteOffset = align4(OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT);
    const totalBytes = dataByteOffset + capacity * itemBytes;
    return { dataByteOffset, totalBytes };
}

function readSharedArrayBufferMaxByteLength(sab: SharedArrayBuffer): number | undefined {
    const m = (sab as { maxByteLength?: number }).maxByteLength;
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
}

export interface SharedListOptions {
    /** When full, new capacity is at least `ceil(capacity * growthFactor)` in steps until `minNeeded` fits. @defaultValue 2 */
    growthFactor?: number;
    /**
     * Set when the backing `SharedArrayBuffer` was allocated by {@link SharedList.createShared}
     * (or a same-sized {@link clone}). Enables {@link growSharedBacking}. Do not set manually.
     */
    ownedSharedBacking?: { initialByteLength: number; maxByteLength: number };
    /** Optional logical growth ceiling (can be < pool page size). */
    logicalMaxByteLength?: number;
    /** Used only by {@link SharedList.createShared} to write the initial header. */
    initFresh?: { initialCapacity: number };
    /** Optional bound view singleton; when omitted, SharedList creates one internally. */
    itemViewSingleton?: ISharedListItemView;
}

/** Options for {@link SharedList.createShared}. */
export interface SharedListCreateSharedOptions extends Omit<SharedListOptions, 'initFresh' | 'ownedSharedBacking'> {
    initialCapacity: number;
    maxByteLength?: number;
}

export interface SharedListConstructorOptions<T extends ISharedListItemView = SharedListItemView> extends SharedListOptions {
    pool: SharedMemoryPool;
    itemByteSize?: number;
    /** Fresh table with this many rows. */
    initFresh?: { initialCapacity: number };
    /** Existing list block pointer in the pool buffer. */
    listPtr?: number;
    itemViewSingleton?: T;
}

export interface SharedListCreateInPoolOptions<T extends ISharedListItemView = SharedListItemView>
    extends Omit<SharedListOptions, 'initFresh' | 'ownedSharedBacking'> {
    initialCapacity: number;
    itemViewSingleton?: T;
}

/** Overrides for {@link SharedList.clone}; omit both for a same-size copy into a new buffer instance. */
export interface SharedListCloneOptions {
    newByteLength?: number;
    newMaxByteLength?: number;
}

export interface SharedListEntry<T extends ISharedListItemView> {
    index: number;
    item: T;
}

/**
 * Fixed-size rows in a {@link SharedArrayBuffer}. Header and payload use plain JS stores — intended
 * for **main-thread-only** mutation while workers (or other views) only read published data.
 */
export default class SharedList<T extends ISharedListItemView = SharedListItemView> {
    public storage!: SharedArrayBuffer;
    private pool!: SharedMemoryPool;
    private listPtr = 0;
    private ctrl!: Uint32Array;
    private hdr!: Uint32Array;
    private data!: Uint8Array;
    private itemByteSize: number;
    private singleton: T;
    private growthFactor: number;
    private _ownedSharedBacking: { initialByteLength: number; maxByteLength: number } | undefined;
    private _logicalMaxByteLength: number | undefined;

    constructor(options: SharedListConstructorOptions<T>) {
        const pool = options.pool;
        const itemByteSize = options.itemByteSize;
        const providedItemByteSize = itemByteSize ?? 0;
        const defaultSingletonItemBytes =
            Number.isInteger(itemByteSize) && (itemByteSize as number) > 0 ? (itemByteSize as number) : 4;
        if (options.listPtr === undefined && (!Number.isInteger(itemByteSize) || providedItemByteSize < 1)) {
            throw new RangeError('SharedList: itemByteSize must be a positive integer');
        }
        const storage = pool.sharedArrayBuffer;
        this.storage = storage;
        this.ctrl = new Uint32Array(storage, 0, SHARED_LIST_POOL_START >>> 2);
        this.singleton =
            (options?.itemViewSingleton as T | undefined) ??
            (new SharedListItemView(defaultSingletonItemBytes) as unknown as T);
        this.itemByteSize = defaultSingletonItemBytes;
        this.growthFactor = options?.growthFactor ?? 2;
        if (!Number.isFinite(this.growthFactor) || this.growthFactor < 1) {
            throw new RangeError('SharedList: growthFactor must be >= 1');
        }
        this._ownedSharedBacking = options?.ownedSharedBacking;
        this._logicalMaxByteLength = options?.logicalMaxByteLength;
        this.pool = pool;

        if (options?.initFresh) {
            this.pool.freeAll();
            const initialCapacity = options.initFresh.initialCapacity;
            if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
                throw new RangeError('SharedList: initFresh.initialCapacity must be a positive integer');
            }
            const ib = itemByteSize as number;
            const need = layoutOffsets(initialCapacity, ib).totalBytes;
            let ptr = this.pool.malloc(need);
            if (!ptr && this._tryAutoGrowSharedBacking()) {
                ptr = this.pool.malloc(need);
            }
            if (!ptr) throw new RangeError('SharedList: malloc failed for initFresh layout');
            this.listPtr = ptr >>> 0;
            this.ctrl[CTRL_LIST_PTR] = this.listPtr;
            this.hdr = new Uint32Array(storage, this.listPtr, HDR_WORDS);
            this.hdr[H.count] = 0;
            this.hdr[H.capacity] = initialCapacity >>> 0;
            this.hdr[H.itemBytes] = ib >>> 0;
        } else {
            this.listPtr =
                options.listPtr !== undefined ? (options.listPtr >>> 0) : (this.ctrl[CTRL_LIST_PTR] >>> 0);
            if (this.listPtr === 0) throw new RangeError('SharedList: missing list pointer in control area');
            this.hdr = new Uint32Array(storage, this.listPtr, HDR_WORDS);
            const count = this.hdr[H.count] >>> 0;
            const capacity = this.hdr[H.capacity] >>> 0;
            const ib = this.hdr[H.itemBytes] >>> 0;
            if (options.listPtr === undefined && ib !== ((itemByteSize as number) >>> 0)) {
                throw new RangeError(`SharedList: itemByteSize ${itemByteSize} does not match header (${ib})`);
            }
            if (capacity < 1 || ib < 1 || count > capacity) {
                throw new RangeError('SharedList: invalid header');
            }
            this.itemByteSize = ib;
            if (!options.itemViewSingleton) {
                this.singleton = new SharedListItemView(ib) as unknown as T;
            }
            const need = layoutOffsets(capacity, ib).totalBytes;
            if (this.listPtr + need > storage.byteLength) {
                throw new RangeError('SharedList: list layout exceeds buffer byteLength');
            }
        }
        this._rebindData();
    }

    /**
     * Allocate a new resizable `SharedArrayBuffer` and construct the list on the main thread.
     * Workers attach with {@link SharedList.from} to the published buffer; use {@link clone}
     * to build a larger replacement while readers keep the old reference.
     */
    static createShared<T extends ISharedListItemView>(
        itemByteSize: number,
        options: SharedListCreateSharedOptions,
    ): SharedList<T> {
        const { initialCapacity, maxByteLength, growthFactor, ...rest } = options;
        if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
            throw new RangeError('SharedList.createShared: initialCapacity must be a positive integer');
        }
        const layout0 = layoutOffsets(initialCapacity, itemByteSize);
        const minMax = Math.max(layout0.totalBytes * 4, layout0.totalBytes + 4096);
        const maxB = Math.max(maxByteLength ?? minMax, layout0.totalBytes);
        if (!Number.isInteger(maxB) || maxB < layout0.totalBytes) {
            throw new RangeError('SharedList.createShared: maxByteLength must be an integer ≥ layout size');
        }
        const initialByteLength = Math.max(SHARED_LIST_POOL_START + layout0.totalBytes + 64, SHARED_LIST_POOL_START + 64);
        const poolMax = Math.max(SHARED_LIST_POOL_START + 64, maxB, 64);
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: poolMax,
            fractionOfAvailable: 1,
            minMaxByteLength: 64,
            maxMaxByteLength: poolMax,
            initialByteLength,
            start: SHARED_LIST_POOL_START,
        });
        return new SharedList<T>({
            pool,
            itemByteSize,
            ...rest,
            itemViewSingleton: rest.itemViewSingleton as T | undefined,
            growthFactor,
            ownedSharedBacking: { initialByteLength, maxByteLength: maxB },
            logicalMaxByteLength: maxByteLength,
            initFresh: { initialCapacity },
        });
    }

    static createInPool<T extends ISharedListItemView = SharedListItemView>(
        pool: SharedMemoryPool,
        itemByteSize: number,
        options: SharedListCreateInPoolOptions<T>,
    ): SharedList<T> {
        const { initialCapacity, ...rest } = options;
        return new SharedList<T>({
            pool,
            itemByteSize,
            ...rest,
            initFresh: { initialCapacity },
        });
    }

    /**
     * Attach to an existing buffer (e.g. a worker after `postMessage` of the same `SharedArrayBuffer`).
     * The owner thread must have initialized the buffer (e.g. via {@link createShared}).
     */
    static from<T extends ISharedListItemView>(
        pool: SharedMemoryPool,
        listPtr: number,
    ): SharedList<T> {
        return new SharedList<T>({
            pool,
            itemByteSize: 1,
            listPtr,
        });
    }

    /**
     * Copy the full backing image into a **new** {@link SharedList} and buffer instance.
     * By default the copy uses the same `byteLength` and resizable `maxByteLength` as the source.
     */
    clone(options?: SharedListCloneOptions): SharedList<T> {
        const oldBuf = this.storage;
        const oldLen = oldBuf.byteLength;
        const oldMax = readSharedArrayBufferMaxByteLength(oldBuf) ?? oldLen;
        const newLen = options?.newByteLength ?? oldLen;
        if (!Number.isInteger(newLen) || newLen < oldLen) {
            throw new RangeError('SharedList.clone: newByteLength must be an integer ≥ current byteLength');
        }
        const newMax = options?.newMaxByteLength ?? oldMax;
        if (!Number.isInteger(newMax) || newMax < newLen) {
            throw new RangeError('SharedList.clone: newMaxByteLength must be an integer ≥ newByteLength');
        }
        const pool = new SharedMemoryPool({
            estimatedAvailableBytes: newMax,
            fractionOfAvailable: 1,
            minMaxByteLength: 64,
            maxMaxByteLength: newMax,
            initialByteLength: newLen,
            start: SHARED_LIST_POOL_START,
        });
        const nextBuf = pool.sharedArrayBuffer;
        new Uint8Array(nextBuf, 0, oldLen).set(new Uint8Array(oldBuf, 0, oldLen));
        const cloned = SharedList.from<T>(
            SharedMemoryPool.from(nextBuf, { start: SHARED_LIST_POOL_START }),
            new Uint32Array(nextBuf, 0, SHARED_LIST_POOL_START >>> 2)[CTRL_LIST_PTR] >>> 0,
        );
        cloned._logicalMaxByteLength = this._logicalMaxByteLength;
        return cloned;
    }

    /**
     * In-place `SharedArrayBuffer.prototype.grow` on the same buffer reference. Only for buffers
     * allocated via {@link createShared} (or {@link clone} with owned metadata).
     */
    growSharedBacking(targetByteLength: number): void {
        if (this._logicalMaxByteLength !== undefined && targetByteLength > this._logicalMaxByteLength) {
            throw new RangeError(
                `SharedList.growSharedBacking: targetByteLength ${targetByteLength} exceeds maxByteLength ${this._logicalMaxByteLength}`,
            );
        }
        this.pool.growSharedBacking(targetByteLength);
        this.storage = this.pool.sharedArrayBuffer;
        this.ctrl = new Uint32Array(this.storage, 0, SHARED_LIST_POOL_START >>> 2);
        this.listPtr = this.ctrl[CTRL_LIST_PTR] >>> 0;
        this.hdr = new Uint32Array(this.storage, this.listPtr, HDR_WORDS);
        this._rebindData();
    }

    get buffer(): SharedArrayBuffer {
        return this.storage;
    }

    get length(): number {
        return this.hdr[H.count] >>> 0;
    }

    get capacity(): number {
        return this.hdr[H.capacity] >>> 0;
    }

    get itemBytes(): number {
        return this.itemByteSize;
    }

    private _dataByteOffset(): number {
        return layoutOffsets(this.capacity, this.itemByteSize).dataByteOffset;
    }

    /**
     * Refresh the row {@link Uint8Array} view from the current header (e.g. after another handle
     * grew {@link capacity} on the same {@link storage}).
     */
    rebind(): void {
        this._rebindData();
    }

    /** @param listLength — When set (e.g. snapshot in {@link unsafeIterateItems}), passed to {@link ISharedListItemView.attachAt} instead of the live length. */
    private _bindSingleton(index: number, listLength?: number): T {
        const count = listLength ?? (this.hdr[H.count] >>> 0);
        const off = this.listPtr + this._dataByteOffset() + index * this.itemByteSize;
        this.singleton.attachAt(this.storage, off, this.itemByteSize, index, count);
        return this.singleton;
    }

    add(item: ISharedListItemView): number {
        return this.push(item.bytes);
    }

    /**
     * Copy `source` into {@link storage} at `byteOffset`, growing the buffer when the write would extend past `byteLength`.
     * Prefer offsets that do not overlap the list header or active row region unless you manage layout yourself.
     *
     * @returns Byte offset immediately after the written range (next append cursor).
     */
    appendBuffer(byteOffset: number, source: Uint8Array<ArrayBufferLike>): number {
        if (!Number.isInteger(byteOffset) || byteOffset < 0) {
            throw new RangeError('SharedList.appendBuffer: byteOffset must be a non-negative integer');
        }
        const end = byteOffset + source.byteLength;
        if (this._logicalMaxByteLength !== undefined && end > this._logicalMaxByteLength) {
            throw new RangeError(`SharedList.appendBuffer: need ${end} bytes but maxByteLength is ${this._logicalMaxByteLength}`);
        }
        if (end > this.storage.byteLength) {
            this.growSharedBacking(end);
        }
        new Uint8Array(this.storage).set(source, byteOffset);
        return end;
    }

    push(bytes: Uint8Array<ArrayBufferLike>): number {
        if (bytes.length !== this.itemByteSize) {
            throw new RangeError(`SharedList: payload must be exactly ${this.itemByteSize} bytes`);
        }
        let count = this.hdr[H.count] >>> 0;
        if (count >= this.capacity) {
            this._growCapacity(this._nextCapacity(this.capacity, count + 1));
            count = this.hdr[H.count] >>> 0;
        }
        const offset = count * this.itemByteSize;
        this.data.set(bytes, offset);
        this.hdr[H.count] = count + 1;
        return count;
    }

    delete(index: number): void {
        if (!Number.isInteger(index) || index < 0) {
            throw new RangeError('SharedList: index must be a non-negative integer');
        }
        const count = this.hdr[H.count] >>> 0;
        if (index >= count) {
            throw new RangeError('SharedList: index out of range');
        }
        const last = count - 1;
        if (index !== last) {
            const src = last * this.itemByteSize;
            const dst = index * this.itemByteSize;
            this.data.copyWithin(dst, src, src + this.itemByteSize);
        }
        this.hdr[H.count] = last;
    }

    readAt(index: number): Uint8Array | undefined {
        const count = this.hdr[H.count] >>> 0;
        if (index >= count) {
            return undefined;
        }
        const offset = index * this.itemByteSize;
        return this.data.subarray(offset, offset + this.itemByteSize);
    }

    /** @deprecated Alias of {@link readAt} (same implementation; kept for call-site clarity). */
    unsafeReadAt(index: number): Uint8Array | undefined {
        return this.readAt(index);
    }

    get(index: number): T | undefined {
        return this.itemAt(index);
    }

    itemAt(index: number): T | undefined {
        const bytes = this.readAt(index);
        if (bytes === undefined) {
            return undefined;
        }
        const count = this.length;
        this.singleton.attachAt(this.storage, bytes.byteOffset, this.itemByteSize, index, count);
        return this.singleton;
    }

    /** @deprecated Alias of {@link itemAt}. */
    unsafeItemAt(index: number): T | undefined {
        return this.itemAt(index);
    }

    *iterateItems(): Generator<SharedListEntry<T>, void, undefined> {
        const count = this.hdr[H.count] >>> 0;
        for (let i = 0; i < count; i++) {
            yield { index: i, item: this._bindSingleton(i, count) };
        }
    }

    /** @deprecated Alias of {@link iterateItems}. */
    *unsafeIterateItems(): Generator<SharedListEntry<T>, void, undefined> {
        yield* this.iterateItems();
    }

    clear(): void {
        this.hdr[H.count] = 0;
    }

    private _nextCapacity(cap: number, minNeeded: number): number {
        let c = cap;
        const gf = this.growthFactor;
        while (c < minNeeded) {
            const step = Math.max(1, Math.ceil(c * gf));
            c = Math.max(c + 1, step);
        }
        return c >>> 0;
    }

    private _growCapacity(newCapacity: number): void {
        const itemBytes = this.hdr[H.itemBytes] >>> 0;
        const oldLayout = layoutOffsets(this.capacity, itemBytes);
        const newLayout = layoutOffsets(newCapacity, itemBytes);
        const newBytes = newLayout.totalBytes;
        if (this._logicalMaxByteLength !== undefined && newBytes > this._logicalMaxByteLength) {
            throw new RangeError('SharedList: maxByteLength exceeded while growing');
        }
        let newPtr = this.pool.realloc(this.listPtr, newBytes);
        if (!newPtr && this._tryAutoGrowSharedBacking()) {
            newPtr = this.pool.realloc(this.listPtr, newBytes);
        }
        if (!newPtr) throw new RangeError('SharedList: realloc failed while growing');
        this.listPtr = newPtr >>> 0;
        this.ctrl[CTRL_LIST_PTR] = this.listPtr;
        this.hdr = new Uint32Array(this.storage, this.listPtr, HDR_WORDS);
        this.hdr[H.capacity] = newCapacity >>> 0;
        this._rebindData();
        void oldLayout;
    }

    private _rebindData(): void {
        const l = layoutOffsets(this.capacity, this.itemByteSize);
        this.data = new Uint8Array(this.storage, this.listPtr + l.dataByteOffset, this.capacity * this.itemByteSize);
    }

    private _tryAutoGrowSharedBacking(): boolean {
        const sab = this.pool.sharedArrayBuffer;
        const maxB = readSharedArrayBufferMaxByteLength(sab);
        if (!maxB || maxB <= sab.byteLength) return false;
        const next = Math.min(maxB, Math.max(sab.byteLength + 1, sab.byteLength * 2));
        if (next <= sab.byteLength) return false;
        this.pool.growSharedBacking(next);
        this.storage = this.pool.sharedArrayBuffer;
        this.ctrl = new Uint32Array(this.storage, 0, SHARED_LIST_POOL_START >>> 2);
        this.listPtr = this.ctrl[CTRL_LIST_PTR] >>> 0;
        this.hdr = new Uint32Array(this.storage, this.listPtr, HDR_WORDS);
        this._rebindData();
        return true;
    }
}

/** Byte offset of payload after the 8-byte header (count + capacity as u32). */
const U8R_DATA_OFFSET = 8;
const U8R_CTRL_PTR = 2; // u32[2] at byte offset 8

const U8R_H = {
    count: 0,
    capacity: 1,
} as const;

function u8rTotalBytes(capacity: number): number {
    return U8R_DATA_OFFSET + capacity;
}

/**
 * Build a {@link SharedArrayBuffer} holding a {@link Uint8SharedList} layout: `count`, `capacity`, then `capacity` byte slots (first `count` used).
 * Each value is coerced with `value & 0xff`. Use only while readers are not relying on a stable snapshot, then publish `count` last if needed.
 */
export function buildUint8SharedListStorage(
    capacity: number,
    values: readonly number[],
    options?: { maxByteLength?: number },
): SharedArrayBuffer {
    if (!Number.isInteger(capacity) || capacity < 1) {
        throw new RangeError('buildUint8SharedListStorage: capacity must be a positive integer');
    }
    const count = values.length;
    if (count > capacity) {
        throw new RangeError('buildUint8SharedListStorage: more values than capacity');
    }
    const total = u8rTotalBytes(capacity);
    const minMax = Math.max(total * 4, total + 4096);
    const logicalMax = Math.max(options?.maxByteLength ?? minMax, total);
    const poolMax = Math.max(SHARED_LIST_POOL_START + 64, logicalMax, 64);
    const initialByteLength = Math.max(SHARED_LIST_POOL_START + total + 64, SHARED_LIST_POOL_START + 64);
    const pool = new SharedMemoryPool({
        estimatedAvailableBytes: poolMax,
        fractionOfAvailable: 1,
        minMaxByteLength: 64,
        maxMaxByteLength: poolMax,
        initialByteLength,
        start: SHARED_LIST_POOL_START,
    });
    const storage = pool.sharedArrayBuffer;
    pool.freeAll();
    let ptr = pool.malloc(total);
    if (!ptr) {
        pool.growSharedBacking(Math.max(storage.byteLength + 64, SHARED_LIST_POOL_START + total + 64));
        ptr = pool.malloc(total);
    }
    if (!ptr) {
        throw new RangeError('buildUint8SharedListStorage: malloc failed');
    }
    const ctrl = new Uint32Array(storage, 0, SHARED_LIST_POOL_START >>> 2);
    ctrl[U8R_CTRL_PTR] = ptr >>> 0;
    const hdr = new Uint32Array(storage, (ptr >>> 0), 2);
    hdr[U8R_H.count] = count >>> 0;
    hdr[U8R_H.capacity] = capacity >>> 0;
    const data = new Uint8Array(storage, (ptr >>> 0) + U8R_DATA_OFFSET, capacity);
    for (let i = 0; i < count; i++) {
        data[i] = values[i]! & 0xff;
    }
    return storage;
}

/**
 * Dense list of bytes in a {@link SharedArrayBuffer}, exposed as numbers `0..255` via {@link get}.
 * Plain header loads/stores; {@link push} is for a single writer (e.g. main thread) while readers treat the list as frozen or accept relaxed visibility.
 *
 * Layout: bytes `0..3` = `count` (u32 LE), `4..7` = `capacity` (u32 LE), byte index `i` payload at `8 + i`.
 */
export class Uint8SharedList {
    public storage!: SharedArrayBuffer;
    private pool!: SharedMemoryPool;
    private ctrl!: Uint32Array;
    private listPtr = 0;
    private logicalMaxByteLength: number | undefined;
    private hdr!: Uint32Array;
    public bytes!: Uint8Array;

    constructor(initialCapacity: number, options?: { maxByteLength?: number }) {
        if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
            throw new RangeError('Uint8SharedList: initialCapacity must be a positive integer');
        }
        this.storage = buildUint8SharedListStorage(initialCapacity, [], options);
        this.pool = SharedMemoryPool.from(this.storage, { start: SHARED_LIST_POOL_START });
        this.ctrl = new Uint32Array(this.storage, 0, SHARED_LIST_POOL_START >>> 2);
        this.listPtr = this.ctrl[U8R_CTRL_PTR] >>> 0;
        this.logicalMaxByteLength = options?.maxByteLength;
        this.hdr = new Uint32Array(this.storage, this.listPtr, 2);
        this._rebindBytes();
    }

    static from(storage: SharedArrayBuffer): Uint8SharedList {
        if (storage.byteLength < U8R_DATA_OFFSET + 1) {
            throw new RangeError('Uint8SharedList.from: buffer too small');
        }
        const ctrl = new Uint32Array(storage, 0, Math.max(2, SHARED_LIST_POOL_START >>> 2));
        const ptr = ctrl.length > U8R_CTRL_PTR ? (ctrl[U8R_CTRL_PTR] >>> 0) : 0;
        const hdr = new Uint32Array(storage, ptr !== 0 ? ptr : 0, 2);
        const count = hdr[U8R_H.count] >>> 0;
        const capacity = hdr[U8R_H.capacity] >>> 0;
        if (capacity < 1 || count > capacity) {
            throw new RangeError('Uint8SharedList.from: invalid header');
        }
        const need = u8rTotalBytes(capacity);
        if ((ptr !== 0 ? ptr : 0) + need > storage.byteLength) {
            throw new RangeError('Uint8SharedList.from: buffer byteLength is smaller than layout');
        }
        const inst = Object.create(Uint8SharedList.prototype) as Uint8SharedList;
        inst.storage = storage;
        inst.pool = SharedMemoryPool.from(storage, { start: SHARED_LIST_POOL_START });
        inst.ctrl = new Uint32Array(storage, 0, SHARED_LIST_POOL_START >>> 2);
        inst.listPtr = ptr !== 0 ? ptr : 0;
        inst.logicalMaxByteLength = undefined;
        inst.hdr = hdr;
        inst._rebindBytes();
        return inst;
    }

    /**
     * Append one byte (`value & 0xff`). Grows `capacity` (and the buffer) when `count === capacity`.
     *
     * @returns Index of the appended element (previous length).
     */
    push(value: number): number {
        const b = value & 0xff;
        let count = this.hdr[U8R_H.count] >>> 0;
        let cap = this.hdr[U8R_H.capacity] >>> 0;
        if (count >= cap) {
            this._growCapacity(Math.max(cap * 2, cap + 1));
            count = this.hdr[U8R_H.count] >>> 0;
            cap = this.hdr[U8R_H.capacity] >>> 0;
        }
        this.bytes[count] = b;
        this.hdr[U8R_H.count] = count + 1;
        return count;
    }

    get length(): number {
        return this.hdr[U8R_H.count] >>> 0;
    }

    get capacity(): number {
        return this.hdr[U8R_H.capacity] >>> 0;
    }

    /**
     * Rebind the byte view after the backing buffer grew or `capacity` in the header changed (e.g. producer finished resizing).
     */
    rebind(): void {
        this._rebindBytes();
    }

    /**
     * Element at `index` as `0..255`, or `null` if out of range.
     */
    get(index: number): number | undefined {
        if (!Number.isInteger(index) || index < 0) {
            throw new RangeError('Uint8SharedList.get: index must be a non-negative integer');
        }
        const count = this.hdr[U8R_H.count] >>> 0;
        if (index >= count) {
            return undefined;
        }
        return this.bytes[index]!;
    }

    *values(): Generator<number, void, undefined> {
        const count = this.hdr[U8R_H.count] >>> 0;
        for (let i = 0; i < count; i++) {
            yield this.bytes[i]!;
        }
    }
    private _growCapacity(newCapacity: number): void {
        if (!Number.isInteger(newCapacity) || newCapacity < 1) {
            throw new RangeError('Uint8SharedList: newCapacity must be a positive integer');
        }
        const need = u8rTotalBytes(newCapacity);
        if (this.logicalMaxByteLength !== undefined && need > this.logicalMaxByteLength) {
            throw new RangeError('Uint8SharedList: maxByteLength exceeded while growing');
        }
        let newPtr = this.pool.realloc(this.listPtr, need);
        if (!newPtr) {
            const sab = this.pool.sharedArrayBuffer;
            const maxB = readSharedArrayBufferMaxByteLength(sab);
            const next = maxB ? Math.min(maxB, Math.max(sab.byteLength + 1, sab.byteLength * 2)) : 0;
            if (next > sab.byteLength) {
                this.pool.growSharedBacking(next);
                this.storage = this.pool.sharedArrayBuffer;
                this.ctrl = new Uint32Array(this.storage, 0, SHARED_LIST_POOL_START >>> 2);
                newPtr = this.pool.realloc(this.listPtr, need);
            }
        }
        if (!newPtr) {
            throw new RangeError('Uint8SharedList: realloc failed while growing');
        }
        this.listPtr = newPtr >>> 0;
        this.ctrl[U8R_CTRL_PTR] = this.listPtr;
        this.hdr = new Uint32Array(this.storage, this.listPtr, 2);
        this.hdr[U8R_H.capacity] = newCapacity >>> 0;
        this._rebindBytes();
    }

    private _rebindBytes(): void {
        const capacity = this.hdr[U8R_H.capacity] >>> 0;
        this.bytes = new Uint8Array(this.storage, this.listPtr + U8R_DATA_OFFSET, capacity);
    }
}
