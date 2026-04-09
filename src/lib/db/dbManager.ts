import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Pool } from 'pg';
import { getRuntimeConfig } from '../../config.js';
import type { ResolvedRuntimeConfig } from '../../config.js';
import { NSQLite, NSQLiteOpts, NSQLiteSchema } from './NSQLite.js';
import Database from 'better-sqlite3';
import { migratePostgresKV, migrateSQLiteKV } from './kv.js';
import { NPostgres } from './NPostgres.js';
import { NRelay, NStore } from '@nostrify/nostrify';
import type { NostrEvent } from '@nostrify/types';

export type DbDriver = 'sqlite' | 'postgres';

export type Store = NSQLite | NPostgres;

export interface ExtendedNRelay extends NRelay {
  getEvent(id: string): Promise<NostrEvent | null>;
  allEvents(kinds: number[], authors: string[], contexts: string[], signal?: AbortSignal): AsyncIterable<NostrEvent>;
}

let storeInstance: Store | null = null;

export type NSQLiteDbInput = string | Database.Database;

export async function createStore(cfg: ResolvedRuntimeConfig): Promise<Store> {
  if (cfg.database === 'postgres') {
    const store = await createNPostgresStore(cfg.connectionString);
    await migratePostgresKV(store.db);
    return store;
  }

  if (cfg.database === 'sqlite') {
    const dbDir = dirname(cfg.connectionString);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const store = await createNSQLiteStore(cfg.connectionString);
    await migrateSQLiteKV(store.db);
    return store;
  }

  throw new Error(`Unsupported database type: ${cfg.database}`);
}



export async function createNPostgresStore(url: string): Promise<NPostgres> {
  const pool = new Pool({ connectionString: url });
  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool }),
  });
  const store = new NPostgres(db);
  store.setPool(pool);
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


/** Default CLI fragment so cold `resolveConfig` does not require identity keys (DB init only). */
const DB_INIT_CLI: Record<string, unknown> = { authors: '*' };

export async function getStore(cfg: ResolvedRuntimeConfig | undefined = undefined): Promise<Store> {
  if (storeInstance) return storeInstance;

  const resolved = cfg ?? getRuntimeConfig(DB_INIT_CLI);
  storeInstance = await createStore(resolved);
  return storeInstance;
}

export async function closeStore(store: Store | null = storeInstance): Promise<void> {
  if (store) {
    await store.close();
  }
  if (!store || store === storeInstance) {
    storeInstance = null;
  }
}

/** Initialize trust database using configured backend. Creates config dir if needed. */
export async function initTrustDb(): Promise<Store> {
  const cfg = getRuntimeConfig(DB_INIT_CLI);
  return getStore(cfg);
}

/** Close the trust database connection. */
export async function closeTrustDb(store?: Store): Promise<void> {
  await closeStore(store);
}