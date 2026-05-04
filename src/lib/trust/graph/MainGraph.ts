import { VerifiedEvent } from 'nostr-tools';
import { extractSubjects, ITrustEvent, KIND_TRUST, SubjectType } from '../../nostr/nip32010.js';

import { Node } from './Node.js';
import { TrustItemView } from './TrustItemView.js';
import { IWorkerGraphData, WorkerGraph } from './WorkerGraph.js';
import { TrustIndexMap } from '../../TrustIndexMap.js';

export type GraphTrustValue = 1 | 0 | -1;

export interface GraphTrustEdgePayload {
  dTag: string;
  author: string;
  kind: number;
  value: GraphTrustValue;
  context: string;
  createdAt: number;
  activate?: number;
  expire?: number;
  content?: string;
}

export interface GraphTrustConnectionPayload {
  author: string;
  subject: string;
  subjectType: SubjectType;
  edge: GraphTrustEdgePayload;
}

export interface GraphTrustConnectionOptions {
  context?: string;
  value?: GraphTrustValue;
  subjectType?: SubjectType;
  includeInactive?: boolean;
}

export interface IGraph {
  applyTrustEvent(trust: ITrustEvent): boolean;
  removeTrustEvent(trust: ITrustEvent): boolean;
  removePubkey(pubkey: string, until: number): boolean;
  getContextIndexes(context: string, subjectType: SubjectType): Array<number>;
  applyUserMetadataEvent(event: VerifiedEvent): boolean;
  out(authorId: string, options?: GraphTrustConnectionOptions): GraphTrustConnectionPayload[];
  in(subjectId: string, options?: GraphTrustConnectionOptions): GraphTrustConnectionPayload[];
  addNode(id: string, type: SubjectType): Node;
  getNode(id: string): Node | null;
  createNode(id: string, type: SubjectType): Node;
  toObject(): unknown;
}

function contextKeyToPayloadContext(rawKey: string | null | undefined): string {
  if (rawKey == null || rawKey.length === 0) return '';
  if (rawKey.length > 2 && rawKey[1] === ':' && (rawKey[0] === 'p' || rawKey[0] === 'i')) {
    return rawKey.slice(2);
  }
  return rawKey;
}

export class MainGraph extends WorkerGraph implements IGraph {
  contextIndex: Map<string, number>;
  contextList: Array<string | null>;

  /** (authorIndex, contextIndex, subjectIndex) → row index in {@link WorkerGraph.trusts}. */
  trustIndex: TrustIndexMap;

  /** Per-node type flag: 1 = pubkey `p`, 0 = identity `i`. */
  nodeType: Array<number>;
  /** Parallel to {@link nodeType}: hex id at each node index. */
  nodeIds: string[];

  nodesIndex: Map<string, number>;

  eventAddedSinceLastSave = 0;
  eventRemovedSinceLastSave = 0;

  constructor(graphData: IWorkerGraphData) {
    super(graphData);

    this.contextIndex = new Map<string, number>();
    this.contextList = [];
    this.trustIndex = new TrustIndexMap();
    this.nodeType = [];
    this.nodeIds = [];
    this.nodesIndex = new Map<string, number>();
  }

  applyTrustEvent(trust: ITrustEvent): boolean {
    const authorId = trust.pubkey.toLowerCase();
    const authorIndex = this.ensureNodeIndex(authorId, 'p');

    const pContextIndex = this.applyContext(trust.c_tag ?? '', 'p');
    const iContextIndex = this.applyContext(trust.c_tag ?? '', 'i');

    const subjects = extractSubjects(trust);
    if (subjects.length === 0) return false;

    let applied = 0;
    for (const subject of subjects) {
      const subjectId = subject.value;
      const subjectType: SubjectType = subject.tag;
      const subjectIndex = this.ensureNodeIndex(subjectId, subjectType);

      const contextIndex = subjectType === 'p' ? pContextIndex : iContextIndex;

      const trustRowIndex = this.addTrust(authorIndex, contextIndex, subjectIndex, trust);
      if (trustRowIndex === undefined) continue; // Trust add failed, skip this subject and try the next one

      const trustView = this.trusts.get(trustRowIndex);
      if (!trustView) continue; // Should never happen
      const value = trustView.value;
      const createdAt = trustView.createdAt;


      if (value !== 0) {
        this.upsertTrustLink(authorIndex, contextIndex, subjectIndex, trustRowIndex);
      } else {
        //this.removeTrustLink(authorIndex, contextIndex, subjectIndex, createdAt); // Not needed yet
      }
      applied++;
    }

    if (applied === 0) return false;
    this.eventAddedSinceLastSave++;
    return true;
  }

