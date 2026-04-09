import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const testDir = join(tmpdir(), 'trust-timestamp-test-' + process.pid + '-' + Date.now());
  const PATHS = {
    ...actual.PATHS,
    configDir: testDir,
    config: join(testDir, 'config.json'),
    trustDb: join(testDir, 'trust.db'),
  };
  const loadUserConfig = () => undefined;
  return {
    ...actual,
    PATHS,
    DEFAULT_RELAYS: ['wss://relay.test'],
    loadUserConfig,
    mergeUserConfig: () => ({ ...actual.DEFAULT_CONFIG, ...loadUserConfig() }),
  };
});

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
  },
  initLogger: vi.fn(),
}));

// Import after mocking
import {
  resolveSyncTimeParam,
  trackLatestSyncTime,
} from '../../src/lib/syncTime.js';
import { initTrustDb, closeTrustDb } from '../../src/lib/db/dbManager.js';
import {
  setLatestSyncTime,
  getLatestSyncTime,
  getLastSeenSyncTime,
  setLastSeenSyncTime,
} from '../../src/lib/syncTime.js';
import { PATHS, resetRuntimeConfig } from '../../src/config.js';
import { logger } from '../../src/lib/logger.js';

describe('syncTime lib', () => {
  beforeEach(async () => {
    await closeTrustDb();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
    await initTrustDb();
  });

  afterEach(async () => {
    await closeTrustDb();
    resetRuntimeConfig();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
  });

  describe('resolveSyncTimeParam', () => {
    it('should return undefined when value is undefined', async () => {
      const ns = randomUUID();
      expect(await resolveSyncTimeParam(undefined, ns)).toBeUndefined();
    });

    it('should parse a numeric string into a number', async () => {
      const ns = randomUUID();
      expect(await resolveSyncTimeParam('1700000000', ns)).toBe(1700000000);
    });

    it('should parse zero', async () => {
      const ns = randomUUID();
      expect(await resolveSyncTimeParam('0', ns)).toBe(0);
    });

    it('should resolve "latest" to the stored latest sync time', async () => {
      const ns = randomUUID();
      await setLatestSyncTime(ns, 1700000000);
      expect(await resolveSyncTimeParam('latest', ns)).toBe(1700000000);
    });

    it('should exit with error when "latest" has no stored value', async () => {
      const ns = randomUUID();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      vi.mocked(logger.error).mockClear();

      await expect(resolveSyncTimeParam('latest', ns)).rejects.toThrow('process.exit');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No "latest" sync time stored'));

      exitSpy.mockRestore();
    });

    it('should exit with error for a non-numeric non-latest string', async () => {
      const ns = randomUUID();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      vi.mocked(logger.error).mockClear();

      await expect(resolveSyncTimeParam('not-a-number', ns)).rejects.toThrow('process.exit');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid timestamp value'));

      exitSpy.mockRestore();
    });
  });

  describe('trackLatestSyncTime', () => {
    it('should do nothing when events array is empty', async () => {
      const ns = randomUUID();
      await trackLatestSyncTime(ns, []);
      expect(await getLastSeenSyncTime(ns)).toBeUndefined();
    });

    it('should set last seen sync time to max created_at + 1 for a single event', async () => {
      const ns = randomUUID();
      await trackLatestSyncTime(ns, [{ created_at: 1700000000 } as any]);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000001);
    });

    it('should pick the maximum created_at + 1 across multiple events', async () => {
      const ns = randomUUID();
      await trackLatestSyncTime(ns, [
        { created_at: 1700000005 } as any,
        { created_at: 1700000001 } as any,
        { created_at: 1700000009 } as any,
        { created_at: 1700000003 } as any,
      ]);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000010);
    });

    it('should NOT update last seen sync time when the new batch is older', async () => {
      const ns = randomUUID();
      await trackLatestSyncTime(ns, [{ created_at: 1700000020 } as any]);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000021);

      await trackLatestSyncTime(ns, [{ created_at: 1700000005 } as any]);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000021);
    });

    it('should advance last seen sync time when the new batch is newer', async () => {
      const ns = randomUUID();
      await trackLatestSyncTime(ns, [{ created_at: 1700000000 } as any]);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000001);

      await trackLatestSyncTime(ns, [{ created_at: 1700000010 } as any]);
      expect(await getLastSeenSyncTime(ns)).toBe(1700000011);
    });

    it('should not affect latest sync time', async () => {
      const ns = randomUUID();
      await setLatestSyncTime(ns, 9999999999);
      await trackLatestSyncTime(ns, [{ created_at: 1700000000 } as any]);
      expect(await getLatestSyncTime(ns)).toBe(9999999999);
    });
  });
});
