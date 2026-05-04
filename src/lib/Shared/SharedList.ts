import { SharedListItemView, type ISharedListItemView } from './SharedListItemView.js';

export type { ISharedListItemView, SharedListView } from './SharedListItemView.js';
export { SharedListItemView } from './SharedListItemView.js';

const HDR_WORDS = 3;
const OFF_HDR = 4;

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

type GrowableSharedArrayBufferCtor = new (
    byteLength: number,
    options?: { maxByteLength?: number },
) => SharedArrayBuffer;

function createGrowableSharedArrayBuffer(byteLength: number, maxByteLength: number): SharedArrayBuffer {
    const Ctor = SharedArrayBuffer as unknown as GrowableSharedArrayBufferCtor;
    return new Ctor(byteLength, { maxByteLength });
}

function readSharedArrayBufferMaxByteLength(sab: SharedArrayBuffer): number | undefined {
    const m = (sab as { maxByteLength?: number }).maxByteLength;
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
}

/** Raw tail write used by {@link SharedList.appendBuffer}. */
function appendBufferToStorage(
    storage: SharedArrayBuffer,
    byteOffset: number,
    source: Uint8Array<ArrayBufferLike>,
): number {
    const end = byteOffset + source.byteLength;
    if (end <= storage.byteLength) {
        new Uint8Array(storage).set(source, byteOffset);
        return end;
    }
    const maxB = storage.maxByteLength;
    if (end > maxB) {
        throw new RangeError(`SharedList.appendBuffer: need ${end} bytes but maxByteLength is ${maxB}`);
    }
    storage.grow(end);
    new Uint8Array(storage).set(source, byteOffset);
    return end;
}

export interface SharedListOptions {
    /** When full, new capacity is at least `ceil(capacity * growthFactor)` in steps until `minNeeded` fits. @defaultValue 2 */
    growthFactor?: number;
    /**
     * Set when the backing `SharedArrayBuffer` was allocated by {@link SharedList.createShared}
     * (or a same-sized {@link clone}). Enables {@link growSharedBacking}. Do not set manually.
     */
    ownedSharedBacking?: { initialByteLength: number; maxByteLength: number };
    /** Used only by {@link SharedList.createShared} to write the initial header. */
    initFresh?: { initialCapacity: number };
}

/** Options for {@link SharedList.createShared}. */
export interface SharedListCreateSharedOptions extends Omit<SharedListOptions, 'initFresh' | 'ownedSharedBacking'> {
    initialCapacity: number;
    maxByteLength?: number;
}

export interface SharedListFromOptions {
    growthFactor?: number;
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
    private hdr!: Uint32Array;
    private data!: Uint8Array;
    private itemByteSize: number;
    private singleton: T;
    private growthFactor: number;
    private _ownedSharedBacking: { initialByteLength: number; maxByteLength: number } | undefined;

