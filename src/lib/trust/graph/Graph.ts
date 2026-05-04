import { VerifiedEvent } from 'nostr-tools';
import { extractSubjects, getValueFromTags, ITrustEvent, SubjectType } from '../../nostr/nip32010.js';

import { EdgeT1, IEdge } from './Edge.js';
import { Node } from './Node.js';

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
  toObject(): any;
}


export class Graph implements IGraph {

  nodesIndex: Map<string, number> = new Map();
  nodesList: Array<Node | null> = new Array<Node | null>();

  contextIndex: Map<string, number> = new Map();
  contextList: Array<string | null> = new Array<string | null>();

  edgesIndex: Map<string, number> = new Map();
  edgesList: Array<IEdge | null> = new Array<IEdge | null>();



  //outMap?: SharedMapTyped; // out map is a map of context indexes to a map of subject indexes to a map of edge indexes
  //inMap?: SharedMapTyped; // in map is a map of context indexes to a map of subject indexes to a map of edge indexes

  //nodes?: SharedList<NodeView>;
  //edges?: SharedList<EdgeView>;

  nodes: Uint8Array<ArrayBufferLike>;

  eventAddedSinceLastSave: number = 0;
  eventRemovedSinceLastSave: number = 0;


  toObject(): any {
    return {
      nodes: this.nodesList.length,
      edges: this.edgesList.length,
    };
  }


  constructor() {
    this.nodes = new Uint8Array(1000); // One byte data per node for now

    //this.nodes = new SharedList<NodeView>(1000, NodeView.SIZE);
    //this.edges = new SharedList<EdgeView>(1000, EdgeView.SIZE);
  }


  applyTrustEvent(trust: ITrustEvent): boolean {

    let edge = this.addEdge(trust);
    if (!edge) return false; // If the edge is not valid or too old, return false

    const authorId = trust.pubkey.toLowerCase();
    const authorNode = this.addNode(authorId, 'p'); // author is a pubkey, so type is 'p'

    // Keep both context buckets present for each trust event context.
    // Some resolver topology expectations rely on both p:* and i:* existing.
    const pContextIndex = this.applyContext(trust.c_tag ?? '', 'p');
    const iContextIndex = this.applyContext(trust.c_tag ?? '', 'i');

    const subjects = extractSubjects(trust);
    if (subjects.length === 0) return false;
    let value = edge.value;
    let createdAt = edge.createdAt;

    for (const subject of subjects) {
      const subjectId = subject.value;
      const subjectType: SubjectType = subject.tag;
      const subjectNode = this.addNode(subjectId, subjectType);

      const contextIndex = subjectType === 'p' ? pContextIndex : iContextIndex;
      

      if(value !== 0) {
        authorNode.addOut(contextIndex, subjectNode.index, edge.index!);
        subjectNode.addIn(contextIndex, authorNode.index, edge.index!);
      } else {
        authorNode.removeOut(this, contextIndex, subjectNode.index, createdAt);
        subjectNode.removeIn(this, contextIndex, authorNode.index, createdAt);
      }

      // Update the subject node identity with the ExstractedSubject
      //subjectNode.updateIdentity(subject);
    }
    this.eventAddedSinceLastSave++;
    return true;

  }

  removeTrustEvent(trust: ITrustEvent): boolean {
    let edgeIndex = this.edgesIndex.get(trust.addressableId);
    if (edgeIndex === undefined) return false; // No edge found for the parameterizedId
    let edge = this.edgesList[edgeIndex];
    if (!edge) {
      console.trace('Edge not found for parameterizedId: ' + trust.addressableId + ' in removeTrustEvent - Failsafe check, as this should never happen');
      return false; // Failsafe check, as this should never happen
    } 
    
    const authorId = trust.pubkey.toLowerCase();
    const authorNode = this.getNode(authorId);
    if (!authorNode) return false; // Author node not found for the pubkey

    const pContextIndex = this.getContextIndex(trust.c_tag ?? '', 'p');//this.addContext(trust);
    const iContextIndex = this.getContextIndex(trust.c_tag ?? '', 'i');//this.addContext(trust);
    
    const subjects = extractSubjects(trust);
    if (subjects.length === 0) return false;

    for (const subject of subjects) {
      const subjectId = subject.value;

      let subjectNodeIndex = this.nodesIndex.get(subjectId);
      if (subjectNodeIndex === undefined) continue;

      const subjectNode = this.nodesList[subjectNodeIndex];
      if (!subjectNode) continue;

      const contextIndex = subject.tag === 'p' ? pContextIndex : iContextIndex;
      if (contextIndex === undefined) continue;
      
      authorNode.removeOut(this, contextIndex, subjectNode.index, edge.createdAt);
      subjectNode.removeIn(this, contextIndex, authorNode.index, edge.createdAt);
    }
    return true;
  }


