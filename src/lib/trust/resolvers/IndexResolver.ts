import { IResolveStrategy, IResolveStrategyOptions, ResolveResult } from "./IResolveStrategy.js";
import { Graph } from "../graph/Graph.js";
import pathStrategyJson from "./PathStrategyJson.js";
import { Score, IndexScoreMap } from "./Score.js";
import { ErrorCode } from "../../../server/errors.js";

const MAX_DEPTH = 4;


export class IndexResolver implements IResolveStrategy {
    readonly name = 'graph';

    resolve(
        authorId: string,
        subjectId: string,
        options: IResolveStrategyOptions = {}
    ): ResolveResult {
        const graph = options.graph as Graph;
        if (!graph) {
            return {
                ok: false,
                error: {
                    code: ErrorCode.GRAPH_NOT_FOUND,
                    message: 'Graph is required for trust resolution. Call loadGraph() before resolve.',
                },
            };
        }

        const time = Math.floor(Date.now() / 1000);
        authorId = authorId.toLowerCase().trim();
        subjectId = subjectId.toLowerCase().trim();

        const authorIndex = graph.nodesIndex.get(authorId);
        if (authorIndex === undefined) {
            return {
                ok: false,
                error: {
                    code: ErrorCode.AUTHOR_NOT_FOUND,
                    message: `Author not found in trust graph: ${authorId}`,
                },
            };
        }

        const subjectIndex = graph.nodesIndex.get(subjectId);
        if (subjectIndex === undefined) {
            return {
                ok: false,
                error: {
                    code: ErrorCode.SUBJECT_NOT_FOUND,
                    message: `Subject not found in trust graph: ${subjectId}`,
                },
            };
        }

        const scores = new IndexScoreMap();
        const authorScore = scores.getSubject(authorIndex, 0);
        authorScore.visited = true;
        authorScore.trustValue = 1; // Self-trust or the graph logic dosen't include it
        authorScore.count = 1;
        authorScore.degree = 0;


        if (authorId === subjectId) {
            authorScore.connected = true;
            authorScore.subject = authorId;
            return { ok: true, data: [authorScore] };
        }


        const maxDepth = Math.min(options.maxDepth ?? MAX_DEPTH, MAX_DEPTH);
        const followTrustThreshold = options.followTrustThreshold ?? 1;
        const context = options.context ?? '';


        const subjectScore = scores.getSubject(subjectIndex, 0);
        subjectScore.subject = subjectId;
        const subjectNode = graph.getNode(subjectId);
        if (!subjectNode) {
            return {
                ok: false,
                error: {
                    code: ErrorCode.SUBJECT_NOT_FOUND,
                    message: `Subject not found in trust graph: ${subjectId}`,
                },
            };
        }

        const subjectIncoming = subjectNode.getIn(graph.getContextIndexes(context, subjectNode.type));
        if (subjectIncoming.size === 0) return { ok: true, data: [subjectScore] };

        const contextIndexes = graph.getContextIndexes(context, 'p');

        const queue: number[] = [authorIndex];
        let degree = 0;
        let nodeCounter = 0;

        while (queue.length > nodeCounter && degree <= maxDepth && subjectScore.count === 0) {
            const degreeLength = queue.length;
            degree++;

            for (let i = nodeCounter; i < degreeLength; i++) {
                const aIndex = queue[i]!;
                const edgeIndex = subjectIncoming.get(aIndex);
                if (!edgeIndex) continue; // No edge found from the author to the subject
                
                const authorScore = scores.get(aIndex);
                if (!authorScore) continue; // No author score found, should not happen
                if (authorScore.trustValue < followTrustThreshold) continue; // Don't include distrusted nodes 

                let edge = graph.edgesList[edgeIndex];
                if (!edge) continue; // No edge found, should not happen

                subjectScore.addTrust(edge, degree); // Add the trust to the subject score
            }
            if (subjectScore.count > 0) continue; // If the subject score has been updated, stop the loop


            while (nodeCounter < degreeLength) {
                const nodeIndex = queue[nodeCounter++];
                const score = scores.get(nodeIndex);
                if (!score) continue;
                if (score.trustValue < followTrustThreshold) continue;

                let node = graph.nodesList[nodeIndex];
                if (!node) continue;

                for (const outgoing of node?.getOut(contextIndexes)) {
                    this.processTrusts(graph, nodeIndex, degree, outgoing, scores, subjectScore, queue, time);
                }
            }
        }

        if (options.format === 'path') {
            const pathScores = pathStrategyJson.resolve(authorIndex, subjectIndex, scores, graph);
            return { ok: true, data: pathScores.length > 0 ? pathScores : [subjectScore] };
        }

        subjectScore.connected = subjectScore.count > 0;
        return { ok: true, data: [subjectScore] };
    }

    private processTrusts(
        graph: Graph,
        authorIndex: number,
        degree: number,
        outgoing: Map<number, number>,
        scores: IndexScoreMap,
        subjectScore: Score,
        queue: number[],
        time: number
    ): void {
        for (const [nodeIndex, edgeIndex] of outgoing.entries()) {

            const nodeScore = scores.getSubject(nodeIndex, degree);
            if (!nodeScore) continue;
            if (nodeScore.authorIndex === authorIndex) continue; // Only process edge once from different context index
            nodeScore.authorIndex = authorIndex; // Set the author index for the score, this is used to avoid processing the same edge multiple times from different context indexes

            let edge = graph.edgesList[edgeIndex];
            if (!edge) continue;
            if (!edge.isValidAt(time)) continue;
            nodeScore.addTrust(edge, degree);

            if (!nodeScore.visited && subjectScore.count === 0) {
                queue.push(nodeIndex);
                nodeScore.visited = true;
            }
        }
    }

}

const indexResolver = new IndexResolver();
export default indexResolver;
