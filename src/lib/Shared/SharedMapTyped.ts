/**
 * SharedMapTyped — `(key1, key2) → value` hash map in a `SharedArrayBuffer`.
 *
 * **Concurrency.** No mutex, no line locks, no `Atomics`. Intended for **main-thread-only**
 * mutation (`set` / `delete` / `clear` / internal rehash); workers should treat the buffer as
 * **read-only** and only call `get` / `has` / `keys` / `map` / `reduce` after the producer publishes
 * updates (same model as {@link SharedList}).
 *
 * **Growth.** When the entry count **exceeds** `floor(0.75 × bucketCapacity)` after an insert, the
 * map is rehashed into a larger table (default next size `max(⌈n / 0.75⌉, 2 × current capacity)`,
 * aligned to 4 buckets). Explicit {@link resize} is still available. For growable buffers created
 * with {@link SharedMapTyped.createShared}, use {@link clone} or {@link growSharedBacking} like
 * {@link SharedList}.
 *
 * **Lineage.** Table shape (coalesced chaining, occupancy bitmap, uint32 key/value words) derives
 * from the earlier concurrent `SharedMapTyped` design; locking and `Atomics` were removed in
 * favor of the single-writer model above.
 *
 * @packageDocumentation
 */

export const UINT32_MAX = 0xffffffff;

const KEY_WORDS = 2;
const VALUE_WORDS = 1;

const LAYOUT_VERSION = 1;

/** `true` when entry count strictly exceeds 75% of bucket slots (`n × 100 > cap × 75`). */
function exceedsLoadFactor(n: number, cap: number): boolean {
    return n * 100 > cap * 75;
}

function _hashPair(k1: number, k2: number): number {
    let h = (Math.imul(k1 >>> 0, 0x9e3779b1) ^ (k2 >>> 0) * 0x85ebca6b) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0xc2b2ae3d) >>> 0;
    h ^= h >>> 16;
    h = h >>> 0;
    return h === UINT32_MAX ? 1 : h;
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

export interface SharedMapTypedKeyPair {
    key1: number;
    key2: number;
}

export interface SharedMapTypedConstructorOptions {
    ownedSharedBacking?: { initialByteLength: number; maxByteLength: number };
    initFresh?: { initialBucketCapacity: number };
}

export interface SharedMapTypedCreateSharedOptions {
    initialBucketCapacity: number;
    maxByteLength?: number;
}

export interface SharedMapTypedCloneOptions {
    newByteLength?: number;
    newMaxByteLength?: number;
}

interface FindResult {
    pos: number;
    previous: number;
}

interface ChainEntry {
    key1: number;
    key2: number;
    value: number;
}

export default class SharedMapTyped {
    public storage!: SharedArrayBuffer;
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
    private _ownedSharedBacking: { initialByteLength: number; maxByteLength: number } | undefined;

    constructor(storage: SharedArrayBuffer, options?: SharedMapTypedConstructorOptions) {
        this.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, rehash: 0 };
        this._ownedSharedBacking = options?.ownedSharedBacking;
        this.storage = storage;

