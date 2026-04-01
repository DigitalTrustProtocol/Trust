import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadKeyPair } from './lib/keys.js';

// Allow override via env (e.g. TRUST_CONFIG_DIR=./trust for local testing)
const CONFIG_DIR = process.env.TRUST_CONFIG_DIR
  ? join(process.cwd(), process.env.TRUST_CONFIG_DIR)
  : join(homedir(), '.trust');

// Default relays for the Trust network
export const DEFAULT_RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

// Default server host/port for server mode
const DEFAULT_SERVER_HOST = 'localhost';
const DEFAULT_SERVER_PORT = 3417;

// Configuration paths
export const PATHS = {
  configDir: CONFIG_DIR,
  secretKey: join(CONFIG_DIR, 'secret.key'),
  config: join(CONFIG_DIR, 'config.json'),
  trustDb: join(CONFIG_DIR, 'trust.db'),
  graphCache: join(CONFIG_DIR, 'graph-cache.bin'),
} as const;

// User configuration stored in config.json
export interface UserConfig {
  version: number;
  relays: string[];
  db?: {
    driver?: 'sqlite' | 'postgres';
    sqlitePath?: string;
    postgresUrl?: string;
  };
  profile?: {
    name?: string;
    about?: string;
    picture?: string;
    nip05?: string;
    lud16?: string;
  };
  createdAt: string;
  serverPort?: number;
  serverHost?: string;
}

export const DEFAULT_CONFIG: UserConfig = {
  version: 1,
  relays: DEFAULT_RELAYS,
  createdAt: new Date().toISOString(),
  serverPort: DEFAULT_SERVER_PORT,
  serverHost: DEFAULT_SERVER_HOST,
};

export function getServerPort(config?: UserConfig): number {
  const env = process.env.TRUST_SERVER_PORT;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return config?.serverPort ?? DEFAULT_SERVER_PORT;
}

export function getServerHost(config?: UserConfig): string {
  const env = process.env.TRUST_SERVER_HOST;
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return config?.serverHost ?? DEFAULT_SERVER_HOST;
}

export function loadUserConfig(): UserConfig | undefined {
  if (!existsSync(PATHS.config)) return undefined;
  try {
    const raw = readFileSync(PATHS.config, 'utf8');
    return JSON.parse(raw) as UserConfig;
  } catch {
    return undefined;
  }
}

export function getPublicKey(): string {
  const keyPair = loadKeyPair();
  if (!keyPair) {
    throw new Error('No key pair found');
  }
  return keyPair.publicKey.toLowerCase();
}

export function getNpub(): string {
  const keyPair = loadKeyPair();
  if (!keyPair) {
    throw new Error('No key pair found');
  }
  return keyPair.npub.toLowerCase();
}

/*
// Take and merge the opts into values in, if not existing then use config file, if not existing the use hardcode values
export function getGraphSyncParams(opts: any, pool?: NPool, store?: NStore, graph?: Graph): GraphSyncParams {
  const config = loadUserConfig();
  const author = opts.author ?? getPublicKey();
  const relays = opts.relays ?? config?.relays ?? DEFAULT_RELAYS;
  const since = opts.since ?? config?.since ?? 0;
  const maxDepth = opts.maxDepth ?? config?.maxDepth ?? 3;
  const context = opts.context ?? config?.context ?? '';
  const kinds = opts.kinds ?? config?.kinds ?? [KIND_TRUST, KIND_USER_METADATA];

  return {
    author: opts.author ?? getPublicKey(),
    pool: pool ?? getPool(),
    store: store ?? getStore(),
    graph: graph ?? getGraph(),
    relays: DEFAULT_RELAYS,
    since: 0,
    maxDepth: 3,
    context: '',
    kinds: [KIND_TRUST, KIND_USER_METADATA],
  } as GraphSyncParams;
}*/