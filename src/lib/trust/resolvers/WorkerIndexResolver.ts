import UInt32SharedMap from "../../Shared/UInt32SharedMap.js";
import { ErrorCode, fail, type ApiEnvelope } from "../../../server/errors.js";
import { WorkerGraph } from "../graph/WorkerGraph.js";
import { ResolveFormat } from "./IResolveStrategy.js";
import { WorkerScore, WorkerScoreMap } from "./WorkerScore.js";

const MAX_DEPTH = 4;

export interface IWorkerResolveStrategyOptions {
  /** Graph to use for resolution. */
  graph?: WorkerGraph;
  /** Max depth to traverse. Limited by resolver max; can be smaller. */
  maxDepth?: number;
  /** Stop as soon as subject is found; if false, explore full maxDepth (default: true). */
  stopWhenFound?: boolean;
  /**
   * Worker graph does not contain context labels, only context indexes.
   * Accepts comma-separated indexes (example: "2,5,9").
   */
  context?: string;
  /** Follow trust edges only if trust value is greater than this threshold (default: 1). */
  followTrustThreshold?: number;
  /** Block keys author has directly distrusted - never follow them (default: true). */
  respectDirectDistrust?: boolean;
  /** Output format. */
  format?: ResolveFormat;
}

export class WorkerIndexResolver {
  readonly name = "graph";



  resolve(
    authorIndex: number,
    subjectIndex: number,
    options: IWorkerResolveStrategyOptions = {},
  ): ApiEnvelope<Array<WorkerScore>> {
    const graph = options.graph;
    if (!graph) {
      return fail(
        ErrorCode.GRAPH_NOT_FOUND,
        "Graph is required for trust resolution. Call loadGraph() before resolve.",
      );
    }
   
    const time = Math.floor(Date.now() / 1000);
    const scores = new WorkerScoreMap();

    const authorScore = scores.getSubject(authorIndex, 0);
    authorScore.visited = true;
    authorScore.trustValue = 1; // Self-trust or graph logic does not include it.
    authorScore.count = 1;
    authorScore.degree = 0;

    if (authorIndex === subjectIndex) {
      authorScore.connected = true;
      authorScore.subjectIndex = subjectIndex;
      return { ok: true, data: [authorScore] };
    }

    const maxDepth = Math.min(options.maxDepth ?? MAX_DEPTH, MAX_DEPTH);
    const followTrustThreshold = options.followTrustThreshold ?? 1;

    const subjectScore = scores.getSubject(subjectIndex, 0);
    subjectScore.subjectIndex = subjectIndex;

    const subjectIncomingContexts = graph.getContextMap(graph.in, subjectIndex);
    if (!subjectIncomingContexts) {
      return { ok: true, data: [subjectScore] };
    }

    const requestedContexts = this.parseContextFilter(options.context);
    const contextIndexes = requestedContexts?.values() ?? [];
    const subjectContextIndexes = this.getContextIndexes(subjectIncomingContexts, requestedContexts);
    if (subjectContextIndexes.length === 0) {
      return { ok: true, data: [subjectScore] };
    }

    const queue: number[] = [authorIndex];
    let degree = 0;
    let nodeCounter = 0;

    while (queue.length > nodeCounter && degree <= maxDepth && subjectScore.count === 0) {
      const degreeLength = queue.length;
      degree++;

      for (let i = nodeCounter; i < degreeLength; i++) {
        const fromAuthorIndex = queue[i]!;
        const fromScore = scores.get(fromAuthorIndex);
        if (!fromScore) continue;
        if (fromScore.trustValue < followTrustThreshold) continue;

        for (const contextIndex of subjectContextIndexes) {
          const incomingMap = graph.getEdgeMap(subjectIncomingContexts, contextIndex);
          if (!incomingMap) continue;
          const trustIndex = incomingMap.get(fromAuthorIndex);
          if (trustIndex === undefined) continue;

          const trust = graph.trust.get(trustIndex);
          if (!trust) continue;
          subjectScore.addTrust(trustIndex, trust.value, degree);
        }
      }
      if (subjectScore.count > 0) continue; // Stop if subject already reached.

      while (nodeCounter < degreeLength) {
        const nodeIndex = queue[nodeCounter++]!;
        const nodeScore = scores.get(nodeIndex);
        if (!nodeScore) continue;
        if (nodeScore.trustValue < followTrustThreshold) continue;

        const outContextMap = graph.getContextMap(graph.out, nodeIndex);
        if (!outContextMap) continue;

        for (const contextIndex of contextIndexes) {
          const outgoingMap = graph.getEdgeMap(outContextMap, contextIndex);
          if (!outgoingMap) continue;

          this.processTrusts(
            graph,
            nodeIndex,
            degree,
            outgoingMap,
            scores,
            subjectScore,
            queue,
            time,
          );
        }
      }
    }

    subjectScore.connected = subjectScore.count > 0;
    return { ok: true, data: [subjectScore] };
  }

  private processTrusts(
    graph: WorkerGraph,
    authorIndex: number,
    degree: number,
    outgoing: UInt32SharedMap,
    scores: WorkerScoreMap,
    subjectScore: WorkerScore,
    queue: number[],
    time: number,
  ): void {
    for (const [nodeIndex, trustIndex] of outgoing.entries()) {
      const nodeScore = scores.getSubject(nodeIndex, degree);
      if (nodeScore.authorIndex === authorIndex) continue; // Process edge once per author node.
      nodeScore.authorIndex = authorIndex;

      const trust = graph.trust.get(trustIndex);
      if (!trust) continue;
      if (!WorkerGraph.trustViewIsValidAt(trust, time)) continue;
      nodeScore.addTrust(trustIndex, trust.value, degree);

      if (!nodeScore.visited && subjectScore.count === 0) {
        queue.push(nodeIndex);
        nodeScore.visited = true;
      }
    }
  }

  private nodeExists(graph: WorkerGraph, nodeIndex: number): boolean {
    return graph.out.get(nodeIndex) !== undefined || graph.in.get(nodeIndex) !== undefined;
  }

  private parseNodeIndex(nodeId: string): number | undefined {
    const value = Number(nodeId);
    if (!Number.isInteger(value) || value < 0) return undefined;
    return value;
  }

  private parseContextFilter(context: string | undefined): Set<number> | undefined {
    if (!context) return undefined;
    const indexes = context
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
    if (indexes.length === 0) return undefined;
    return new Set(indexes);
  }

  private getContextIndexes(contextMap: UInt32SharedMap, contextFilter: Set<number> | undefined): number[] {
    const contextIndexes = Array.from(contextMap.keys()) as number[];
    if (!contextFilter) return contextIndexes;
    return contextIndexes.filter((contextIndex) => contextFilter.has(contextIndex));
  }
}

const workerIndexResolver = new WorkerIndexResolver();
export default workerIndexResolver;