  removeTrustEvent(_trust: ITrustEvent): boolean {
    return false;
  }

  removePubkey(_pubkey: string, _until: number): boolean {
    return false;
  }

  getContextIndexes(context: string, subjectType: SubjectType): Array<number> {
    const result: Array<number> = [];
    const contexts = [subjectType, ...context.split(':')];

    let key = '';
    for (const segment of contexts) {
      key += key.length > 0 ? ':' + segment : segment;
      const index = this.contextIndex.get(key);
      if (index !== undefined) result.push(index);
    }
    return result.reverse();
  }

  applyUserMetadataEvent(event: VerifiedEvent): boolean {
    const authorIndex = this.nodesIndex.get(event.pubkey.toLowerCase());
    if (authorIndex === undefined) return false;
    return true;
  }

  private edgePayloadFromTrust(
    trust: TrustItemView,
    authorId: string,
    contextIndex: number,
  ): GraphTrustEdgePayload {
    const rawKey = this.contextList[contextIndex];
    const context = contextKeyToPayloadContext(rawKey ?? undefined);
    return {
      dTag: trust.d_tag,
      author: authorId,
      kind: KIND_TRUST,
      value: trust.value as GraphTrustValue,
      context,
      createdAt: trust.createdAt,
      ...(trust.activate !== 0 ? { activate: trust.activate } : {}),
      ...(trust.expire !== 0 ? { expire: trust.expire } : {}),
    };
  }

