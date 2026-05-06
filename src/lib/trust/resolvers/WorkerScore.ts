export type ScoreTrustPathProfile = {
  subject: string;
  name: string;
  value: number;
}

export type ScorePath = Array<{ subject: string; from: Array<string> }>;

export interface IScore {
  subjectIndex?: number; // The npub of the subject of this score
  count: number;
  trustValue: number;
  degree: number;
  trust: number;
  distrust: number;
  connected: boolean;
  visited: boolean;
  authorIndex?: number; // Dynamics  index of the author of this score

  edges?: Array<number>;

  addTrust(edgeIndex: number, value: number, degree: number): void;
}

export class WorkerScore implements IScore {
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


  addTrust(edgeIndex: number, value: number, degree: number): void {
    if (value === 0) return; // Neutral edges are not counted
    
    this.count += 1;
    this.trustValue += value;
    if (value === 1) {
      this.trust += 1;
    } else if (value === -1) {
      this.distrust += 1;
    }
    this.degree = degree;

    if (!this.edges) this.edges = [];
    this.edges.push(edgeIndex);
  }
}


export class WorkerScoreMap extends Map<number, WorkerScore> {

  getSubject(subjectIndex: number, degree: number): WorkerScore {
    let subjectScore = this.get(subjectIndex);
    if (!subjectScore) {
      subjectScore = new WorkerScore();
      subjectScore.subjectIndex = subjectIndex;
      subjectScore.degree = degree;
      this.set(subjectIndex, subjectScore);
    }
    return subjectScore;
  }
}