    constructor(storage: SharedArrayBuffer, itemViewSingleton: T, itemByteSize: number, options?: SharedListOptions) {
        if (!Number.isInteger(itemByteSize) || itemByteSize < 1) {
            throw new RangeError('SharedList: itemByteSize must be a positive integer');
        }
        this.storage = storage;
        this.singleton = itemViewSingleton;
        this.itemByteSize = itemByteSize;
        this.growthFactor = options?.growthFactor ?? 2;
        if (!Number.isFinite(this.growthFactor) || this.growthFactor < 1) {
            throw new RangeError('SharedList: growthFactor must be >= 1');
        }
        this._ownedSharedBacking = options?.ownedSharedBacking;
        /** Bytes `0..3` reserved (legacy mutex slot); header starts at {@link OFF_HDR}. */
        new Uint32Array(storage, 0, 1)[0] = 0;
        this.hdr = new Uint32Array(storage, OFF_HDR, HDR_WORDS);

        if (options?.initFresh) {
            const initialCapacity = options.initFresh.initialCapacity;
            if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
                throw new RangeError('SharedList: initFresh.initialCapacity must be a positive integer');
            }
            const need = layoutOffsets(initialCapacity, itemByteSize).totalBytes;
            if (need > storage.byteLength) {
                throw new RangeError('SharedList: buffer too small for initFresh layout');
            }
            this.hdr[H.count] = 0;
            this.hdr[H.capacity] = initialCapacity >>> 0;
            this.hdr[H.itemBytes] = itemByteSize >>> 0;
        } else {
            const minBytes = OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT;
            if (storage.byteLength < minBytes) {
                throw new RangeError('SharedList: buffer too small for header');
            }
            const count = this.hdr[H.count] >>> 0;
            const capacity = this.hdr[H.capacity] >>> 0;
            const ib = this.hdr[H.itemBytes] >>> 0;
            if (ib !== (itemByteSize >>> 0)) {
                throw new RangeError(`SharedList: itemByteSize ${itemByteSize} does not match header (${ib})`);
            }
            if (capacity < 1 || ib < 1 || count > capacity) {
                throw new RangeError('SharedList: invalid header');
            }
            const need = layoutOffsets(capacity, itemByteSize).totalBytes;
            if (need > storage.byteLength) {
                throw new RangeError('SharedList: buffer byteLength is smaller than embedded layout');
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
        itemViewSingleton: T,
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
        const sab = createGrowableSharedArrayBuffer(layout0.totalBytes, maxB);
        return new SharedList(sab, itemViewSingleton, itemByteSize, {
            ...rest,
            growthFactor,
            ownedSharedBacking: { initialByteLength: layout0.totalBytes, maxByteLength: maxB },
            initFresh: { initialCapacity },
        });
    }

    /**
     * Attach to an existing buffer (e.g. a worker after `postMessage` of the same `SharedArrayBuffer`).
     * The owner thread must have initialized the buffer (e.g. via {@link createShared}).
     */
    static from<T extends ISharedListItemView>(
        storage: SharedArrayBuffer,
        itemViewSingleton: T,
        options?: SharedListFromOptions,
    ): SharedList<T> {
        const minBytes = OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (storage.byteLength < minBytes) {
            throw new RangeError('SharedList.from: buffer too small for header');
        }
        const hdr = new Uint32Array(storage, OFF_HDR, HDR_WORDS);
        const count = hdr[H.count] >>> 0;
        const capacity = hdr[H.capacity] >>> 0;
        const itemBytes = hdr[H.itemBytes] >>> 0;
        if (capacity < 1 || itemBytes < 1 || count > capacity) {
            throw new RangeError('SharedList.from: invalid header');
        }
        const need = layoutOffsets(capacity, itemBytes).totalBytes;
        if (need > storage.byteLength) {
            throw new RangeError('SharedList.from: buffer byteLength is smaller than embedded layout');
        }
        const inst = Object.create(SharedList.prototype) as SharedList<T>;
        inst.storage = storage;
        inst.hdr = hdr;
        inst.singleton = itemViewSingleton;
        inst.itemByteSize = itemBytes;
        inst.growthFactor = options?.growthFactor ?? 2;
        inst._ownedSharedBacking = undefined;
        inst._rebindData();
        return inst;
    }

    /**
     * Copy the full backing image into a **new** {@link SharedList} and buffer instance.
     * By default the copy uses the same `byteLength` and resizable `maxByteLength` as the source.
     */
    clone(options?: SharedListCloneOptions): SharedList<T> {
        const oldBuf = this.storage;
        const oldLen = oldBuf.byteLength;
        const meta = this._ownedSharedBacking;
        const sabMax = readSharedArrayBufferMaxByteLength(oldBuf);
        const oldMax = meta?.maxByteLength ?? sabMax ?? oldLen;

        const newLen = options?.newByteLength ?? oldLen;
        if (!Number.isInteger(newLen) || newLen < oldLen) {
            throw new RangeError('SharedList.clone: newByteLength must be an integer ≥ current byteLength');
        }

        let newMax = options?.newMaxByteLength ?? oldMax;
        if (!Number.isInteger(newMax) || newMax < newLen) {
            throw new RangeError('SharedList.clone: newMaxByteLength must be an integer ≥ newByteLength');
        }

        const src = new Uint8Array(oldBuf, 0, oldLen);
        const nextBuf = createGrowableSharedArrayBuffer(newLen, newMax);
        new Uint8Array(nextBuf, 0, oldLen).set(src);

        const inst = Object.create(SharedList.prototype) as SharedList<T>;
        inst.storage = nextBuf;
        inst.hdr = new Uint32Array(nextBuf, OFF_HDR, HDR_WORDS);
        inst.singleton = this.singleton;
        inst.itemByteSize = this.itemByteSize;
        inst.growthFactor = this.growthFactor;
        inst._ownedSharedBacking =
            meta !== undefined
                ? { initialByteLength: meta.initialByteLength, maxByteLength: newMax }
                : undefined;
        inst._rebindData();
        return inst;
    }

    /**
     * In-place `SharedArrayBuffer.prototype.grow` on the same buffer reference. Only for buffers
     * allocated via {@link createShared} (or {@link clone} with owned metadata).
     */
    growSharedBacking(targetByteLength: number): void {
        if (!this._ownedSharedBacking) {
            throw new RangeError('SharedList.growSharedBacking: only supported for buffers created with createShared');
        }
        const sab = this.storage;
        const grow = (sab as { grow?: (n: number) => void }).grow;
        if (typeof grow !== 'function') {
            throw new RangeError('SharedList.growSharedBacking: SharedArrayBuffer is not growable');
        }
        const cur = sab.byteLength;
        if (!Number.isInteger(targetByteLength) || targetByteLength <= cur) {
            throw new RangeError('SharedList.growSharedBacking: targetByteLength must be an integer > current length');
        }
        const maxB = readSharedArrayBufferMaxByteLength(sab);
        if (maxB !== undefined && targetByteLength > maxB) {
            throw new RangeError(
                `SharedList.growSharedBacking: targetByteLength ${targetByteLength} exceeds maxByteLength ${maxB}`,
            );
        }
        grow.call(sab, targetByteLength);
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
        const off = this._dataByteOffset() + index * this.itemByteSize;
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
        return appendBufferToStorage(this.storage, byteOffset, source);
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
        if (newLayout.totalBytes > this.storage.maxByteLength) {
            throw new RangeError('SharedList: maxByteLength exceeded while growing');
        }
        if (newLayout.totalBytes > this.storage.byteLength) {
            this.storage.grow(newLayout.totalBytes);
        }
        this.hdr[H.capacity] = newCapacity >>> 0;
        this._rebindData();
        const oldData = new Uint8Array(
            this.storage,
            oldLayout.dataByteOffset,
            oldLayout.totalBytes - oldLayout.dataByteOffset,
        );
        const newData = new Uint8Array(this.storage, newLayout.dataByteOffset, oldData.length);
        newData.set(oldData);
    }

    private _rebindData(): void {
        const l = layoutOffsets(this.capacity, this.itemByteSize);
        this.data = new Uint8Array(this.storage, l.dataByteOffset, this.capacity * this.itemByteSize);
    }
}

/** Byte offset of payload after the 8-byte header (count + capacity as u32). */
const U8R_DATA_OFFSET = 8;

const U8R_H = {
    count: 0,
    capacity: 1,
} as const;

function u8rTotalBytes(capacity: number): number {
    return U8R_DATA_OFFSET + capacity;
}

/**
 * Build a {@link SharedArrayBuffer} holding a {@link Uint8ReadonlySharedList} layout: `count`, `capacity`, then `capacity` byte slots (first `count` used).
 * Each value is coerced with `value & 0xff`. Use only while readers are not relying on a stable snapshot, then publish `count` last if needed.
 */
export function buildUint8ReadonlySharedListStorage(
    capacity: number,
    values: readonly number[],
    options?: { maxByteLength?: number },
): SharedArrayBuffer {
    if (!Number.isInteger(capacity) || capacity < 1) {
        throw new RangeError('buildUint8ReadonlySharedListStorage: capacity must be a positive integer');
    }
    const count = values.length;
    if (count > capacity) {
        throw new RangeError('buildUint8ReadonlySharedListStorage: more values than capacity');
    }
    const total = u8rTotalBytes(capacity);
    const minMax = Math.max(total * 4, total + 4096);
    const maxB = Math.max(options?.maxByteLength ?? minMax, total);
    const storage = new SharedArrayBuffer(total, { maxByteLength: maxB });
    const hdr = new Uint32Array(storage, 0, 2);
    hdr[U8R_H.count] = count >>> 0;
    hdr[U8R_H.capacity] = capacity >>> 0;
    const data = new Uint8Array(storage, U8R_DATA_OFFSET, capacity);
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
export class Uint8ReadonlySharedList {
    public storage!: SharedArrayBuffer;
    private hdr!: Uint32Array;
    public bytes!: Uint8Array;

    constructor(initialCapacity: number, options?: { maxByteLength?: number }) {
        if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
            throw new RangeError('Uint8ReadonlySharedList: initialCapacity must be a positive integer');
        }
        this.storage = buildUint8ReadonlySharedListStorage(initialCapacity, [], options);
        this.hdr = new Uint32Array(this.storage, 0, 2);
        this._rebindBytes();
    }

    static from(storage: SharedArrayBuffer): Uint8ReadonlySharedList {
        if (storage.byteLength < U8R_DATA_OFFSET + 1) {
            throw new RangeError('Uint8ReadonlySharedList.from: buffer too small');
        }
        const hdr = new Uint32Array(storage, 0, 2);
        const count = hdr[U8R_H.count] >>> 0;
        const capacity = hdr[U8R_H.capacity] >>> 0;
        if (capacity < 1 || count > capacity) {
            throw new RangeError('Uint8ReadonlySharedList.from: invalid header');
        }
        const need = u8rTotalBytes(capacity);
        if (need > storage.byteLength) {
            throw new RangeError('Uint8ReadonlySharedList.from: buffer byteLength is smaller than layout');
        }
        const inst = Object.create(Uint8ReadonlySharedList.prototype) as Uint8ReadonlySharedList;
        inst.storage = storage;
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
            throw new RangeError('Uint8ReadonlySharedList.get: index must be a non-negative integer');
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
            throw new RangeError('Uint8ReadonlySharedList: newCapacity must be a positive integer');
        }
        const need = u8rTotalBytes(newCapacity);
        if (need > this.storage.maxByteLength) {
            throw new RangeError('Uint8ReadonlySharedList: maxByteLength exceeded while growing');
        }
        if (need > this.storage.byteLength) {
            this.storage.grow(need);
        }
        this.hdr[U8R_H.capacity] = newCapacity >>> 0;
        this._rebindBytes();
    }

    private _rebindBytes(): void {
        const capacity = this.hdr[U8R_H.capacity] >>> 0;
        this.bytes = new Uint8Array(this.storage, U8R_DATA_OFFSET, capacity);
    }
}
