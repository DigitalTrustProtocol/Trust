import { NIP50, NKinds, RelayError } from '@nostrify/nostrify';
import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from '@nostrify/types';
import { Kysely, sql } from 'kysely';
import { getFilterLimit, sortEvents } from 'nostr-tools';
import { Packr } from 'msgpackr';
import { KIND_TRUST } from '../nostr/nip32010.js';
import type { AllEventsOpts, GraphNotifyRow } from './dbManager.js';
import { ExtendedNRelay } from './dbManager.js';

const DENORMALIZED_TAGS = new Set(['d', 'c', 't']);
const packr = new Packr({ structuredClone: false });

export interface NSQLiteSchema {
  nostr_events: {
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    raw_event: Uint8Array;
    d: string | null;
    t: string | null;
    c: string | null;
    search_text: string | null;
    search_ext: string;
  };
  nostr_tags: {
    event_id: string;
    name: string;
    value: string;
  };
  trust_graph_notify: {
    seq: number;
    event_id: string;
    op: string;
    raw_event: Buffer | null;
  };
}

export interface NSQLiteOpts {
  indexTags?(event: NostrEvent): string[][];
  indexSearch?(event: NostrEvent): string | undefined;
  indexExtensions?(event: NostrEvent): Record<string, string> | Promise<Record<string, string>>;
}



export class NSQLite implements ExtendedNRelay  {
  db: Kysely<NSQLiteSchema>;
  private indexTags: (event: NostrEvent) => string[][];
  private indexSearch: (event: NostrEvent) => string | undefined;
  private indexExtensions: (event: NostrEvent) => Record<string, string> | Promise<Record<string, string>>;

  constructor(db: Kysely<any>, opts?: NSQLiteOpts) {
    this.db = db as Kysely<NSQLiteSchema>;
    this.indexTags = opts?.indexTags ?? NSQLite.indexTags;
    this.indexSearch = opts?.indexSearch ?? NSQLite.indexSearch;
    this.indexExtensions = opts?.indexExtensions ?? (() => ({}));
  }

  static indexTags(event: NostrEvent): string[][] {
    return event.tags.filter(
      ([name, value]) => name.length === 1 && !!value && value.length < 200 && !DENORMALIZED_TAGS.has(name),
    );
  }

  static indexSearch(event: NostrEvent): string | undefined {
    if (event.kind === 0 || event.kind === 1) {
      return `${event.content} ${event.tags.map(([_name, value]) => value).join(' ')}`.substring(0, 1000);
    }
  }

  async event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    if (NKinds.ephemeral(event.kind)) return;

    if (await this.isDeleted(event)) {
      if(opts) {
        (opts as any).isDeleted = true; // indicate that the event was deleted
        (opts as any).isInserted = false; // indicate that the event was not inserted into the database
      }
      return;
    }

    try {
      if (opts?.signal?.aborted) return;

      await NSQLite.trx(this.db, async (trx) => {
        await this.deleteEvents(trx, event);
        let inserted = await this.insertEvent(trx, event);
        if(inserted && opts) 
          (opts as any).isInserted = true; // indicate that the event was inserted into the database
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) return;
      throw e;
    }
  }

  private deriveTrustKindFromD(dTagValue: string | null, fallback: string): string | null {
    if (!dTagValue) return null;
    // Future format: <trust_kind>|<hex(64)>[|context]
    const m = dTagValue.match(/^(\d+)\|([a-fA-F0-9]{64})(\|.*)?$/);
    if (m?.[1]) return m[1]!;
    // d tag without kind prefix; use default kind.
    return fallback;
  }

  protected async isDeleted(event: NostrEvent): Promise<boolean> {
    const filters: NostrFilter[] = [{ kinds: [5], authors: [event.pubkey], '#e': [event.id], limit: 1 }];

    if (NKinds.replaceable(event.kind) || NKinds.addressable(event.kind)) {
      const d = event.tags.find(([name]) => name === 'd')?.[1] ?? '';
      filters.push({
        kinds: [5],
        authors: [event.pubkey],
        '#a': [`${event.kind}:${event.pubkey}:${d}`],
        since: event.created_at,
        limit: 1,
      });
    }

    const events = await this.query(filters, { limit: 1 });
    return events.length > 0;
  }

