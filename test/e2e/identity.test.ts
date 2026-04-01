import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(__dirname, '../../dist/index.js');
const TEST_HOME = join(tmpdir(), 'trust-e2e-test-' + process.pid);
const TRUST_DIR = join(TEST_HOME, '.trust');

function runCli(
  args: string[],
  options: { input?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      // Set both HOME and USERPROFILE so os.homedir() resolves correctly on Windows and Unix
      // Unset TRUST_CONFIG_DIR so CLI uses ~/.trust (i.e. TEST_HOME/.trust)
      env: {
        ...process.env,
        HOME: TEST_HOME,
        USERPROFILE: TEST_HOME,
        TRUST_CONFIG_DIR: '',
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
      proc.stdin.write(options.input);
      proc.stdin.end();
    }

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Process timed out'));
    }, options.timeout || 20000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

describe('identity e2e tests', () => {
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

  describe('trust init', () => {
    it('should create secret key file', async () => {
      const { code } = await runCli(['init', '--skip-profile']);

      expect(code).toBe(0);
      expect(existsSync(join(TRUST_DIR, 'secret.key'))).toBe(true);
    });

    it('should generate valid keypair', async () => {
      const { stdout, code } = await runCli(['init', '--skip-profile']);

      expect(code).toBe(0);
      expect(stdout).toContain('npub');
      expect(stdout).toContain('Public Key');
    });

    it('should create config.json', async () => {
      await runCli(['init', '--skip-profile']);

      const configPath = join(TRUST_DIR, 'config.json');
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.version).toBe(1);
      expect(config.relays).toBeInstanceOf(Array);
    });

    it('should create trust.db on init', async () => {
      const { code } = await runCli(['init', '--skip-profile']);

      expect(code).toBe(0);
      expect(existsSync(join(TRUST_DIR, 'trust.db'))).toBe(true);
    });

    it('should warn when already initialized', async () => {
      await runCli(['init', '--skip-profile']);
      const { stdout } = await runCli(['init', '--skip-profile']);

      expect(stdout).toContain('already exists');
    });

    it('should save profile name', async () => {
      await runCli(['init', '--name', 'Test Agent', '--skip-profile']);

      const configPath = join(TRUST_DIR, 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.profile?.name).toBe('Test Agent');
    });
  });

  describe('trust whoami', () => {
    it('should fail when not initialized', async () => {
      const { stdout, code } = await runCli(['whoami']);

      expect(code).not.toBe(0);
      expect(stdout).toContain('No identity found');
    });

    it('should display identity after init', async () => {
      await runCli(['init', '--skip-profile']);
      const { stdout, code } = await runCli(['whoami']);

      expect(code).toBe(0);
      expect(stdout).toContain('Public Key');
      expect(stdout).toContain('npub');
      expect(stdout).toContain('Profile URL');
    });

    it('should output JSON with --json flag', async () => {
      await runCli(['init', '--name', 'JSON Test', '--skip-profile']);
      const { stdout, code } = await runCli(['whoami', '--json']);

      expect(code).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(output.npub).toMatch(/^npub1/);
      expect(output.profile.name).toBe('JSON Test');
    });
  });

  describe('identity persistence', () => {
    it('should maintain same identity across commands', async () => {
      await runCli(['init', '--skip-profile']);
      const { stdout: whoami1 } = await runCli(['whoami', '--json']);
      const { stdout: whoami2 } = await runCli(['whoami', '--json']);

      const id1 = JSON.parse(whoami1);
      const id2 = JSON.parse(whoami2);

      expect(id1.publicKey).toBe(id2.publicKey);
      expect(id1.npub).toBe(id2.npub);
    });

    it('should preserve secret key format', async () => {
      await runCli(['init', '--skip-profile']);

      const keyPath = join(TRUST_DIR, 'secret.key');
      const keyContent = readFileSync(keyPath, 'utf-8').trim();

      // Should be 64-char hex
      expect(keyContent).toMatch(/^[0-9a-f]{64}$/i);
    });
  });
});
