import type { Identity, SubjectType } from '../nostr/nip32010.js';
import type { Graph } from './graph/Graph.js';

export type GraphVizNode = {
  id: string;
  type: SubjectType;
  identity?: Record<string, string>;
};

export type GraphVizLink = {
  source: string;
  target: string;
  value: number;
  context: string;
};

function identityToRecord(identity: Identity): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(identity)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Export the in-memory trust graph for browser visualization (nodes + directed trust edges).
 * Caps output size so public endpoints stay bounded.
 */
export function exportGraphForViz(
  graph: Graph,
  options: { maxEdges?: number } = {},
): { nodes: GraphVizNode[]; links: GraphVizLink[]; truncated: boolean } {
  const maxEdges = Math.min(Math.max(1, options.maxEdges ?? 10_000), 50_000);
  const links: GraphVizLink[] = [];
  const nodeIds = new Set<string>();

  outer: for (const [authorId, node] of graph.nodes) {
    nodeIds.add(authorId);
    for (const [, contextEdge] of node.outgoing) {
      for (const [context, subjectMap] of contextEdge) {
        for (const [subjectId, edge] of subjectMap) {
          if (links.length >= maxEdges) break outer;
          if (!edge.isValidAt()) continue;
          nodeIds.add(subjectId);
          links.push({
            source: authorId,
            target: subjectId,
            value: edge.value as number,
            context,
          });
        }
      }
    }
  }

  const nodes: GraphVizNode[] = [];
  for (const id of nodeIds) {
    const n = graph.nodes.get(id);
    const identity = n?.identity ? identityToRecord(n.identity) : undefined;
    nodes.push({
      id,
      type: n?.type ?? 'p',
      ...(Object.keys(identity ?? {}).length > 0 ? { identity } : {}),
    });
  }

  return { nodes, links, truncated: links.length >= maxEdges };
}
