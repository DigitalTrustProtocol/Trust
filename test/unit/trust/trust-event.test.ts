import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { computeDTag, buildTrustEventTemplate } from '../../../src/lib/nostr/nip32010.js';
import type { ParsedSubject } from '../../../src/lib/trust/subject.js';

describe('nip32010 computeDTag / buildTrustEventTemplate', () => {
  describe('computeDTag', () => {
    it('single p subject, no context', () => {
      const subj: ParsedSubject = { tag: 'p', value: 'A'.repeat(64), k: '' };
      const d = computeDTag([subj]);
      expect(d).toBe('a'.repeat(64));
    });

    it('single p subject, with context', () => {
      const subj: ParsedSubject = { tag: 'p', value: 'A'.repeat(64), k: '' };
      const d = computeDTag([subj], 'development');
      expect(d).toBe('a'.repeat(64) + '|development');
    });

    it('duplicate p subjects dedupe to one fragment', () => {
      const s1: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      const s2: ParsedSubject = { tag: 'p', value: 'A'.repeat(64), k: '' };
      const d = computeDTag([s1, s2]);
      expect(d).toBe('a'.repeat(64)); // same as single subject
    });

    it('triple duplicate subject same as single', () => {
      const s: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      expect(computeDTag([s, s, s])).toBe('a'.repeat(64));
    });

    it('dedupe invariant: [a,a,b] same as [a,b]', () => {
      const a: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      const b: ParsedSubject = { tag: 'p', value: 'b'.repeat(64), k: '' };
      expect(computeDTag([a, a, b])).toBe(computeDTag([a, b]));
    });

    it('two distinct p subjects XOR then context', () => {
      const s1: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      const s2: ParsedSubject = { tag: 'p', value: 'b'.repeat(64), k: '' };
      const d = computeDTag([s1, s2], 'spam');
      const b1 = Uint8Array.from({ length: 32 }, (_, i) => parseInt(s1.value.slice(i * 2, i * 2 + 2), 16));
      const b2 = Uint8Array.from({ length: 32 }, (_, i) => parseInt(s2.value.slice(i * 2, i * 2 + 2), 16));
      const xored = new Uint8Array(32);
      for (let i = 0; i < 32; i++) xored[i] = b1[i]! ^ b2[i]!;
      expect(d).toBe(`${bytesToHex(xored)}|spam`);
    });

    it('two distinct p XOR no context', () => {
      const s1: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      const s2: ParsedSubject = { tag: 'p', value: 'b'.repeat(64), k: '' };
      const d = computeDTag([s1, s2]);
      const b1 = Uint8Array.from({ length: 32 }, (_, i) => parseInt(s1.value.slice(i * 2, i * 2 + 2), 16));
      const b2 = Uint8Array.from({ length: 32 }, (_, i) => parseInt(s2.value.slice(i * 2, i * 2 + 2), 16));
      const xored = new Uint8Array(32);
      for (let i = 0; i < 32; i++) xored[i] = b1[i]! ^ b2[i]!;
      expect(d).toBe(bytesToHex(xored));
    });

    it('non-64-hex preimage hashes to fragment', () => {
      const s: ParsedSubject = { tag: 'i', value: 'url:https://example.com/a' };
      const te = new TextEncoder();
      expect(computeDTag([s])).toBe(`${bytesToHex(sha256(te.encode(s.value.toLowerCase())))}`);
    });

    it('empty subjects throws', () => {
      expect(() => computeDTag([])).toThrow(/At least one/);
    });
  });

  describe('buildTrustEventTemplate', () => {
    it('includes d and v, no t tag', () => {
      const subj: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      const t = buildTrustEventTemplate({ subjects: [subj], value: 1 });
      expect(t.kind).toBe(32010);
      expect(t.tags).toContainEqual(['d', 'a'.repeat(64)]);
      expect(t.tags.find((x) => x[0] === 't')).toBeUndefined();
      expect(t.tags).toContainEqual(['v', '1']);
      expect(t.tags.filter((x) => x[0] === 'p')).toEqual([['p', 'a'.repeat(64)]]);
    });

    it('includes context c when non-empty', () => {
      const subj: ParsedSubject = { tag: 'p', value: 'a'.repeat(64), k: '' };
      const t = buildTrustEventTemplate({ subjects: [subj], context: 'dev', value: 0 });
      expect(t.tags.find((x) => x[0] === 'd')?.[1]).toBe('a'.repeat(64) + '|dev');
      expect(t.tags).toContainEqual(['c', 'dev']);
      expect(t.tags).toContainEqual(['v', '0']);
    });

    it('emits i tag with typed subject value (no k wire tags)', () => {
      const subj: ParsedSubject = { tag: 'i', value: `node:${'b'.repeat(64)}` };
      const t = buildTrustEventTemplate({ subjects: [subj], value: 1 });
      expect(t.tags).toContainEqual(['i', `node:${'b'.repeat(64)}`]);
      expect(t.tags.some((x) => x[0] === 'k')).toBe(false);
    });

    it('emits one i tag per subject in wire order (no k wire tags)', () => {
      const s1: ParsedSubject = { tag: 'i', value: 'ext:isbn:9780000000001', k: 'isbn' };
      const s2: ParsedSubject = { tag: 'i', value: 'ext:doi:10.1/x', k: 'doi' };
      const t = buildTrustEventTemplate({ subjects: [s1, s2], value: 1 });
      const iTags = t.tags.filter((x) => x[0] === 'i');
      expect(iTags).toEqual([
        ['i', 'ext:isbn:9780000000001'],
        ['i', 'ext:doi:10.1/x'],
      ]);
      expect(t.tags.some((x) => x[0] === 'k')).toBe(false);
    });
  });
});
