/**
 * SharedMapTyped — concurrent hash map in a SharedArrayBuffer.
 *
 * **Lineage.** The locking model, coalesced-chaining table, line locks, and
 * reader/writer maplock protocol follow the original **SharedMap** design by
 * [Momtchil Momtchev](mailto:momtchil@momtchev.com) (see
 * [mmomtchev/SharedMap](https://github.com/mmomtchev/SharedMap)). This file is a
 * **substantially altered derivative**: fixed-width binary records (two uint32
 * key parts, one uint32 value), a dedicated occupancy bitmap so `(0,0)` is a
 * valid key, a different hash over key words, `resize()`, TypeScript, and other
 * layout/API changes — not a drop-in replacement for the upstream class.
 *
 * @packageDocumentation
 */

const UINT32_MAX = 0xffffffff;
const UINT32_UNDEFINED = 0xffffffff;

const KEY_WORDS = 2;
const VALUE_WORDS = 1;

function _hashPair(k1: number, k2: number): number {
    let h = (Math.imul(k1 >>> 0, 0x9e3779b1) ^ (k2 >>> 0) * 0x85ebca6b) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0xc2b2ae3d) >>> 0;
    h ^= h >>> 16;
    h = h >>> 0;
    return h === UINT32_UNDEFINED ? 1 : h;
}

function align32(v: number): number {
    return (v & 0xffffffffffffc) + (v & 0x3 ? 0x4 : 0);
}

const META = {
    maxSize: 0,
    length: 1,
} as const;

const LOCK = {
    SHAREDREAD: 0,
    READLOCK: 1,
    READERS: 2,
    SHAREDWRITE: 3,
    WRITELOCK: 4,
    WRITERS: 5,
} as const;

class Deadlock extends Error {
    constructor(message?: string, options?: ErrorOptions) {
        super(message, options);
    }
}

export interface SharedMapTypedOptions {
    lockWrite?: boolean;
    lockExclusive?: boolean;
}

/** Key pair as unsigned 32-bit components (low words of JS numbers). */
export interface SharedMapTypedKeyPair {
    key1: number;
    key2: number;
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

/**
 * Fixed-shape concurrent hash map: `(key1, key2) → value` with uint32 words
 * stored in a `SharedArrayBuffer`. See the file header for attribution to the
 * original SharedMap author and a summary of differences from upstream.
 */
export default class SharedMapTyped {
    /** Assigned in {@link SharedMapTyped._allocateStorage}. */
    storage!: SharedArrayBuffer;
    meta!: Uint32Array;
    keysData!: Uint32Array;
    valuesData!: Uint32Array;
    chaining!: Uint32Array;
    bucketUsed!: Uint8Array;
    linelocks!: Int32Array;
    maplock!: Int32Array;
    readonly stats: {
        set: number;
        delete: number;
        collisions: number;
        rechains: number;
        get: number;
        deadlock: number;
    };

    constructor(maxSize: number) {
        const aligned = align32(maxSize);
        if (!(aligned > 0)) throw new RangeError('maxSize must be a positive number');
        this.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, deadlock: 0 };
        this._allocateStorage(aligned);
    }

    /**
     * Build views for a zeroed SharedArrayBuffer sized for `maxSize` buckets.
     * `maxSize` must already be {@link align32 | aligned} and positive.
     */
    private _allocateStorage(maxSize: number): void {
        let offset = 0;
        const metaBytes = Object.keys(META).length * Uint32Array.BYTES_PER_ELEMENT;
        const keysBytes = KEY_WORDS * maxSize * Uint32Array.BYTES_PER_ELEMENT;
        const valuesBytes = VALUE_WORDS * maxSize * Uint32Array.BYTES_PER_ELEMENT;
        const chainBytes = maxSize * Uint32Array.BYTES_PER_ELEMENT;
        const usedBytes = maxSize * Uint8Array.BYTES_PER_ELEMENT;
        let afterUsed = offset + metaBytes + keysBytes + valuesBytes + chainBytes + usedBytes;
        afterUsed = (afterUsed + 3) & ~3;
        const lineBytes = Math.ceil(maxSize / 32) * Int32Array.BYTES_PER_ELEMENT;
        const lockBytes = Object.keys(LOCK).length * Int32Array.BYTES_PER_ELEMENT;

        this.storage = new SharedArrayBuffer(afterUsed - offset + lineBytes + lockBytes);

        offset = 0;
        this.meta = new Uint32Array(this.storage, offset, Object.keys(META).length);
        offset += this.meta.byteLength;
        this.meta[META.maxSize] = maxSize;
        this.meta[META.length] = 0;

        this.keysData = new Uint32Array(this.storage, offset, KEY_WORDS * maxSize);
        offset += this.keysData.byteLength;
        this.valuesData = new Uint32Array(this.storage, offset, VALUE_WORDS * maxSize);
        offset += this.valuesData.byteLength;
        this.chaining = new Uint32Array(this.storage, offset, maxSize);
        this.chaining.fill(UINT32_UNDEFINED);
        offset += this.chaining.byteLength;
        this.bucketUsed = new Uint8Array(this.storage, offset, maxSize);
        offset += this.bucketUsed.byteLength;
        offset = (offset + 3) & ~3;

        this.linelocks = new Int32Array(this.storage, offset, Math.ceil(maxSize / 32));
        offset += this.linelocks.byteLength;
        this.maplock = new Int32Array(this.storage, offset, Object.keys(LOCK).length);
    }

