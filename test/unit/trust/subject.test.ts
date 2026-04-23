import { describe, it, expect } from 'vitest';
import {
  encodeNpub,
  encodeNote,
  encodeNevent,
  encodeNprofile,
  encodeNaddr,
} from '../../../src/lib/nostr/nip19.js';
import {
  parseAuthorPubkeyInput,
  parseSubject,
  parseSubjects,
  resolveTargetForQuery,
} from '../../../src/lib/trust/subject.js';

const TEST_PUBKEY = 'a'.repeat(64);
const TEST_EVENT_ID = 'b'.repeat(64);

describe('subject module', () => {
  describe('parseSubject', () => {
    describe('bare hex and explicit tags', () => {
      it('should parse bare 64-char hex as i (hash: typed id)', () => {
        const r = parseSubject(TEST_PUBKEY);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`hash:${TEST_PUBKEY.toLowerCase()}`);
        expect(r.k).toBeUndefined();
      });

      it('should parse pubkey: prefix as p', () => {
        const r = parseSubject(`pubkey:${TEST_PUBKEY}`);
        expect(r.tag).toBe('p');
        expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
        expect(r.k).toBeUndefined();
      });

      it('should force event id with e: prefix for 64-char hex', () => {
        const r = parseSubject(`e:${TEST_EVENT_ID}`);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`nevent:${TEST_EVENT_ID.toLowerCase()}`);
      });

      it('should force pubkey with p: prefix for 64-char hex', () => {
        const r = parseSubject(`p:${TEST_PUBKEY}`);
        expect(r.tag).toBe('p');
        expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
      });

      it('should force URL with r: prefix', () => {
        const r = parseSubject('r:example.com/foo');
        expect(r.tag).toBe('i');
        expect(r.value).toBe('url:https://example.com/foo');
      });
    });

    describe('NIP-19', () => {
      it('should parse npub as pubkey', () => {
        const npub = encodeNpub(TEST_PUBKEY);
        const r = parseSubject(npub);
        expect(r.tag).toBe('p');
        expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
      });

      it('should parse nprofile as pubkey', () => {
        const nprofile = encodeNprofile(TEST_PUBKEY);
        const r = parseSubject(nprofile);
        expect(r.tag).toBe('p');
        expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
      });

      it('should parse note as typed i (node id)', () => {
        const note = encodeNote(TEST_EVENT_ID);
        const r = parseSubject(note);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`node:${TEST_EVENT_ID.toLowerCase()}`);
        expect(r.k).toBeUndefined();
      });

      it('should parse nevent without kind as i (nevent id)', () => {
        const nevent = encodeNevent(TEST_EVENT_ID);
        const r = parseSubject(nevent);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`nevent:${TEST_EVENT_ID.toLowerCase()}`);
        expect(r.k).toBeUndefined();
      });

      it('should parse nevent with kind as i (nevent id)', () => {
        const nevent = encodeNevent(TEST_EVENT_ID, undefined, undefined, 30023);
        const r = parseSubject(nevent);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`nevent:${TEST_EVENT_ID.toLowerCase()}`);
        expect(r.k).toBeUndefined();
      });

      it('should parse naddr as typed i (naddressable)', () => {
        const naddr = encodeNaddr(30023, TEST_PUBKEY, 'my-article');
        const r = parseSubject(naddr);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`naddressable:30023:${TEST_PUBKEY.toLowerCase()}:my-article`);
      });
    });

    describe('nostr URI', () => {
      it('should parse nostr:npub...', () => {
        const npub = encodeNpub(TEST_PUBKEY);
        const r = parseSubject('nostr:' + npub);
        expect(r.tag).toBe('p');
        expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
      });
    });

    describe('a tag', () => {
      it('should parse kind:pubkey:d format', () => {
        const r = parseSubject(`30023:${TEST_PUBKEY}:my-id`);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`naddressable:30023:${TEST_PUBKEY.toLowerCase()}:my-id`);
      });
    });

    describe('URL', () => {
      it('should parse https URL as i (url:)', () => {
        const r = parseSubject('https://example.com/path?q=1');
        expect(r.tag).toBe('i');
        expect(r.value).toBe('url:https://example.com/path?q=1');
      });

      it('should strip fragment from URL', () => {
        const r = parseSubject('https://example.com/path#section');
        expect(r.tag).toBe('i');
        expect(r.value).toBe('url:https://example.com/path');
      });
    });

    describe('hash', () => {
      it('should parse h: prefix for hash', () => {
        const hash = 'c'.repeat(64);
        const r = parseSubject('h:' + hash);
        expect(r.tag).toBe('i');
        expect(r.value).toBe(`hash:${hash.toLowerCase()}`);
      });
    });

    describe('NIP-73', () => {
      it('should parse isbn:', () => {
        const r = parseSubject('isbn:978-0-76-538203-0');
        expect(r.tag).toBe('i');
        expect(r.value).toBe('ext:isbn:9780765382030');
        expect(r.k).toBe('isbn');
      });

      it('should parse doi:', () => {
        const r = parseSubject('doi:10.1234/example.paper');
        expect(r.tag).toBe('i');
        expect(r.value).toBe('ext:doi:10.1234/example.paper');
        expect(r.k).toBe('doi');
      });

      it('should parse geo:', () => {
        const r = parseSubject('geo:ezs42e44yx96');
        expect(r.tag).toBe('i');
        expect(r.k).toBe('geo');
      });
    });

    describe('errors', () => {
      it('should throw on empty input', () => {
        expect(() => parseSubject('')).toThrow(/cannot be empty/);
        expect(() => parseSubject('   ')).toThrow(/cannot be empty/);
      });

      it('should throw on unparseable input', () => {
        expect(() => parseSubject('not-a-valid-subject-xyz')).toThrow(/Cannot parse/);
      });
    });
  });

  describe('parseSubjects', () => {
    it('should parse multiple inputs', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      const note = encodeNote(TEST_EVENT_ID);
      const results = parseSubjects([npub, note]);
      expect(results).toHaveLength(2);
      expect(results[0].tag).toBe('p');
      expect(results[0].value).toBe(TEST_PUBKEY.toLowerCase());
      expect(results[1].tag).toBe('i');
      expect(results[1].value).toBe(`node:${TEST_EVENT_ID.toLowerCase()}`);
    });
  });

  describe('resolveTargetForQuery', () => {
    it('should resolve npub to canonical pubkey', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      const r = resolveTargetForQuery(npub);
      expect(r.tag).toBe('p');
      expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
    });

    it('should resolve bare hex as p (pubkey query target)', () => {
      const r = resolveTargetForQuery(TEST_PUBKEY);
      expect(r.tag).toBe('p');
      expect(r.value).toBe(TEST_PUBKEY.toLowerCase());
    });

    it('should resolve URL to canonical form', () => {
      const r = resolveTargetForQuery('https://example.com/foo');
      expect(r.tag).toBe('i');
      expect(r.value).toBe('url:https://example.com/foo');
    });
  });

  describe('parseAuthorPubkeyInput', () => {
    it('should treat bare 64-hex as pubkey (author context)', () => {
      expect(parseAuthorPubkeyInput(TEST_PUBKEY)).toBe(TEST_PUBKEY.toLowerCase());
    });

    it('should accept npub', () => {
      const npub = encodeNpub(TEST_PUBKEY);
      expect(parseAuthorPubkeyInput(npub)).toBe(TEST_PUBKEY.toLowerCase());
    });

    it('should reject note id as author', () => {
      const note = encodeNote(TEST_EVENT_ID);
      expect(() => parseAuthorPubkeyInput(note)).toThrow(/pubkey/);
    });
  });
});
