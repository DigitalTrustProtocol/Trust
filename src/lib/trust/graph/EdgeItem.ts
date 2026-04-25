import { SharedLinkedListItemView } from "../../Shared/SharedLinkedList.js";

export class EdgeItem implements SharedLinkedListItemView {
    private dv!: DataView;

    attach(b: Uint8Array<ArrayBufferLike>): void {
        this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }

    get nodeIndex(): number {
        return this.dv.getUint32(0, true);
    }

    get edgeIndex(): number {
        return this.dv.getUint32(4, true);
    }

    get timeStamp(): number {
        return this.dv.getUint32(8, true);
    }

    get value(): number {
        return this.dv.getUint8(12);
    }

    static SIZE = 13;

}
