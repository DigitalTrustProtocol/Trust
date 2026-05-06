import { SubjectType } from "../../nostr/nip32010.js";
import UInt32SharedMap from "../../Shared/UInt32SharedMap.js";
import { GraphTrustValue } from "../graph/Graph.js";
import { MainGraph } from "../graph/MainGraph.js";


export interface IGraphTrustEdgePayload {
    d_tag: string;
    author: string;
    subject: string;
    subjectType: SubjectType;
    kind: number;
    value: GraphTrustValue;
    context: string;
    createdAt: number;
    activate?: number;
    expire?: number;
    content?: string;
  }
  
  export interface IGraphTrustConnectionPayload {
    author: string;
    subject: string;
    subjectType: SubjectType;
    edge: IGraphTrustEdgePayload;
  }
  
  export interface IGraphTrustConnectionOptions {
    context?: string;
    value?: GraphTrustValue;
    subjectType?: SubjectType;
    time?: number;
    includeInactive?: boolean;
  }
  

export class NodeResolver {

    graph: MainGraph;

    constructor(graph: MainGraph) {
        this.graph = graph;
    }

    getOut(authorId: string, options: IGraphTrustConnectionOptions = {}): IGraphTrustEdgePayload[] {
        return this.connections(this.graph.out, authorId, options);
    }

    getIn(subjectId: string, options: IGraphTrustConnectionOptions = {}): IGraphTrustEdgePayload[] {
        return this.connections(this.graph.in, subjectId, options);
    }


    connections(map: UInt32SharedMap, nodeId: string, options: IGraphTrustConnectionOptions = {}): IGraphTrustEdgePayload[] {
        const graph = this.graph;
        let nodeIndex = graph.nodesIndex.get(nodeId);
        if (nodeIndex === undefined) return [];

        let contextMap = graph.getContextMap(map, nodeIndex);
        if (contextMap === undefined) return [];

        const subjectTypes = options.subjectType ? [options.subjectType] : (['p', 'i'] as SubjectType[]);
        if (options.time === undefined) {
            options.time = Math.floor(Date.now() / 1000);
        }
        const result: IGraphTrustEdgePayload[] = [];

        for (const subjectType of subjectTypes) {
            let contextIndexes: number[] = [];
            if (options.context !== undefined) {
                contextIndexes = graph.context.getIndexes(options.context!, subjectType);
            } 

            if (options.context === undefined) {
                const indexes = Array.from(contextMap.keys());

                for (const contextIndex of indexes) {
                    let stype = graph.context.type[contextIndex];
                    if (stype !== subjectType) continue;
                    contextIndexes.push(contextIndex);
                }
            }

            for (const contextIndex of contextIndexes) {

                const edgeMap = graph.getEdgeMap(contextMap, contextIndex);
                if (edgeMap === undefined) continue;

                this.processEdgeMap(edgeMap, contextIndex, result, options);
            }
        }

        return result;
    }


    processEdgeMap(edgeMap: UInt32SharedMap, contextIndex: number, result: IGraphTrustEdgePayload[], options: IGraphTrustConnectionOptions): void {

        for (const [subjectIndex, trustIndex] of edgeMap.entries()) {
            const payload = this.createPayload(trustIndex, contextIndex, subjectIndex);
            if (payload === undefined) continue;
            if (options?.value !== undefined && payload.value !== options.value) continue;
            if (payload.expire && options.time! > payload.expire && !options.includeInactive) continue;
            if (payload.activate && options.time! < payload.activate && !options.includeInactive) continue;

            result.push(payload);
        }
    }

    createPayload(trustIndex: number, contextIndex: number, subjectIndex: number): IGraphTrustEdgePayload | undefined {
        const trust = this.graph.trust.get(trustIndex);
        if (trust === undefined) return undefined;

        const authorIndex = trust.authorIndex;
        const authorId = this.graph.nodeIds[authorIndex];
        if (authorId === undefined) return undefined;
        const subjectId = this.graph.nodeIds[subjectIndex];
        if (subjectId === undefined) return undefined;
        const subjectTypeNumber = this.graph.nodeType[subjectIndex];
        const subjectType = subjectTypeNumber === 1 ? 'p' : 'i';

        const context = this.graph.context.list[contextIndex] ?? '';

        return {
            d_tag: trust.d_tag,
            kind: 32010,
            author: authorId,
            subject: subjectId,
            subjectType: subjectType,
            value: trust.value as GraphTrustValue,
            context,
            createdAt: trust.createdAt,
            activate: trust.activate,
            expire: trust.expire,
        } as IGraphTrustEdgePayload;
    }
}

