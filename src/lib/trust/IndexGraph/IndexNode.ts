import type { VerifiedEvent } from 'nostr-tools';
import type { SubjectType, Identity } from '../../nostr/nip32010.js';
import { parseIdentityFromKind0, mergeIdentity } from '../identity.js';
import { IEdge } from '../graph/Edge.js';
import { IndexGraph } from './IndexGraph.js';

export class IndexNode {
    index: number = 0;
    id: string = ''; // pubkey or subject id (e.g. event id)
    type: SubjectType = 'p';
    identity?: Identity;


    out: Map<number, Map<number, number>> = new Map();
    in: Map<number, Map<number, number>> = new Map();

    edges: Set<number> = new Set<number>();


    constructor(id: string, type: SubjectType) {
        this.id = id;
        this.type = type;
    }


    *getOut(contextIndexes: Array<number>): IterableIterator<Map<number, number>> {
        for (const contextIndex of contextIndexes) {
            let outMap = this.out.get(contextIndex);
            if (!outMap) continue;
            yield outMap;
        }
    }

    getIn(contextIndexes: Array<number>): Map<number, number> {
        let result = new Map<number, number>();
        for (const contextIndex of contextIndexes) {
            let inMap = this.in.get(contextIndex);
            if (!inMap) continue;
            for (const [subjectIndex, edgeIndex] of inMap.entries()) {
                result.set(subjectIndex, edgeIndex);
            }
        }
        return result;
    }

    addOut(contextIndex: number, subjectIndex: number, edgeIndex: number): void {

        let outMap = this.out.get(contextIndex);
        if (!outMap) {
            outMap = new Map<number, number>();
            this.out.set(contextIndex, outMap);
        }

        //let encodedValue = createdAt << 8 | value & 0xFF;
        outMap.set(subjectIndex, edgeIndex);
    }


    addIn(contextIndex: number, subjectIndex: number, edgeIndex: number): void {
        let inMap = this.in.get(contextIndex);
        if (!inMap) {
            inMap = new Map<number, number>();
            this.in.set(contextIndex, inMap);
        }
        //let encodedValue = createdAt << 8 | value & 0xFF;
        inMap.set(subjectIndex, edgeIndex);
    }

    removeOut(graph: IndexGraph, contextIndex: number, subjectIndex: number, createdAt: number): void {
        let contextMap = this.out.get(contextIndex);
        if (!contextMap) return;

        /*
        let outCreatedAt = contextMap.get(subjectIndex);
        if (!outCreatedAt) return; // No subject found for the context
        
        outCreatedAt = outCreatedAt >> 8;
        if (outCreatedAt > createdAt) return; // If the createdAt is lesser than the graph record, do not remove the edge
        */
        let edgeIndex = contextMap.get(subjectIndex);
        if (!edgeIndex) return;
        let edge = graph.edgesList[edgeIndex];
        if (!edge) return;
        if (edge.createdAt > createdAt) return; // If the createdAt is lesser than the graph record, do not remove the edge

        contextMap.delete(subjectIndex);

        if (contextMap.size === 0) {
            this.out.delete(contextIndex);
        }
    }

    removeIn(graph: IndexGraph, contextIndex: number, subjectIndex: number, createdAt: number): void {
        let inMap = this.in.get(contextIndex);
        if (!inMap) return;

        /*
        let inCreatedAt = inMap.get(subjectIndex);
        if (!inCreatedAt) return; // No subject found for the context
        
        inCreatedAt = inCreatedAt >> 8;
        if (inCreatedAt > createdAt) return; // If the createdAt is lesser than the graph record, do not remove the edge
        */
        let edgeIndex = inMap.get(subjectIndex);
        if (!edgeIndex) return;
        let edge = graph.edgesList[edgeIndex];
        if (!edge) return;
        if (edge.createdAt > createdAt) return; // If the createdAt is lesser than the graph record, do not remove the edge

        inMap.delete(subjectIndex);
        if (inMap.size === 0) {
            this.in.delete(contextIndex);
        }
    }



    /** Update identity from a kind 0 user metadata event. */
    updateUserMetadata(event: VerifiedEvent): this {
        const parsed = parseIdentityFromKind0(event);
        if (parsed) {
            this.identity = this.identity ? mergeIdentity(this.identity, parsed) : parsed;
        }
        return this;
    }

    updateIdentity(identity: Identity): this {
        if (!this.identity) {
            this.identity = identity;
        }
        //else {
        //      this.identity = mergeIdentity(this.identity, identity);
        //}
        return this;
    }

}