  protected async deleteEvents(db: Kysely<NSQLiteSchema>, event: NostrEvent): Promise<void> {
    if (event.kind !== 5) return;

    const ids = new Set(event.tags.filter(([name]) => name === 'e').map(([_name, value]) => value));
    const addrs = new Set(event.tags.filter(([name]) => name === 'a').map(([_name, value]) => value));
    const filters: NostrFilter[] = [];

    if (ids.size) filters.push({ ids: [...ids], authors: [event.pubkey] });

    for (const addr of addrs) {
      const [k, pubkey, d] = addr.split(':');
      const kind = Number(k);
      if (pubkey !== event.pubkey) continue;
      if (!(Number.isInteger(kind) && kind >= 0)) continue;
      if (d === undefined) continue;

      const filter: NostrFilter = {
        kinds: [kind],
        authors: [event.pubkey],
        until: event.created_at,
      };

      if (d) filter['#d'] = [d];
      filters.push(filter);
    }

    if (filters.length) await this.removeEvents(db, filters);
  }

  protected async insertEvent(trx: Kysely<NSQLiteSchema>, event: NostrEvent): Promise<boolean> {
    const replaceable = NKinds.replaceable(event.kind);
    const addressable = NKinds.addressable(event.kind);
    const dTag = event.tags.find(([name]) => name === 'd')?.[1] ?? '';
    const tTag = event.tags.find(([name]) => name === 't')?.[1] ?? null;
    const cTag = event.tags.find(([name]) => name === 'c')?.[1] ?? null;
    const d = addressable ? dTag : null;
    const t =
      tTag ??
      (event.kind === 32010 ? this.deriveTrustKindFromD(dTag, '32010') : null);

    if (replaceable || addressable) {
      let existingQuery = trx
        .selectFrom('nostr_events')
        .select(['id', 'created_at'])
        .where('kind', '=', event.kind)
        .where('pubkey', '=', event.pubkey);

      if (addressable) {
        existingQuery = existingQuery.where('d', '=', d);
      }

      const existing = await existingQuery
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (existing) {
        const existingCreated = Number(existing.created_at);
        if (
          existingCreated > event.created_at ||
          (existingCreated === event.created_at && existing.id >= event.id)
        ) {
          return false;
        }

        await trx.deleteFrom('nostr_events').where('id', '=', existing.id).execute();
      }
    }

    const tagsIndex = this.indexTags(event);
    const searchText = this.indexSearch(event) ?? null;
    const searchExt = await this.indexExtensions(event);

    await trx
      .insertInto('nostr_events')
      .values({
        id: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        created_at: event.created_at,
        raw_event: packr.pack(event),
        d: dTag,
        t,
        c: cTag,
        search_text: searchText,
        search_ext: JSON.stringify(searchExt),
      })
      .execute();

    if (tagsIndex.length) {
      const tagRows = tagsIndex.map(([name, value]) => ({
        event_id: event.id,
        name,
        value,
      }));

      await trx.insertInto('nostr_tags').values(tagRows).execute();
    }
    return true;
  }

  protected getFilterQuery(filter: NostrFilter) {
    let query = this.db.selectFrom('nostr_events').selectAll('nostr_events');

    if (filter.ids?.length) query = query.where('id', 'in', filter.ids);
    if (filter.kinds?.length) query = query.where('kind', 'in', filter.kinds);
    if (filter.authors?.length) query = query.where('pubkey', 'in', filter.authors);
    if (typeof filter.since === 'number') query = query.where('created_at', '>=', filter.since);
    if (typeof filter.until === 'number') query = query.where('created_at', '<=', filter.until);

    if (filter.search) {
      const parsed = NIP50.parseInput(filter.search);
      const extMap: Record<string, string[]> = {};
      const textTokens: string[] = [];

      for (const token of parsed) {
        if (typeof token === 'object') {
          extMap[token.key] ??= [];
          extMap[token.key].push(token.value);
        } else {
          const cleaned = token.trim();
          if (cleaned) textTokens.push(cleaned);
        }
      }

      for (const [rawKey, values] of Object.entries(extMap)) {
        const negated = rawKey.startsWith('-');
        const key = negated ? rawKey.slice(1) : rawKey;
        if (!key) continue;

        const jsonPath = `$.${key}`;
        const joined = sql.join(values);
        query = query.where(
          negated
            ? sql<boolean>`json_extract(search_ext, ${jsonPath}) not in (${joined})`
            : sql<boolean>`json_extract(search_ext, ${jsonPath}) in (${joined})`,
        );
      }

      for (const token of textTokens) {
        const negated = token.startsWith('-');
        const value = negated ? token.slice(1) : token;
        if (!value) continue;
        const likeValue = `%${value}%`;
        query = query.where((eb) =>
          negated ? eb.not(eb('search_text', 'like', likeValue)) : eb('search_text', 'like', likeValue),
        );
      }
    }

    for (const [key, values] of Object.entries(filter)) {
      if (!(key.startsWith('#') && Array.isArray(values) && values.length)) continue;

      const name = key.slice(1);
      if (name === 'd' && filter.kinds?.every((kind) => NKinds.addressable(kind))) {
        query = query.where('d', 'in', values);
        continue;
      }
      if (name === 't') {
        query = query.where('t', 'in', values);
        continue;
      }
      if (name === 'c') {
        query = query.where('c', 'in', values);
        continue;
      }

      query = query.where((eb) =>
        eb.or(
          values.map((value) =>
            eb.exists(
              eb
                .selectFrom('nostr_tags')
                .select('event_id')
                .whereRef('nostr_tags.event_id', '=', 'nostr_events.id')
                .where('nostr_tags.name', '=', name)
                .where('nostr_tags.value', '=', value),
            ),
          ),
        ),
      );
    }

    if (NSQLite.shouldOrder(filter)) {
      query = query.orderBy('created_at', 'desc').orderBy('id', 'asc');
    }

    if (typeof filter.limit === 'number') query = query.limit(filter.limit);
    return query;
  }

