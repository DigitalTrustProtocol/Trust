/**
 * UInt32SharedMap — `uint32 key → uint32 value` hash map in bytes allocated from a
 * {@link SharedMemoryPool} (no separate map-owned {@link SharedArrayBuffer}).
 *
 * **Concurrency.** Same model as {@link SharedMapTyped}: single-writer mutation; readers
 * only observe published updates.
 *
 * **Growth.** Load factor 75% triggers rehash into a larger table via `malloc` / `realloc` on
 * the {@link SharedMemoryPool}. If allocation fails, the map attempts
 * {@link SharedMemoryPool.growSharedBacking} (growable SAB) before retrying.
 *
 * @packageDocumentation
 */

import SharedMemoryPool from './SharedMemoryPool.js';

export const UINT32_MAX = 0xffffffff;

const KEY_WORDS = 1;
const VALUE_WORDS = 1;

const LAYOUT_VERSION = 3;

/** `true` when entry count strictly exceeds 75% of bucket slots (`n × 100 > cap × 75`). */
function exceedsLoadFactor(n: number, cap: number): boolean {
    return n * 100 > cap * 75;
}

function hashU32(k: number, mod: number): number {
    let h = Math.imul(k >>> 0, 0x9e3779b1) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0xc2b2ae3d) >>> 0;
    h ^= h >>> 16;
    h = h >>> 0;
    if (h === UINT32_MAX) h = 1;
    return h % mod;
}

function align32(maxSize: number): number {
    return (maxSize & 0xffffffffffffc) + (maxSize & 0x3 ? 0x4 : 0);
}

const META = {
    maxSize: 0,
    length: 1,
    layoutVersion: 2,
} as const;

const META_WORDS = 3;

function totalBytesForBuckets(maxSize: number): number {
    let offset = META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
    const keysBytes = KEY_WORDS * maxSize * Uint32Array.BYTES_PER_ELEMENT;
    const valuesBytes = VALUE_WORDS * maxSize * Uint32Array.BYTES_PER_ELEMENT;
    const chainBytes = maxSize * Uint32Array.BYTES_PER_ELEMENT;
    const usedBytes = maxSize * Uint8Array.BYTES_PER_ELEMENT;
    let total = offset + keysBytes + valuesBytes + chainBytes + usedBytes;
    total = (total + 3) & ~3;
    return total;
}

function readSharedArrayBufferMaxByteLength(sab: SharedArrayBuffer): number | undefined {
    const m = (sab as { maxByteLength?: number }).maxByteLength;
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
}

export interface UInt32SharedMapConstructorOptions {
    /** Allocator backing the map table (same buffer as workers attach to). */
    pool: SharedMemoryPool;
    /** Fresh table with this many buckets (aligned to a multiple of 4). */
    initFresh?: { initialBucketCapacity: number };
    /** Byte offset returned by {@link SharedMemoryPool.malloc} for an existing table image. */
    tablePtr?: number;
}

export interface UInt32SharedMapCreateOptions {
    initialBucketCapacity: number;
}

interface FindResult {
    pos: number;
    previous: number;
}

interface ChainEntry {
    key: number;
    value: number;
}

/**
 * Open-addressing hash map with coalesced chaining; one `uint32` key and one `uint32` value
 * per bucket, stored in a contiguous block allocated from {@link UInt32SharedMapConstructorOptions.pool}.
 */
export default class UInt32SharedMap {
    public ptr!: number;
    readonly pool: SharedMemoryPool;

    meta!: Uint32Array;
    keysData!: Uint32Array;
    valuesData!: Uint32Array;
    chaining!: Uint32Array;
    bucketUsed!: Uint8Array;

    stats: {
        set: number;
        delete: number;
        collisions: number;
        rechains: number;
        get: number;
        rehash: number;
    };

    constructor(options: UInt32SharedMapConstructorOptions) {
        this.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, rehash: 0 };
        this.pool = options.pool;
        const pool = options.pool;

