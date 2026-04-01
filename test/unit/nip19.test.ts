import { describe, it, expect } from 'vitest';
import {
  decode,
  encodeNpub,
  encodeNote,
  encodeNevent,
  encodeNprofile,
  encodeNaddr,
  isNip19,
  extractPubkey,
  extractEventId,
} from '../../src/lib/nostr/nip19.js';

// Test fixtures
const TEST_PUBKEY = 'a'.repeat(64);
const TEST_EVENT_ID = 'b'.repeat(64);
const TEST_RELAY = 'wss://relay.damus.io';

describe('nip19 module', () => {
  describe('encodeNpub', () => {
    it('should encode a public key to npub', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      expect(npub).toMatch(/^npub1[a-z0-9]+$/);
    });

    it('should produce consistent encoding', () => {
      const npub1 = encodeNpub(TEST_PUBKEY);
      const npub2 = encodeNpub(TEST_PUBKEY);
      expect(npub1).toBe(npub2);
    });
  });

  describe('encodeNote', () => {
    it('should encode an event ID to note', () => {
      const note = encodeNote(TEST_EVENT_ID);
      expect(note).toMatch(/^note1[a-z0-9]+$/);
    });
  });

  describe('encodeNevent', () => {
    it('should encode event ID without relays', () => {
      const nevent = encodeNevent(TEST_EVENT_ID);
      expect(nevent).toMatch(/^nevent1[a-z0-9]+$/);
    });

    it('should encode event ID with relay hints', () => {
      const nevent = encodeNevent(TEST_EVENT_ID, [TEST_RELAY]);
      expect(nevent).toMatch(/^nevent1[a-z0-9]+$/);

      // Decode and verify relay is included
      const decoded = decode(nevent);
      expect(decoded.type).toBe('nevent');
      expect((decoded.data as { relays?: string[] }).relays).toContain(TEST_RELAY);
    });

    it('should encode event ID with author', () => {
      const nevent = encodeNevent(TEST_EVENT_ID, undefined, TEST_PUBKEY);
      const decoded = decode(nevent);
      expect((decoded.data as { author?: string }).author).toBe(TEST_PUBKEY);
    });

    it('should encode event ID with kind', () => {
      const nevent = encodeNevent(TEST_EVENT_ID, undefined, undefined, 1);
      const decoded = decode(nevent);
      expect((decoded.data as { kind?: number }).kind).toBe(1);
    });
  });

  describe('encodeNprofile', () => {
    it('should encode pubkey to nprofile', () => {
      const nprofile = encodeNprofile(TEST_PUBKEY);
      expect(nprofile).toMatch(/^nprofile1[a-z0-9]+$/);
    });

    it('should encode pubkey with relay hints', () => {
      const nprofile = encodeNprofile(TEST_PUBKEY, [TEST_RELAY]);
      const decoded = decode(nprofile);
      expect((decoded.data as { relays?: string[] }).relays).toContain(TEST_RELAY);
    });
  });

  describe('encodeNaddr', () => {
    it('should encode addressable event', () => {
      const naddr = encodeNaddr(30023, TEST_PUBKEY, 'my-article');
      expect(naddr).toMatch(/^naddr1[a-z0-9]+$/);
    });

    it('should include all metadata', () => {
      const naddr = encodeNaddr(30023, TEST_PUBKEY, 'my-article', [TEST_RELAY]);
      const decoded = decode(naddr);

      const data = decoded.data as {
        kind: number;
        pubkey: string;
        identifier: string;
        relays?: string[];
      };

      expect(data.kind).toBe(30023);
      expect(data.pubkey).toBe(TEST_PUBKEY);
      expect(data.identifier).toBe('my-article');
      expect(data.relays).toContain(TEST_RELAY);
    });
  });

  describe('decode', () => {
    it('should decode npub', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      const decoded = decode(npub);

      expect(decoded.type).toBe('npub');
      expect(decoded.data).toBe(TEST_PUBKEY);
    });

    it('should decode note', () => {
      const note = encodeNote(TEST_EVENT_ID);
      const decoded = decode(note);

      expect(decoded.type).toBe('note');
      expect(decoded.data).toBe(TEST_EVENT_ID);
    });

    it('should decode nevent', () => {
      const nevent = encodeNevent(TEST_EVENT_ID, [TEST_RELAY], TEST_PUBKEY, 1);
      const decoded = decode(nevent);

      expect(decoded.type).toBe('nevent');
      const data = decoded.data as {
        id: string;
        relays?: string[];
        author?: string;
        kind?: number;
      };
      expect(data.id).toBe(TEST_EVENT_ID);
    });

    it('should decode nprofile', () => {
      const nprofile = encodeNprofile(TEST_PUBKEY, [TEST_RELAY]);
      const decoded = decode(nprofile);

      expect(decoded.type).toBe('nprofile');
      const data = decoded.data as { pubkey: string; relays?: string[] };
      expect(data.pubkey).toBe(TEST_PUBKEY);
    });

    it('should decode naddr', () => {
      const naddr = encodeNaddr(30023, TEST_PUBKEY, 'test-id');
      const decoded = decode(naddr);

      expect(decoded.type).toBe('naddr');
      const data = decoded.data as {
        kind: number;
        pubkey: string;
        identifier: string;
      };
      expect(data.kind).toBe(30023);
      expect(data.pubkey).toBe(TEST_PUBKEY);
      expect(data.identifier).toBe('test-id');
    });

    it('should throw on invalid input', () => {
      expect(() => decode('invalid')).toThrow();
      expect(() => decode('')).toThrow();
    });
  });

  describe('isNip19', () => {
    it('should return true for valid npub', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      expect(isNip19(npub)).toBe(true);
    });

    it('should return true for valid note', () => {
      const note = encodeNote(TEST_EVENT_ID);
      expect(isNip19(note)).toBe(true);
    });

    it('should return true for valid nevent', () => {
      const nevent = encodeNevent(TEST_EVENT_ID);
      expect(isNip19(nevent)).toBe(true);
    });

    it('should return true for valid nprofile', () => {
      const nprofile = encodeNprofile(TEST_PUBKEY);
      expect(isNip19(nprofile)).toBe(true);
    });

    it('should return true for valid naddr', () => {
      const naddr = encodeNaddr(30023, TEST_PUBKEY, 'test');
      expect(isNip19(naddr)).toBe(true);
    });

    it('should return false for hex pubkey', () => {
      expect(isNip19(TEST_PUBKEY)).toBe(false);
    });

    it('should return false for invalid strings', () => {
      expect(isNip19('invalid')).toBe(false);
      expect(isNip19('')).toBe(false);
      expect(isNip19('npub1invalid')).toBe(false);
    });
  });

  describe('extractPubkey', () => {
    it('should extract pubkey from npub', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      expect(extractPubkey(npub)).toBe(TEST_PUBKEY);
    });

    it('should extract pubkey from nprofile', () => {
      const nprofile = encodeNprofile(TEST_PUBKEY, [TEST_RELAY]);
      expect(extractPubkey(nprofile)).toBe(TEST_PUBKEY);
    });

    it('should throw for note', () => {
      const note = encodeNote(TEST_EVENT_ID);
      expect(() => extractPubkey(note)).toThrow('Cannot extract pubkey');
    });

    it('should throw for nevent', () => {
      const nevent = encodeNevent(TEST_EVENT_ID);
      expect(() => extractPubkey(nevent)).toThrow('Cannot extract pubkey');
    });
  });

  describe('extractEventId', () => {
    it('should extract event ID from note', () => {
      const note = encodeNote(TEST_EVENT_ID);
      expect(extractEventId(note)).toBe(TEST_EVENT_ID);
    });

    it('should extract event ID from nevent', () => {
      const nevent = encodeNevent(TEST_EVENT_ID, [TEST_RELAY]);
      expect(extractEventId(nevent)).toBe(TEST_EVENT_ID);
    });

    it('should throw for npub', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      expect(() => extractEventId(npub)).toThrow('Cannot extract event ID');
    });

    it('should throw for nprofile', () => {
      const nprofile = encodeNprofile(TEST_PUBKEY);
      expect(() => extractEventId(nprofile)).toThrow('Cannot extract event ID');
    });
  });
});
