import { SharedListItemView } from '../../Shared/SharedList.js';

export class EdgeItemView extends SharedListItemView {
    constructor() {
        super(EdgeItemView.SIZE);
    }

    update(nodeIndex: number, trustIndex: number): void {
        this.nodeIndex = nodeIndex;
        this.trustIndex = trustIndex;
    }

    set nodeIndex(value: number) {
        this.dv.setUint32(this.off, value >>> 0, true);
    }

    get nodeIndex(): number {
        return this.dv!.getUint32(this.off, true);
    }

    set trustIndex(value: number) {
        this.dv.setUint32(this.off + 4, value >>> 0, true);
    }

    get trustIndex(): number {
        return this.dv!.getUint32(this.off + 4, true);
    }

    static SIZE = 8;
}


export class EdgeListView extends SharedListItemView {
    constructor() {
        super(EdgeItemView.SIZE);
    }

    update(EdgeListIndex: number): void {
        this.listIndex = EdgeListIndex;
    }

    set listIndex(value: number) {
        this.dv.setUint32(this.off, value >>> 0, true);
    }

    get listIndex(): number {
        return this.dv!.getUint32(this.off, true);
    }

    static SIZE = 4;
}
