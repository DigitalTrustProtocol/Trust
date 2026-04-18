import { EdgeT1, IEdge } from './Edge.js';
import { Node } from './Node.js';
import { PATHS } from '../../../config.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'node:path';
import { Packr } from 'msgpackr';
import { extractSubjects, ITrustEvent, KIND_TRUST, SubjectType } from '../../nostr/nip32010.js';
import { VerifiedEvent } from 'nostr-tools';
import { EdgeSubject } from './EdgeMap.js';


const packr = new Packr({ structuredClone: true });

export class Graph {
  nodes: Map<string, Node> = new Map();
  edges: Map<string, IEdge> = new Map();

  nodesIndex: Array<Node> = new Array<Node>();
  contextMap: Map<string, number> = new Map();
  contextIndex: Array<string> = new Array<string>();

  eventAddedSinceLastSave: number = 0;
  eventRemovedSinceLastSave: number = 0;


  getContextIndex(context: string): number {
    let index = this.contextMap.get(context?.toLowerCase() ?? '');
    if (!index) {
      index = this.contextIndex.length;
      this.contextMap.set(context, index);
      this.contextIndex.push(context);
    }
    return index;
  }

  getOrCreateNode(id: string, type: SubjectType): Node {
    let node = this.nodes.get(id);
    if (!node) {
      node = new Node(id, type);
      this.nodes.set(id, node);
      //node.index = this.nodesIndex.length;
      //this.nodesIndex.push(node);
    }
    return node;
  }

  getOrCreateEdge(event: ITrustEvent): IEdge {
    let edge = this.edges.get(event.parameterizedId);
    if (!edge) {
      edge = this.createTrustEdge(event);
    }
    return edge;
  }

  createTrustEdge(event: ITrustEvent): IEdge {
    let edge: IEdge;

    if (event.kind === KIND_TRUST) {
      edge = new EdgeT1(event);
    } else {
      throw new Error(`Unknown kind: ${event.kind}`);
    }

    this.edges.set(event.parameterizedId, edge);
    return edge;
  }


  isEventNewer(event: ITrustEvent): boolean {
    //if (!event.d_tag) return true; // if the d_tag is not found, the event is invalid
    const edge = this.edges.get(event.parameterizedId);
    if (!edge) return true; // if the edge is not found, the event is new
    if (edge.createdAt >= event.created_at) return false; // If the edge is older than the new event, return undefined
    return true;
  }


  applyTrustEvent(trust: ITrustEvent): boolean {
    let edge = this.edges.get(trust.parameterizedId);
    if (edge) {
      if (edge.createdAt >= trust.created_at) return false; // If the edge is older than the new event, return undefined
      if (edge.createdAt < trust.created_at) {
        edge.update(trust); // update the edge from memory with the new event
      }
    } else {
      edge = this.createTrustEdge(trust);
    }

    const authorId = trust.pubkey.toLowerCase();
    const authorNode = this.getOrCreateNode(authorId, 'p'); // author is a pubkey, so type is 'p'

    const subjects = extractSubjects(trust);
    if (subjects.length === 0) return false;

    for (const identity of subjects) {
      const subjectId = identity.value;
      const subjectType: SubjectType = identity.tag;
      const subjectNode = this.getOrCreateNode(subjectId, subjectType);

      edge.updateNodes(authorNode, subjectNode);
      // Update the subject node identity with the ExstractedSubject
      subjectNode.updateIdentity(identity);
    }
    this.eventAddedSinceLastSave++;
    return true;
  }

  removeTrustEvent(trust: ITrustEvent): boolean {
    let edge = this.edges.get(trust.parameterizedId);

    if (!edge) return false;
    if (edge.createdAt > trust.created_at) return false; // If the trust is older than the new edges, return false

    const authorId = trust.pubkey;
    const authorNode = this.nodes.get(authorId); // author is a pubkey, so type is 'p'
    if (!authorNode) return false;

    const subjects = extractSubjects(trust);
    if (subjects.length === 0) return false;

    for (const identity of subjects) {
      const subjectId = identity.value;
      const subjectType: SubjectType = identity.tag;
      const subjectNode = this.getOrCreateNode(subjectId, subjectType);

      edge.removeNodes(authorNode, subjectNode);
    }
    this.eventRemovedSinceLastSave++;
    return true;
  }

  applyUserMetadataEvent(event: VerifiedEvent): boolean {
    // Get the node for the author
    const authorNode = this.nodes.get(event.pubkey); // author is a pubkey, so type is 'p'
    if (!authorNode) return false; // update only if the node exists
    // Update the node with the user metadata
    authorNode.updateUserMetadata(event);
    return true;
  }


  trustedSubjects(authorId: string, context?: string, includeEmptyContext: boolean = true): string[] {

    let result: string[] = [];
    const authorNode = this.nodes.get(authorId);
    if (!authorNode) return result;

    let contexts = authorNode.outgoing.getContexts({ kind: KIND_TRUST, subjectType: 'p' });
    if (!contexts) return result;

    if (context) {
      if (context.length > 0) {
        const subjectEdge = contexts.get(context);
        if (subjectEdge) {
          addSubjects(subjectEdge);
        }
      }

      if (includeEmptyContext) {
        const subjectEdge = contexts.get('');
        if (subjectEdge) {
          addSubjects(subjectEdge);
        }
      }
    } else {
      for (const [_, subjectMap] of contexts.entries()) { // All contexts
        addSubjects(subjectMap);
      }
    }

    function addSubjects(subjectMap: EdgeSubject): void {
      for (const [subjectId, edge] of subjectMap.entries()) {
        if (edge.value > 0)
          result.push(subjectId);
      }
    }

    return result;
  }


  static async loadFromFile(filePath ?: string): Promise < Graph | null > {
  filePath = filePath ?? PATHS.graphCache;

  if(!existsSync(filePath)) return Promise.resolve(null);
let graph: Graph | null = null;

try {
  const buf = readFileSync(filePath);
  graph = packr.unpack(buf) as Graph;
} catch {
  return Promise.resolve(null);
}

return Promise.resolve(graph);
  }

  async saveToFile(filePath ?: string): Promise < boolean > {
  filePath = filePath ?? PATHS.graphCache;
  try {
    const dir = dirname(filePath);
    if(!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}
this.eventAddedSinceLastSave = 0;
writeFileSync(filePath, packr.pack(this));
    } catch {
  return Promise.resolve(false);
}
return Promise.resolve(true);
  }

}
