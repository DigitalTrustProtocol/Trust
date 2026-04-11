import { Score } from './Score.js';
import { IEdge } from '../graph/Edge.js';


export type EdgeArray = Array<IEdge>;


class PathStrategyJson {
  resolve(
    authorId: string,
    subjectId: string,
    scores: Map<string, Score>
  ): Array<Score> {
    
    const result: Array<Score> = [];
    const visited = new Set<string>();

    function traverse(subject: string): void {
      const score = scores.get(subject);
      if (!score) return; // Should not happen, but just in case

      result.push(score);
      if (authorId === score.subject) return; // Starting node, no need to traverse
      if (!score.edges) return; // May be the root node, no edges. Starting node is not in the scores map, so it will not have edges.

      for (const edge of score.edges) {
        const author = edge.author;
        if (visited.has(author)) continue;
        visited.add(author);

        traverse(author);
      }

    }

    traverse(subjectId);
    return result;
  }
}

const pathStrategyJson = new PathStrategyJson();
export default pathStrategyJson;
