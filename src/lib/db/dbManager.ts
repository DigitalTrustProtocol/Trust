import { existsSync, mkdirSync } from 'node:fs';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Pool } from 'pg';
import { PATHS, loadUserConfig } from '../../config.js';
import { NSQLite, NSQLiteOpts, NSQLiteSchema } from './NSQLite.js';
import Database from 'better-sqlite3';
import { migratePostgresKV, migrateSQLiteKV } from './kv.js';
import { NPostgres } from './NPostgres.js';
import { NRelay, NStore } from '@nostrify/nostrify';
import type { NostrEvent } from '@nostrify/types';

export type DbDriver = 'sqlite' | 'postgres';

export type Store = NSQLite | NPostgres;

export interface ExtendedNRelay extends NRelay {
  allEvents(kind: number, opts: { signal?: AbortSignal }): AsyncIterable<NostrEvent>;
}



interface RuntimeDbConfig {
  driver: DbDriver;
  sqlitePath: string;
  postgresUrl?: string;
}

let storeInstance: Store | null = null;

/** Set by `server` CLI before init when `--database` is passed. */
let dbDriverCliOverride: DbDriver | undefined;

export function setDbDriverOverride(driver: DbDriver | undefined): void {
  dbDriverCliOverride = driver;
}

function formatPgHostForUrl(host: string): string {
  if (host.startsWith('[')) return host;
  if (host.includes(':')) return `[${host}]`;
  return host;
}

/** Build a postgres URL from standard PG* env vars (Coolify / libpq style). */
function buildPostgresUrlFromPgEnv(): string | undefined {
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

function resolvePostgresUrl(config: ReturnType<typeof loadUserConfig>): string | undefined {
  const fromTrustEnv = process.env.TRUST_POSTGRES_URL?.trim();
  if (fromTrustEnv) return fromTrustEnv;
  const fromDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (fromDatabaseUrl) return fromDatabaseUrl;
  const fromPgEnv = buildPostgresUrlFromPgEnv();
  if (fromPgEnv) return fromPgEnv;
  const fromConfig = config?.db?.postgresUrl?.trim();
  if (fromConfig) return fromConfig;
  return undefined;
}

export type NSQLiteDbInput = string | Database.Database;
function resolveDbConfig(): RuntimeDbConfig {
  const config = loadUserConfig();
  const postgresUrl = resolvePostgresUrl(config);

  const envDriver = process.env.TRUST_DB_DRIVER?.trim().toLowerCase();
  const driverFromConfig = config?.db?.driver;

  let driver: DbDriver;
  if (dbDriverCliOverride === 'postgres' || dbDriverCliOverride === 'sqlite') {
    driver = dbDriverCliOverride;
  } else if (envDriver === 'postgres' || envDriver === 'sqlite') {
    driver = envDriver;
  } else if (driverFromConfig === 'postgres' || driverFromConfig === 'sqlite') {
    driver = driverFromConfig;
  } else {
    driver = postgresUrl ? 'postgres' : 'sqlite';
  }

  const sqlitePath = process.env.TRUST_SQLITE_PATH ?? config?.db?.sqlitePath ?? PATHS.trustDb;

  return { driver, sqlitePath, postgresUrl };
}

export async function createStore(): Promise<Store> {

  const cfg = resolveDbConfig();

  if (cfg.driver === 'postgres') {
    if (!cfg.postgresUrl) {
      throw new Error(
        'Postgres selected but no connection URL found. Set DATABASE_URL, or PGHOST/PGUSER/PGDATABASE (and optional PGPASSWORD, PGPORT), or TRUST_POSTGRES_URL / config.db.postgresUrl.',
      );
    }

    const store = await createNPostgresStore(cfg.postgresUrl);
    await migratePostgresKV(store.db);
    return store;
  }

  const store = await createNSQLiteStore(cfg.sqlitePath);
  await migrateSQLiteKV(store.db);
  return store;
}


export async function createNPostgresStore(url: string): Promise<NPostgres> {
  const pool = new Pool({ connectionString: url });
  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool }),
  });
  const store = new NPostgres(db);
  await store.migrate();
  return store;
}

export async function createNSQLiteStore(db: NSQLiteDbInput, opts?: NSQLiteOpts): Promise<NSQLite> {
  const sqlite = typeof db === 'string' ? new Database(db) : db;
  const kysely = new Kysely<NSQLiteSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  const store = new NSQLite(kysely, opts);
  await store.migrate();
  return store;
}


export async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await createStore();
  }
  return storeInstance;
}

export async function closeStore(store: Store | null = storeInstance): Promise<void> {
  if (store) {
    await store.close();
    storeInstance = null;
  }
}

/** Initialize trust database using configured backend. Creates config dir if needed. */
export async function initTrustDb(): Promise<Store> {
  if (!existsSync(PATHS.configDir)) {
    mkdirSync(PATHS.configDir, { recursive: true });
  }
  storeInstance = await getStore();
  return storeInstance;
}

/** Close the trust database connection. */
export async function closeTrustDb(store?: Store): Promise<void> {
  await closeStore(store);
}