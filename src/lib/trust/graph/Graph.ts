import { VerifiedEvent } from 'nostr-tools';
import { extractSubjects, ITrustEvent, SubjectType } from '../../nostr/nip32010.js';

import { EdgeT1, IEdge } from './Edge.js';
import { Node } from './Node.js';

export interface IGraph {
  applyTrustEvent(trust: ITrustEvent): boolean;
  removeTrustEvent(trust: ITrustEvent): boolean;
  removePubkey(pubkey: string, until: number): boolean;
  getContextIndexes(context: string, subjectType: SubjectType | ''): Array<number>;
  applyUserMetadataEvent(event: VerifiedEvent): boolean;
  trustedSubjects(authorId: string, context?: string, includeEmptyContext?: boolean): string[];
  addNode(id: string, type: SubjectType): Node;
  getNode(id: string): Node | null;
  createNode(id: string, type: SubjectType): Node;
  toObject(): any;
}


export class IndexGraph implements IGraph {

  nodesIndex: Map<string, number> = new Map();
  nodesList: Array<Node | null> = new Array<Node | null>();

  contextIndex: Map<string, number> = new Map();
  contextList: Array<string | null> = new Array<string | null>();

  edgesIndex: Map<string, number> = new Map();
  edgesList: Array<IEdge | null> = new Array<IEdge | null>();


  eventAddedSinceLastSave: number = 0;
  eventRemovedSinceLastSave: number = 0;


  toObject(): any {
    return {
      nodes: this.nodesList.length,
      edges: this.edgesList.length,
    };
  }

  applyTrustEvent(trust: ITrustEvent): boolean {

    let edge = this.addEdge(trust);
    if (!edge) return false; // If the edge is not valid or too old, return false

    const authorId = trust.pubkey.toLowerCase();
    const authorNode = this.addNode(authorId, 'p'); // author is a pubkey, so type is 'p'

    const pContextIndex = this.applyContext(trust.c_tag ?? '', 'p');//this.addContext(trust);
    const iContextIndex = this.applyContext(trust.c_tag ?? '', 'i');//this.addContext(trust);

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
    let edgeIndex = this.edgesIndex.get(trust.parameterizedId);
    if (!edgeIndex) return false; // No edge found for the parameterizedId
    let edge = this.edgesList[edgeIndex];
    if (!edge) {
      console.trace('Edge not found for parameterizedId: ' + trust.parameterizedId + ' in removeTrustEvent - Failsafe check, as this should never happen');
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
      if (!subjectNodeIndex) continue;

      const subjectNode = this.nodesList[subjectNodeIndex];
      if (!subjectNode) continue;

      const contextIndex = subject.tag === 'p' ? pContextIndex : iContextIndex;
      
      if (contextIndex !== undefined) {
        authorNode.removeOut(this, contextIndex, subjectNode.index, edge.createdAt);
        subjectNode.removeIn(this, contextIndex, authorNode.index, edge.createdAt);
      }
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
      this.removeEdge(edge.parameterizedId);
    }


    if (authorNode.out.size === 0 && authorNode.in.size === 0) {
      // If the node has no incoming or outgoing edges, remove it
      // However, there may be other nodes pointing to this node, so we cannot remove it
      this.removeNode(pubkey);
    }

    return true;
  }

  getContextIndexes(context: string, subjectType: SubjectType | '' = ''): Array<number>{
    let result: Array<number> = [];
    
    // Split the context into an array of contexts
    let contexts = context.split(':');
    if (contexts.length === 0) return result;

    let key = subjectType;
    for (const context of contexts) {

      let index = this.contextIndex.get(key);
      if (index !== undefined) result.push(index!);

      key += key.length > 0 ? ':' + context : context; // Build the key for the next context
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

  trustedSubjects(authorId: string, context?: string, includeEmptyContext: boolean = true): string[] {
    let result: string[] = [];
    const authorNode = this.getNode(authorId);
    if (!authorNode) return result;
    let time = Math.floor(Date.now() / 1000); // Current time in seconds 


    let pContextIndex = this.getContextIndexes(context ?? '', 'p');
 
    for (const contextIndex of pContextIndex) {
      for (const [subjectIndex, edgeIndex] of authorNode.out.get(contextIndex)!.entries()) {
        let edge = this.edgesList[edgeIndex];
        if (!edge) continue;
        if (!edge.isValidAt(time)) continue;
        if (edge.value > 0) {
          let subjectNode = this.nodesList[subjectIndex];
          if (!subjectNode) continue;
          result.push(subjectNode.id);
        }
      }
    }

    return result;
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
    let index = this.nodesList.push(node);
    node.index = index-1; // Avoid internal object reference tracking (a design principle)
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
    let index = this.edgesIndex.get(trust.parameterizedId); // Avoid internal object reference tracking (a design principle) 
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

  removeEdge(parameterizedId: string): IEdge | null {
    let index = this.edgesIndex.get(parameterizedId);
    if (!index) return null;
    let edge = this.edgesList[index];
    if (!edge) return null;
    this.edgesList[index] = null;
    this.edgesIndex.delete(parameterizedId);
    let node = this.getNode(edge.author);
    if (node && edge.index) node.edges.delete(edge.index);
    return edge;
  }

  createEdge(trust: ITrustEvent): IEdge {
    let edge = new EdgeT1(trust);
    let index = this.edgesList.push(edge);
    edge.index = index-1; // Avoid internal object reference tracking (a design principle)
    this.edgesIndex.set(trust.parameterizedId, edge.index!); // Avoid internal object reference tracking (a design principle)
    return edge;
  }


  applyContext(context: string, subjectType: SubjectType): number {
    let key = subjectType + ':' + context;
    let index = this.addContext(key);
    return index;
  }

  getContextIndex(context: string, subjectType: SubjectType): number | undefined{
    let key = subjectType + ':' + context;
    return this.contextIndex.get(key);
  }

  addContext(context: string): number {
    let index = this.contextIndex.get(context);
    if (index !== undefined) return index;
    index = this.contextList.push(context);
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