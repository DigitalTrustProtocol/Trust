import type { Graph } from '../graph/Graph.js';
import { Identity, KIND_TRUST } from '../../nostr/nip32010.js';
import type { EdgeSubject } from '../graph/EdgeMap.js';
import { Score } from './Score.js';




export type TrustPathItem = [string, string, number, number, number]; // [eventid, npub, kind, context_id (0= '',1 = context), value]
export type TrustPathElement = { node: string, identity?: Identity, from: Array<TrustPathItem>};
export type TrustPathArray = Array<TrustPathElement>;


function getIncomingFromGraph(graph: Graph, subjectId: string, context: string): EdgeSubject | undefined {
  const canonical = subjectId.toLowerCase().trim();
  const node = graph.nodes.get(canonical);
  if (!node) return undefined;
  return node.incoming.getSubjects({ kind: KIND_TRUST, context, subjectType: node.type });
}

class PathStrategy {
  resolve(
    subjectId: string,
    context: string,
    scores: Map<string, Score>,
    graph: Graph
  ): TrustPathArray {
    
    const path: TrustPathArray = [];
    const visited = new Set<string>();
    const self = this;

    function traverse(nodeId: string): void {
      const score = scores.get(nodeId);
      if (!score) return;

      const from: TrustPathItem[] = [];

      for (const authorId of score.from) {
        const trustPath = self.getTrustPath(graph, authorId, subjectId, context);
        if (!trustPath) continue;
        from.push(trustPath);

        if (visited.has(authorId)) continue;
        visited.add(authorId);

        traverse(authorId);
      }

      const graphNode = graph.nodes.get(nodeId);
      const identity: Identity | undefined = graphNode?.identity;

      const element: TrustPathElement = { node: nodeId, identity, from };
      path.push(element);
    }

    traverse(subjectId);
    return path;
  }

  getTrustPath(
    graph: Graph,
    authorId: string,
    subjectId: string,
    context: string
  ): TrustPathItem | undefined {
    const node = graph.nodes.get(subjectId);
    if (!node) return undefined;

    // Try context-specific first
    const incomingContext = getIncomingFromGraph(graph, subjectId, context);
    if (incomingContext) {
      const edge = incomingContext.get(authorId);
      if (edge) return ['', authorId, KIND_TRUST, 1, edge.value];
    }

    // Fall back to generic context
    const incomingGeneric = getIncomingFromGraph(graph, subjectId, '');
    if (incomingGeneric) {
      const edge = incomingGeneric.get(authorId);
      if (edge) return ['', authorId, KIND_TRUST, 0, edge.value];
    }

    return undefined;
  }
}

const pathStrategy = new PathStrategy();
export default pathStrategy;
