import { VerifiedEvent } from 'nostr-tools';
import { extractSubjects, ITrustEvent, KIND_TRUST, SubjectType } from '../../nostr/nip32010.js';

import { Node } from './Node.js';
import { TrustItemView } from './TrustItemView.js';
import { IWorkerGraphData, WorkerGraph } from './WorkerGraph.js';
import { TrustContext } from './ContextIndex.js';
import UInt32SharedMap from '../../Shared/UInt32SharedMap.js';

export type GraphTrustValue = 1 | 0 | -1;


export interface IGraph {
  applyTrustEvent(trust: ITrustEvent): boolean;
  removeTrustEvent(trust: ITrustEvent): boolean;
  removePubkey(pubkey: string, until: number): boolean;
  getContextIndexes(context: string, subjectType: SubjectType): Array<number>;
  applyUserMetadataEvent(event: VerifiedEvent): boolean;
  addNode(id: string, type: SubjectType): Node;
  getNode(id: string): Node | null;
  createNode(id: string, type: SubjectType): Node;
  serialize(): unknown;
}


export class MainGraph extends WorkerGraph {
  context: TrustContext;

  /** (authorIndex, contextIndex, subjectIndex) → row index in {@link WorkerGraph.trust}. */
  trustIndex: Map<string, number>;

  /** Per-node type flag: 1 = pubkey `p`, 0 = identity `i`. */
  nodeType: Array<number>;
  /** Parallel to {@link nodeType}: hex id at each node index. */
  nodeIds: string[];
  nodesIndex: Map<string, number>;




  eventAddedSinceLastSave = 0;
  eventRemovedSinceLastSave = 0;

  constructor(graphData: IWorkerGraphData) {
    super(graphData);

    this.context = new TrustContext();
    this.trustIndex = new Map<string, number>();
    this.nodeType = [];
    this.nodeIds = [];
    this.nodesIndex = new Map<string, number>();
  }

  applyTrustEvent(trust: ITrustEvent): boolean {
    const authorId = trust.pubkey.toLowerCase();
    const authorIndex = this.ensureNodeIndex(authorId, 'p');

    const trustIndex = this.ensureTrust(trust, authorIndex);
    if (trustIndex === undefined) return false; // Trust did not update or is too old, skip this event

    const subjects = extractSubjects(trust);
    if (subjects.length === 0) return false;

    const pContextIndex = this.context.ensure(trust.c_tag ?? '', 'p');
    const iContextIndex = this.context.ensure(trust.c_tag ?? '', 'i');

    for (const subject of subjects) {
      const subjectId = subject.value;
      const subjectType: SubjectType = subject.tag;
      const subjectIndex = this.ensureNodeIndex(subjectId, subjectType);
      const contextIndex = subjectType === 'p' ? pContextIndex : iContextIndex;

      this.ensureEdge(authorIndex, contextIndex, subjectIndex, trustIndex);
    }

    this.eventAddedSinceLastSave++;
    return true;
  }

  private ensureTrust(trust: ITrustEvent, authorIndex: number): number | undefined {
    const key = trust.d_tag;
    const index = this.trustIndex.get(key);
    if (index !== undefined) {

      const tv = this.trust.get(index);
      if (!tv) return undefined; // Should never happen
      if (tv.createdAt > trust.created_at) return undefined;
      if (tv.createdAt < trust.created_at) tv.update(trust, authorIndex);
      return index;
    }

    const tv = new TrustItemView();
    tv.update(trust, authorIndex);
    const trustIndex = this.trust.push(tv);
    this.trustIndex.set(key, trustIndex);

    return trustIndex;
  }

  private ensureEdge(authorIndex: number, contextIndex: number, subjectIndex: number, trustIndex: number): void {
    this.ensureEdgeMap(this.out, authorIndex, contextIndex, subjectIndex, trustIndex);
    this.ensureEdgeMap(this.in, subjectIndex, contextIndex, authorIndex, trustIndex);
  }

  private ensureEdgeMap(map: UInt32SharedMap, authorIndex: number, contextIndex: number, subjectIndex: number, trustIndex: number): void {

    const pool = this.pool;
    let context: UInt32SharedMap;
    let edge: UInt32SharedMap | undefined;

    const contextPtr = map.get(authorIndex);
    if (contextPtr === undefined) {
      const context = new UInt32SharedMap({ pool, initFresh: { initialBucketCapacity: 10 } });
      map.set(authorIndex, context.ptr);

      edge = new UInt32SharedMap({ pool, initFresh: { initialBucketCapacity: 10 } });
      context.set(contextIndex, edge.ptr);

    } else {

      let context = new UInt32SharedMap({ pool: this.pool, tablePtr: contextPtr });
      let edgePtr = context.get(contextIndex);
      edge = new UInt32SharedMap({ pool, tablePtr: edgePtr });

    }

    if (edge === undefined)
      console.trace('Edge map not found - this should never happen');

    edge!.set(subjectIndex, trustIndex);

  }

  removeTrustEvent(_trust: ITrustEvent): boolean {
    return false;
  }

  removePubkey(_pubkey: string, _until: number): boolean {
    return false;
  }

  applyUserMetadataEvent(event: VerifiedEvent): boolean {
    const authorIndex = this.nodesIndex.get(event.pubkey.toLowerCase());
    if (authorIndex === undefined) return false;
    return true;
  }

  /** Returns existing or newly allocated node index (hex id stored lowercased). */
  ensureNodeIndex(id: string, type: SubjectType): number {
    return this.nodesIndex.get(id) ?? this.allocateNodeIndex(id, type);
  }

  allocateNodeIndex(id: string, type: SubjectType): number {
    const index = this.nodeType.length;
    this.nodeType.push(type === 'p' ? 1 : 0);
    this.nodeIds.push(id);
    this.nodesIndex.set(id, index);
    return index;
  }




}
