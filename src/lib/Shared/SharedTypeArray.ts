import { SharedListItemView, type ISharedListItemView } from './SharedListItemView.js';
import SharedMemoryPool from './SharedMemoryPool.js';

const LAYOUT_VERSION = 1;
const META = {
    length: 0,
    capacity: 1,
    itemByteSize: 2,
    layoutVersion: 3,
} as const;
const META_WORDS = 4;

function align4(n: number): number {
    return (n + 3) & ~3;
}

function totalBytesFor(capacity: number, itemByteSize: number): number {
    const headerBytes = META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
    const dataBytes = capacity * itemByteSize;
    return align4(headerBytes + dataBytes);
}

function readSharedArrayBufferMaxByteLength(sab: SharedArrayBuffer): number | undefined {
    const m = (sab as { maxByteLength?: number }).maxByteLength;
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
}

export interface SharedTypeArrayConstructorOptions<T extends ISharedListItemView> {
    pool: SharedMemoryPool;
    itemViewSingleton?: T;
    initFresh?: { initialCapacity: number };
    arrayPtr?: number;
}

export interface SharedTypeArrayCreateOptions<T extends ISharedListItemView> {
    initialCapacity: number;
    itemViewSingleton?: T;
}

export default class SharedTypeArray<T extends ISharedListItemView> {
    readonly pool: SharedMemoryPool;

    private readonly singleton: T;
    public ptr!: number;
    private meta!: Uint32Array;
    private data!: Uint8Array;

    constructor(options: SharedTypeArrayConstructorOptions<T>) {
        this.pool = options.pool;
        this.singleton = options.itemViewSingleton ?? new SharedListItemView() as unknown as T;

        if (options.initFresh) {
            const capacity = options.initFresh.initialCapacity >>> 0;
            const itemByteSize = this.singleton.itemByteSize >>> 0;
            if (!Number.isInteger(capacity) || capacity < 1) {
                throw new RangeError('SharedTypeArray: initialCapacity must be a positive integer');
            }
            if (!Number.isInteger(itemByteSize) || itemByteSize < 1) {
                throw new RangeError('SharedTypeArray: itemViewSingleton.itemByteSize must be a positive integer');
            }
            const need = totalBytesFor(capacity, itemByteSize);
            let ptr = this.pool.malloc(need);
            if (!ptr && this._tryGrowPool()) {
                ptr = this.pool.malloc(need);
            }
            if (!ptr) {
                throw new RangeError('SharedTypeArray: malloc failed for initial array');
            }
            this.ptr = ptr >>> 0;
            this._bindViews(capacity, itemByteSize);
            this.meta[META.length] = 0;
            this.meta[META.capacity] = capacity >>> 0;
            this.meta[META.itemByteSize] = itemByteSize >>> 0;
            this.meta[META.layoutVersion] = LAYOUT_VERSION;
            this.data.fill(0);
        } else if (options.arrayPtr !== undefined) {
            this.ptr = options.arrayPtr >>> 0;
            SharedTypeArray._attachFromBufferInto(this, this.pool.buf, this.ptr);
            const expectedItemByteSize = this.singleton.itemByteSize >>> 0;
            const actualItemByteSize = this.meta[META.itemByteSize] >>> 0;
            if (expectedItemByteSize !== actualItemByteSize) {
                throw new RangeError(
                    `SharedTypeArray.from: itemViewSingleton.itemByteSize ${expectedItemByteSize} does not match stored itemByteSize ${actualItemByteSize}`,
                );
            }
        } else {
            throw new RangeError('SharedTypeArray: provide initFresh or arrayPtr');
        }
    }

    static createInPool<T extends ISharedListItemView>(
        pool: SharedMemoryPool,
        options: SharedTypeArrayCreateOptions<T>,
    ): SharedTypeArray<T> {
        return new SharedTypeArray({
            pool,
            itemViewSingleton: options.itemViewSingleton,
            initFresh: { initialCapacity: options.initialCapacity },
        });
    }

    static from<T extends ISharedListItemView>(
        pool: SharedMemoryPool,
        arrayPtr: number
    ): SharedTypeArray<T> {
        return new SharedTypeArray({
            pool,
            arrayPtr
        });
    }

