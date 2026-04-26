import { describe, expect, it } from 'vitest';
import { EdgeView } from '../../../src/lib/trust/graph/EdgeView.js';
import type { IEdge } from '../../../src/lib/trust/graph/Edge.js';

describe('EdgeView', () => {
    const upperHex = 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899';
    const lowerHex = upperHex.toLowerCase();

    function makeEdge(overrides?: Partial<IEdge>): IEdge {
        return {
            parameterizedId: lowerHex,
            author: 'a'.repeat(64),
            kind: 32010,
            value: 1,
            context: '',
            createdAt: 1_700_000_000,
            activate: 100,
            expire: 200,
            content: undefined,
            index: 42,
            update() {
                return this;
            },
            isValidAt() {
                return true;
            },
            ...overrides,
        };
    }

    it('stores and returns d_tag as lowercase hex', () => {
        const v = new EdgeView();
        v.d_tag = upperHex;
        expect(v.d_tag).toBe(lowerHex);
    });

    it('encodes/decodes numeric fields', () => {
        const v = new EdgeView();
        v.nodeIndex = 1234;
        v.activate = 1111;
        v.expire = 2222;
        v.value = -1;
        expect(v.nodeIndex).toBe(1234);
        expect(v.activate).toBe(1111);
        expect(v.expire).toBe(2222);
        expect(v.value).toBe(-1);
    });

    it('update(edge) writes all mapped fields', () => {
        const v = new EdgeView();
        const edge = makeEdge({ index: 7, activate: 333, expire: 444, value: 0 });
        v.update(edge);
        expect(v.d_tag).toBe(lowerHex);
        expect(v.nodeIndex).toBe(7);
        expect(v.activate).toBe(333);
        expect(v.expire).toBe(444);
        expect(v.value).toBe(0);
    });

    it('attach rebinds to existing storage', () => {
        const row = new Uint8Array(EdgeView.SIZE);
        const a = new EdgeView(makeEdge({ index: 9, activate: 10, expire: 11, value: 1 }));
        row.set(a.bytes);
        const b = new EdgeView();
        b.attach(row);
        expect(b.d_tag).toBe(lowerHex);
        expect(b.nodeIndex).toBe(9);
        expect(b.activate).toBe(10);
        expect(b.expire).toBe(11);
        expect(b.value).toBe(1);
    });
});
