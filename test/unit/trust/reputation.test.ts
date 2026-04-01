import { describe, it, expect } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import { aggregateByTarget, resolveLatestWins, type ITrustRow } from '../../../src/lib/trust/reputation.js';

const TEST_SK = new Uint8Array(32);
TEST_SK.fill(0x7f);

function makeTrustEvent(
  tags: string[][],
  content = '',
  created_at = Math.floor(Date.now() / 1000)
) {
  return finalizeEvent(
    { kind: 32010, content, tags, created_at },
    TEST_SK
  );
}

describe('reputation module', () => {
  describe('aggregateByTarget', () => {
    it('should count trust, neutral, distrust', () => {
      const rows: ITrustRow[] = [
        {
          author_id: 'a',
          subject_id: 'x',
          context: 'dev',
          value: 1,
          event_id: 'e1',
          created_at: 100,
        },
        {
          author_id: 'b',
          subject_id: 'x',
          context: 'dev',
          value: 1,
          event_id: 'e2',
          created_at: 101,
        },
        {
          author_id: 'c',
          subject_id: 'x',
          context: 'dev',
          value: -1,
          event_id: 'e3',
          created_at: 102,
        },
      ];
      const r = aggregateByTarget(rows);
      expect(r.trust).toBe(2);
      expect(r.distrust).toBe(1);
      expect(r.neutral).toBe(0);
    });

    it('should filter by context when provided', () => {
      const rows: ITrustRow[] = [
        {
          author_id: 'a',
          subject_id: 'x',
          context: 'dev',
          value: 1,
          event_id: 'e1',
          created_at: 100,
        },
        {
          author_id: 'b',
          subject_id: 'x',
          context: 'commerce',
          value: -1,
          event_id: 'e2',
          created_at: 101,
        },
      ];
      const r = aggregateByTarget(rows, 'dev');
      expect(r.trust).toBe(1);
      expect(r.distrust).toBe(0);
    });

    it('should count neutral (value 0)', () => {
      const rows: ITrustRow[] = [
        {
          author_id: 'a',
          subject_id: 'x',
          context: '',
          value: 0,
          event_id: 'e1',
          created_at: 100,
        },
      ];
      const r = aggregateByTarget(rows);
      expect(r.neutral).toBe(1);
      expect(r.trust).toBe(0);
      expect(r.distrust).toBe(0);
    });
  });

  describe('resolveLatestWins', () => {
    it('should apply latest-wins per author|subject|context', () => {
      const subj = 'a'.repeat(64);
      const e1 = makeTrustEvent(
        [['d', subj], ['p', subj], ['c', 'dev'], ['v', '1']],
        '',
        100
      );
      const e2 = makeTrustEvent(
        [['d', subj + '|dev'], ['p', subj], ['c', 'dev'], ['v', '-1']],
        '',
        101
      );

      const map = resolveLatestWins([e1, e2]);
      const author = e1.pubkey.toLowerCase();
      const key = `${author}|${subj}|dev`;
      const entry = map.get(key);
      expect(entry).toBeDefined();
      expect(entry!.value).toBe(-1);
      expect(entry!.event).toBe(e2);
    });

    it('should handle batch events', () => {
      const s1 = 'a'.repeat(64);
      const s2 = 'b'.repeat(64);
      const e = makeTrustEvent(
        [['d', 'xor|spam'], ['p', s1], ['p', s2], ['c', 'spam'], ['v', '-1']],
        '',
        100
      );
      const map = resolveLatestWins([e]);
      const author = e.pubkey.toLowerCase();
      expect(map.get(`${author}|${s1}|spam`)?.value).toBe(-1);
      expect(map.get(`${author}|${s2}|spam`)?.value).toBe(-1);
    });

    it('should ignore non-32010 events', () => {
      const e = makeTrustEvent([['p', 'a'.repeat(64)]], '', 100);
      (e as { kind: number }).kind = 1;
      const map = resolveLatestWins([e]);
      expect(map.size).toBe(0);
    });
  });
});