    /** Release {@link lockExclusive} on another map’s `maplock` view (same layout as this class). */
    private _unlockReadLockOn(maplock: Int32Array): void {
        const state = Atomics.exchange(maplock, LOCK.READLOCK, 0);
        if (state === 0) throw new Error('maplock desync ' + LOCK.READLOCK);
        Atomics.notify(maplock, LOCK.READLOCK);
    }

    /**
     * Replace backing storage with a new SharedArrayBuffer and reinsert all entries.
     * Must run when no other agents still rely on the previous buffer’s locks, or they must
     * adopt this instance’s new `storage` reference after `resize` returns.
     *
     * @param newMaxSize — new bucket capacity (aligned up to a multiple of 4); must be ≥ current {@link length}.
     */
    resize(newMaxSize: number): void {
        const aligned = align32(newMaxSize);
        if (!(aligned > 0)) throw new RangeError('newMaxSize must be a positive number');
        if (aligned < this.length) {
            throw new RangeError(
                `SharedMapTyped.resize: new capacity ${aligned} is smaller than current length ${this.length}`,
            );
        }
        if (aligned === this.size) return;

        this.lockExclusive();
        const oldMaplock = this.maplock;
        let releasedOldLock = false;
        try {
            const oldMax = this.meta[META.maxSize];
            const expectedLen = Atomics.load(this.meta, META.length);

            const tmp = new SharedMapTyped(aligned);
            tmp.lockExclusive();
            try {
                let copied = 0;
                for (let pos = 0; pos < oldMax; pos++) {
                    if (!this.bucketUsed[pos]) continue;
                    tmp._set(
                        this.keysData[pos * KEY_WORDS] >>> 0,
                        this.keysData[pos * KEY_WORDS + 1] >>> 0,
                        this._readValue(pos),
                        true,
                    );
                    copied++;
                }
                if (copied !== expectedLen) {
                    throw new Error('SharedMapTyped.resize: entry count does not match meta length');
                }
            } finally {
                tmp.unlockExclusive();
            }

            this._unlockReadLockOn(oldMaplock);
            releasedOldLock = true;

            this.storage = tmp.storage;
            this.meta = tmp.meta;
            this.keysData = tmp.keysData;
            this.valuesData = tmp.valuesData;
            this.chaining = tmp.chaining;
            this.bucketUsed = tmp.bucketUsed;
            this.linelocks = tmp.linelocks;
            this.maplock = tmp.maplock;
        } catch (e: unknown) {
            if (!releasedOldLock) this._unlockReadLockOn(oldMaplock);
            throw e;
        }

        this.stats.set = 0;
        this.stats.delete = 0;
        this.stats.collisions = 0;
        this.stats.rechains = 0;
        this.stats.get = 0;
        this.stats.deadlock = 0;
    }

    get length(): number {
        return Atomics.load(this.meta, META.length);
    }

    get size(): number {
        return this.meta[META.maxSize];
    }

    /* eslint-disable no-constant-condition */
    _lock(l: number): void {
        while (true) {
            const state = Atomics.exchange(this.maplock, l, 1);
            if (state === 0) return;
            Atomics.wait(this.maplock, l, state);
        }
    }

    _unlock(l: number): void {
        const state = Atomics.exchange(this.maplock, l, 0);
        if (state === 0) throw new Error('maplock desync ' + l);
        Atomics.notify(this.maplock, l);
    }

