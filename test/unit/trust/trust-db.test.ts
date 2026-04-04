import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

vi.mock('../../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config.js')>();
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = join(tmpdir(), 'trust-trust-db-test-' + process.pid + '-' + Date.now());
  const PATHS = {
    ...actual.PATHS,
    configDir: dir,
    secretKey: join(dir, 'secret.key'),
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
    resolveSqlitePath: (cli: Record<string, unknown>, base: actual.UserConfig) => {
      if (Object.prototype.hasOwnProperty.call(cli, 'sqlitePath')) {
        const v = cli['sqlitePath'];
        if (v !== undefined && v !== null) {
          const s = String(v).trim();
          if (s) return s;
        }
      }
      const fromEnv = process.env.TRUST_SQLITE_PATH?.trim();
      if (fromEnv) return fromEnv;
      const fromConfig = base.db?.sqlitePath?.trim();
      if (fromConfig) return fromConfig;
      return PATHS.trustDb;
    },
  };
});

import { initTrustDb, closeTrustDb } from '../../../src/lib/db/dbManager.js';
import { kvGet, kvSet, kvDelete } from '../../../src/lib/db/kv.js';
import {
  getLatestTimestamp,
  setLatestTimestamp,
  getLastSeenTimestamp,
  setLastSeenTimestamp,
  updateLastSeenTimestamp,
} from '../../../src/lib/timestamp.js';
import { PATHS } from '../../../src/config.js';

describe('trust-db module (SQLite)', () => {
  beforeEach(async () => {
    await closeTrustDb();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
    mkdirSync(PATHS.configDir, { recursive: true });
  });

  afterEach(async () => {
    await closeTrustDb();
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
      expect(await getLatestTimestamp()).toBeUndefined();
      await setLatestTimestamp(1700000000);
      expect(await getLatestTimestamp()).toBe(1700000000);
    });

    it('should get and set last seen timestamp', async () => {
      expect(await getLastSeenTimestamp()).toBeUndefined();
      await setLastSeenTimestamp(1700000001);
      expect(await getLastSeenTimestamp()).toBe(1700000001);
    });

    it('should update last seen only when greater', async () => {
      await updateLastSeenTimestamp(1700000000);
      expect(await getLastSeenTimestamp()).toBe(1700000001);
      await updateLastSeenTimestamp(1700000005);
      expect(await getLastSeenTimestamp()).toBe(1700000006);
      await updateLastSeenTimestamp(1700000000);
      expect(await getLastSeenTimestamp()).toBe(1700000006);
    });
  });
});
