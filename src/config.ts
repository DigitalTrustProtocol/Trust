import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadKeyPair } from './lib/keys.js';
import { nip19 } from 'nostr-tools';

const ALL_TOKEN = 'all';
export type GraphLoadMode = 'all' | 'author';

// Allow override via env (e.g. TRUST_CONFIG_DIR=./trust for local testing)
const CONFIG_DIR = process.env.TRUST_CONFIG_DIR
  ? join(process.cwd(), process.env.TRUST_CONFIG_DIR)
  : join(homedir(), '.trust');



// Default relays for the Trust network
// Current public relays but not used for now.
export const DEFAULT_REMOTE_RELAYS = [
  'wss://relay.trust.dance',
  'wss://relay.ditto.pub',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
];


// Default server host/port for server mode
const DEFAULT_SERVER_HOST = 'localhost';
const DEFAULT_SERVER_PORT = 3417;
const DEFAULT_REMOTE_API_URL = 'https://trust.dance';

// Configuration paths
export const PATHS = {
  configDir: CONFIG_DIR,
  config: join(CONFIG_DIR, 'config.json'),
  identity: join(CONFIG_DIR, 'identity.json'),
  keysDir: join(CONFIG_DIR, 'keys'),
  trustDb: join(CONFIG_DIR, 'trust.db'),
  graphCache: join(CONFIG_DIR, 'graph-cache.bin'),
  serverState: join(CONFIG_DIR, 'server-state.json'),
} as const;

/**
 * NIP-11 `limitation` fields plus matching relay enforcement.
 * @see https://nips.nostr.com/11
 */
export interface RelayLimitation {
  max_message_length: number;
  max_subscriptions: number;
  max_limit: number;
  max_subid_length: number;
  max_event_tags: number;
  max_content_length: number;
  min_pow_difficulty: number;
  auth_required: boolean;
  payment_required: boolean;
  restricted_writes: boolean;
  /** Reject events older than `now - created_at_lower_limit` seconds when positive. */
  created_at_lower_limit: number;
  /** Reject events with `created_at` more than this many seconds ahead of relay time. */
  created_at_upper_limit: number;
  default_limit: number;
}

/** Defaults aligned with NIP-11 examples; override via `config.json` → `relay.limitation`. */
export const DEFAULT_RELAY_LIMITATION: RelayLimitation = {
  max_message_length: 16384,
  max_subscriptions: 300,
  max_limit: 5000,
  max_subid_length: 100,
  max_event_tags: 100,
  max_content_length: 8196,
  min_pow_difficulty: 0,
  auth_required: false,
  payment_required: false,
  restricted_writes: false,
  created_at_lower_limit: 31536000,
  created_at_upper_limit: 3,
  default_limit: 500,
};

function sanitizeRelayLimitation(l: RelayLimitation): RelayLimitation {
  const max_limit = Math.max(1, Math.min(100_000, Math.floor(l.max_limit)));
  const default_limit = Math.max(1, Math.min(max_limit, Math.floor(l.default_limit)));
  return {
    ...l,
    max_message_length: Math.max(512, Math.min(16_777_216, Math.floor(l.max_message_length))),
    max_subscriptions: Math.max(1, Math.min(10_000, Math.floor(l.max_subscriptions))),
    max_limit,
    max_subid_length: Math.max(8, Math.min(2000, Math.floor(l.max_subid_length))),
    max_event_tags: Math.max(1, Math.min(50_000, Math.floor(l.max_event_tags))),
    max_content_length: Math.max(256, Math.min(1_000_000, Math.floor(l.max_content_length))),
    min_pow_difficulty: Math.max(0, Math.min(256, Math.floor(l.min_pow_difficulty))),
    default_limit,
    created_at_lower_limit: Math.max(0, Math.min(10 * 365 * 86400, Math.floor(l.created_at_lower_limit))),
    created_at_upper_limit: Math.max(0, Math.min(86400 * 365, Math.floor(l.created_at_upper_limit))),
  };
}