    private static _attachFromBufferInto<U extends ISharedListItemView>(
        target: SharedTypeArray<U>,
        buf: ArrayBufferLike,
        ptr: number,
    ): void {
        const minBytes = ptr + META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (buf.byteLength < minBytes) {
            throw new RangeError('SharedTypeArray.from: buffer too small for header');
        }
        const meta = new Uint32Array(buf, ptr, META_WORDS);
        const length = meta[META.length] >>> 0;
        const capacity = meta[META.capacity] >>> 0;
        const itemByteSize = meta[META.itemByteSize] >>> 0;
        const ver = meta[META.layoutVersion] >>> 0;
        if (ver !== LAYOUT_VERSION) {
            throw new RangeError(`SharedTypeArray.from: unsupported layout version ${ver}`);
        }
        if (capacity < 1 || itemByteSize < 1 || length > capacity) {
            throw new RangeError('SharedTypeArray.from: invalid meta header');
        }
        const need = totalBytesFor(capacity, itemByteSize);
        if (ptr + need > buf.byteLength) {
            throw new RangeError('SharedTypeArray.from: array extends past buffer');
        }
        target.ptr = ptr >>> 0;
        target.meta = meta;
        target._bindViews(capacity, itemByteSize);
    }

    private _bindViews(capacity: number, itemByteSize: number): void {
        const ptr = this.ptr >>> 0;
        const buf = this.pool.buf;
        this.meta = new Uint32Array(buf, ptr, META_WORDS);
        const dataByteOffset = ptr + META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        this.data = new Uint8Array(buf, dataByteOffset, capacity * itemByteSize);
    }

    get arrayPtr(): number {
        return this.ptr >>> 0;
    }

    get length(): number {
        return this.meta[META.length] >>> 0;
    }

    get capacity(): number {
        return this.meta[META.capacity] >>> 0;
    }

    get itemByteSize(): number {
        return this.meta[META.itemByteSize] >>> 0;
    }

    rebind(): void {
        const capacity = this.meta[META.capacity] >>> 0;
        const itemByteSize = this.meta[META.itemByteSize] >>> 0;
        this._bindViews(capacity, itemByteSize);
    }

    private _byteOffsetAt(index: number): number {
        return this.ptr + META_WORDS * Uint32Array.BYTES_PER_ELEMENT + index * this.itemByteSize;
    }

    get(index: number): T | undefined {
        if (index < 0) {
            throw new RangeError('SharedTypeArray.get: index must be a non-negative integer');
        }
        const length = this.length;
        if (index >= length) {
            return undefined;
        }
        const off = this._byteOffsetAt(index);
        this.singleton.attachAt(this.pool.buf, off, this.itemByteSize, index, length);
        return this.singleton;
    }

    *items(): Generator<T, void, undefined> {
        const length = this.length;
        for (let i = 0; i < length; i++) {
            this.singleton.attachAt(this.pool.buf, this._byteOffsetAt(i), this.itemByteSize, i, length);
            yield this.singleton;
        }
    }

    set(index: number, item: ISharedListItemView): void {
        if (!Number.isInteger(index) || index < 0) {
            throw new RangeError('SharedTypeArray.set: index must be a non-negative integer');
        }
        if (index >= this.capacity) {
            throw new RangeError('SharedTypeArray.set: index out of capacity range');
        }
        const bytes = item.bytes;
        if (bytes.byteLength !== this.itemByteSize) {
            throw new RangeError(
                `SharedTypeArray.set: item bytes length ${bytes.byteLength} must match itemByteSize ${this.itemByteSize}`,
            );
        }
        const offset = index * this.itemByteSize;
        this.data.set(bytes, offset);
        if (index >= this.length) {
            this.meta[META.length] = (index + 1) >>> 0;
        }
    }

    push(item: ISharedListItemView): number {
        const index = this.length;
        if (index >= this.capacity) {
            this.resize(Math.max(this.capacity * 2, this.capacity + 1));
        }
        this.set(index, item);
        return index;
    }

    clear(): void {
        this.meta[META.length] = 0;
    }

    resize(newCapacity: number): void {
        if (!Number.isInteger(newCapacity) || newCapacity < 1) {
            throw new RangeError('SharedTypeArray.resize: newCapacity must be a positive integer');
        }
        if (newCapacity < this.length) {
            throw new RangeError(
                `SharedTypeArray.resize: newCapacity ${newCapacity} is smaller than current length ${this.length}`,
            );
        }
        if (newCapacity === this.capacity) {
            return;
        }
        const itemByteSize = this.itemByteSize;
        const need = totalBytesFor(newCapacity, itemByteSize);
        const oldPtr = this.ptr >>> 0;
        let newPtr = this.pool.realloc(oldPtr, need);
        if (!newPtr && this._tryGrowPool()) {
            newPtr = this.pool.realloc(oldPtr, need);
        }
        if (!newPtr) {
            throw new RangeError('SharedTypeArray.resize: realloc failed (out of memory)');
        }
        this.ptr = newPtr >>> 0;
        this._bindViews(newCapacity, itemByteSize);
        this.meta[META.capacity] = newCapacity >>> 0;
    }

    private _tryGrowPool(): boolean {
        const sab = this.pool.sharedArrayBuffer;
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
        this.pool.growSharedBacking(next);
        return true;
    }
}