        if (options.initFresh) {
            const raw = options.initFresh.initialBucketCapacity;
            const cap = align32(raw);
            if (!(cap > 0)) {
                throw new RangeError('UInt32SharedMap: initialBucketCapacity must be a positive number');
            }
            const need = totalBytesForBuckets(cap);
            let ptr = pool.malloc(need);
            if (!ptr && this._tryGrowPool()) {
                ptr = pool.malloc(need);
            }
            if (!ptr) {
                throw new RangeError('UInt32SharedMap: malloc failed for initial table');
            }
            this.ptr = ptr >>> 0;
            this._bindViews(cap);
            this.meta[META.maxSize] = cap >>> 0;
            this.meta[META.length] = 0;
            this.meta[META.layoutVersion] = LAYOUT_VERSION;
            this.chaining.fill(UINT32_MAX);
            this.bucketUsed.fill(0);
            this.keysData.fill(0);
            this.valuesData.fill(0);
        } else if (options.tablePtr !== undefined) {
            this.ptr = options.tablePtr >>> 0;
            UInt32SharedMap._attachFromBufferInto(this, this.pool.buf, this.ptr);
        } else {
            throw new RangeError('UInt32SharedMap: provide initFresh or tablePtr');
        }
    }

    /**
     * Allocate a table in `pool` (grow pool if needed). Main thread owns writes; workers attach
     * with {@link UInt32SharedMap.from} using the published `tablePtr`.
     */
    static createInPool(pool: SharedMemoryPool, options: UInt32SharedMapCreateOptions): UInt32SharedMap {
        return new UInt32SharedMap({
            pool,
            initFresh: { initialBucketCapacity: options.initialBucketCapacity },
        });
    }

    /** Attach to an existing table at `tablePtr` in the same buffer the pool uses. */
    static from(pool: SharedMemoryPool, tablePtr: number): UInt32SharedMap {
        return new UInt32SharedMap({ pool, tablePtr });
    }

    private static _attachFromBufferInto(target: UInt32SharedMap, buf: ArrayBufferLike, ptr: number): void {
        const minBytes = ptr + META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (buf.byteLength < minBytes) {
            throw new RangeError('UInt32SharedMap.from: buffer too small for header');
        }
        const meta = new Uint32Array(buf, ptr, META_WORDS);
        const maxSize = meta[META.maxSize] >>> 0;
        const length = meta[META.length] >>> 0;
        const ver = meta[META.layoutVersion] >>> 0;
        if (ver !== LAYOUT_VERSION) {
            throw new RangeError(`UInt32SharedMap.from: unsupported layout version ${ver}`);
        }
        if (maxSize < 1 || length > maxSize) {
            throw new RangeError('UInt32SharedMap.from: invalid meta header');
        }
        const need = totalBytesForBuckets(maxSize);
        if (ptr + need > buf.byteLength) {
            throw new RangeError('UInt32SharedMap.from: table extends past buffer');
        }
        target.ptr = ptr >>> 0;
        target.meta = meta;
        target._bindViews(maxSize);
    }

    /** Byte offset of the table block in {@link SharedMemoryPool.buf} (for workers / persistence). */
    get tablePtr(): number {
        return this.ptr >>> 0;
    }

    /** Rebind typed views after the pool buffer grew in place (same `tablePtr`). */
    rebind(): void {
        const maxSize = this.meta[META.maxSize] >>> 0;
        this._bindViews(maxSize);
    }

    /**
     * Grow the backing {@link SharedArrayBuffer} (then {@link UInt32SharedMap.rebind}).
     * Use when large `resize` / inserts need more heap than `maxByteLength` currently allows.
     */
    growPool(targetByteLength: number): void {
        this.pool.growSharedBacking(targetByteLength);
        this.rebind();
    }

    private _bindViews(maxSize: number): void {
        const buf = this.pool.buf;
        const ptr = this.ptr >>> 0;
        let offset = ptr + META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        this.meta = new Uint32Array(buf, ptr, META_WORDS);
        this.keysData = new Uint32Array(buf, offset, KEY_WORDS * maxSize);
        offset += this.keysData.byteLength;
        this.valuesData = new Uint32Array(buf, offset, VALUE_WORDS * maxSize);
        offset += this.valuesData.byteLength;
        this.chaining = new Uint32Array(buf, offset, maxSize);
        offset += this.chaining.byteLength;
        this.bucketUsed = new Uint8Array(buf, offset, maxSize);
    }

    get length(): number {
        return this.meta[META.length] >>> 0;
    }

    get size(): number {
        return this.meta[META.maxSize] >>> 0;
    }

    /**
     * Replace with a larger bucket table and rehash all entries (new `malloc` block; old block
     * `free`d unless `keepOldBlock` is used internally during failed realloc — we always free old).
     */
    resize(newMaxSize: number): void {
        const aligned = align32(newMaxSize);
        if (!(aligned > 0)) {
            throw new RangeError('UInt32SharedMap.resize: newMaxSize must be a positive number');
        }
        if (aligned < this.length) {
            throw new RangeError(
                `UInt32SharedMap.resize: new capacity ${aligned} is smaller than current length ${this.length}`,
            );
        }
        if (aligned === this.size) {
            return;
        }
        this._rehashToCapacity(aligned);
    }

    private _nextBucketCapacityForCount(n: number, currentCap: number): number {
        const minSlots = Math.ceil((n * 100) / 75);
        const doubled = currentCap * 2;
        return align32(Math.max(minSlots, doubled, n + 1));
    }

    /**
     * Linear scan of occupied buckets — same traversal as {@link UInt32SharedMap._collectEntries}
     * (single pass, no `get` / hash lookups).
     */
    private *_bucketEntryPairs(): Generator<readonly [number, number], void, undefined> {
        const cap = this.meta[META.maxSize] >>> 0;
        for (let pos = 0; pos < cap; pos++) {
            if (!this._bucketOccupied(pos)) continue;
            yield [this.keysData[pos] >>> 0, this._readValue(pos)] as const;
        }
    }

    private _collectEntries(): ChainEntry[] {
        const out: ChainEntry[] = [];
        for (const [key, value] of this._bucketEntryPairs()) {
            out.push({ key, value });
        }
        return out;
    }

    private _rehashToCapacity(newAlignedMax: number): void {
        const entries = this._collectEntries();
        const n = entries.length;
        const need = totalBytesForBuckets(newAlignedMax);
        const oldPtr = this.ptr >>> 0;

        let ptr = this.pool.realloc(oldPtr, need);
        if (!ptr && this._tryGrowPool()) {
            ptr = this.pool.realloc(oldPtr, need);
        }

        if (!ptr) {
            const newPtr = this._mallocOrThrow(need);
            const savedPtr = oldPtr;
            this.ptr = newPtr >>> 0;
            this._bindViews(newAlignedMax);
            this.meta[META.maxSize] = newAlignedMax >>> 0;
            this.meta[META.length] = 0;
            this.meta[META.layoutVersion] = LAYOUT_VERSION;
            this.chaining.fill(UINT32_MAX);
            this.bucketUsed.fill(0);
            this.keysData.fill(0);
            this.valuesData.fill(0);
            for (const e of entries) {
                this._putPair(e.key, e.value);
            }
            if ((this.meta[META.length] >>> 0) !== n) {
                this.pool.free(newPtr);
                this.ptr = savedPtr;
                UInt32SharedMap._attachFromBufferInto(this, this.pool.buf, savedPtr);
                throw new Error('UInt32SharedMap._rehashToCapacity: entry count mismatch after malloc');
            }
            this.pool.free(savedPtr);
            this.stats.rehash++;
            return;
        }

        this.ptr = ptr >>> 0;
        this._bindViews(newAlignedMax);
        this.meta[META.maxSize] = newAlignedMax >>> 0;
        this.meta[META.length] = 0;
        this.meta[META.layoutVersion] = LAYOUT_VERSION;
        this.chaining.fill(UINT32_MAX);
        this.bucketUsed.fill(0);
        this.keysData.fill(0);
        this.valuesData.fill(0);
        for (const e of entries) {
            this._putPair(e.key, e.value);
        }
        if ((this.meta[META.length] >>> 0) !== n) {
            throw new Error('UInt32SharedMap._rehashToCapacity: entry count mismatch after realloc');
        }
        this.stats.rehash++;
    }

    private _mallocOrThrow(bytes: number): number {
        let p = this.pool.malloc(bytes);
        if (!p && this._tryGrowPool()) {
            p = this.pool.malloc(bytes);
        }
        if (!p) {
            throw new RangeError('UInt32SharedMap: malloc failed (out of memory)');
        }
        return p >>> 0;
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

    private _maybeRehashForLoad(): void {
        const n = this.meta[META.length] >>> 0;
        const cap = this.meta[META.maxSize] >>> 0;
        if (cap < 1) return;
        if (exceedsLoadFactor(n, cap)) {
            const next = this._nextBucketCapacityForCount(n, cap);
            if (next > cap) {
                this._rehashToCapacity(next);
            }
        }
    }

    private _ensureSlotForNewKey(key: number): void {
        const n = this.meta[META.length] >>> 0;
        const cap = this.meta[META.maxSize] >>> 0;
        if (n >= cap && this._find(key) === undefined) {
            this._rehashToCapacity(this._nextBucketCapacityForCount(n + 1, cap));
        }
    }

    _bucketOccupied(pos: number): boolean {
        return this.bucketUsed[pos] !== 0;
    }

    _match(key: number, pos: number): boolean {
        return this.keysData[pos] === (key >>> 0);
    }

    _readValue(pos: number): number {
        return this.valuesData[pos] >>> 0;
    }

    _write(pos: number, key: number, value: number): void {
        this.keysData[pos] = key >>> 0;
        this.valuesData[pos] = value >>> 0;
        this.bucketUsed[pos] = 1;
    }

    _clearBucket(pos: number): void {
        this.keysData[pos] = 0;
        this.valuesData[pos] = 0;
        this.bucketUsed[pos] = 0;
    }

    _hashKey(key: number): number {
        return hashU32(key, this.meta[META.maxSize] >>> 0);
    }

    private _putPair(key: number, value: number): boolean {
        let pos = this._hashKey(key);
        let toChain: number | undefined;
        while (this._bucketOccupied(pos)) {
            this.stats.collisions++;
            if (this._match(key, pos)) {
                this.valuesData[pos] = value >>> 0;
                return false;
            }
            if (this.chaining[pos] === UINT32_MAX || toChain !== undefined) {
                if (toChain === undefined) {
                    toChain = pos;
                    pos = (pos + 1) % this.meta[META.maxSize];
                } else {
                    pos = (pos + 1) % this.meta[META.maxSize];
                }
            } else {
                pos = this.chaining[pos];
            }
        }
        this._write(pos, key, value);
        this.chaining[pos] = UINT32_MAX;
        this.meta[META.length] = (this.meta[META.length] >>> 0) + 1;
        if (toChain !== undefined) {
            this.chaining[toChain] = pos;
        }
        return true;
    }

    set(key: number, value: number): void {
        if (typeof key !== 'number' || typeof value !== 'number') {
            throw new TypeError('UInt32SharedMap: key and value must be numbers');
        }
        const k = key >>> 0;
        const v = value >>> 0;
        this.stats.set++;

        const existing = this._find(k);
        if (existing !== undefined) {
            this.valuesData[existing.pos] = v;
            return;
        }
        this._ensureSlotForNewKey(k);
        const inserted = this._putPair(k, v);
        if (inserted) {
            this._maybeRehashForLoad();
        }
    }

    _find(key: number): FindResult | undefined {
        let pos = this._hashKey(key);
        let previous = UINT32_MAX;
        this.stats.get++;
        while (pos !== UINT32_MAX && this._bucketOccupied(pos)) {
            if (this._match(key, pos)) {
                return { pos, previous };
            }
            previous = pos;
            pos = this.chaining[pos];
        }
        return undefined;
    }

    get(key: number): number | undefined {
        const k = key >>> 0;
        const pos = this._find(k);
        if (pos !== undefined) {
            return this._readValue(pos.pos);
        }
        return undefined;
    }

    has(key: number): boolean {
        return this.get(key) !== undefined;
    }

    delete(key: number): void {
        const k = key >>> 0;
        const find = this._find(k);
        if (find === undefined) {
            throw new RangeError(`UInt32SharedMap does not contain key ${k}`);
        }
        this.stats.delete++;
        const { pos, previous } = find;
        const next = this.chaining[pos];
        this._clearBucket(pos);
        if (previous !== UINT32_MAX) {
            this.chaining[previous] = next === UINT32_MAX ? UINT32_MAX : next;
        }
        this.meta[META.length] = (this.meta[META.length] >>> 0) - 1;
        if (next === UINT32_MAX) {
            return;
        }
        this.stats.rechains++;
        let el = next;
        const chain: ChainEntry[] = [];
        while (el !== UINT32_MAX) {
            chain.push({
                key: this.keysData[el] >>> 0,
                value: this._readValue(el),
            });
            this._clearBucket(el);
            this.meta[META.length] = (this.meta[META.length] >>> 0) - 1;
            el = this.chaining[el];
        }
        for (const entry of chain) {
            this._putPair(entry.key, entry.value);
        }
    }

    *keys(): Generator<number, void, unknown> {
        for (const [key] of this._bucketEntryPairs()) {
            yield key;
        }
    }

    /**
     * All `(key, value)` pairs in insertion order of bucket index (same order as {@link keys}).
     * Iterator shape matches {@link Map.prototype.entries}: each step is `[key, value]`.
     * Uses the same single-pass bucket scan as {@link UInt32SharedMap._collectEntries} (no per-key `get`).
     */
    entries(): IterableIterator<readonly [number, number]> {
        return this._bucketEntryPairs() as IterableIterator<readonly [number, number]>;
    }

    map<R>(cb: (value: number, key: number) => R): R[];
    map<R, T>(cb: (this: T, value: number, key: number) => R, thisArg: T): R[];
    map<R, T>(cb: (this: T | undefined, value: number, key: number) => R, thisArg?: T): R[] {
        const a: R[] = [];
        for (const [k, v] of this._bucketEntryPairs()) {
            a.push(cb.call(thisArg, v, k));
        }
        return a;
    }

    reduce<R>(cb: (acc: R, value: number, key: number) => R, initialValue: R): R {
        let acc = initialValue;
        for (const [k, v] of this._bucketEntryPairs()) {
            acc = cb(acc, v, k);
        }
        return acc;
    }

    clear(): void {
        this.keysData.fill(0);
        this.valuesData.fill(0);
        this.bucketUsed.fill(0);
        this.chaining.fill(UINT32_MAX);
        this.meta[META.length] = 0;
    }

    /** Release the table block back to the pool. */
    destroy(): void {
        if (this.ptr) {
            this.pool.free(this.ptr);
            this.ptr = 0;
        }
    }
}
