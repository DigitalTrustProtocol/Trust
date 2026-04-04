import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

// Create a unique test directory
const getTestDir = () => join(tmpdir(), 'trust-keys-test-' + process.pid + '-' + Date.now());
let TEST_DIR: string;

// Mock the config module - factory must not reference outer variables
vi.mock('../../src/config.js', () => {
  const testDir = join(tmpdir(), 'trust-keys-test-' + process.pid + '-' + Date.now());
  return {
    PATHS: {
      configDir: testDir,
      config: join(testDir, 'config.json'),
      identity: join(testDir, 'identity.json'),
      keysDir: join(testDir, 'keys'),
      trustDb: join(testDir, 'trust.db'),
      graphCache: join(testDir, 'graph-cache.bin'),
    },
    DEFAULT_RELAYS: ['wss://relay.test'],
    DEFAULT_MINT: 'https://mint.test',
  };
});

// Import after mocking
import {
  generateKeyPair,
  hasSecretKey,
  loadSecretKey,
  loadKeyPair,
  getOrCreateKeyPair,
} from '../../src/lib/keys.js';
import { addIdentityKey, identityPathForPubkey } from '../../src/lib/identityStore.js';
import { PATHS } from '../../src/config.js';

describe('keys module', () => {
  beforeEach(() => {
    TEST_DIR = PATHS.configDir;
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('generateKeyPair', () => {
    it('should generate a valid keypair', () => {
      const keyPair = generateKeyPair();

      expect(keyPair.secretKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.secretKey.length).toBe(32);
      expect(keyPair.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(keyPair.nsec).toMatch(/^nsec1[a-z0-9]+$/);
      expect(keyPair.npub).toMatch(/^npub1[a-z0-9]+$/);
    });

    it('should generate different keypairs each time', () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();

      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
    });

    it('should have consistent public key derivation', () => {
      const keyPair = generateKeyPair();
      const derivedPubkey = getPublicKey(keyPair.secretKey);

      expect(keyPair.publicKey).toBe(derivedPubkey);
    });
  });

  describe('hasSecretKey', () => {
    it('should return false when no key exists', () => {
      expect(hasSecretKey()).toBe(false);
    });

    it('should return true when identity key exists', () => {
      addIdentityKey(generateSecretKey());
      expect(hasSecretKey()).toBe(true);
    });
  });

  describe('loadSecretKey', () => {
    it('should return null when no key exists', () => {
      expect(loadSecretKey()).toBeNull();
    });

    it('should load hex format secret key', () => {
      const hex = 'c'.repeat(64);
      addIdentityKey(hexToBytes(hex));

      const secretKey = loadSecretKey();
      expect(secretKey).toBeInstanceOf(Uint8Array);
      expect(bytesToHex(secretKey!)).toBe(hex);
    });

    it('should handle uppercase hex', () => {
      const hex = 'D'.repeat(64);
      addIdentityKey(hexToBytes(hex));

      const secretKey = loadSecretKey();
      expect(secretKey).toBeInstanceOf(Uint8Array);
      expect(bytesToHex(secretKey!)).toBe(hex.toLowerCase());
    });

    it('should throw on invalid format', () => {
      const { publicKey } = addIdentityKey(generateSecretKey());
      writeFileSync(identityPathForPubkey(publicKey), 'invalid');
      expect(() => loadSecretKey()).toThrow('Invalid secret key format');
    });

    it('should throw on nsec format (not yet supported)', () => {
      const { publicKey } = addIdentityKey(generateSecretKey());
      writeFileSync(identityPathForPubkey(publicKey), 'nsec1test');
      expect(() => loadSecretKey()).toThrow();
    });
  });

  describe('loadKeyPair', () => {
    it('should return null when no key exists', () => {
      expect(loadKeyPair()).toBeNull();
    });

    it('should load complete keypair', () => {
      const hex = 'e'.repeat(64);
      addIdentityKey(hexToBytes(hex));

      const keyPair = loadKeyPair();
      expect(keyPair).not.toBeNull();
      expect(keyPair!.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(keyPair!.nsec).toMatch(/^nsec1/);
      expect(keyPair!.npub).toMatch(/^npub1/);
    });
  });

  describe('getOrCreateKeyPair', () => {
    it('should create new keypair when none exists', () => {
      const { keyPair, isNew } = getOrCreateKeyPair();

      expect(isNew).toBe(true);
      expect(keyPair.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(PATHS.identity)).toBe(true);
      expect(existsSync(identityPathForPubkey(keyPair.publicKey.toLowerCase()))).toBe(true);
    });

    it('should load existing keypair', () => {
      const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      addIdentityKey(hexToBytes(hex));

      const { keyPair, isNew } = getOrCreateKeyPair();

      expect(isNew).toBe(false);
      expect(bytesToHex(keyPair.secretKey)).toBe(hex);
    });

    it('should return same keypair on subsequent calls', () => {
      const { keyPair: keyPair1 } = getOrCreateKeyPair();
      const { keyPair: keyPair2, isNew } = getOrCreateKeyPair();

      expect(isNew).toBe(false);
      expect(keyPair1.publicKey).toBe(keyPair2.publicKey);
    });
  });
});
