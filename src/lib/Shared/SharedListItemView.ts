/**
 * View bound to one row in {@link SharedList} / {@link MSharedList} storage. A single instance is
 * rebound via {@link ISharedListItemView.attachAt} on each read / iteration step.
 */
export interface ISharedListItemView {
    /** Row bytes for {@link SharedList.push} / inserts; length must equal the list row size. */
    get bytes(): Uint8Array<ArrayBufferLike>;
    /**
     * Bind this singleton to `byteLength` bytes at `byteOffset` in `buffer`
     * (e.g. one `DataView` over `buffer` plus a stored offset, same idea as `EdgeView`).
     *
     * @param itemIndex — Current row index (for {@link nextItem} bounds).
     * @param listLength — Row count in this list when attached (cached for fast {@link nextItem}).
     */
    attachAt(
        buffer: ArrayBufferLike,
        byteOffset: number,
        byteLength: number,
        itemIndex: number,
        listLength: number,
    ): void;

    /**
     * Advance to the next row in the same list without reallocating views: `off += byteLength`,
     * unless there is no next row. Returns `this` or `undefined` when already at the last item.
     */
    nextItem(): ISharedListItemView | undefined;
}

/** Reference u32 row view with fast in-list stepping via {@link nextItem}. */
export class SharedListItemView implements ISharedListItemView {
    protected itemIndex = 0;
    protected listLength = 0;
    protected itemByteSize = 0;
    protected buffer!: ArrayBufferLike;
    protected off = 0;
    protected dv!: DataView;
    protected readonly writeScratch: Uint8Array;

    constructor(rowByteSize = 4) {
        if (!Number.isInteger(rowByteSize) || rowByteSize < 1) {
            throw new RangeError('SharedListItemView: rowByteSize must be a positive integer');
        }
        this.writeScratch = new Uint8Array(rowByteSize);
        this.itemByteSize = rowByteSize;
        this.attachAt(this.writeScratch.buffer, this.writeScratch.byteOffset, rowByteSize, 0, 1);
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return new Uint8Array(this.buffer, this.off, this.itemByteSize);
    }

    attachAt(
        buffer: ArrayBufferLike,
        byteOffset: number,
        byteLength: number,
        itemIndex: number,
        listLength: number,
    ): void {
        this.itemByteSize = byteLength;
        this.itemIndex = itemIndex;
        this.listLength = listLength >>> 0;
        this.buffer = buffer;
        this.off = byteOffset;
        this.dv = new DataView(buffer, 0, buffer.byteLength);
    }

    nextItem(): ISharedListItemView | undefined {
        if (this.itemIndex + 1 >= this.listLength) {
            return undefined;
        }
        this.itemIndex += 1;
        this.off += this.itemByteSize;
        return this;
    }

    set u32(v: number) {
        this.dv.setUint32(this.off, v >>> 0, true);
    }

    get u32(): number {
        return this.dv.getUint32(this.off, true);
    }
}

/** @deprecated Use {@link ISharedListItemView} */
export type SharedListView = ISharedListItemView;
