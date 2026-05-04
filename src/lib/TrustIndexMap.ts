/**
 * Maps (authorIndex, contextIndex, subjectIndex) → trust list index.
 *
 * Keys are packed into a `bigint` so the underlying `Map` uses primitive
 * equality (unlike object or array keys, which are compared by reference).
 *
 * Each index lane uses 32 bits (uint32 space); components must be in
 * `0 … 0xffffffff` so packing is well-defined.
 */
export type IndexMapKey = bigint;

/** Trust row index stored as a JS number (use uint32 / 4-byte range in practice). */
export type TrustIndex = number;

const MASK32 = 0xffffffffn;

function toLane(n: number): bigint {
  return BigInt(n >>> 0);
}

/** Pack three nonnegative indices (uint32 space) into one map key. */
export function packIndexMapKey(
  authorIndex: number,
  contextIndex: number,
  subjectIndex: number,
): IndexMapKey {
  return (toLane(authorIndex) << 64n) | (toLane(contextIndex) << 32n) | toLane(subjectIndex);
}

/** Inverse of {@link packIndexMapKey}. */
export function unpackIndexMapKey(key: IndexMapKey): readonly [authorIndex: number, contextIndex: number, subjectIndex: number] {
  const subjectIndex = Number(key & MASK32);
  const contextIndex = Number((key >> 32n) & MASK32);
  const authorIndex = Number((key >> 64n) & MASK32);
  return [authorIndex, contextIndex, subjectIndex];
}

export class TrustIndexMap extends Map<IndexMapKey, TrustIndex> {
  constructor(entries?: Iterable<readonly [readonly [number, number, number], TrustIndex]> | null) {
    if (entries === undefined || entries === null) {
      super();
      return;
    }
    super(
      (function* () {
        for (const [[a, c, s], trust] of entries) {
          yield [packIndexMapKey(a, c, s), trust] as const;
        }
      })(),
    );
  }

  getAt(authorIndex: number, contextIndex: number, subjectIndex: number): TrustIndex | undefined {
    return this.get(packIndexMapKey(authorIndex, contextIndex, subjectIndex));
  }

  setAt(
    authorIndex: number,
    contextIndex: number,
    subjectIndex: number,
    trustIndex: TrustIndex,
  ): this {
    return this.set(packIndexMapKey(authorIndex, contextIndex, subjectIndex), trustIndex);
  }

  hasAt(authorIndex: number, contextIndex: number, subjectIndex: number): boolean {
    return this.has(packIndexMapKey(authorIndex, contextIndex, subjectIndex));
  }

  deleteAt(authorIndex: number, contextIndex: number, subjectIndex: number): boolean {
    return this.delete(packIndexMapKey(authorIndex, contextIndex, subjectIndex));
  }

  /** Entries with unpacked triple keys (allocates a tuple per entry). */
  *entriesByTriplet(): IterableIterator<readonly [readonly [number, number, number], TrustIndex]> {
    for (const [k, v] of this) {
      yield [unpackIndexMapKey(k), v] as const;
    }
  }

  /** Keys as unpacked triples (allocates a tuple per key). */
  *keysByTriplet(): IterableIterator<readonly [number, number, number]> {
    for (const k of this.keys()) {
      yield unpackIndexMapKey(k);
    }
  }
}
