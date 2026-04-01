import type { VerifiedEvent } from 'nostr-tools';
import type { SubjectType, Identity } from '../../nostr/nip32010.js';
import { parseIdentityFromKind0, mergeIdentity } from '../identity.js';
import { EdgeMap } from './EdgeMap.js';

/** @deprecated Use Identity from identity.js */
export type NodeIdentity = Identity;

export class Node {
  id: string; // pubkey or subject id (e.g. event id)
  type: SubjectType;

  identity?: Identity;

  outgoing: EdgeMap = new EdgeMap();
  incoming: EdgeMap = new EdgeMap();

  constructor(id: string, type: SubjectType) {
    this.id = id;
    this.type = type;
  }

  /** Update identity from a kind 0 user metadata event. */
  updateUserMetadata(event: VerifiedEvent): this {
    const parsed = parseIdentityFromKind0(event);
    if (parsed) {
      this.identity = this.identity ? mergeIdentity(this.identity, parsed) : parsed;
    }
    return this;
  }

  updateIdentity(identity: Identity): this {
    if (!this.identity) {
      this.identity = identity;
    } 
    //else {
//      this.identity = mergeIdentity(this.identity, identity);
    //}
    return this;
  }
}
