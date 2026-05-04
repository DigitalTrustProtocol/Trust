import MSharedList from "../../Shared/MSharedList.js";
import SharedMapTyped from "../../Shared/SharedMapTyped.js";
import SharedList from "../../Shared/SharedList.js";
import { EdgeItemView } from "./EdgeItemView.js";
import { TrustItemView } from "./TrustItemView.js";

export interface IWorkerGraphData {
    outMap?: SharedMapTyped;
    inMap?: SharedMapTyped;
    trusts?: SharedList<TrustItemView>;
    edges?: MSharedList<EdgeItemView>;
    /**
     * List id inside {@link edges} where each row is an {@link EdgeItemView}.
     * Omit to call {@link MSharedList.createList} once on construction.
     */
    edgeRowsListId?: number;
}

function trustViewIsValidAt(trust: TrustItemView, now: number): boolean {
    const act = trust.activate >>> 0;
    const exp = trust.expire >>> 0;
    if (act !== 0 && now < act) return false;
    if (exp !== 0 && now > exp) return false;
    return true;
}

function sharedMapDeleteIfPresent(m: SharedMapTyped, key1: number, key2: number): void {
    if (!m.has(key1, key2)) return;
    m.delete(key1, key2);
}

/**
 * Worker-local graph buffers.
 *
 * - **outMap** `(authorNodeIndex, contextIndex) → edgeItemIndex` — index of a row in the
 *   {@link edges} list {@link edgeRowsListId}.
 * - **inMap** `(subjectNodeIndex, contextIndex) → edgeItemIndex` — same row index for the incoming side.
 * - Each **edges** row ({@link EdgeItemView}): `nodeIndex` = subject node index, `trustIndex` = row in {@link trusts}.
 */
export class WorkerGraph {
    public outMap: SharedMapTyped;
    public inMap: SharedMapTyped;
    public trusts: SharedList<TrustItemView>;
    public edges: MSharedList<EdgeItemView>;
    public readonly edgeRowsListId: number;

    private readonly _edgeScratch = new EdgeItemView();

    constructor(graphData: IWorkerGraphData) {
        this.outMap =
            graphData.outMap ??
            SharedMapTyped.createShared({
                initialBucketCapacity: 1000,
                maxByteLength: 1 << 24,
            });
        this.inMap =
            graphData.inMap ??
            SharedMapTyped.createShared({
                initialBucketCapacity: 1000,
                maxByteLength: 1 << 24,
            });

        this.trusts =
            graphData.trusts ??
            new SharedList<TrustItemView>(new SharedArrayBuffer(1000 * TrustItemView.SIZE), new TrustItemView(), TrustItemView.SIZE);
        this.edges =
            graphData.edges ??
            new MSharedList<EdgeItemView>(
                new SharedArrayBuffer(1000 * (TrustItemView.SIZE + EdgeItemView.SIZE)),
                new EdgeItemView(),
                EdgeItemView.SIZE,
            );

        this.edgeRowsListId = graphData.edgeRowsListId ?? this.edges.createList();
    }

    static trustViewIsValidAt(trust: TrustItemView, now: number): boolean {
        return trustViewIsValidAt(trust, now);
    }

    static from(graphData: IWorkerGraphData) {
        return new WorkerGraph(graphData);
    }

    toObject(): IWorkerGraphData {
        return {
            outMap: this.outMap,
            inMap: this.inMap,
            trusts: this.trusts,
            edges: this.edges,
            edgeRowsListId: this.edgeRowsListId,
        };
    }

    /** Append an edge row: subject node index + trust row index. Returns item index in {@link edgeRowsListId}. */
    pushEdgeRow(subjectNodeIndex: number, trustIndex: number): number {
        this._edgeScratch.update(subjectNodeIndex, trustIndex);
        this.edges.push(this.edgeRowsListId, this._edgeScratch);
        return this.edges.length(this.edgeRowsListId) - 1;
    }

    getEdgeItem(edgeItemIndex: number): EdgeItemView {
        return this.edges.getItem(this.edgeRowsListId, edgeItemIndex);
    }

    /**
     * Record outgoing `(authorNodeIndex, contextIndex)` → edges row and incoming `(subjectNodeIndex, contextIndex)` → same row.
     * Replaces an existing outgoing link for the same author+context; drops the previous subject's inMap entry.
     */
    upsertTrustLink(
        authorNodeIndex: number,
        contextIndex: number,
        subjectNodeIndex: number,
        trustIndex: number,
    ): number {
        this._edgeScratch.update(subjectNodeIndex, trustIndex);
        let listIndex = this.outMap.get(authorNodeIndex, contextIndex) ?? this.edges.createList();
        this.edges.push(listIndex, this._edgeScratch);
        this.outMap.set(authorNodeIndex, contextIndex, listIndex);
        this.inMap.set(subjectNodeIndex, contextIndex, listIndex);
        return listIndex;
    }

    /*
    removeTrustLink(authorNodeIndex: number, contextIndex: number, subjectNodeIndex: number, createdAt: number): void {
        const edgeItemIndex = this.outMap.get(authorNodeIndex, contextIndex);
        if (edgeItemIndex === undefined) return;

        let edge: EdgeItemView;
        try {
            edge = this.getEdgeItem(edgeItemIndex);
        } catch {
            return;
        }

        if ((edge.nodeIndex >>> 0) !== (subjectNodeIndex >>> 0)) return;

        const trust = this.trusts.get(edge.trustIndex);
        if (!trust) return;
        if (trust.createdAt > createdAt) return;

        sharedMapDeleteIfPresent(this.outMap, authorNodeIndex, contextIndex);
        sharedMapDeleteIfPresent(this.inMap, subjectNodeIndex, contextIndex);
    }
*/

    *outLinkKeysForAuthor(authorNodeIndex: number): Generator<{ contextIndex: number; edgeItemIndex: number }, void, undefined> {
        for (const k of this.outMap.keys()) {
            if ((k.key1 >>> 0) !== (authorNodeIndex >>> 0)) continue;
            const edgeItemIndex = this.outMap.get(k.key1, k.key2);
            if (edgeItemIndex === undefined) continue;
            yield { contextIndex: k.key2 >>> 0, edgeItemIndex };
        }
    }

    *inLinkKeysForSubject(subjectNodeIndex: number): Generator<{ contextIndex: number; edgeItemIndex: number }, void, undefined> {
        for (const k of this.inMap.keys()) {
            if ((k.key1 >>> 0) !== (subjectNodeIndex >>> 0)) continue;
            const edgeItemIndex = this.inMap.get(k.key1, k.key2);
            if (edgeItemIndex === undefined) continue;
            yield { contextIndex: k.key2 >>> 0, edgeItemIndex };
        }
    }
}
