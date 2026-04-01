import { Graph } from "../graph/Graph.js";
import { KIND_TRUST, SubjectType } from "../../nostr/nip32010.js";
import { IResolveStrategy, IResolveStrategyOptions } from "./IResolveStrategy.js";
import { Score, ScoreMap } from "./Score.js";
import { EdgeMap, type EdgeSubject } from "../graph/EdgeMap.js";
import { getGraph } from "../graphManager.js";
import pathStrategy from "./pathStrategy.js";

const MAX_DEPTH = 4;

/** Get outgoing trust edges from a node in the graph (who this node trusts). */
function getOutgoingFromGraph(
  graph: Graph,
  authorId: string,
  context: string,
  subjectType: 'p' | 'i' = 'p'
): EdgeSubject | undefined {
  const node = graph.nodes.get(authorId);
  if (!node) return undefined;
  return node.outgoing.getSubjects({ kind: KIND_TRUST, context, subjectType });
}

/** Get incoming trust edges to a node in the graph (who trusts this node). */
function getIncomingFromGraph(
  graph: Graph,
  subjectId: string,
  context: string | undefined,
  now: number
  //subjectType: SubjectType
): Map<string, { value: number }> | undefined {
  const node = graph.nodes.get(subjectId);
  if (!node) return undefined;

  if (context === undefined || context === null) {
    const result = new Map<string, { value: number }>();
    const contexts = node.incoming.getContexts({ kind: KIND_TRUST, subjectType: node.type }); 
    if (!contexts) return undefined;
    for (const [, subjectMap] of contexts.entries()) {
      for (const [authorId, edge] of subjectMap.entries()) {
        if (!edge.isValidAt(now)) continue;
        result.set(authorId, { value: edge.value });
      }
    }
    return result.size > 0 ? result : undefined;
  }

  const subjectMap = node.incoming.getSubjects({ kind: KIND_TRUST, context, subjectType: node.type });
  if (!subjectMap) return undefined;
  const result = new Map<string, { value: number }>();
  for (const [authorId, edge] of subjectMap.entries()) {
    if (!edge.isValidAt(now)) continue;
    result.set(authorId, { value: edge.value });
  }
  return result.size > 0 ? result : undefined;
}

class StandardResolver implements IResolveStrategy {
  readonly name = 'graph';

  resolve(
    authorId: string,
    subjectId: string,
    options: IResolveStrategyOptions = {}
  ): Score {
    const graph = options.graph;
    if (!graph) {
      throw new Error('Graph is required for trust resolution. Call loadGraph() before resolve.');
    }

    const now = Math.floor(Date.now() / 1000);
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
      return authorScore;
    }

    const subjectScore = scores.getSubject(subject, 0);
    const subjectIncoming = getIncomingFromGraph(graph, subject, context, now);
    if (!subjectIncoming) {
      return subjectScore;
    }

    const queue: string[] = [author];
    let degree = 0;
    let nodeIndex = 0;

    while (queue.length > nodeIndex && degree <= maxDepth && subjectScore.count === 0) {
      const degreeLength = queue.length;
      degree++;

      for (let i = nodeIndex; i < degreeLength; i++) {
        const nodeId = queue[i];
        const trustItem = subjectIncoming.get(nodeId);
        if (trustItem) {
          const nodeScore = scores.get(nodeId);
          if (!nodeScore) continue;
          if (nodeScore.trustValue < followTrustThreshold) continue;
          subjectScore.addTrust(nodeId, trustItem.value, degree);
        }
      }

      if (subjectScore.count > 0) continue;

      while (nodeIndex < degreeLength) {
        const nodeId = queue[nodeIndex++];
        const score = scores.get(nodeId);
        if (!score) continue;
        if (score.trustValue < followTrustThreshold) continue;

        const outgoing = getOutgoingFromGraph(graph, nodeId, context, 'p');
        this.processTrusts(nodeId, degree, outgoing, scores, subjectScore, queue, now);

        if (context !== '' && context.length > 0) {
          const outgoingGeneric = getOutgoingFromGraph(graph, nodeId, '', 'p');
          this.processTrusts(nodeId, degree, outgoingGeneric, scores, subjectScore, queue, now);
        }
      }
    }

    if (options.format === 'path') {  
      subjectScore.path = pathStrategy.resolve(subject, context, scores, graph);
    }
    
    subjectScore.connected = subjectScore.count > 0;
    return subjectScore;
  }

  private processTrusts(
    authorId: string,
    degree: number,
    outgoing: EdgeSubject | undefined,
    scores: ScoreMap,
    subjectScore: Score,
    queue: string[],
    now: number
  ): void {
    if (!outgoing) return;
    for (const [nodeId, edge] of outgoing.entries()) {
      if (!edge.isValidAt(now)) continue;
      const nodeScore = scores.getSubject(nodeId, degree);
      nodeScore.addTrust(authorId, edge.value, degree);

      if (!nodeScore.visited && subjectScore.count === 0) {
        queue.push(nodeId);
        nodeScore.visited = true;
      }
    }
  }
}

const standardResolver = new StandardResolver();
export default standardResolver;
