import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyEvent } from 'nostr-tools/pure';

const TEST_SECRET_KEY = 'a'.repeat(64);
let TEST_DIR: string;

// Mock config - factory must not reference outer variables
vi.mock('../../src/config.js', () => {
  const testDir = join(tmpdir(), 'trust-signer-test-' + process.pid + '-' + Date.now());
  return {
    PATHS: {
      configDir: testDir,
      secretKey: join(testDir, 'secret.key'),
      config: join(testDir, 'config.json'),
    },
    DEFAULT_RELAYS: ['wss://relay.test'],
  };
});

import { signEvent, createEventTemplate, createSignedEvent } from '../../src/lib/signer.js';
import { PATHS } from '../../src/config.js';

describe('signer module', () => {
  beforeEach(() => {
    TEST_DIR = PATHS.configDir;
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(PATHS.secretKey, TEST_SECRET_KEY);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('createEventTemplate', () => {
    it('should create template with required fields', () => {
      const template = createEventTemplate(1, 'Hello, Nostr!');

      expect(template.kind).toBe(1);
      expect(template.content).toBe('Hello, Nostr!');
      expect(template.tags).toEqual([]);
      expect(template.created_at).toBeTypeOf('number');
    });

    it('should include custom tags', () => {
      const tags = [
        ['p', 'b'.repeat(64)],
        ['e', 'c'.repeat(64)],
      ];
      const template = createEventTemplate(1, 'Reply', tags);

      expect(template.tags).toEqual(tags);
    });

    it('should set timestamp close to now', () => {
      const before = Math.floor(Date.now() / 1000);
      const template = createEventTemplate(1, 'test');
      const after = Math.floor(Date.now() / 1000);

      expect(template.created_at).toBeGreaterThanOrEqual(before);
      expect(template.created_at).toBeLessThanOrEqual(after);
    });
  });

  describe('signEvent', () => {
    it('should sign event template', () => {
      const template = createEventTemplate(1, 'Hello!');
      const signedEvent = signEvent(template);

      expect(signedEvent.id).toMatch(/^[0-9a-f]{64}$/);
      expect(signedEvent.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(signedEvent.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(signedEvent.kind).toBe(1);
      expect(signedEvent.content).toBe('Hello!');
    });

    it('should produce verifiable signature', () => {
      const template = createEventTemplate(1, 'Verify me!');
      const signedEvent = signEvent(template);

      expect(verifyEvent(signedEvent)).toBe(true);
    });

    it('should throw when no secret key', () => {
      rmSync(PATHS.secretKey);

      expect(() => signEvent(createEventTemplate(1, 'test'))).toThrow(
        'No secret key found'
      );
    });

    it('should preserve all template fields', () => {
      const tags = [['t', 'test']];
      const template = createEventTemplate(1111, 'Custom content', tags);
      const signedEvent = signEvent(template);

      expect(signedEvent.kind).toBe(1111);
      expect(signedEvent.content).toBe('Custom content');
      expect(signedEvent.tags).toEqual(tags);
      expect(signedEvent.created_at).toBe(template.created_at);
    });
  });

  describe('createSignedEvent', () => {
    it('should create and sign in one step', () => {
      const event = createSignedEvent(1, 'Quick post');

      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(verifyEvent(event)).toBe(true);
    });

    it('should include tags', () => {
      const tags = [['t', 'trust']];
      const event = createSignedEvent(1111, 'Post to trust', tags);

      expect(event.tags).toEqual(tags);
    });

    it('should work for various event kinds', () => {
      const kinds = [0, 1, 3, 7, 1111, 10000, 30023];

      for (const kind of kinds) {
        const event = createSignedEvent(kind, `Kind ${kind} event`);
        expect(event.kind).toBe(kind);
        expect(verifyEvent(event)).toBe(true);
      }
    });
  });
});
