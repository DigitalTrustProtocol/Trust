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

export interface SharedListView {
    get bytes(): Uint8Array<ArrayBufferLike>;
    attach(bytes: Uint8Array<ArrayBufferLike>): void;
}

export class SharedListBytesView implements SharedListView {
    
    private _bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    attach(bytes: Uint8Array<ArrayBufferLike>): void {
        this._bytes = bytes;
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return this._bytes;
    }
}

export interface SharedListOptions<T extends SharedListView = SharedListBytesView> {
    maxByteLength?: number;
    createView?: () => T;
}

export interface SharedListEntry<T extends SharedListView> {
    index: number;
    item: T;
}

export default class SharedList<T extends SharedListView = SharedListBytesView> {
    public storage!: SharedArrayBuffer;
    private mutex!: Int32Array;
    private hdr!: Uint32Array;
    private data!: Uint8Array;
    private itemByteSize: number;
    private view: T;

    constructor(initialCapacity: number, itemBytes: number, options?: SharedListOptions<T>) {
        if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
            throw new RangeError('SharedList: initialCapacity must be a positive integer');
        }
        if (!Number.isInteger(itemBytes) || itemBytes < 1) {
            throw new RangeError('SharedList: itemBytes must be a positive integer');
        }
        this.itemByteSize = itemBytes;
        const layout0 = layoutOffsets(initialCapacity, itemBytes);
        const minMax = Math.max(layout0.totalBytes * 4, layout0.totalBytes + 4096);
        const maxB = Math.max(options?.maxByteLength ?? minMax, layout0.totalBytes);
        this.storage = new SharedArrayBuffer(layout0.totalBytes, { maxByteLength: maxB });
        this.mutex = new Int32Array(this.storage, 0, 1);
        this.hdr = new Uint32Array(this.storage, OFF_HDR, HDR_WORDS);
        Atomics.store(this.hdr, H.count, 0);
        Atomics.store(this.hdr, H.capacity, initialCapacity >>> 0);
        Atomics.store(this.hdr, H.itemBytes, itemBytes >>> 0);
        this.view = (options?.createView?.() ?? (new SharedListBytesView() as unknown as T)) as T;
        this._rebindData();
    }

    static from(storage: SharedArrayBuffer): SharedList<SharedListBytesView>;
    static from<T extends SharedListView>(storage: SharedArrayBuffer, createView: () => T): SharedList<T>;
    static from<T extends SharedListView>(
        storage: SharedArrayBuffer,
        createView?: () => T,
    ): SharedList<T> | SharedList<SharedListBytesView> {
        const minBytes = OFF_HDR + HDR_WORDS * Uint32Array.BYTES_PER_ELEMENT;
        if (storage.byteLength < minBytes) throw new RangeError('SharedList.from: buffer too small for header');
        const hdr = new Uint32Array(storage, OFF_HDR, HDR_WORDS);
        const count = Atomics.load(hdr, H.count) >>> 0;
        const capacity = Atomics.load(hdr, H.capacity) >>> 0;
        const itemBytes = Atomics.load(hdr, H.itemBytes) >>> 0;
        if (capacity < 1 || itemBytes < 1 || count > capacity) throw new RangeError('SharedList.from: invalid header');
        const need = layoutOffsets(capacity, itemBytes).totalBytes;
        if (need > storage.byteLength) throw new RangeError('SharedList.from: buffer byteLength is smaller than embedded layout');
        const inst = Object.create(SharedList.prototype) as SharedList<T>;
        inst.storage = storage;
        inst.mutex = new Int32Array(storage, 0, 1);
        inst.hdr = hdr;
        inst.itemByteSize = itemBytes;
        inst.view = (createView?.() ?? (new SharedListBytesView() as unknown as T)) as T;
        inst._rebindData();
        return inst;
    }

    get length(): number {
        return Atomics.load(this.hdr, H.count);
    }

    get capacity(): number {
        return Atomics.load(this.hdr, H.capacity);
    }

    get itemBytes(): number {
        return this.itemByteSize;
    }

    add(item: SharedListView): number {
        return this.push(item.bytes);
    }

    
    push(bytes: Uint8Array): number {
        if (bytes.length !== this.itemByteSize) {
            throw new RangeError(`SharedList: payload must be exactly ${this.itemByteSize} bytes`);
        }
        this._lock();
        try {
            let count = Atomics.load(this.hdr, H.count);
            if (count >= this.capacity) {
                this._growCapacity(this.capacity * 2);
                count = Atomics.load(this.hdr, H.count);
            }
            const offset = count * this.itemByteSize;
            this.data.set(bytes, offset);
            Atomics.store(this.hdr, H.count, count + 1);
            return count;
        } finally {
            this._unlock();
        }
    }

    delete(index: number): void {
        if (!Number.isInteger(index) || index < 0) throw new RangeError('SharedList: index must be a non-negative integer');
        this._lock();
        try {
            const count = Atomics.load(this.hdr, H.count);
            if (index >= count) throw new RangeError('SharedList: index out of range');
            const last = count - 1;
            if (index !== last) {
                const src = last * this.itemByteSize;
                const dst = index * this.itemByteSize;
                this.data.copyWithin(dst, src, src + this.itemByteSize);
            }
            Atomics.store(this.hdr, H.count, last);
        } finally {
            this._unlock();
        }
    }

    readAt(index: number): Uint8Array | null {
        if (!Number.isInteger(index) || index < 0) throw new RangeError('SharedList: index must be a non-negative integer');
        this._lock();
        try {
            if (index >= this.length) return null;
            const offset = index * this.itemByteSize;
            return this.data.subarray(offset, offset + this.itemByteSize);
        } finally {
            this._unlock();
        }
    }

    /**
     * Lock-free read of one row.
     * Use only when writers are not deleting/reordering rows while you read.
     */
    unsafeReadAt(index: number): Uint8Array | null {
        if (!Number.isInteger(index) || index < 0) throw new RangeError('SharedList: index must be a non-negative integer');
        const count = Atomics.load(this.hdr, H.count);
        if (index >= count) return null;
        const offset = index * this.itemByteSize;
        return this.data.subarray(offset, offset + this.itemByteSize);
    }

    itemAt(index: number): T | null {
        const bytes = this.readAt(index);
        if (bytes === null) return null;
        this.view.attach(bytes);
        return this.view;
    }

    /**
     * Lock-free typed view read.
     * Reuses the same view instance as {@link itemAt}.
     */
    unsafeItemAt(index: number): T | null {
        const bytes = this.unsafeReadAt(index);
        if (bytes === null) return null;
        this.view.attach(bytes);
        return this.view;
    }

    *iterateItems(): Generator<SharedListEntry<T>, void, undefined> {
        this._lock();
        try {
            const count = this.length;
            for (let i = 0; i < count; i++) {
                const offset = i * this.itemByteSize;
                this.view.attach(this.data.subarray(offset, offset + this.itemByteSize));
                yield { index: i, item: this.view };
            }
        } finally {
            this._unlock();
        }
    }

    /**
     * Lock-free iteration.
     * Captures `count` at iteration start; concurrent deletes/reorders can make yielded rows inconsistent.
     */
    *unsafeIterateItems(): Generator<SharedListEntry<T>, void, undefined> {
        const count = Atomics.load(this.hdr, H.count);
        for (let i = 0; i < count; i++) {
            const offset = i * this.itemByteSize;
            this.view.attach(this.data.subarray(offset, offset + this.itemByteSize));
            yield { index: i, item: this.view };
        }
    }

    clear(): void {
        this._lock();
        try {
            Atomics.store(this.hdr, H.count, 0);
        } finally {
            this._unlock();
        }
    }

    private _growCapacity(newCapacity: number): void {
        const itemBytes = Atomics.load(this.hdr, H.itemBytes);
        const oldLayout = layoutOffsets(this.capacity, itemBytes);
        const newLayout = layoutOffsets(newCapacity, itemBytes);
        if (newLayout.totalBytes > this.storage.maxByteLength) {
            throw new RangeError('SharedList: maxByteLength exceeded while growing');
        }
        if (newLayout.totalBytes > this.storage.byteLength) {
            this.storage.grow(newLayout.totalBytes);
        }
        Atomics.store(this.hdr, H.capacity, newCapacity >>> 0);
        this._rebindData();
        const oldData = new Uint8Array(this.storage, oldLayout.dataByteOffset, oldLayout.totalBytes - oldLayout.dataByteOffset);
        const newData = new Uint8Array(this.storage, newLayout.dataByteOffset, oldData.length);
        newData.set(oldData);
    }

    private _rebindData(): void {
        const l = layoutOffsets(this.capacity, this.itemByteSize);
        this.data = new Uint8Array(this.storage, l.dataByteOffset, this.capacity * this.itemByteSize);
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
        if (v !== 1) throw new Error('SharedList: mutex desync');
        Atomics.notify(this.mutex, 0);
    }
    /* eslint-enable no-constant-condition */
}
