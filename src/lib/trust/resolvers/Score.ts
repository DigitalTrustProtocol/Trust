import { IEdge } from "../graph/Edge.js";
import { EdgeArray } from "./pathStrategyJson.js";

export type ScoreTrustPathProfile = {
  subject: string;
  name: string;
  value: number;
}

export type ScorePath = Array<{ subject: string; from: Array<string> }>;

export interface IScore {
  subject?: string; // The npub of the subject of this score
  count: number;
  trustValue: number;
  degree: number;
  trust: number;
  distrust: number;
  connected: boolean;
  visited: boolean;


  edges?: EdgeArray;

  addTrust(edge: IEdge, degree: number): void;
}

export class Score implements IScore {
  subject?: string; // The npub of the subject of this score
  count: number = 0;
  trustValue: number = 0;
  degree: number = 0;
  trust: number = 0;
  distrust: number = 0;
  connected: boolean = false;
  visited: boolean = false;

  kind?: number;
  context?: string;
  edges?: EdgeArray | undefined;


  constructor(count: number = 0, trustValue: number = 0, degree: number = 0, trust: number = 0, distrust: number = 0, connected: boolean = false, visited: boolean = false) {
    this.count = count;
    this.trustValue = trustValue;
    this.degree = degree;
    this.trust = trust;
    this.distrust = distrust;
    this.connected = connected;
    this.visited = visited;
  }


  addTrust(edge: IEdge, degree: number): void {
    if (edge.value === 0) return; // Neutral edges are not counted
    
    this.count += 1;
    this.trustValue += edge.value;
    if (edge.value === 1) {
      this.trust += 1;
    } else if (edge.value === -1) {
      this.distrust += 1;
    }
    this.degree = degree;

    if (!this.edges) this.edges = [];
    this.edges.push(edge);
  }
}


export class ScoreMap extends Map<string, Score> {

  getSubject(subject: string, degree: number): Score {
    let nodeScore = this.get(subject);
    if (!nodeScore) {
      nodeScore = new Score();
      nodeScore.subject = subject;
      nodeScore.degree = degree;
      this.set(subject, nodeScore);
    }
    return nodeScore;
  }
}