import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test directory for isolated test runs
export const TEST_DIR = join(tmpdir(), 'trust-test-' + process.pid);

// Create test directory before tests
export function setupTestDir(): string {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  return TEST_DIR;
}

// Cleanup test directory after tests
export function cleanupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// Test fixtures
export const TEST_KEYPAIR = {
  secretKeyHex: '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
  publicKeyHex: '2ce0ebc25b9d63f1f8d5e0e6f3f7d3d4e3f2f1e0d9c8b7a6958473625140312f',
};

export const TEST_PUBKEYS = {
  alice: 'a'.repeat(64),
  bob: 'b'.repeat(64),
  charlie: 'c'.repeat(64),
  dave: 'd'.repeat(64),
  eve: 'e'.repeat(64),
};

export const TEST_EVENT_IDS = {
  post1: '1'.repeat(64),
  post2: '2'.repeat(64),
  reply1: '3'.repeat(64),
};

// Valid test mnemonic (DO NOT USE IN PRODUCTION)
export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