  static shouldOrder(filter: NostrFilter): boolean {
    const { limit = Infinity, ...rest } = filter;
    const potentialLimit = getFilterLimit(rest);
    return potentialLimit === Infinity || limit < potentialLimit;
  }

  protected parseEventRow(row: NSQLiteSchema['nostr_events']): NostrEvent {
    return packr.unpack(row.raw_event) as NostrEvent;
  }

  protected normalizeFilters(filters: NostrFilter[]): NostrFilter[] {
    return filters.reduce<NostrFilter[]>((acc, filter) => {
      const limit = getFilterLimit(filter);
      if (limit > 0) acc.push(limit === Infinity ? filter : { ...filter, limit });
      return acc;
    }, []);
  }




  async getEvent(id: string): Promise<NostrEvent | null> {
    const row = await this.db.selectFrom('nostr_events').selectAll('nostr_events').where('id', '=', id).executeTakeFirst();
    if (!row) return null;
    return this.parseEventRow(row);
  }

  // Returns the raw event data from the database, no parsing is done, no deduplication is done
  async rowQuery(filters: NostrFilter[], opts: { signal?: AbortSignal } = {}): Promise<NSQLiteSchema['nostr_events'][]> {
    filters = this.normalizeFilters(filters);
    if (!filters.length) return [];

    const allRows = await Promise.all(filters.map((filter) => this.getFilterQuery(filter).execute()));
    return allRows.flat();
  }

  async *allEvents(kind: number = KIND_TRUST, opts: AllEventsOpts = {}): AsyncIterable<NostrEvent> {
    let query = this.db.selectFrom('nostr_events').selectAll('nostr_events').where('kind', '=', kind);

    if (Array.isArray(opts.authors) && opts.authors.length > 0) {
      query = query.where(
        'pubkey',
        'in',
        opts.authors.map((a) => a.toLowerCase()),
      );
    }

    if (Array.isArray(opts.contexts) && opts.contexts.length > 0) {
      const ctxs = opts.contexts;
      query = query.where((eb) => {
        const parts = [];
        for (const c of ctxs) {
          if (c === '') {
            parts.push(eb('c', 'is', null));
            parts.push(eb('c', '=', ''));
          } else {
            parts.push(eb('c', '=', c));
          }
        }
        return eb.or(parts);
      });
    }

    const rows = query.stream();

    for await (const row of rows) {
      if (opts.signal?.aborted) break;
      yield packr.unpack(row.raw_event) as NostrEvent;
    }
  }

  async drainGraphNotifyBatch(limit: number): Promise<GraphNotifyRow[]> {
    let rows: NSQLiteSchema['trust_graph_notify'][];
    try {
      rows = await this.db
        .selectFrom('trust_graph_notify')
        .selectAll()
        .orderBy('seq', 'asc')
        .limit(limit)
        .execute();
    } catch {
      return [];
    }

    if (!rows.length) return [];

    const seqs = rows.map((r) => r.seq);
    await this.db.deleteFrom('trust_graph_notify').where('seq', 'in', seqs).execute();

    return rows.map((r) => ({
      seq: r.seq,
      event_id: r.event_id,
      op: r.op as 'INSERT' | 'DELETE',
      raw_event: r.raw_event ? new Uint8Array(r.raw_event) : null,
    }));
  }

  async query(filters: NostrFilter[], opts: { signal?: AbortSignal; limit?: number } = {}): Promise<NostrEvent[]> {
    filters = this.normalizeFilters(filters);
    if (!filters.length) return [];

    const allRows = await Promise.all(filters.map((filter) => this.getFilterQuery(filter).execute()));
    const events = allRows.flat().map((row) => packr.unpack(row.raw_event) as NostrEvent);
    const deduped = [...new Map(events.map((event) => [event.id, event])).values()];
    const sorted = sortEvents(deduped);

    if (typeof opts.limit === 'number') return sorted.slice(0, opts.limit);
    return sorted;
  }

