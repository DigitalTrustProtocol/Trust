import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { SharedListView } from "../../Shared/SharedList.js";
import { IEdge } from "./Edge.js";

export class EdgeView implements SharedListView {
    private buffer! : Uint8Array<ArrayBufferLike>;
    private dv!: DataView;

    constructor(edge?: IEdge) {
        this.attach(new Uint8Array(EdgeView.SIZE));
        if (edge) {
            this.update(edge);
        }
    }

    attach(b: Uint8Array<ArrayBufferLike>): void {
        this.buffer = b;
        this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }

    update(edge: IEdge): void {
        this.d_tag = edge.parameterizedId;
        this.nodeIndex = edge.index ?? 0;
        this.activate = edge.activate ?? 0;
        this.expire = edge.expire ?? 0;
        this.createdAt = edge.createdAt;
        this.value = edge.value ?? 0;
    }


    set d_tag(value: string) {
        const bytes = hexToBytes(value);
        this.buffer.set(bytes, 0);
    }

    get d_tag(): string {
        const bytes = this.buffer.subarray(0, 32);
        return bytesToHex(bytes);
    }

    set nodeIndex(value: number) {
        this.dv.setUint32(32, value, true);
    }

    get nodeIndex(): number {
        return this.dv.getUint32(32, true); // node index on the SharedList
    }

    set activate(value: number) {
        this.dv.setUint32(36, value, true);
    }

    get activate(): number {
        return this.dv.getUint32(36, true); // byte timestamp seconds since epoch
    }

    set expire(value: number) {
        this.dv.setUint32(40, value, true);
    }

    get expire(): number {
        return this.dv.getUint32(40, true); // byte timestamp seconds since epoch
    }

    set createdAt(value: number) {
        this.dv.setUint32(44, value, true);
    }

    get createdAt(): number {
        return this.dv.getUint32(44, true); // byte timestamp seconds since epoch
    }

    set value(value: number) {
        this.dv.setInt8(48, value); // 1 | 0 | -1
    }

    get value(): number {
        return this.dv.getInt8(48); // 1 | 0 | -1
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return this.buffer;
    }

    static SIZE = 49;

}