export function mergeRelayLimitation(partial?: Partial<RelayLimitation>): RelayLimitation {
  const base = { ...DEFAULT_RELAY_LIMITATION };
  if (!partial) return sanitizeRelayLimitation(base);
  const keys = Object.keys(DEFAULT_RELAY_LIMITATION) as (keyof RelayLimitation)[];
  for (const k of keys) {
    const v = partial[k];
    if (v === undefined) continue;
    if (typeof v === 'boolean') {
      (base as Record<string, unknown>)[k] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      (base as Record<string, unknown>)[k] = v;
    }
  }
  return sanitizeRelayLimitation(base);
}

// User configuration stored in config.json
export interface UserConfig {

  graphLoadMode: GraphLoadMode;
  /** Version of the config file. */
  version: number;
  relays: string[];
  /**
   * Hex pubkeys to retain (storage + graph), or a single entry `"All"`.
   * Omitted means all authors (see resolveConfig).
   */
  authors?: string[];
  /**
   * Trust `c` tag values to retain, or `"All"`. Empty string matches events with no/missing context tag.
   */
  contexts?: string[];

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
  /** Default max graph depth for sync/server (CLI overrides). */
  maxDepth?: number;
  /** Seconds between sync runs; `0` = run once (CLI `--sync-interval` overrides). */
  syncIntervalSeconds?: number;
  /** Incremental fetch: unix timestamp string for `--since` when not passed on CLI. */
  since?: string;
  /** Trust event kinds for sync (default kind 32010). */
  kinds?: number[];
  /** Default `trust server --service` when CLI omits it. */
  serverService?: 'all' | 'relay' | 'api' | 'web';
  quietTimeoutMs?: number;
  json?: boolean;
  /** Remote API base URL used when no local server is available (default: https://trust.dance). */
  remoteApiUrl?: string;
  /** Relay websocket policy and NIP-11 `limitation` advertisement. */
  relay?: {
    limitation?: Partial<RelayLimitation>;
  };
}

const DEFAULT_SYNC_KINDS = [32010];

export const DEFAULT_CONFIG: UserConfig = {
  graphLoadMode: 'author',
  version: 1,
  relays: DEFAULT_REMOTE_RELAYS,
  createdAt: new Date().toISOString(),
  serverPort: DEFAULT_SERVER_PORT,
  serverHost: DEFAULT_SERVER_HOST,
  maxDepth: 3,
  syncIntervalSeconds: 3600,
  quietTimeoutMs: 1000,
  kinds: DEFAULT_SYNC_KINDS,
  json: false,
  remoteApiUrl: DEFAULT_REMOTE_API_URL,
  authors: undefined,
  contexts: undefined,
};


/**
 * Single resolved instance: file + defaults + CLI + identity. Use this for host/port/relays/sync
 * and focus — no parallel option objects.
 */
export type ResolvedRuntimeConfig = UserConfig & {
  /** Effective relay limits (merged defaults + `config.json` `relay.limitation`). */
  relay: { limitation: RelayLimitation };
  primaryPubkey: string;
  /**
   * Hex pubkeys to retain in graph/sync filters, or `undefined` = no author filter (all authors).
   * Resolved: CLI `--authors` → `TRUST_AUTHORS` → `config.json`; empty / `*` / `all` → undefined.
   */
  //authors: string[] | undefined;
  /**
   * Trust `c` tag values to retain, or `undefined` = no context filter (all contexts).
   * Resolved: CLI `--contexts` → `TRUST_CONTEXTS` → `config.json`; empty / `*` / `all` → undefined.
   */
  //contexts: string[] | undefined;
  /** Effective HTTP bind (CLI > `TRUST_SERVER_*` env > config > defaults). */
  host: string;
  port: number;
  /** Relay URLs for this process (CLI `--relay` replaces file list when given). */
  relays: string[];
  /** Merged `--since` / config `since` string for `getSinceFromTimestamp`. */
  since?: number | undefined;
  /** Unix timestamp for incremental sync / relay `since` filter (parsed from `since` when numeric). */
  syncSince?: number | undefined;
  maxDepth: number;
  syncIntervalSeconds: number;
  kinds: number[];
  json: boolean;
  service: 'all' | 'relay' | 'api' | 'web';
  /** Database type: sqlite or postgres. */
  database: 'sqlite' | 'postgres';
  /**
   * Unified connection string for the active database.
   * For sqlite: file path (e.g. ~/.trust/trust.db).
   * For postgres: connection URL (e.g. postgres://user:pass@host:5432/db).
   */
  connectionString: string;
  /** Remote API fallback URL (default: https://trust.dance). */
  remoteApiUrl: string;
};