  async *req(
    filters: NostrFilter[],
    _opts: { signal?: AbortSignal; timeout?: number } = {},
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    const subId = crypto.randomUUID();
    const events = await this.query(filters);
    for (const event of events) {
      yield ['EVENT', subId, event];
    }
    yield ['EOSE', subId];
    yield ['CLOSED', subId, 'error: realtime streaming is not supported'];
  }

  protected async removeEvents(db: Kysely<NSQLiteSchema>, filters: NostrFilter[]): Promise<void> {
    const events = await this.query(filters);
    const ids = [...new Set(events.map((event) => event.id))];
    if (!ids.length) return;
    await db.deleteFrom('nostr_events').where('id', 'in', ids).execute();
  }

  async remove(filters: NostrFilter[]): Promise<void> {
    await this.removeEvents(this.db, filters);
  }

  async count(filters: NostrFilter[]): Promise<{ count: number; approximate: boolean }> {
    const events = await this.query(filters);
    return { count: events.length, approximate: false };
  }

  async transaction(callback: (store: NSQLite, kysely: Kysely<NSQLiteSchema>) => Promise<void>): Promise<void> {
    await NSQLite.trx(this.db, async (trx) => {
      const store = new NSQLite(trx as Kysely<NSQLiteSchema>, {
        indexTags: this.indexTags,
        indexSearch: this.indexSearch,
        indexExtensions: this.indexExtensions,
      });
      await callback(store, trx);
    });
  }

  private static async trx<T>(
    db: Kysely<NSQLiteSchema>,
    callback: (trx: Kysely<NSQLiteSchema>) => Promise<T>,
  ): Promise<T> {
    if (db.isTransaction) return callback(db);
    return db.transaction().execute((trx) => callback(trx));
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async migrate(): Promise<void> {
    const schema = this.db.schema;

    await schema
      .createTable('nostr_events')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('kind', 'integer', (col) => col.notNull())
      .addColumn('pubkey', 'text', (col) => col.notNull())
      .addColumn('d', 'text')
      .addColumn('t', 'text')
      .addColumn('c', 'text')
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .addColumn('raw_event', 'blob', (col) => col.notNull())
      .addColumn('search_text', 'text')
      .addColumn('search_ext', 'text', (col) => col.notNull())
      .ifNotExists()
      .execute();

    await schema
      .createTable('nostr_tags')
      .addColumn('event_id', 'text', (col) => col.notNull().references('nostr_events.id').onDelete('cascade'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('value', 'text', (col) => col.notNull())
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_created_kind_idx')
      .on('nostr_events')
      .columns(['created_at', 'id', 'kind', 'pubkey'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_pubkey_created_idx')
      .on('nostr_events')
      .columns(['pubkey', 'created_at', 'id', 'kind'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_replaceable_idx')
      .on('nostr_events')
      .columns(['kind', 'pubkey'])
      .where(() => sql<boolean>`kind >= 10000 and kind < 20000 or kind in (0, 3)`)
      .unique()
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_parameterized_idx')
      .on('nostr_events')
      .columns(['kind', 'pubkey', 'd'])
      .where(() => sql<boolean>`kind >= 30000 and kind < 40000`)
      .unique()
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_kind_pubkey_c_idx')
      .on('nostr_events')
      .columns(['kind', 'pubkey', 'c'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_kind_pubkey_t_idx')
      .on('nostr_events')
      .columns(['kind', 'pubkey', 't'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_tags_name_value_idx')
      .on('nostr_tags')
      .columns(['name', 'value', 'event_id'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_search_text_idx')
      .on('nostr_events')
      .columns(['search_text'])
      .ifNotExists()
      .execute();

    await this.installGraphNotifySchema();
  }

  /** Queue rows for API graph processes when relay and API share a DB (split processes). */
  private async installGraphNotifySchema(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS trust_graph_notify (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        op TEXT NOT NULL,
        raw_event BLOB
      )
    `.execute(this.db);

    await sql.raw(`CREATE TRIGGER IF NOT EXISTS trg_nostr_events_ai_graph
AFTER INSERT ON nostr_events
BEGIN
  INSERT INTO trust_graph_notify(event_id, op) VALUES (NEW.id, 'INSERT');
END`).execute(this.db);

    await sql.raw(`CREATE TRIGGER IF NOT EXISTS trg_nostr_events_ad_graph
AFTER DELETE ON nostr_events
BEGIN
  INSERT INTO trust_graph_notify(event_id, op, raw_event) VALUES (OLD.id, 'DELETE', OLD.raw_event);
END`).execute(this.db);
  }
}
