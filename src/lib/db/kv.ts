import { Kysely } from 'kysely';
import { getStore } from './dbManager.js';

export interface KVSchema {
  kv: {
    key: string;
    value: string;
  };
}

export const KV_KEYS = {
  LATEST_TIMESTAMP: 'latest_timestamp',
  LAST_SEEN_TIMESTAMP: 'last_seen_timestamp',
  TRUST_SYNC_SINCE: 'trust_sync_since',
} as const;

export async function migrateSQLiteKV(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('kv')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .ifNotExists()
    .execute();
}

export async function migratePostgresKV(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('kv')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .ifNotExists()
    .execute();
}

export async function kvGetFromDB(db: Kysely<any>, key: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('kv')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();

  return row?.value;
}

export async function kvSetToDB(db: Kysely<any>, key: string, value: string): Promise<void> {
  await db
    .insertInto('kv')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

export async function kvDeleteFromDB(db: Kysely<any>, key: string): Promise<void> {
  await db.deleteFrom('kv').where('key', '=', key).execute();
}

export async function kvGet(key: string): Promise<string | undefined> {
  const store = await getStore();
  return kvGetFromDB(store.db, key);
}

export async function kvSet(key: string, value: string): Promise<void> {
  const store = await getStore();
  return kvSetToDB(store.db, key, value);
}

export async function kvDelete(key: string): Promise<void> {
  const store = await getStore();
  return kvDeleteFromDB(store.db, key);
}

