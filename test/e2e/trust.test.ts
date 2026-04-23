import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(__dirname, '../../dist/index.js');
const TEST_HOME = join(tmpdir(), 'trust-trust-e2e-' + process.pid);
const TRUST_DIR = join(TEST_HOME, '.trust');

function runCli(
  args: string[],
  options: { input?: string; timeout?: number; flushDelayMs?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: TEST_HOME,
        USERPROFILE: TEST_HOME,
        TRUST_CONFIG_DIR: '',
        TRUST_E2E_OFFLINE: '1',
        TRUST_DB_DRIVER: 'sqlite',
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    if (options.input) {
      proc.stdin?.write(options.input);
      proc.stdin?.end();
    }

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Process timed out'));
    }, options.timeout || 15000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const delay = options.flushDelayMs ?? 0;
      const finish = () =>
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      if (delay > 0) {
        setTimeout(finish, delay);
      } else {
        finish();
      }
    });
  });
}

describe('trust e2e tests', () => {
  beforeEach(() => {
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true });
    }
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true });
    }
  });

  describe('trust resolve', () => {
    it('should fail when author is not found in graph (offline)', async () => {
      const { stdout, stderr, code } = await runCli([
        'resolve',
        'a'.repeat(64),
        '--authors',
        'b'.repeat(64),
      ]);

      const output = `${stdout}\n${stderr}`;
      expect(code).not.toBe(0);
      expect(stdout).toContain('No API available');
      expect(output).toMatch(/AUTHOR_NOT_FOUND|Author not found in trust graph/i);
    });

    it('should return resolver error with --json', async () => {
      const { stdout, stderr, code } = await runCli([
        'resolve',
        'a'.repeat(64),
        '--authors',
        'b'.repeat(64),
        '--json',
      ]);

      const output = `${stdout}\n${stderr}`;
      expect(code).not.toBe(0);
      expect(output).toMatch(/AUTHOR_NOT_FOUND|Author not found in trust graph/i);
    });
  });

  describe('trust sync', () => {
    it('should run sync and create trust.db', async () => {
      const since = Math.floor(Date.now() / 1000) - 86400;
      const { stdout, stderr, code } = await runCli(['sync', '--since', String(since)], {
        timeout: 20000,
      });

      expect(code).toBe(0);
      const output = stdout + stderr;
      expect(output).toMatch(/Synced \d+ event/);
      expect(existsSync(join(TRUST_DIR, 'trust.db'))).toBe(true);
    });
  });

  describe('trust add', () => {
    it('should require init before add', async () => {
      const { stderr, code } = await runCli([
        'add',
        'a'.repeat(64),
        '-v',
        '1',
      ]);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/init|secret key|No secret key/i);
    });

    it('should publish trust after init', async () => {
      await runCli(['init', '--skip-profile']);
      const whoami = await runCli(['whoami', '--json']);
      const pubkey = JSON.parse(whoami.stdout).publicKey as string;

      const { stdout, stderr, code } = await runCli(
        ['add', `p:${pubkey}`, '-v', '1', '-c', 'e2e-test'],
        { timeout: 45000, flushDelayMs: 400 },
      );

      const logOut = stdout + stderr;
      expect(code).toBe(0);
      expect(logOut).toMatch(/Added trust to the system/);
      expect(logOut).toMatch(/Event ID:/);
    });
  });

  describe('trust show', () => {
    it('should error for unknown event id', async () => {
      const { stdout, stderr, code } = await runCli([
        'show',
        'a'.repeat(64),
        '--source',
        'database',
      ]);

      const output = stdout + stderr;
      expect(code).not.toBe(0);
      expect(output).toMatch(/not found|Event not found/i);
    });
  });
});