  private connections(
    nodeId: string,
    direction: 'out' | 'in',
    options: GraphTrustConnectionOptions = {},
  ): GraphTrustConnectionPayload[] {
    const nodeIndex = this.nodesIndex.get(nodeId.toLowerCase());
    if (nodeIndex === undefined) return [];

    const subjectTypes = options.subjectType ? [options.subjectType] : (['p', 'i'] as SubjectType[]);
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const result: GraphTrustConnectionPayload[] = [];

    for (const subjectType of subjectTypes) {
      const contextIndexes = new Set(this.getContextIndexes(options.context ?? '', subjectType));

      const linkIter =
        direction === 'out'
          ? this.outLinkKeysForAuthor(nodeIndex)
          : this.inLinkKeysForSubject(nodeIndex);

      for (const { contextIndex, edgeItemIndex } of linkIter) {
        if (!contextIndexes.has(contextIndex)) continue;

        let edgeRow;
        try {
          edgeRow = this.getEdgeItem(edgeItemIndex);
        } catch {
          continue;
        }

        const trust = this.trusts.get(edgeRow.trustIndex);
        if (!trust) continue;
        if (!options.includeInactive && !WorkerGraph.trustViewIsValidAt(trust, now)) continue;
        if (options.value !== undefined && trust.value !== options.value) continue;

        const subjectIndex = edgeRow.nodeIndex >>> 0;
        const authorTrustIndex = trust.authorIndex >>> 0;
        const authorIndex = direction === 'out' ? nodeIndex : authorTrustIndex;
        const subjectNodeIndex = direction === 'out' ? subjectIndex : nodeIndex;

        const subjectTypeAt = this.nodeType[subjectNodeIndex] === 1 ? 'p' : 'i';
        if (options.subjectType && subjectTypeAt !== options.subjectType) continue;

        const authorHex = this.nodeIds[authorIndex];
        const subjectHex = this.nodeIds[subjectNodeIndex];
        if (authorHex === undefined || subjectHex === undefined) continue;

        const dedupeKey = `${authorIndex}:${subjectNodeIndex}:${edgeItemIndex}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        result.push({
          author: authorHex,
          subject: subjectHex,
          subjectType: subjectTypeAt,
          edge: this.edgePayloadFromTrust(trust, authorHex, contextIndex),
        });
      }
    }

    return result;
  }

  out(authorId: string, options: GraphTrustConnectionOptions = {}): GraphTrustConnectionPayload[] {
    return this.connections(authorId, 'out', options);
  }

  in(subjectId: string, options: GraphTrustConnectionOptions = {}): GraphTrustConnectionPayload[] {
    return this.connections(subjectId, 'in', options);
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

  addNode(id: string, type: SubjectType): Node {
    const idx = this.ensureNodeIndex(id, type);
    return this.nodeViewAt(idx);
  }

  createNode(id: string, type: SubjectType): Node {
    const lower = id.toLowerCase();
    if (this.nodesIndex.has(lower)) {
      return this.nodeViewAt(this.nodesIndex.get(lower)!);
    }
    const idx = this.allocateNodeIndex(lower, type);
    return this.nodeViewAt(idx);
  }

  removeNode(id: string): number | undefined {
    const lower = id.toLowerCase();
    const index = this.nodesIndex.get(lower);
    if (index === undefined) return undefined;
    this.nodesIndex.delete(lower);
    return index;
  }

  /**
   * Returns the trust list index for this author–context–subject triple, creating or updating
   * the corresponding row. `undefined` when the event is older than the stored row for that triple.
   */
  private addTrust(
    authorIndex: number,
    contextIndex: number,
    subjectIndex: number,
    trust: ITrustEvent,
  ): number | undefined {
    const existing = this.trustIndex.getAt(authorIndex, contextIndex, subjectIndex);
    if (existing !== undefined) {
      const tv = this.trusts.get(existing);
      if (!tv) return undefined; // Should never happen
      if (tv.createdAt > trust.created_at) return undefined;
      if (tv.createdAt < trust.created_at) tv.update(trust, authorIndex);
      return existing;
    }

    const row = new TrustItemView();
    row.update(trust, authorIndex);
    const trustIndex = this.trusts.add(row);
    this.trustIndex.setAt(authorIndex, contextIndex, subjectIndex, trustIndex);
    return trustIndex;
  }

  applyContext(context: string, subjectType: SubjectType): number {
    const key = subjectType + (context.length > 0 ? ':' : '') + context;
    return this.addContext(key);
  }

  getContextIndex(context: string, subjectType: SubjectType): number | undefined {
    const key = subjectType + (context.length > 0 ? ':' : '') + context;
    return this.contextIndex.get(key);
  }

  addContext(context: string): number {
    let index = this.contextIndex.get(context);
    if (index !== undefined) return index;
    index = this.contextList.push(context) - 1;
    this.contextIndex.set(context, index);
    return index;
  }

  removeContext(context: string): number {
    const index = this.contextIndex.get(context);
    if (index === undefined) return 0;
    const contextItem = this.contextList[index];
    if (!contextItem) return 0;
    this.contextList[index] = null;
    this.contextIndex.delete(context);
    return index;
  }

  getNode(id: string): Node | null {
    const lower = id.toLowerCase();
    const idx = this.nodesIndex.get(lower);
    if (idx === undefined) return null;
    return this.nodeViewAt(idx);
  }

  private nodeViewAt(idx: number): Node {
    const t: SubjectType = this.nodeType[idx] === 1 ? 'p' : 'i';
    const hex = this.nodeIds[idx] ?? '';
    const n = new Node(hex, t);
    n.index = idx;
    return n;
  }

  override toObject(): IWorkerGraphData & {
    contextIndex: Map<string, number>;
    contextList: Array<string | null>;
    nodeIds: string[];
    nodesIndex: Map<string, number>;
  } {
    return {
      ...super.toObject(),
      contextIndex: this.contextIndex,
      contextList: this.contextList,
      nodeIds: this.nodeIds,
      nodesIndex: this.nodesIndex,
    };
  }
}
