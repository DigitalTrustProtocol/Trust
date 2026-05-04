import { describe, expect, it } from 'vitest';
import { IndexMap, packIndexMapKey, unpackIndexMapKey } from '../../src/lib/IndexMap.js';

describe('IndexMap', () => {
  it('packs and unpacks round-trip', () => {
    const k = packIndexMapKey(1, 2, 3);
    expect(unpackIndexMapKey(k)).toEqual([1, 2, 3]);
  });

  it('setAt / getAt / hasAt / deleteAt', () => {
    const m = new IndexMap();
    expect(m.getAt(10, 20, 30)).toBeUndefined();
    m.setAt(10, 20, 30, 999);
    expect(m.getAt(10, 20, 30)).toBe(999);
    expect(m.hasAt(10, 20, 30)).toBe(true);
    expect(m.deleteAt(10, 20, 30)).toBe(true);
    expect(m.hasAt(10, 20, 30)).toBe(false);
  });

  it('constructor accepts triplet entries', () => {
    const m = new IndexMap([
      [[0, 0, 0], 0],
      [[1, 2, 3], 42],
    ]);
    expect(m.getAt(1, 2, 3)).toBe(42);
  });

  it('entriesByTriplet lists unpacked keys', () => {
    const m = new IndexMap([[[7, 8, 9], 5]]);
    expect([...m.entriesByTriplet()]).toEqual([[[7, 8, 9], 5]]);
  });

  it('distinct triplets do not collide at uint32 boundaries', () => {
    const a = packIndexMapKey(0xffffffff, 0, 0);
    const b = packIndexMapKey(0, 0xffffffff, 0);
    expect(a).not.toBe(b);
    expect(unpackIndexMapKey(a)[0]).toBe(0xffffffff);
    expect(unpackIndexMapKey(b)[1]).toBe(0xffffffff);
  });
});