export function getServerPort(config?: Pick<UserConfig, 'serverPort'>): number {
  const env = process.env.TRUST_SERVER_PORT;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return config?.serverPort ?? DEFAULT_SERVER_PORT;
}

export function getServerHost(config?: Pick<UserConfig, 'serverHost'>): string {
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

export function saveUserConfig(config: UserConfig): void {
  const dir = dirname(PATHS.config);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(PATHS.config, JSON.stringify(config, null, 2), { mode: 0o600 });
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



export function isAllToken(s: string): boolean {
  let t = s.trim().toLowerCase();
  if (t.length === 0) return true;
  if (t === '*' || t === ALL_TOKEN) return true;
  return false;
}


function parseOptionalUnixTimestamp(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

// If npubXXX then decode it, otherwise just return the hex
export function normalizePubkeyHex(hex: string): string {
  const h = hex.trim().toLowerCase();
  if (h.startsWith('npub')) {
    const decoded = nip19.decode(h);
    if (decoded.type !== 'npub') {
      throw new Error(`Invalid npub: ${h}`);
    }
    return decoded.data.toLowerCase();
  }
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error(`Invalid hex pubkey: ${hex}`);
  }
  return h;
}


export function parseAuthorsString(raw?: string): string[] | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (isAllToken(t)) return undefined; // empty string is an empty array, no filter
  const parts = t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map((p) => normalizePubkeyHex(p));
}


export function parseContextsString(raw?: string): string[] | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (isAllToken(t)) return undefined; // empty string is an empty array, no filter
  const parts = t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts;
}


export function normalizeAuthorsList(list: string[] | undefined): string[] | undefined {
  if (!list?.length) return undefined;
  if (list.length === 1 && isAllToken(list[0]!)) return undefined;
  return list.map((a) => normalizePubkeyHex(a));
}

export function normalizeContextsList(list: string[] | undefined): string[] | undefined {
  if (!list?.length) return undefined;
  if (list.length === 1 && isAllToken(list[0]!)) return undefined;
  return list.map((c) => c.trim());
}

/** Merged `config.json` (if present) with defaults. */
export function mergeUserConfig(): UserConfig {
  const file = loadUserConfig();
  return { ...DEFAULT_CONFIG, ...file };
}

function cliHas(cli: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(cli, key);
}

function getCliString(cli: Record<string, unknown>, key: string): string | undefined {
  if (!cliHas(cli, key)) return undefined;
  const v = cli[key];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function getCliNumber(cli: Record<string, unknown>, key: string): number | undefined {
  if (!cliHas(cli, key)) return undefined;
  const v = cli[key];
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function getCliBoolean(cli: Record<string, unknown>, key: string): boolean | undefined {
  if (!cliHas(cli, key)) return undefined;
  return cli[key] === true;
}


function getStringArray(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined; // undefined is undefined
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    if (v.trim() === '') return []; // empty string is an empty array
    const parts = v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    return parts;
  };
  return [];

}

function getCliNumberArray(cli: Record<string, unknown>, key: string): number[] | undefined {
  if (!cliHas(cli, key)) return undefined;
  const v = cli[key];
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x === 'number' && !Number.isNaN(x)) out.push(x);
    else if (typeof x === 'string' && x.trim() !== '') {
      const n = parseInt(x, 10);
      if (!Number.isNaN(n)) out.push(n);
    }
  }
  return out.length ? out : undefined;
}

// ——— Postgres URL from PG* env (libpq / Coolify style) ———

function formatPgHostForUrl(host: string): string {
  if (host.startsWith('[')) return host;
  if (host.includes(':')) return `[${host}]`;
  return host;
}