  removePubkey(pubkey: string, until: number = 0): boolean {
    const authorNode = this.getNode(pubkey);
    if (!authorNode) return false;

   
    for (const [contextIndex, subjectMap] of authorNode.out.entries()) {
      for (const [subjectIndex, value] of [...subjectMap.entries()]) {
        let subjectNode = this.nodesList[subjectIndex];
        if (!subjectNode) continue;
        authorNode.removeOut(this, contextIndex, subjectNode.index, until);
        subjectNode.removeIn(this, contextIndex, authorNode.index, until);
      }
    }
    
    for (const edgeIndex of authorNode.edges) {
      let edge = this.edgesList[edgeIndex];
      if (!edge) continue;
      if (edge.createdAt > until) continue;
      this.removeEdge(edge.addressableId);
    }


    if (authorNode.out.size === 0 && authorNode.in.size === 0) {
      // If the node has no incoming or outgoing edges, remove it
      // However, there may be other nodes pointing to this node, so we cannot remove it
      this.removeNode(pubkey);
    }

    return true;
  }

  getContextIndexes(context: string, subjectType: SubjectType): Array<number>{
    let result: Array<number> = [];
    
    // Split the context into an array of contexts
    let contexts = [subjectType, ...context.split(':')];
    
    let key = '';
    for (const segment of contexts) {
      key += key.length > 0 ? ':' + segment : segment; // Build the key for the next context

      let index = this.contextIndex.get(key);
      if (index !== undefined) result.push(index!);

    }
    return result.reverse(); // Return the result in the order of the contexts
  }


  applyUserMetadataEvent(event: VerifiedEvent): boolean {
    // Get the node for the author
    const authorNode = this.getNode(event.pubkey); // author is a pubkey, so type is 'p'
    if (!authorNode) return false; // update only if the node exists
    // Update the node with the user metadata
    authorNode.updateUserMetadata(event);
    return true;
  }

  private edgePayload(edge: IEdge): GraphTrustEdgePayload {
    return {
      dTag: edge.addressableId,
      author: edge.author,
      kind: edge.kind,
      value: edge.value,
      context: edge.context,
      createdAt: edge.createdAt,
      ...(edge.activate !== undefined ? { activate: edge.activate } : {}),
      ...(edge.expire !== undefined ? { expire: edge.expire } : {}),
      ...(edge.content !== undefined ? { content: edge.content } : {}),
    };
  }

