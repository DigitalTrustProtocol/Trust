import { Graph } from '../graph/Graph.js';
import { Score } from './Score.js';

/** Output format for resolve: number (trust−distrust), default (counts + degree), or path (includes paths). */
export type ResolveFormat = 'number' | 'default' | 'path';

export interface IResolveStrategyOptions {
  /** Graph to use for resolution */
  graph?: Graph;
  /** Max depth to traverse. Limited by each strategy's own max; can be smaller. */
  maxDepth?: number;
  /** Stop as soon as subject is found; if false, explore full maxDepth (default: true) */
  stopWhenFound?: boolean;
  /** Context filter for edges */
  context?: string;
  /** Follow trust edges only if trust value is greater than this threshold (default: 0.0) */
  followTrustThreshold?: number;
  /** Block keys author has directly distrusted - never follow them (default: true) */
  respectDirectDistrust?: boolean;
  /** Format to return the result in (default: 'default'). When 'path', strategy may attach path data to the result. */
  format?: ResolveFormat;
}

export interface IResolveStrategy {
  readonly name: string;
  resolve(
    authorId: string,
    subjectId: string,
    options?: IResolveStrategyOptions
  ): Score;
}