export function buildPostgresUrlFromPgEnv(): string | undefined {
  const hostRaw = process.env.PGHOST?.trim();
  if (!hostRaw) return undefined;
  const host = formatPgHostForUrl(hostRaw);
  const user = encodeURIComponent(process.env.PGUSER?.trim() || 'postgres');
  const password =
    process.env.PGPASSWORD !== undefined && process.env.PGPASSWORD !== ''
      ? encodeURIComponent(process.env.PGPASSWORD)
      : '';
  const port = process.env.PGPORT?.trim() || '5432';
  const dbName =
    process.env.PGDATABASE?.trim() ||
    process.env.PGUSER?.trim() ||
    'postgres';
  const database = encodeURIComponent(dbName);
  const auth = password !== '' ? `${user}:${password}@` : `${user}@`;
  let url = `postgres://${auth}${host}:${port}/${database}`;
  const ssl = process.env.PGSSLMODE?.trim();
  if (ssl) {
    url += (url.includes('?') ? '&' : '?') + `sslmode=${encodeURIComponent(ssl)}`;
  }
  return url;
}

// ——— Unified database resolution ———

export interface DbConfig {
  database: 'sqlite' | 'postgres';
  connectionString: string;
}

/**
 * Resolve database type and connection string.
 *
 * **Priority** (first match wins at each level):
 *
 * | Level       | Database type             | Connection string                                        |
 * |-------------|---------------------------|----------------------------------------------------------|
 * | CLI         | `--database`              | `--connection-string`                                    |
 * | Environment | `TRUST_DATABASE`          | `TRUST_CONNECTION_STRING`, `DATABASE_URL` (pg only),     |
 * |             |                           | `TRUST_POSTGRES_URL` (pg), `PGHOST/…` (pg),             |
 * |             |                           | `TRUST_SQLITE_PATH` (sqlite only)                        |
 * | Config file | `db.driver`               | `db.postgresUrl` (pg), `db.sqlitePath` (sqlite)          |
 * | Default     | `sqlite`                  | `~/.trust/trust.db`                                      |
 *
 * When the database type is omitted, it is inferred from the connection string
 * (`postgres://` or `postgresql://` → postgres, anything else → sqlite).
 *
 * Type-specific env vars (e.g. `DATABASE_URL`) are skipped when an explicit
 * type doesn't match, so `TRUST_DB_DRIVER=sqlite` + `DATABASE_URL` won't
 * accidentally use the postgres URL as a file path.
 */
export function resolveDatabase(cli: Record<string, unknown>, base: UserConfig): DbConfig {
  const explicitType = resolveExplicitDatabaseType(cli, base);
  const connectionString = resolveConnectionString(cli, base, explicitType);
  const database = explicitType
    ?? (connectionString && looksLikePostgresUrl(connectionString) ? 'postgres' : 'sqlite');

  if (database === 'postgres' && !connectionString) {
    throw new Error(
      'Postgres selected but no connection string provided. ' +
      'Use --connection-string, TRUST_CONNECTION_STRING, or DATABASE_URL.',
    );
  }

  return {
    database,
    connectionString: connectionString ?? PATHS.trustDb,
  };
}

/**
 * Explicit database type from CLI / env / config (without inference).
 * Returns `undefined` when no layer specifies a type.
 */
function resolveExplicitDatabaseType(
  cli: Record<string, unknown>,
  base: UserConfig,
): 'sqlite' | 'postgres' | undefined {
  const fromCli = getCliString(cli, 'database')?.trim().toLowerCase();
  if (fromCli === 'sqlite' || fromCli === 'postgres') return fromCli;
  if (fromCli !== undefined && fromCli !== '') {
    throw new Error('Invalid --database value. Use sqlite or postgres.');
  }

  const fromEnv = (process.env.TRUST_DATABASE ?? process.env.TRUST_DB_DRIVER)?.trim().toLowerCase();
  if (fromEnv === 'sqlite' || fromEnv === 'postgres') return fromEnv;

  const fromConfig = base.db?.driver;
  if (fromConfig === 'sqlite' || fromConfig === 'postgres') return fromConfig;

  return undefined;
}

/**
 * Connection string resolution. Universal sources (`--connection-string`,
 * `TRUST_CONNECTION_STRING`) are always checked. Type-specific sources
 * (`DATABASE_URL`, `TRUST_SQLITE_PATH`, etc.) are skipped when they
 * don't match the explicit database type.
 */
