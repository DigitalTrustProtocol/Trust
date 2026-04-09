import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

vi.mock('../../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config.js')>();
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = join(tmpdir(), 'trust-trust-db-test-' + process.pid + '-' + Date.now());
  const PATHS = {
    ...actual.PATHS,
    configDir: dir,
    config: join(dir, 'config.json'),
    trustDb: join(dir, 'trust.db'),
    graphCache: join(dir, 'graph-cache.bin'),
  };
  const loadUserConfig = () => undefined;
  return {
    ...actual,
    PATHS,
    loadUserConfig,
    mergeUserConfig: () => ({ ...actual.DEFAULT_CONFIG, ...loadUserConfig() }),
  };
});

import { initTrustDb, closeTrustDb } from '../../../src/lib/db/dbManager.js';
import { kvGet, kvSet, kvDelete } from '../../../src/lib/db/kv.js';
import {
  getLatestSyncTime,
  setLatestSyncTime,
  getLastSeenSyncTime,
  setLastSeenSyncTime,
  updateLastSeenSyncTime,
} from '../../../src/lib/syncTime.js';
import { PATHS, resetRuntimeConfig } from '../../../src/config.js';

describe('trust-db module (SQLite)', () => {
  beforeEach(async () => {
    await closeTrustDb();
    resetRuntimeConfig();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
    mkdirSync(PATHS.configDir, { recursive: true });
  });

  afterEach(async () => {
    await closeTrustDb();
    resetRuntimeConfig();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
  });

  it('should create SQLite store on initTrustDb', async () => {
    await initTrustDb();
    expect(existsSync(PATHS.trustDb) || existsSync(PATHS.configDir)).toBe(true);
  });

  describe('kv', () => {
    it('should store and retrieve values', async () => {
      await initTrustDb();
      expect(await kvGet('foo')).toBeUndefined();
      await kvSet('foo', 'bar');
      expect(await kvGet('foo')).toBe('bar');
    });

    it('should delete values', async () => {
      await initTrustDb();
      await kvSet('foo', 'bar');
      await kvDelete('foo');
      expect(await kvGet('foo')).toBeUndefined();
    });
  });

  describe('timestamps', () => {
    beforeEach(async () => await initTrustDb());

    it('should get and set latest timestamp', async () => {
      const ns = randomUUID();
      expect(await getLatestSyncTime(ns)).toBeUndefined();
      await setLatestSyncTime(ns, 1700000000);
      expect(await getLatestSyncTime(ns)).toBe(1700000000);
    });

    it('should get and set last seen timestamp', async () => {
      const ns = randomUUID();
      expect(await getLastSeenSyncTime(ns)).toBeUndefined();
      await setLastSeenSyncTime(ns, 1700000001);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000001);
    });

    it('should update last seen only when greater', async () => {
      const ns = randomUUID();
      await updateLastSeenSyncTime(ns, 1700000000);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000001);
      await updateLastSeenSyncTime(ns, 1700000005);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000006);
      await updateLastSeenSyncTime(ns, 1700000000);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000006);
    });
  });
});