    _lockLine(pos: number): number {
        const bitmask = 1 << (pos % 32);
        const index = Math.floor(pos / 32);
        while (true) {
            const state = Atomics.or(this.linelocks, index, bitmask);
            if ((state & bitmask) === 0) return pos;
            Atomics.wait(this.linelocks, index, state);
        }
    }
    /* eslint-enable no-constant-condition */

    _unlockLine(pos: number): void {
        const bitmask = 1 << (pos % 32);
        const notbitmask = (~bitmask) & UINT32_MAX;
        const index = Math.floor(pos / 32);
        const state = Atomics.and(this.linelocks, index, notbitmask);
        if ((state & bitmask) === 0) throw new Error('linelock desync ' + pos);
        Atomics.notify(this.linelocks, index);
    }

    _lockLineSliding(oldLock: number, newLock: number): number {
        if (newLock <= oldLock) throw new Deadlock();
        this._lockLine(newLock);
        this._unlockLine(oldLock);
        return newLock;
    }

    lockExclusive(): void {
        this._lock(LOCK.READLOCK);
    }

    unlockExclusive(): void {
        this._unlock(LOCK.READLOCK);
    }

    _lockSharedRead(): void {
        this._lock(LOCK.SHAREDREAD);
        if (++this.maplock[LOCK.READERS] === 1) this._lock(LOCK.READLOCK);
        this._unlock(LOCK.SHAREDREAD);
    }

    _unlockSharedRead(): void {
        this._lock(LOCK.SHAREDREAD);
        if (--this.maplock[LOCK.READERS] === 0) this._unlock(LOCK.READLOCK);
        this._unlock(LOCK.SHAREDREAD);
    }

    _lockSharedWrite(): void {
        this._lockSharedRead();
        this._lock(LOCK.SHAREDWRITE);
        if (++this.maplock[LOCK.WRITERS] === 1) this._lock(LOCK.WRITELOCK);
        this._unlock(LOCK.SHAREDWRITE);
    }

    _unlockSharedWrite(): void {
        this._lock(LOCK.SHAREDWRITE);
        if (--this.maplock[LOCK.WRITERS] === 0) this._unlock(LOCK.WRITELOCK);
        this._unlock(LOCK.SHAREDWRITE);
        this._unlockSharedRead();
    }

    lockWrite(): void {
        this._lockSharedRead();
        this._lock(LOCK.WRITELOCK);
    }