function resolveConnectionString(
  cli: Record<string, unknown>,
  base: UserConfig,
  explicitType: 'sqlite' | 'postgres' | undefined,
): string | undefined {
  const fromCli = getCliString(cli, 'connectionString')?.trim();
  if (fromCli) return fromCli;

  const fromUniversalEnv = process.env.TRUST_CONNECTION_STRING?.trim();
  if (fromUniversalEnv) return fromUniversalEnv;

  if (explicitType !== 'sqlite') {
    const pg =
      process.env.DATABASE_URL?.trim() ||
      process.env.TRUST_POSTGRES_URL?.trim() ||
      buildPostgresUrlFromPgEnv() ||
      base.db?.postgresUrl?.trim();
    if (pg) return pg;
  }

  if (explicitType !== 'postgres') {
    const sqlite =
      process.env.TRUST_SQLITE_PATH?.trim() ||
      base.db?.sqlitePath?.trim();
    if (sqlite) return sqlite;
  }

  return undefined;
}

function looksLikePostgresUrl(s: string): boolean {
  return s.startsWith('postgres://') || s.startsWith('postgresql://');
}

function parseKindsEnv(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (!Number.isNaN(n)) out.push(n);
  }
  return out.length ? out : undefined;
}

function mergeEffectiveRelays(cli: Record<string, unknown>, base: UserConfig): string[] {
  let relays = getStringArray(cli['relays'] ? cli['relays'] as string : process.env.TRUST_RELAYS?.trim());
  if (relays) {
    return relays;
  }   
  return base.relays;
}

/**
 * Authors filter: CLI `--authors` → `TRUST_AUTHORS` → `config.json` `authors`.
 * If a layer is not provided (e.g. CLI flag absent, env unset), fall through to the next.
 * Explicit empty, `*`, or `all` → `undefined` (no author filter).
 */
function resolveAuthorsFilter(cli: Record<string, unknown>, base: UserConfig): string[] | undefined {
  if (cliHas(cli, 'authors')) {
    return parseAuthorsString(getCliString(cli, 'authors'));
  }
  if (process.env.TRUST_AUTHORS !== undefined) {
    return parseAuthorsString(process.env.TRUST_AUTHORS);
  }
  return normalizeAuthorsList(base.authors);
}

/**
 * Contexts filter: CLI `--contexts` → `TRUST_CONTEXTS` → `config.json` `contexts`.
 * Same precedence and empty / `*` / `all` → `undefined` (no context filter).
 */
function resolveContextsFilter(cli: Record<string, unknown>, base: UserConfig): string[] | undefined {
  if (cliHas(cli, 'contexts')) {
    return parseContextsString(getCliString(cli, 'contexts'));
  }
  if (process.env.TRUST_CONTEXTS !== undefined) {
    return parseContextsString(process.env.TRUST_CONTEXTS);
  }
  return normalizeContextsList(base.contexts);
}


function mergeEffectiveHostPort(cli: Record<string, unknown>, base: UserConfig): { host: string; port: number } {
  const port = cliHas(cli, 'port') ? (getCliNumber(cli, 'port') ?? getServerPort(base)) : getServerPort(base);
  const hostFromCli = getCliString(cli, 'host');
  const host =
    hostFromCli !== undefined && hostFromCli.trim() !== '' ? hostFromCli.trim() : getServerHost(base);
  return { host, port };
}

/**
 * Merge `config.json`, defaults, CLI, env, and identity into one runtime object.
 * Pass a plain object (e.g. Commander `options`); only **present** keys override lower layers.
 *
 * **Precedence** (each field uses the first available):
 *   CLI → `process.env` (`TRUST_*`, `PG*`, etc.) → `config.json` → built-in defaults.
 *
 * **Database**: see {@link resolveDatabase} for the full priority chain.
 *
 * **Authors / contexts**: CLI → `TRUST_AUTHORS` / `TRUST_CONTEXTS` → `config.json`. Omitted layer falls
 * through. Explicit empty, `*`, or `all` → `undefined` (no filter).
 */
