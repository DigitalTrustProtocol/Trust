import { Graph, IGraph } from "../graph/Graph.js";
import { KIND_TRUST } from "../../nostr/nip32010.js";
import { IResolveStrategy, IResolveStrategyOptions } from "./IResolveStrategy.js";
import { Score, ScoreMap } from "./Score.js";
import { type EdgeSubject } from "../graph/EdgeMap.js";
import { IEdge } from "../graph/Edge.js";
import pathStrategyJson from "./pathStrategyJson.js";

const MAX_DEPTH = 4;

/** Get outgoing trust edges from a node in the graph (who this node trusts). */
function getOutgoingFromGraph(
  graph: Graph,
  authorId: string,
  context: string,
  subjectType: 'p' | 'i' = 'p'
): EdgeSubject | undefined {
  const node = graph.nodes.get(authorId); // We could use the node reference directly and not id 
  if (!node) return undefined;
  return node.outgoing.getSubjects({ kind: KIND_TRUST, context, subjectType });
}

/** Get incoming trust edges to a node in the graph (who trusts this node). */
function getIncomingFromGraph(
  graph: Graph,
  subjectId: string,
  context: string | undefined,
  time: number
  //subjectType: SubjectType
): Map<string, IEdge> | undefined {
  const node = graph.nodes.get(subjectId);
  if (!node) return undefined;

  // Do not make sense. context is always defined.
  /*
  if (context === undefined || context === null) {
    const contexts = node.incoming.getContexts({ kind: KIND_TRUST, subjectType: node.type });
    if (!contexts) return undefined;
    for (const [, subjectMap] of contexts.entries()) {
      for (const [authorId, edge] of subjectMap.entries()) {
        if (!edge.isValidAt(time)) continue;
        result.set(authorId, edge);
      }
    }
    return result.size > 0 ? result : undefined;
  }
*/
  
  const result = node.incoming.getSubjects({ kind: KIND_TRUST, context, subjectType: node.type }) ?? new Map<string, IEdge>();
  if (context && context.length > 0) {
    const contextMap = node.incoming.getSubjects({ kind: KIND_TRUST, context, subjectType: node.type });
    if (contextMap && contextMap.size > 0) {
      for (const [authorId, edge] of contextMap.entries()) {
        if (!edge.isValidAt(time)) continue;
        result.set(authorId, edge);
      }
    }
  }
  return result?.size > 0 ? result : undefined;
}

class StandardResolver implements IResolveStrategy {
  readonly name = 'graph';

  resolve(
    authorId: string,
    subjectId: string,
    options: IResolveStrategyOptions = {}
  ): Array<Score> {
    const graph = options.graph;
    if (!graph) {
      throw new Error('Graph is required for trust resolution. Call loadGraph() before resolve.');
    }

    const time = Math.floor(Date.now() / 1000);
    const author = authorId.toLowerCase().trim();
    const subject = subjectId.toLowerCase().trim();
    const maxDepth = Math.min(options.maxDepth ?? MAX_DEPTH, MAX_DEPTH);
    const followTrustThreshold = options.followTrustThreshold ?? 1;
    const context = options.context ?? '';

    const scores = new ScoreMap();
    const authorScore = scores.getSubject(author, 0);
    authorScore.trustValue = 1;
    authorScore.trust = 1;
    authorScore.count = 1;
    authorScore.connected = true;
    authorScore.visited = true;

    if (author === subject) {
      authorScore.connected = true;
      return [authorScore];
    }

    const subjectScore = scores.getSubject(subject, 0);
    const subjectIncoming = getIncomingFromGraph(graph as Graph, subject, context, time);
    if (!subjectIncoming) {
      return [subjectScore];
    }

    const queue: string[] = [author];
    let degree = 0;
    let nodeIndex = 0;

    while (queue.length > nodeIndex && degree <= maxDepth && subjectScore.count === 0) {
      const degreeLength = queue.length;
      degree++;

      for (let i = nodeIndex; i < degreeLength; i++) {
        const authorId = queue[i];
        const edge = subjectIncoming.get(authorId);
        if (edge) {
          const authorScore = scores.get(authorId);
          if (!authorScore) continue;
          if (authorScore.trustValue < followTrustThreshold) continue;

          subjectScore.addTrust(edge, degree);
        }
      }

      if (subjectScore.count > 0) continue;

      while (nodeIndex < degreeLength) {
        const nodeId = queue[nodeIndex++];
        const score = scores.get(nodeId);
        if (!score) continue;
        if (score.trustValue < followTrustThreshold) continue;

        const outgoing = getOutgoingFromGraph(graph as Graph, nodeId, context, 'p');
        this.processTrusts(nodeId, degree, outgoing, scores, subjectScore, queue, time);

        if (context !== '' && context.length > 0) {
          const outgoingGeneric = getOutgoingFromGraph(graph as Graph, nodeId, '', 'p');
          this.processTrusts(nodeId, degree, outgoingGeneric, scores, subjectScore, queue, time);
        }
      }
    }

    if (options.format === 'path') {
      return pathStrategyJson.resolve(author, subject, scores);
    }

    subjectScore.connected = subjectScore.count > 0;
    return [subjectScore];
  }

  private processTrusts(
    authorId: string,
    degree: number,
    outgoing: EdgeSubject | undefined,
    scores: ScoreMap,
    subjectScore: Score,
    queue: string[],
    time: number
  ): void {
    if (!outgoing) return;
    for (const [nodeId, edge] of outgoing.entries()) {
      if (!edge.isValidAt(time)) continue;
      const nodeScore = scores.getSubject(nodeId, degree);
      nodeScore.addTrust(edge, degree);

      if (!nodeScore.visited && subjectScore.count === 0) {
        queue.push(nodeId);
        nodeScore.visited = true;
      }
    }
  }
}

const standardResolver = new StandardResolver();
export default standardResolver;