    unlockWrite(): void {
        this._unlock(LOCK.WRITELOCK);
        this._unlockSharedRead();
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

    /* c8 ignore next 8 */
    _decodeBucket(pos: number, n: number): string {
        const { key1, key2 } = this._decodeKeyPair(pos);
        return (
            `pos: ${pos}` +
            ` hash: ${this._hashKey(key1, key2)}` +
            ` key: (${key1},${key2})` +
            ` value: ${this._readValue(pos)}` +
            ` chain: ${this.chaining[pos]}` +
            (n > 0 && this.chaining[pos] !== UINT32_UNDEFINED
                ? '\n' + this._decodeBucket(this.chaining[pos], n - 1)
                : '')
        );
    }
    /* c8 ignore next 5 */
    __printMap(): void {
        for (let i = 0; i < this.meta[META.maxSize]; i++) console.log(this._decodeBucket(i, 0));
        if (typeof process !== 'undefined') process.exit(1);
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

    _set(key1: number, key2: number, value: number, exclusive: boolean): void {
        let pos = this._hashKey(key1, key2);
        if (Atomics.load(this.meta, META.length) === this.meta[META.maxSize]) {
            if (!this._find(key1, key2, exclusive)) throw new RangeError('SharedMapTyped is full');
        }
        let toChain: number | undefined;
        let slidingLock: number | undefined;
        if (!exclusive) slidingLock = this._lockLine(pos);
        try {
            while (this._bucketOccupied(pos)) {
                this.stats.collisions++;
                if (this._match(key1, key2, pos)) {
                    this.valuesData[pos] = value >>> 0;
                    if (!exclusive) this._unlockLine(slidingLock!);
                    return;
                }
                if (this.chaining[pos] === UINT32_UNDEFINED || toChain !== undefined) {
                    if (toChain === undefined) {
                        toChain = pos;
                        pos = (pos + 1) % this.meta[META.maxSize];
                        if (!exclusive) slidingLock = this._lockLine(pos);
                    } else {
                        pos = (pos + 1) % this.meta[META.maxSize];
                        if (!exclusive) slidingLock = this._lockLineSliding(slidingLock!, pos);
                    }
                } else {
                    pos = this.chaining[pos];
                    if (!exclusive) slidingLock = this._lockLineSliding(slidingLock!, pos);
                }
            }
            this._write(pos, key1, key2, value);
            this.chaining[pos] = UINT32_UNDEFINED;
            Atomics.add(this.meta, META.length, 1);
            if (toChain !== undefined) {
                this.chaining[toChain] = pos;
                if (!exclusive) this._unlockLine(toChain);
                toChain = undefined;
            }
            if (!exclusive) this._unlockLine(slidingLock!);
        } catch (e) {
            if (!exclusive) {
                if (slidingLock !== undefined) this._unlockLine(slidingLock);
                if (toChain !== undefined) this._unlockLine(toChain);
            }
            throw e;
        }
    }

    set(key1: number, key2: number, value: number, opt?: SharedMapTypedOptions): void {
        if (typeof key1 !== 'number' || typeof key2 !== 'number') {
            throw new TypeError('SharedMapTyped keys must be numbers (key1, key2)');
        }
        if (typeof value !== 'number') throw new TypeError('SharedMapTyped value must be a number');

        const lockHeld = !!(opt?.lockWrite || opt?.lockExclusive);
        this.stats.set++;
        if (!lockHeld) this._lockSharedWrite();
        try {
            this._set(key1 >>> 0, key2 >>> 0, value, lockHeld);
            if (!lockHeld) this._unlockSharedWrite();
        } catch (e: unknown) {
            if (!lockHeld) this._unlockSharedWrite();
            if (e instanceof Deadlock && !lockHeld) {
                this.lockExclusive();
                this.stats.deadlock++;
                try {
                    this._set(key1 >>> 0, key2 >>> 0, value, true);
                    this.unlockExclusive();
                } catch (e2: unknown) {
                    this.unlockExclusive();
                    throw e2;
                }
            } else throw e;
        }
    }

    _find(key1: number, key2: number, exclusive: boolean): FindResult | undefined {
        let slidingLock: number | undefined;
        try {
            let pos = this._hashKey(key1, key2);
            let previous = UINT32_UNDEFINED;
            this.stats.get++;
            if (!exclusive) slidingLock = this._lockLine(pos);
            while (pos !== UINT32_UNDEFINED && this._bucketOccupied(pos)) {
                if (this._match(key1, key2, pos)) {
                    return { pos, previous };
                }
                previous = pos;
                pos = this.chaining[pos];
                if (pos !== UINT32_UNDEFINED && !exclusive) slidingLock = this._lockLineSliding(slidingLock!, pos);
            }
            if (!exclusive) this._unlockLine(slidingLock!);
            return undefined;
        } catch (e: unknown) {
            if (!exclusive && slidingLock !== undefined) this._unlockLine(slidingLock);
            throw e;
        }
    }

    /**
     * @returns Unsigned 32-bit value, or `undefined` if the key pair is absent.
     */
    get(key1: number, key2: number, opt?: SharedMapTypedOptions): number | undefined {
        let pos: FindResult | undefined;
        let val: number | undefined;
        const lockHeld = !!(opt?.lockWrite || opt?.lockExclusive);
        const k1 = key1 >>> 0;
        const k2 = key2 >>> 0;
        if (!lockHeld) this._lockSharedRead();
        try {
            pos = this._find(k1, k2, lockHeld);
            if (pos !== undefined) {
                val = this._readValue(pos.pos);
                if (!lockHeld) this._unlockLine(pos.pos);
            }
            if (!lockHeld) this._unlockSharedRead();
        } catch (e: unknown) {
            if (!lockHeld) this._unlockSharedRead();
            if (e instanceof Deadlock && !lockHeld) {
                this.lockExclusive();
                this.stats.deadlock++;
                try {
                    pos = this._find(k1, k2, true);
                    if (pos !== undefined) val = this._readValue(pos.pos);
                    this.unlockExclusive();
                } catch (e2: unknown) {
                    this.unlockExclusive();
                    throw e2;
                }
            } else throw e;
        }
        return val;
    }

    has(key1: number, key2: number, opt?: SharedMapTypedOptions): boolean {
        return this.get(key1, key2, opt) !== undefined;
    }

    delete(key1: number, key2: number, opt?: SharedMapTypedOptions): void {
        const lockHeld = !!(opt?.lockExclusive);
        if (opt?.lockWrite && !lockHeld) throw new Error('delete requires an exclusive lock');
        const k1 = key1 >>> 0;
        const k2 = key2 >>> 0;
        let find: FindResult | undefined;
        try {
            if (!lockHeld) this.lockExclusive();
            find = this._find(k1, k2, true);
        } catch (e: unknown) {
            if (!lockHeld) this.unlockExclusive();
            throw e;
        }
        if (find === undefined) {
            if (!lockHeld) this.unlockExclusive();
            throw new RangeError(`SharedMapTyped does not contain key (${k1}, ${k2})`);
        }
        this.stats.delete++;
        const { pos, previous } = find;
        const next = this.chaining[pos];
        this._clearBucket(pos);
        if (previous !== UINT32_UNDEFINED) {
            this.chaining[previous] = next === UINT32_UNDEFINED ? UINT32_UNDEFINED : next;
        }
        Atomics.sub(this.meta, META.length, 1);
        if (next === UINT32_UNDEFINED) {
            if (!lockHeld) this.unlockExclusive();
            return;
        }
        this.stats.rechains++;
        let el = next;
        const chain: ChainEntry[] = [];
        while (el !== UINT32_UNDEFINED) {
            chain.push({
                key1: this.keysData[el * KEY_WORDS] >>> 0,
                key2: this.keysData[el * KEY_WORDS + 1] >>> 0,
                value: this._readValue(el),
            });
            this._clearBucket(el);
            Atomics.sub(this.meta, META.length, 1);
            el = this.chaining[el];
        }
        for (const entry of chain) {
            this._set(entry.key1, entry.key2, entry.value, true);
        }
        if (!lockHeld) this.unlockExclusive();
    }

    *_keys(exclusive: boolean | undefined): Generator<number, void, unknown> {
        for (let pos = 0; pos < this.meta[META.maxSize]; pos++) {
            if (!exclusive) this._lockSharedRead();
            if (!exclusive) this._lockLine(pos);
            if (this._bucketOccupied(pos)) {
                yield pos;
            } else {
                if (!exclusive) this._unlockLine(pos);
                if (!exclusive) this._unlockSharedRead();
            }
        }
    }

    *keys(opt?: SharedMapTypedOptions): Generator<SharedMapTypedKeyPair, void, unknown> {
        const lockHeld = !!(opt?.lockWrite || opt?.lockExclusive);
        for (const pos of this._keys(lockHeld)) {
            const k = this._decodeKeyPair(pos);
            if (!lockHeld) this._unlockLine(pos);
            if (!lockHeld) this._unlockSharedRead();
            yield k;
        }
    }

    map<R>(cb: (value: number, key1: number, key2: number) => R): R[];
    map<R, T>(cb: (this: T, value: number, key1: number, key2: number) => R, thisArg: T): R[];
    map<R, T>(
        cb: (this: T | undefined, value: number, key1: number, key2: number) => R,
        thisArg?: T,
    ): R[] {
        const a: R[] = [];
        for (const pos of this._keys(undefined)) {
            const { key1, key2 } = this._decodeKeyPair(pos);
            const v = this._readValue(pos);
            try {
                a.push(cb.call(thisArg, v, key1, key2));
                this._unlockLine(pos);
                this._unlockSharedRead();
            } catch (e: unknown) {
                this._unlockLine(pos);
                this._unlockSharedRead();
                throw e;
            }
        }
        return a;
    }

    reduce<R>(cb: (acc: R, value: number, key1: number, key2: number) => R, initialValue: R): R {
        let acc = initialValue;
        for (const pos of this._keys(false)) {
            const { key1, key2 } = this._decodeKeyPair(pos);
            const v = this._readValue(pos);
            try {
                acc = cb(acc, v, key1, key2);
                this._unlockLine(pos);
                this._unlockSharedRead();
            } catch (e: unknown) {
                this._unlockLine(pos);
                this._unlockSharedRead();
                throw e;
            }
        }
        return acc;
    }

    clear(): void {
        this.lockExclusive();
        this.keysData.fill(0);
        this.valuesData.fill(0);
        this.bucketUsed.fill(0);
        this.chaining.fill(UINT32_UNDEFINED);
        Atomics.store(this.meta, META.length, 0);
        this.unlockExclusive();
    }
}
