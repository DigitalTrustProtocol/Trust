import type { VerifiedEvent } from 'nostr-tools';
import type { SubjectType, Identity } from '../../nostr/nip32010.js';
import { parseIdentityFromKind0, mergeIdentity } from '../identity.js';
import { EdgeMap, OutTrust } from './EdgeMap.js';

export class Node {
  index: number = 0;
  id: string; // pubkey or subject id (e.g. event id)
  type: SubjectType;

  identity?: Identity;

  // Not implemented yet
  delegate?: Map<string, any>; // delegate pubkey and context new Map<string, id> (context is the key)

  outgoing: EdgeMap = new EdgeMap();
  incoming: EdgeMap = new EdgeMap();

  out: OutTrust = new OutTrust();

  // Not implemented yet
  attributes?: Map<string, any>; //  context is the key, value is the attribute
  
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
