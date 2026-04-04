import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    secretKey: join(testDir, 'secret.key'),
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

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
  },
  initLogger: vi.fn(),
}));

// Import after mocking
import { resolveTimestampParam, trackLatestTimestamp } from '../../src/lib/timestamp.js';
import { initTrustDb, closeTrustDb } from '../../src/lib/db/dbManager.js';
import {
  setLatestTimestamp,
  getLatestTimestamp,
  getLastSeenTimestamp,
  setLastSeenTimestamp,
} from '../../src/lib/timestamp.js';
import { PATHS } from '../../src/config.js';
import { logger } from '../../src/lib/logger.js';

describe('timestamp lib', () => {
  beforeEach(async () => {
    await closeTrustDb();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
    await initTrustDb();
  });

  afterEach(async () => {
    await closeTrustDb();
    if (existsSync(PATHS.configDir)) {
      rmSync(PATHS.configDir, { recursive: true });
    }
  });

  describe('resolveTimestampParam', () => {
    it('should return undefined when value is undefined', async () => {
      expect(await resolveTimestampParam(undefined)).toBeUndefined();
    });

    it('should parse a numeric string into a number', async () => {
      expect(await resolveTimestampParam('1700000000')).toBe(1700000000);
    });

    it('should parse zero', async () => {
      expect(await resolveTimestampParam('0')).toBe(0);
    });

    it('should resolve "latest" to the stored latest_timestamp', async () => {
      await setLatestTimestamp(1700000000);
      expect(await resolveTimestampParam('latest')).toBe(1700000000);
    });

    it('should exit with error when "latest" has no stored value', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      vi.mocked(logger.error).mockClear();

      await expect(resolveTimestampParam('latest')).rejects.toThrow('process.exit');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No "latest" timestamp stored'));

      exitSpy.mockRestore();
    });

    it('should exit with error for a non-numeric non-latest string', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      vi.mocked(logger.error).mockClear();

      await expect(resolveTimestampParam('not-a-number')).rejects.toThrow('process.exit');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid timestamp value'));

      exitSpy.mockRestore();
    });
  });

  describe('trackLatestTimestamp', () => {
    it('should do nothing when events array is empty', async () => {
      await trackLatestTimestamp([]);
      expect(await getLastSeenTimestamp()).toBeUndefined();
    });

    it('should set last_seen_timestamp to max created_at + 1 for a single event', async () => {
      await trackLatestTimestamp([{ created_at: 1700000000 } as any]);
      expect(await getLastSeenTimestamp()).toBe(1700000001);
    });

    it('should pick the maximum created_at + 1 across multiple events', async () => {
      await trackLatestTimestamp([
        { created_at: 1700000005 } as any,
        { created_at: 1700000001 } as any,
        { created_at: 1700000009 } as any,
        { created_at: 1700000003 } as any,
      ]);
      expect(await getLastSeenTimestamp()).toBe(1700000010);
    });

    it('should NOT update last_seen_timestamp when the new batch is older', async () => {
      // Previous batch had newer events — last_seen should not go backwards
      await trackLatestTimestamp([{ created_at: 1700000020 } as any]);
      expect(await getLastSeenTimestamp()).toBe(1700000021);

      await trackLatestTimestamp([{ created_at: 1700000005 } as any]);
      // Older batch: last_seen stays at the higher value
      expect(await getLastSeenTimestamp()).toBe(1700000021);
    });

    it('should advance last_seen_timestamp when the new batch is newer', async () => {
      await trackLatestTimestamp([{ created_at: 1700000000 } as any]);
      expect(await getLastSeenTimestamp()).toBe(1700000001);

      await trackLatestTimestamp([{ created_at: 1700000010 } as any]);
      expect(await getLastSeenTimestamp()).toBe(1700000011);
    });

    it('should not affect latest_timestamp', async () => {
      await setLatestTimestamp(9999999999);
      await trackLatestTimestamp([{ created_at: 1700000000 } as any]);
      // latest is untouched — trackLatestTimestamp only updates last_seen_timestamp
      expect(await getLatestTimestamp()).toBe(9999999999);
    });
  });
});
