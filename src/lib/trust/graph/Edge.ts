/**
 * Trust edge. Structural position (author, subject, context, subjectType) is
 * implied by where the edge lives in Node.outgoing / Node.incoming.
 */

import {
  getActivateFromTags,
  getContextFromTags,
  getExpireFromTags,
  getValueFromTags,
  ITrustEvent
} from "../../nostr/nip32010.js";





export interface IEdge {
  index?: number;
  addressableId: string;
  author: string;
  kind: number;
  value: any;
  context: string;
  createdAt: number;
  /** Activate (x) — valid only when current time >= this. Undefined = valid immediately. */
  activate?: number;
  /** Expire (y) — valid only when current time <= this. Undefined = no expiry. */
  expire?: number;
  content: string | undefined;
  update(event: ITrustEvent): this;
  /** True if edge is valid for resolution at given time (default: now). Edges with no activate/expire are always valid. */
  isValidAt(now?: number): boolean;
}


// Trust edge for kind 32010
export class EdgeT1 implements IEdge {
  addressableId: string;
  author: string;
  kind: number;
  value: 1 | 0 | -1 = 0;
  context: string = '';
  createdAt: number = 0;
  activate?: number;
  expire?: number;
  index: number = 0;
  content: string | undefined = undefined;

  constructor(event: ITrustEvent) {
    this.kind = event.kind;
    this.author = event.pubkey;
    this.addressableId = event.addressableId;
    this.update(event);
  }

  update(event: ITrustEvent): this {
    this.value = getValueFromTags(event);
    this.context = getContextFromTags(event);
    this.createdAt = event.created_at;
    this.activate = getActivateFromTags(event);
    this.expire = getExpireFromTags(event);
    this.content = event.content;
    return this;
  }

  isValidAt(time?: number): boolean {
    const t = time ?? Math.floor(Date.now() / 1000);
    if (this.activate !== undefined && t < this.activate) return false;
    if (this.expire !== undefined && t > this.expire) return false;
    return true;
  }

}

