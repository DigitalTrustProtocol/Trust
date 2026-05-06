import MSharedList from "../../Shared/MSharedList.js";
import SharedMapTyped, { UINT32_MAX } from "../../Shared/SharedMapTyped.js";
import SharedList from "../../Shared/SharedList.js";
import { EdgeItemView, EdgeListView } from "./EdgeItemView.js";
import { TrustItemView } from "./TrustItemView.js";
import UInt32SharedMap from "../../Shared/UInt32SharedMap.js";
import SharedMemoryPool from "../../Shared/SharedMemoryPool.js";
import SharedTypeArray from "../../Shared/SharedTypeArray.js";
import { GraphTrustConnectionOptions, GraphTrustConnectionPayload } from "./Graph.js";

export interface IWorkerGraphData {
    pool?: SharedMemoryPool;
    buffer?: ArrayBufferLike;
    initFrom?: {
        outPtr?: number;
        inPtr?: number;
        trustsPtr?: number;
    }
}

function trustViewIsValidAt(trust: TrustItemView, now: number): boolean {
    const act = trust.activate >>> 0;
    const exp = trust.expire >>> 0;
    if (act !== 0 && now < act) return false;
    if (exp !== 0 && now > exp) return false;
    return true;
}

export class WorkerGraph {
    public out: UInt32SharedMap;
    public in: UInt32SharedMap;
    public trust: SharedTypeArray<TrustItemView>;

    protected pool: SharedMemoryPool;
    protected readonly _edgeItemView = new EdgeItemView();

    constructor(graphData: IWorkerGraphData) {

        this.pool = graphData.pool ?? new SharedMemoryPool();

        const initFrom = graphData.initFrom;
        const outPtr = initFrom?.outPtr;
        const inPtr = initFrom?.inPtr;
        const trustsPtr = initFrom?.trustsPtr;

        this.out = outPtr ? UInt32SharedMap.from(this.pool, outPtr) : new UInt32SharedMap({
            pool: this.pool,
            initFresh: { initialBucketCapacity: 1000 },
        });

        this.in = inPtr ? UInt32SharedMap.from(this.pool, inPtr) : new UInt32SharedMap({
            pool: this.pool,
            initFresh: { initialBucketCapacity: 1000 },
        });

        this.trust = trustsPtr
            ? SharedTypeArray.from<TrustItemView>(this.pool, trustsPtr)
            : SharedTypeArray.createInPool<TrustItemView>(this.pool, { initialCapacity: 1000 });
    }

    static trustViewIsValidAt(trust: TrustItemView, now: number): boolean {
        return trustViewIsValidAt(trust, now);
    }

    static from(graphData: IWorkerGraphData) {
        return new WorkerGraph(graphData);
    }

    serialize(): IWorkerGraphData {
        return {
            buffer: this.pool.buf,
            initFrom: {
                outPtr: this.out.ptr,
                inPtr: this.in.ptr,
                trustsPtr: this.trust.ptr,
            }
        };
    }



    getContextMap(map: UInt32SharedMap, nodeIndex: number): UInt32SharedMap | undefined {
        let contextPtr = map.get(nodeIndex);
        if (contextPtr === undefined) return undefined;
        return new UInt32SharedMap({ pool: this.pool, tablePtr: contextPtr });
    }

    getEdgeMap(contextMap: UInt32SharedMap, contextIndex: number): UInt32SharedMap | undefined {
        let edgePtr = contextMap.get(contextIndex);
        if (edgePtr === undefined) return undefined;
        return new UInt32SharedMap({ pool: this.pool, tablePtr: edgePtr });
    }
    /*
    getEdgeMap(map: UInt32SharedMap, nodeIndex: number, contextIndex: number): UInt32SharedMap | undefined {
        let contextPtr = map.get(nodeIndex);
        if (contextPtr === undefined) return undefined;
        let context = new UInt32SharedMap({ pool: this.pool, tablePtr: contextPtr });
        let edgePtr = context.get(contextIndex);
        if (edgePtr === undefined) return undefined;
        return new UInt32SharedMap({ pool: this.pool, tablePtr: edgePtr });
    }
*/

/*    
      in(subjectId: string, options: GraphTrustConnectionOptions = {}): GraphTrustConnectionPayload[] {
        return this.connections(subjectId, 'in', options);
      }
  */  
    ///getEdgeIndex



/*
    *outLinkKeysForAuthor(authorNodeIndex: number): Generator<EdgeItemView, void, undefined> {
        let listIndex = this.out.get(authorNodeIndex, UINT32_MAX);
        if (listIndex === undefined) return;
        for (const edgeItemView of this.edges.items(listIndex)) {
            yield edgeItemView;
        }
    }

    *inLinkKeysForSubject(subjectNodeIndex: number): Generator<EdgeItemView, void, undefined> {
        let listIndex = this.inMap.get(subjectNodeIndex, UINT32_MAX);
        if (listIndex === undefined) return;
        for (const edgeItemView of this.edges.items(listIndex)) {
            yield edgeItemView;
        }
    }
*/
}



/*

out:p:edges
out:i:edges
in:p:edges
in:i:edges




*/