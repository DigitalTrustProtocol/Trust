import { IResolveStrategy, IResolveStrategyOptions } from "./IResolveStrategy.js";
import { IndexGraph } from "../graph/Graph.js";
import pathStrategyJson from "./PathStrategyJson.js";
import { Score, IndexScoreMap } from "./Score.js";

const MAX_DEPTH = 4;


export class IndexResolver implements IResolveStrategy {
    readonly name = 'graph';

    resolve(
        authorId: string,
        subjectId: string,
        options: IResolveStrategyOptions = {}
    ): Array<any> {
        const graph = options.graph as IndexGraph;
        if (!graph) {
            throw new Error('Graph is required for trust resolution. Call loadGraph() before resolve.');
        }

        const time = Math.floor(Date.now() / 1000);
        authorId = authorId.toLowerCase().trim();
        subjectId = subjectId.toLowerCase().trim();

        const authorIndex = graph.nodesIndex.get(authorId);
        if (authorIndex === undefined) return []; // No author node found, so no trust

        const subjectIndex = graph.nodesIndex.get(subjectId);
        if (subjectIndex === undefined) return []; // No subject node found, so no trust

        const scores = new IndexScoreMap();
        const authorScore = scores.getSubject(authorIndex, 0);
        authorScore.visited = true;

        if (authorId === subjectId) {
            authorScore.connected = true;
            return [authorScore];
        }


        const maxDepth = Math.min(options.maxDepth ?? MAX_DEPTH, MAX_DEPTH);
        const followTrustThreshold = options.followTrustThreshold ?? 1;
        const context = options.context ?? '';


        const subjectScore = scores.getSubject(subjectIndex, 0);
        const subjectNode = graph.getNode(subjectId);
        if (!subjectNode) return []; // No node found, so no trust

        const subjectIncoming = subjectNode.getIn(graph.getContextIndexes(context));
        if (subjectIncoming.size === 0) return []; // No incoming edges, so no trust

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
                if (edgeIndex) {
                    const authorScore = scores.get(aIndex);
                    if (!authorScore) continue;
                    if (authorScore.trustValue < followTrustThreshold) continue;

                    let edge = graph.edgesList[edgeIndex];
                    if (!edge) continue;

                    subjectScore.addTrust(edge, degree);
                }
            }

            if (subjectScore.count > 0) continue;

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
            return pathStrategyJson.resolve(authorIndex, subjectIndex, scores, graph);
        }

        subjectScore.connected = subjectScore.count > 0;
        return [subjectScore];
    }

    private processTrusts(
        graph: IndexGraph,
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