  private connections(
    nodeId: string,
    direction: 'out' | 'in',
    options: GraphTrustConnectionOptions = {},
  ): GraphTrustConnectionPayload[] {
    const node = this.getNode(nodeId);
    if (!node) return [];

    const subjectTypes = options.subjectType ? [options.subjectType] : (['p', 'i'] as SubjectType[]);
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const result: GraphTrustConnectionPayload[] = [];

    for (const subjectType of subjectTypes) {
      const contextIndexes = this.getContextIndexes(options.context ?? '', subjectType);
      for (const contextIndex of contextIndexes) {
        const peerMap = node[direction].get(contextIndex);
        if (!peerMap) continue;

        for (const [peerIndex, edgeIndex] of peerMap.entries()) {
          const edge = this.edgesList[edgeIndex];
          if (!edge) continue;
          if (!options.includeInactive && !edge.isValidAt(now)) continue;
          if (options.value !== undefined && edge.value !== options.value) continue;

          const peerNode = this.nodesList[peerIndex];
          if (!peerNode) continue;

          const authorNode = direction === 'out' ? node : peerNode;
          const subjectNode = direction === 'out' ? peerNode : node;
          if (options.subjectType && subjectNode.type !== options.subjectType) continue;

          const key = `${authorNode.index}:${subjectNode.index}:${edgeIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);

          result.push({
            author: authorNode.id,
            subject: subjectNode.id,
            subjectType: subjectNode.type,
            edge: this.edgePayload(edge),
          });
        }
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

  addNode(id: string, type: SubjectType): Node  {
    let node: Node | null = null;
    let index = this.nodesIndex.get(id);
    if (index !== undefined) node = this.nodesList[index]; // ! is used to tell the compiler that the node is not null
    if (node) return node;
    node = this.createNode(id, type);
    
    this.eventAddedSinceLastSave++;
    return node;
  }

  getNode(id: string): Node | null {
    let index = this.nodesIndex.get(id);
    if (index === undefined) return null;
    let node = this.nodesList[index];
    if (!node) return null;
    return node;
  }

  createNode(id: string, type: SubjectType): Node {
    let node = new Node(id, type);
    node.index = this.nodesList.push(node) - 1;
    this.nodesIndex.set(id, node.index);
    return node;
  }

  removeNode(id: string): Node | null {
    let index = this.nodesIndex.get(id);
    if (index === undefined) return null;
    let node = this.nodesList[index];
    if (!node) return null;
    this.nodesList[index] = null;
    this.nodesIndex.delete(id);
    return node;
  }

  addEdge(trust: ITrustEvent): IEdge | null {
    let edge: IEdge | null = null;
    let index = this.edgesIndex.get(trust.addressableId); // Avoid internal object reference tracking (a design principle) 
    if (index !== undefined) edge = this.edgesList[index]!; // ! is used to tell the compiler that the edge is not null
    if (edge) {
      if (edge.createdAt > trust.created_at) return null; // If the edge is older than the new event, return null
      if (edge.createdAt < trust.created_at) edge.update(trust); // update the edge from memory with the new event
    } else {
      edge = this.createEdge(trust);
      let node = this.addNode(trust.pubkey, 'p');
      node.edges.add(edge.index!);
    }

    this.eventAddedSinceLastSave++;
    return edge;
  }

  /*
  addEdgeView(trust: ITrustEvent): EdgeView | null {
    //let edge: IEdge | null = null;
    let index = this.edgesIndex.get(trust.parameterizedId); // Avoid internal object reference tracking (a design principle) 
    let edgeView: EdgeView | null = null;
    if (index !== undefined) edgeView = this.edges?.unsafeItemAt(index) as EdgeView | null; // ! is used to tell the compiler that the edge is not null
    if (edgeView) {
      if (edgeView.createdAt > trust.created_at) return null; // If the edge is older than the new event, return null
      edgeView.createdAt = trust.created_at;
      edgeView.value = getValueFromTags(trust);
    } else {
      let edge = new EdgeT1(trust);
      edgeView = new EdgeView(edge);
      this.edges?.add(edgeView);
    }
    return edgeView;
  }
*/

  removeEdge(d_tag: string): IEdge | null {
    let index = this.edgesIndex.get(d_tag);
    if (index === undefined) return null;
    let edge = this.edgesList[index];
    if (!edge) return null;
    this.edgesList[index] = null;
    this.edgesIndex.delete(d_tag);
    let node = this.getNode(edge.author);
    if (node && edge.index !== undefined) node.edges.delete(edge.index);
    return edge;
  }

  createEdge(trust: ITrustEvent): IEdge {
    let edge = new EdgeT1(trust);
    edge.index = this.edgesList.push(edge) - 1;
    this.edgesIndex.set(trust.addressableId, edge.index!); // Avoid internal object reference tracking (a design principle)
    return edge;
  }


  applyContext(context: string, subjectType: SubjectType): number {
    let key = subjectType + (context.length > 0 ? ':' : '') + context;
    let index = this.addContext(key);
    return index;
  }

  getContextIndex(context: string, subjectType: SubjectType): number | undefined{
    let key = subjectType + (context.length > 0 ? ':' : '') + context;
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
    let index = this.contextIndex.get(context);
    if (!index) return 0;
    let contextItem = this.contextList[index];
    if (!contextItem) return 0;
    this.contextList[index] = null;
    this.contextIndex.delete(context);
    return index;
  }
}