import { KIND_TRUST, SubjectType } from "../../nostr/nip32010.js";
import { IEdge } from "./Edge.js";


export const EDGE_KEY_SEP = '|';


export class OutTrust {
  items: TrustContext = new TrustContext();
  pubkeys: TrustContext = new TrustContext();
}

export class InTrust {
  items: TrustContext = new TrustContext();
  pubkeys: TrustContext = new TrustContext();
}

export class TrustContext extends Map<string, TrustSubject> { // context is the key, value is the subject
  constructor() {
    super();
  }
}

export class TrustSubject extends Array<IEdge> {
  constructor() {
    super();
  }
}


export class EdgeSubject extends Map<string, IEdge> {
  constructor() {
    super();
  }
}

export class EdgeContext extends Map<string, EdgeSubject> {
  constructor() {
    super();
  }


}

export class EdgeMap extends Map<string, EdgeContext> {
  constructor() {
    super();
  }

  add(key: string, context: string, subjectId: string, value: IEdge): this {
    let contextEdge = this.get(key);
    if (!contextEdge) {
      contextEdge = new EdgeContext();
      this.set(key, contextEdge);
    }

    let subjectEdge = contextEdge.get(context);
    if (!subjectEdge) {
      subjectEdge = new EdgeSubject();
      contextEdge.set(context, subjectEdge);
    }

    subjectEdge.set(subjectId, value);
    return this;
  }

  remove(key: string, context: string, subjectId: string): this {
    let contextEdge = this.get(key);
    if (!contextEdge) {
      return this;
    }
    let subjectEdge = contextEdge.get(context);
    if (!subjectEdge) {
      return this;
    }
    subjectEdge.delete(subjectId);
    if (subjectEdge.size === 0) {
      contextEdge.delete(context);
      if (contextEdge.size === 0) {
        this.delete(key);
      }
    }
    return this;
  }

  getSubjects(options: { kind?: number, context?: string, subjectType?: SubjectType }): EdgeSubject | undefined {
    let { kind = KIND_TRUST, context = '', subjectType = 'p' } = options;

    let key = EdgeMap.createKey(kind, subjectType);

    let contextEdge = this.get(key);
    if (!contextEdge) return undefined;

    let subjectEdge = contextEdge.get(context);
    return subjectEdge;
  }

  getContexts(options: { kind?: number, subjectType?: SubjectType }): EdgeContext | undefined {
    let { kind = KIND_TRUST, subjectType = 'p' } = options;
    let key = EdgeMap.createKey(kind, subjectType);
    return this.get(key);
  }



  static createKey(kind: number, subjectType: SubjectType): string {
    let edge_sub_type = subjectType === 'p' ? 'p' : 'i';
    return `${kind}${edge_sub_type}`;
  }

}