export function resolveConfig(cli: Record<string, unknown> = {}): ResolvedRuntimeConfig {
  const base = mergeUserConfig();
  const kp = loadKeyPair();
  const primaryPubkey = kp?.publicKey.toLowerCase() ?? '0'.repeat(64);

  const authorsRaw = resolveAuthorsFilter(cli, base);
  const authors = authorsRaw?.length ? [...new Set(authorsRaw)] : undefined;

  const contextsRaw = resolveContextsFilter(cli, base);
  const contexts = contextsRaw?.length ? [...new Set(contextsRaw)] : undefined;

  const { host, port } = mergeEffectiveHostPort(cli, base);
  const relays = mergeEffectiveRelays(cli, base);
  const { database, connectionString } = resolveDatabase(cli, base);

  const sinceString: string | undefined = cli['since'] ? cli['since'] as string : process.env.TRUST_SINCE?.trim();
  const since: number | undefined = parseOptionalUnixTimestamp(sinceString ?? base.since);

  const syncSinceString: string | undefined = cli['syncSince'] ? cli['syncSince'] as string : process.env.TRUST_SYNC_SINCE?.trim();
  const syncSince: number | undefined = parseOptionalUnixTimestamp(syncSinceString ?? base.since);

  const maxDepthEnv = process.env.TRUST_MAX_DEPTH?.trim();
  let maxDepthFromEnv: number | undefined;
  if (maxDepthEnv !== undefined && maxDepthEnv !== '') {
    const n = parseInt(maxDepthEnv, 10);
    if (!Number.isNaN(n) && n > 0) maxDepthFromEnv = n;
  }
  const maxDepth = Math.max(1, getCliNumber(cli, 'maxDepth') ?? maxDepthFromEnv ?? base.maxDepth ?? 3);

  const syncIntervalSeconds = cliHas(cli, 'syncInterval')
    ? Math.max(0, getCliNumber(cli, 'syncInterval') ?? 0)
    : (() => {
      const env = process.env.TRUST_SYNC_INTERVAL_SECONDS?.trim();
      if (env !== undefined && env !== '') {
        const n = parseInt(env, 10);
        if (!Number.isNaN(n)) return Math.max(0, n);
      }
      return base.syncIntervalSeconds ?? 3600;
    })();

  const kindsFromCli = getCliNumberArray(cli, 'kinds');
  const kindsFromEnv = parseKindsEnv(process.env.TRUST_SYNC_KINDS);
  const kinds =
    kindsFromCli !== undefined && kindsFromCli.length > 0
      ? [...kindsFromCli]
      : kindsFromEnv !== undefined
        ? [...kindsFromEnv]
        : [...(base.kinds?.length ? base.kinds : DEFAULT_SYNC_KINDS)];

  const json = getCliBoolean(cli, 'json') === true;

  let service: 'all' | 'relay' | 'api' | 'web';
  if (cliHas(cli, 'service')) {
    const s = getCliString(cli, 'service')?.trim().toLowerCase();
    service =
      s === 'all' || s === 'relay' || s === 'api' || s === 'web' ? s : (base.serverService ?? 'all');
  } else {
    const envService = process.env.TRUST_SERVER_SERVICE?.trim().toLowerCase();
    if (envService === 'all' || envService === 'relay' || envService === 'api' || envService === 'web') {
      service = envService;
    } else {
      service = base.serverService ?? 'all';
    }
  }

  const remoteApiUrl = (process.env.TRUST_REMOTE_API_URL?.trim() || base.remoteApiUrl || DEFAULT_REMOTE_API_URL);

  const relayLimitation = mergeRelayLimitation(base.relay?.limitation);

  return {
    ...base,
    authors,
    contexts,
    primaryPubkey,
    host,
    port,
    relays,
    since,
    syncSince: syncSince ?? undefined,
    maxDepth,
    syncIntervalSeconds,
    kinds,
    json,
    service,
    database,
    connectionString,
    remoteApiUrl,
    relay: { limitation: relayLimitation },
  } as ResolvedRuntimeConfig;
}

let runtimeConfig: ResolvedRuntimeConfig | null = null;

export function getRuntimeConfig(opts?: Record<string, unknown>): ResolvedRuntimeConfig {
  if (!runtimeConfig) {
    runtimeConfig = resolveConfig(opts);
    setRuntimeConfig(runtimeConfig);
  }
  return runtimeConfig;
}

export function setRuntimeConfig(config: ResolvedRuntimeConfig): void {
  runtimeConfig = config;
}

/** Clear cached runtime config (e.g. between tests that mock different paths). */
export function resetRuntimeConfig(): void {
  runtimeConfig = null;
}

