import { IEdge } from "../graph/Edge.js";


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
  authorIndex?: number; // Dynamics  index of the author of this score

  edges?: Array<number>;

  addTrust(edge: IEdge, degree: number): void;
}

export class Score implements IScore {
  subject?: string; // The npub of the subject of this score
  subjectIndex?: number; // The npub of the subject of this score
  count: number = 0;
  trustValue: number = 0;
  degree: number = 0;
  trust: number = 0;
  distrust: number = 0;
  connected: boolean = false;
  visited: boolean = false;
  authorIndex?: number; // Dynamics index of the author of this score

  kind?: number;
  context?: string;
  edges?: Array<number> | undefined;


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
    this.edges.push(edge.index!);
  }
}


export class IndexScoreMap extends Map<number, Score> {

  getSubject(subjectIndex: number, degree: number): Score {
    let subjectScore = this.get(subjectIndex);
    if (!subjectScore) {
      subjectScore = new Score();
      subjectScore.subjectIndex = subjectIndex;
      subjectScore.degree = degree;
      this.set(subjectIndex, subjectScore);
    }
    return subjectScore;
  }
}