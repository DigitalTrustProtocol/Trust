import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { computeDTag, buildTrustEventTemplate } from '../../../src/lib/nostr/nip32010.js';
import { parseSubject } from '../../../src/lib/trust/subject.js';

const te = new TextEncoder();

function xorBytes32(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

describe('trust-event module', () => {
  describe('computeDTag', () => {
    it('should use raw 64-hex for single p/e/h subject (no hash)', () => {
      const subj = parseSubject('a'.repeat(64));
      const d = computeDTag([subj]);
      expect(d).toBe(`32010|` + 'a'.repeat(64));
    });

    it('should append context for single subject', () => {
      const subj = parseSubject('a'.repeat(64));
      const d = computeDTag([subj], 'development');
      expect(d).toBe(`32010|` + 'a'.repeat(64) + '|development');
    });

    it('should dedupe identical fragments before XOR (no F xor F cancellation)', () => {
      const s1 = parseSubject('a'.repeat(64));
      const s2 = parseSubject('a'.repeat(64));
      const d = computeDTag([s1, s2]);
      expect(d).toBe(`32010|` + 'a'.repeat(64)); // same as single subject
    });

    it('should dedupe so triple identical subject matches single', () => {
      const s = parseSubject('a'.repeat(64));
      expect(computeDTag([s, s, s])).toBe(`32010|` + 'a'.repeat(64));
    });

    it('should XOR only unique fragments when duplicates mixed with distinct', () => {
      const a = parseSubject('a'.repeat(64));
      const b = parseSubject('b'.repeat(64));
      expect(computeDTag([a, a, b])).toBe(computeDTag([a, b]));
    });

    it('should compute XOR for batch with context', () => {
      const s1 = parseSubject('a'.repeat(64));
      const s2 = parseSubject('b'.repeat(64));
      const xored = xorBytes32(hexToBytes(s1.value), hexToBytes(s2.value));
      const d = computeDTag([s1, s2], 'spam');
      expect(d).toBe(`32010|${bytesToHex(xored)}|spam`);
    });

    it('should XOR SHA256(canonical URL) for non-hex subjects in batch', () => {
      const s1 = parseSubject('https://example.com');
      const s2 = parseSubject('https://example.org');
      const d = computeDTag([s1, s2]);
      const xored = xorBytes32(sha256(te.encode(s1.value)), sha256(te.encode(s2.value)));
      expect(d).toBe(`32010|${bytesToHex(xored)}`);
    });

    it('should SHA256 single non-hex subject for d tag', () => {
      const s = parseSubject('https://example.com');
      expect(computeDTag([s])).toBe(`32010|${bytesToHex(sha256(te.encode(s.value)))}`);
    });

    it('should throw on empty subjects', () => {
      expect(() => computeDTag([])).toThrow(/At least one/);
    });
  });

  describe('buildTrustEventTemplate', () => {
    it('should build template for single identity', () => {
      const subj = parseSubject('a'.repeat(64));
      const t = buildTrustEventTemplate({ subjects: [subj], value: 1 });
      expect(t.kind).toBe(32010);
      expect(t.tags).toContainEqual(['d', `32010|` + 'a'.repeat(64)]);
      expect(t.tags).toContainEqual(['t', '32010']);
      expect(t.tags).toContainEqual(['v', '1']);
      expect(t.tags).toContainEqual(['p', 'a'.repeat(64)]);
    });

    it('should include context and content', () => {
      const subj = parseSubject('a'.repeat(64));
      const t = buildTrustEventTemplate({
        subjects: [subj],
        context: 'dev',
        value: 1,
        content: 'Good dev',
      });
      expect(t.tags).toContainEqual(['c', 'dev']);
      expect(t.content).toBe('Good dev');
      expect(t.tags.find((x) => x[0] === 'd')?.[1]).toBe(`32010|` + 'a'.repeat(64) + '|dev');
      expect(t.tags).toContainEqual(['t', '32010']);
    });

    it('should build batch template', () => {
      const s1 = parseSubject('a'.repeat(64));
      const s2 = parseSubject('b'.repeat(64));
      const t = buildTrustEventTemplate({
        subjects: [s1, s2],
        context: 'spam',
        value: -1,
      });
      expect(t.tags).toContainEqual(['p', 'a'.repeat(64)]);
      expect(t.tags).toContainEqual(['p', 'b'.repeat(64)]);
      expect(t.tags).toContainEqual(['v', '-1']);
      expect(t.tags).toContainEqual(['c', 'spam']);
      expect(t.tags).toContainEqual(['t', '32010']);
      expect(t.tags.find((x) => x[0] === 'd')?.[1]).toMatch(/\|spam$/);
    });

    it('should include k tag for NIP-73 subject', () => {
      const subj = parseSubject('isbn:9780765382030');
      const t = buildTrustEventTemplate({
        subjects: [subj],
        context: 'books',
        value: 1,
      });
      expect(t.tags).toContainEqual(['i', 'isbn:9780765382030']);
      expect(t.tags).toContainEqual(['k', 'isbn']);
      expect(t.tags.find((x) => x[0] === 'd')?.[1]).toBe(computeDTag([subj], 'books'));
    });

    it('should reject content > 1024 chars', () => {
      const subj = parseSubject('a'.repeat(64));
      expect(() =>
        buildTrustEventTemplate({
          subjects: [subj],
          value: 1,
          content: 'x'.repeat(1025),
        })
      ).toThrow(/1024/);
    });

    it('should reject invalid value', () => {
      const subj = parseSubject('a'.repeat(64));
      expect(() =>
        buildTrustEventTemplate({ subjects: [subj], value: 2 as 1 })
      ).toThrow(/1, 0, or -1/);
    });

    it('should reject empty subjects', () => {
      expect(() =>
        buildTrustEventTemplate({ subjects: [], value: 1 })
      ).toThrow(/At least one/);
    });
  });
});
