import { TrustPathArray } from "./pathStrategy.js";

export type ScoreTrustPathProfile = {
  subject: string;
  name: string;
  value: number;
}

export type ScorePath = Array<{ subject: string; from: Array<string> }>;

export interface IScore {
  count: number;
  trustValue: number;
  degree: number;
  trust: number;
  distrust: number;
  connected: boolean;
  visited: boolean;
  from: Set<string>;

  subject?: string; // The npub of the subject of this score
  context?: string;
  kind?: number;

  path?: TrustPathArray;

  addTrust(authorId: string, trustValue: number, degree: number): void;
}

export class Score implements IScore {
  count: number = 0;
  trustValue: number = 0;
  degree: number = 0;
  trust: number = 0;
  distrust: number = 0;
  connected: boolean = false;
  visited: boolean = false;
  from: Set<string> = new Set<string>();

  subject?: string; // The npub of the subject of this score
  kind?: number;
  context?: string;
  path?: TrustPathArray;


  constructor(count: number = 0, trustValue: number = 0, degree: number = 0, trust: number = 0, distrust: number = 0, connected: boolean = false, visited: boolean = false) {
    this.count = count;
    this.trustValue = trustValue;
    this.degree = degree;
    this.trust = trust;
    this.distrust = distrust;
    this.connected = connected;
    this.visited = visited;
  }


  addTrust(authorId: string,trustValue: number, degree: number): void {
    if (trustValue === 0) return; // Neutral edges are not counted
    if(this.from.has(authorId)) return; // Don't add trust if already added from this author, from a more specific context
    
    this.count += 1;
    this.trustValue += trustValue;
    if (trustValue === 1) {
      this.trust += 1;
    } else if (trustValue === -1) {
      this.distrust += 1;
    }
    this.degree = degree;
    this.from.add(authorId);
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