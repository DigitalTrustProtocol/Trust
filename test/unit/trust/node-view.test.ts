import { describe, expect, it } from 'vitest';
import { NodeView } from '../../../src/lib/trust/graph/Node.js';

describe('NodeView', () => {
    const upperHex = 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899';
    const lowerHex = upperHex.toLowerCase();

    it('normalizes id output to lowercase hex', () => {
        const view = new NodeView(upperHex, 'p');
        // id getter currently returns all 33 bytes (id + type byte)
        expect(view.id.startsWith(lowerHex)).toBe(true);
        expect(view.id).toBe(view.id.toLowerCase());
    });

    it('round-trips id bytes through set/get', () => {
        const view = new NodeView('0'.repeat(64), 'p');
        view.id = upperHex;
        expect(view.id.startsWith(lowerHex)).toBe(true);
    });

    it('encodes and decodes type byte', () => {
        const view = new NodeView(lowerHex, 'p');
        expect(view.type).toBe('p');
        view.type = 'i';
        expect(view.type).toBe('i');
        // last byte in id string is type byte (00 for p, 01 for i)
        expect(view.id.endsWith('01')).toBe(true);
        view.type = 'p';
        expect(view.id.endsWith('00')).toBe(true);
    });

    it('attach rebinds to external storage', () => {
        const row = new Uint8Array(NodeView.SIZE);
        row.fill(0xaa, 0, 32);
        row[32] = 1;
        const view = new NodeView('0'.repeat(64), 'p');
        view.attach(row);
        expect(view.type).toBe('i');
        expect(view.id.startsWith('aa'.repeat(32))).toBe(true);
    });

    it('throws for invalid id length', () => {
        const view = new NodeView('0'.repeat(64), 'p');
        expect(() => {
            view.id = 'abcd';
        }).toThrow('Invalid pubkey length');
    });
});