        if (options?.initFresh) {
            const raw = options.initFresh.initialBucketCapacity;
            const cap = align32(raw);
            if (!(cap > 0)) {
                throw new RangeError('SharedMapTyped: initialBucketCapacity must be a positive number');
            }
            const need = totalBytesForBuckets(cap);
            if (need > storage.byteLength) {
                throw new RangeError('SharedMapTyped: buffer too small for initFresh layout');
            }
            this._bindViews(cap);
            this.meta[META.maxSize] = cap >>> 0;
            this.meta[META.length] = 0;
            this.meta[META.layoutVersion] = LAYOUT_VERSION;
            this.chaining.fill(UINT32_MAX);
            this.bucketUsed.fill(0);
            this.keysData.fill(0);
            this.valuesData.fill(0);
        } else {
            SharedMapTyped._attachFromStorageInto(this, storage);
        }
    }

    /**
     * Allocate a growable `SharedArrayBuffer` and build an empty map. Main thread owns writes;
     * workers attach with {@link SharedMapTyped.from}.
     */
    static createShared(options: SharedMapTypedCreateSharedOptions): SharedMapTyped {
        const cap = align32(options.initialBucketCapacity);
        if (!(cap > 0)) {
            throw new RangeError('SharedMapTyped.createShared: initialBucketCapacity must be positive');
        }
        const need = totalBytesForBuckets(cap);
        const minMax = Math.max(need * 4, need + 4096);
        const maxB = Math.max(options.maxByteLength ?? minMax, need);
        if (!Number.isInteger(maxB) || maxB < need) {
            throw new RangeError('SharedMapTyped.createShared: maxByteLength must be ≥ layout size');
        }
        const sab = createGrowableSharedArrayBuffer(need, maxB);
        return new SharedMapTyped(sab, {
            initFresh: { initialBucketCapacity: cap },
            ownedSharedBacking: { initialByteLength: need, maxByteLength: maxB },
        });
    }

    /** Attach to an existing buffer (e.g. worker); use only for reads unless coordinated with the writer. */
    static from(storage: SharedArrayBuffer): SharedMapTyped {
        const inst = Object.create(SharedMapTyped.prototype) as SharedMapTyped;
        inst.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, rehash: 0 };
        inst._ownedSharedBacking = undefined;
        inst.storage = storage;
        SharedMapTyped._attachFromStorageInto(inst, storage);
        return inst;
    }

    private static _attachFromStorageInto(target: SharedMapTyped, storage: SharedArrayBuffer): void {
        const minBytes = META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (storage.byteLength < minBytes) {
            throw new RangeError('SharedMapTyped.from: buffer too small for header');
        }
        const meta = new Uint32Array(storage, 0, META_WORDS);
        const maxSize = meta[META.maxSize] >>> 0;
        const length = meta[META.length] >>> 0;
        const ver = meta[META.layoutVersion] >>> 0;
        if (ver !== LAYOUT_VERSION) {
            throw new RangeError(`SharedMapTyped.from: unsupported layout version ${ver}`);
        }
        if (maxSize < 1 || length > maxSize) {
            throw new RangeError('SharedMapTyped.from: invalid meta header');
        }
        const need = totalBytesForBuckets(maxSize);
        if (need > storage.byteLength) {
            throw new RangeError('SharedMapTyped.from: buffer byteLength is smaller than embedded layout');
        }
        target.meta = meta;
        target._bindViews(maxSize);
    }

    private _bindViews(maxSize: number): void {
        let offset = META_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        this.meta = new Uint32Array(this.storage, 0, META_WORDS);
        this.keysData = new Uint32Array(this.storage, offset, KEY_WORDS * maxSize);
        offset += this.keysData.byteLength;
        this.valuesData = new Uint32Array(this.storage, offset, VALUE_WORDS * maxSize);
        offset += this.valuesData.byteLength;
        this.chaining = new Uint32Array(this.storage, offset, maxSize);
        offset += this.chaining.byteLength;
        this.bucketUsed = new Uint8Array(this.storage, offset, maxSize);
    }

    /** Refresh typed views after the backing buffer grew in place (same `maxSize` in header). */
    rebind(): void {
        const maxSize = this.meta[META.maxSize] >>> 0;
        this._bindViews(maxSize);
    }

    clone(options?: SharedMapTypedCloneOptions): SharedMapTyped {
        const oldBuf = this.storage;
        const oldLen = oldBuf.byteLength;
        const meta = this._ownedSharedBacking;
        const sabMax = readSharedArrayBufferMaxByteLength(oldBuf);
        const oldMax = meta?.maxByteLength ?? sabMax ?? oldLen;

        const newLen = options?.newByteLength ?? oldLen;
        if (!Number.isInteger(newLen) || newLen < oldLen) {
            throw new RangeError('SharedMapTyped.clone: newByteLength must be an integer ≥ current byteLength');
        }
        let newMax = options?.newMaxByteLength ?? oldMax;
        if (!Number.isInteger(newMax) || newMax < newLen) {
            throw new RangeError('SharedMapTyped.clone: newMaxByteLength must be an integer ≥ newByteLength');
        }

        const src = new Uint8Array(oldBuf, 0, oldLen);
        const nextBuf = createGrowableSharedArrayBuffer(newLen, newMax);
        new Uint8Array(nextBuf, 0, oldLen).set(src);

        const inst = Object.create(SharedMapTyped.prototype) as SharedMapTyped;
        inst.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, rehash: 0 };
        inst.storage = nextBuf;
        inst._ownedSharedBacking =
            meta !== undefined ? { initialByteLength: meta.initialByteLength, maxByteLength: newMax } : undefined;
        SharedMapTyped._attachFromStorageInto(inst, nextBuf);
        return inst;
    }

    growSharedBacking(targetByteLength: number): void {
        if (!this._ownedSharedBacking) {
            throw new RangeError('SharedMapTyped.growSharedBacking: only for buffers from createShared');
        }
        const sab = this.storage;
        const grow = (sab as { grow?: (n: number) => void }).grow;
        if (typeof grow !== 'function') {
            throw new RangeError('SharedMapTyped.growSharedBacking: SharedArrayBuffer is not growable');
        }
        const cur = sab.byteLength;
        if (!Number.isInteger(targetByteLength) || targetByteLength <= cur) {
            throw new RangeError(
                'SharedMapTyped.growSharedBacking: targetByteLength must be an integer > current length',
            );
        }
        const maxB = readSharedArrayBufferMaxByteLength(sab);
        if (maxB !== undefined && targetByteLength > maxB) {
            throw new RangeError(
                `SharedMapTyped.growSharedBacking: targetByteLength ${targetByteLength} exceeds maxByteLength ${maxB}`,
            );
        }
        grow.call(sab, targetByteLength);
        this.rebind();
    }

    get buffer(): SharedArrayBuffer {
        return this.storage;
    }

    get length(): number {
        return this.meta[META.length] >>> 0;
    }

    get size(): number {
        return this.meta[META.maxSize] >>> 0;
    }

    /**
     * Replace with a larger bucket table and rehash all entries.
     * @param newMaxSize — bucket capacity (aligned to a multiple of 4); must be ≥ current {@link length}.
     */
    resize(newMaxSize: number): void {
        const aligned = align32(newMaxSize);
        if (!(aligned > 0)) {
            throw new RangeError('newMaxSize must be a positive number');
        }
        if (aligned < this.length) {
            throw new RangeError(
                `SharedMapTyped.resize: new capacity ${aligned} is smaller than current length ${this.length}`,
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

    private _rehashToCapacity(newAlignedMax: number): void {
        const old = this;
        const need = totalBytesForBuckets(newAlignedMax);
        let newBuf: SharedArrayBuffer;
        let nextOwned: { initialByteLength: number; maxByteLength: number } | undefined;

        if (this._ownedSharedBacking) {
            const ceiling = Math.max(need * 4, need + 4096, this._ownedSharedBacking.maxByteLength);
            newBuf = createGrowableSharedArrayBuffer(need, ceiling);
            nextOwned = {
                initialByteLength: need,
                maxByteLength: readSharedArrayBufferMaxByteLength(newBuf) ?? ceiling,
            };
        } else {
            newBuf = new SharedArrayBuffer(need);
            nextOwned = undefined;
        }

        const fresh = new SharedMapTyped(newBuf, {
            initFresh: { initialBucketCapacity: newAlignedMax },
            ownedSharedBacking: nextOwned,
        });

        const n = old.meta[META.length] >>> 0;
        let copied = 0;
        const oldMax = old.meta[META.maxSize] >>> 0;
        for (let pos = 0; pos < oldMax; pos++) {
            if (!old.bucketUsed[pos]) {
                continue;
            }
            fresh._putPair(
                old.keysData[pos * KEY_WORDS] >>> 0,
                old.keysData[pos * KEY_WORDS + 1] >>> 0,
                old._readValue(pos),
            );
            copied++;
        }
        if (copied !== n) {
            throw new Error('SharedMapTyped._rehashToCapacity: entry count mismatch');
        }

        this.storage = fresh.storage;
        this.meta = fresh.meta;
        this.keysData = fresh.keysData;
        this.valuesData = fresh.valuesData;
        this.chaining = fresh.chaining;
        this.bucketUsed = fresh.bucketUsed;
        this._ownedSharedBacking = fresh._ownedSharedBacking;
        this.stats.rehash++;
    }

    private _maybeRehashForLoad(): void {
        const n = this.meta[META.length] >>> 0;
        const cap = this.meta[META.maxSize] >>> 0;
        if (cap < 1) {
            return;
        }
        if (exceedsLoadFactor(n, cap)) {
            const next = this._nextBucketCapacityForCount(n, cap);
            if (next > cap) {
                this._rehashToCapacity(next);
            }
        }
    }

    private _ensureSlotForNewKey(key1: number, key2: number): void {
        const n = this.meta[META.length] >>> 0;
        const cap = this.meta[META.maxSize] >>> 0;
        if (n >= cap && this._find(key1, key2) === undefined) {
            this._rehashToCapacity(this._nextBucketCapacityForCount(n + 1, cap));
        }
    }

    _bucketOccupied(pos: number): boolean {
        return this.bucketUsed[pos] !== 0;
    }

    _match(key1: number, key2: number, pos: number): boolean {
        const b = pos * KEY_WORDS;
        return this.keysData[b] === (key1 >>> 0) && this.keysData[b + 1] === (key2 >>> 0);
    }

    _readValue(pos: number): number {
        return this.valuesData[pos] >>> 0;
    }

    _decodeKeyPair(pos: number): SharedMapTypedKeyPair {
        const b = pos * KEY_WORDS;
        return { key1: this.keysData[b] >>> 0, key2: this.keysData[b + 1] >>> 0 };
    }

    _write(pos: number, key1: number, key2: number, value: number): void {
        const b = pos * KEY_WORDS;
        this.keysData[b] = key1 >>> 0;
        this.keysData[b + 1] = key2 >>> 0;
        this.valuesData[pos] = value >>> 0;
        this.bucketUsed[pos] = 1;
    }

    _clearBucket(pos: number): void {
        const b = pos * KEY_WORDS;
        this.keysData[b] = 0;
        this.keysData[b + 1] = 0;
        this.valuesData[pos] = 0;
        this.bucketUsed[pos] = 0;
    }

    _hashKey(key1: number, key2: number): number {
        return (_hashPair(key1, key2) >>> 0) % this.meta[META.maxSize];
    }

    /**
     * Insert or update an entry. Does not run load-factor rehash — callers decide.
     * @returns `true` if a new key was inserted (length increased).
     */
    private _putPair(key1: number, key2: number, value: number): boolean {
        let pos = this._hashKey(key1, key2);
        let toChain: number | undefined;
        while (this._bucketOccupied(pos)) {
            this.stats.collisions++;
            if (this._match(key1, key2, pos)) {
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
        this._write(pos, key1, key2, value);
        this.chaining[pos] = UINT32_MAX;
        this.meta[META.length] = (this.meta[META.length] >>> 0) + 1;
        if (toChain !== undefined) {
            this.chaining[toChain] = pos;
        }
        return true;
    }

    set(key1: number, key2: number, value: number): void {
        if (typeof key1 !== 'number' || typeof key2 !== 'number') {
            throw new TypeError('SharedMapTyped keys must be numbers (key1, key2)');
        }
        if (typeof value !== 'number') {
            throw new TypeError('SharedMapTyped value must be a number');
        }
        const k1 = key1 >>> 0;
        const k2 = key2 >>> 0;
        const v = value >>> 0;
        this.stats.set++;

        const existing = this._find(k1, k2);
        if (existing !== undefined) {
            this.valuesData[existing.pos] = v;
            return;
        }
        this._ensureSlotForNewKey(k1, k2);
        const inserted = this._putPair(k1, k2, v);
        if (inserted) {
            this._maybeRehashForLoad();
        }
    }

    _find(key1: number, key2: number): FindResult | undefined {
        let pos = this._hashKey(key1, key2);
        let previous = UINT32_MAX;
        this.stats.get++;
        while (pos !== UINT32_MAX && this._bucketOccupied(pos)) {
            if (this._match(key1, key2, pos)) {
                return { pos, previous };
            }
            previous = pos;
            pos = this.chaining[pos];
        }
        return undefined;
    }

    get(key1: number, key2: number): number | undefined {
        const k1 = key1 >>> 0;
        const k2 = key2 >>> 0;
        const pos = this._find(k1, k2);
        if (pos !== undefined) {
            return this._readValue(pos.pos);
        }
        return undefined;
    }

    has(key1: number, key2: number): boolean {
        return this.get(key1, key2) !== undefined;
    }

    delete(key1: number, key2: number): void {
        const k1 = key1 >>> 0;
        const k2 = key2 >>> 0;
        const find = this._find(k1, k2);
        if (find === undefined) {
            throw new RangeError(`SharedMapTyped does not contain key (${k1}, ${k2})`);
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
                key1: this.keysData[el * KEY_WORDS] >>> 0,
                key2: this.keysData[el * KEY_WORDS + 1] >>> 0,
                value: this._readValue(el),
            });
            this._clearBucket(el);
            this.meta[META.length] = (this.meta[META.length] >>> 0) - 1;
            el = this.chaining[el];
        }
        for (const entry of chain) {
            this._putPair(entry.key1, entry.key2, entry.value);
        }
    }

    *keys(): Generator<SharedMapTypedKeyPair, void, unknown> {
        const cap = this.meta[META.maxSize] >>> 0;
        for (let pos = 0; pos < cap; pos++) {
            if (this._bucketOccupied(pos)) {
                yield this._decodeKeyPair(pos);
            }
        }
    }

    map<R>(cb: (value: number, key1: number, key2: number) => R): R[];
    map<R, T>(cb: (this: T, value: number, key1: number, key2: number) => R, thisArg: T): R[];
    map<R, T>(
        cb: (this: T | undefined, value: number, key1: number, key2: number) => R,
        thisArg?: T,
    ): R[] {
        const a: R[] = [];
        for (const k of this.keys()) {
            const v = this.get(k.key1, k.key2);
            if (v !== undefined) {
                a.push(cb.call(thisArg, v, k.key1, k.key2));
            }
        }
        return a;
    }

    reduce<R>(cb: (acc: R, value: number, key1: number, key2: number) => R, initialValue: R): R {
        let acc = initialValue;
        for (const k of this.keys()) {
            const v = this.get(k.key1, k.key2);
            if (v !== undefined) {
                acc = cb(acc, v, k.key1, k.key2);
            }
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

    /* c8 ignore next 8 */
    _decodeBucket(pos: number, n: number): string {
        const { key1, key2 } = this._decodeKeyPair(pos);
        return (
            `pos: ${pos}` +
            ` hash: ${this._hashKey(key1, key2)}` +
            ` key: (${key1},${key2})` +
            ` value: ${this._readValue(pos)}` +
            ` chain: ${this.chaining[pos]}` +
            (n > 0 && this.chaining[pos] !== UINT32_MAX
                ? '\n' + this._decodeBucket(this.chaining[pos], n - 1)
                : '')
        );
    }

    /* c8 ignore next 5 */
    __printMap(): void {
        for (let i = 0; i < this.meta[META.maxSize]; i++) {
            console.log(this._decodeBucket(i, 0));
        }
        if (typeof process !== 'undefined') {
            process.exit(1);
        }
    }
}
