import { IEdge } from '../graph/Edge.js';
import { Score } from './Score.js';
import { Graph } from '../graph/Graph.js';


export type EdgeArray = Array<IEdge>;


class PathStrategyJson {
  resolve(
    authorIndex: number,
    subjectIndex: number,
    scores: Map<number, Score>,
    graph: Graph
  ): Array<Score> {
    
    const result: Array<Score> = [];
    const visited = new Set<string>();

    function traverse(subject: number): void {
      const score = scores.get(subject);
      if (!score) return; // Should not happen, but just in case

      result.push(score);
      if (authorIndex === score.subjectIndex) return; // Starting node, no need to traverse
      if (!score.edges) return; // May be the root node, no edges. Starting node is not in the scores map, so it will not have edges.

      for (const edgeIndex of score.edges) {
        let edge = graph.edgesList[edgeIndex];
        if (!edge) continue;
        const author = edge.author;
        if (visited.has(author)) continue;
        visited.add(author);

        traverse(authorIndex);
      }

    }

    traverse(subjectIndex);
    return result;
  }
}

const pathStrategyJson = new PathStrategyJson();
export default pathStrategyJson;
