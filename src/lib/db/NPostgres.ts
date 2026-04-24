import { NIP50, NKinds, RelayError } from '@nostrify/nostrify';
import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from '@nostrify/types';
import { Machina } from '@nostrify/nostrify/utils';
import { InsertResult, Kysely, type SelectQueryBuilder, sql } from 'kysely';
import { getFilterLimit, sortEvents } from 'nostr-tools';
import { Packr } from 'msgpackr';
import { ExtendedNRelay, InsertEventOptions } from './dbManager.js';

const DENORMALIZED_TAGS = new Set(['d', 'c', 't']);
const packr = new Packr({ structuredClone: false });
const DEFAULT_POSTGRES_EVENT_BATCH_WINDOW_MS = 100;
const DEFAULT_POSTGRES_EVENT_BATCH_MAX_SIZE = 200;

/** Bind JSONB columns as JSON text; nested JS arrays are otherwise serialized as PG array literals (`{{...}}`), which are invalid JSON. */
function jsonb(value: unknown) {
  return sql`CAST(${JSON.stringify(value)} AS jsonb)`;
}


/** Kysely database schema for Nostr. */
export interface NPostgresSchema {
  nostr_events: {
    id: string;
    kind: number;
    pubkey: string;
    created_at: number | bigint;
    /** Unix seconds when this row was first inserted; not changed on replaceable upsert. */
    firstseen: number | bigint;
    raw_event: Uint8Array;
    tags: string[][];
    tags_index: Record<string, string[]>;
    d: string | null;
    t: string | null;
    c: string | null;
    search: unknown;
    search_ext: Record<string, string>;
  };
}

/** Options object for the NPostgres constructor. */
export interface NPostgresOpts {
  /**
   * Function that returns which tags to index so tag queries like `{ "#p": ["..."] }` resolve via `tags_index` (all `p` values, including multiple per event).
   * By default, all single-letter tags are indexed.
   */
  indexTags?(event: NostrEvent): string[][];
  /**
   * Build NIP-50 search text from the event.
   * By default, only kinds 0 and 1 events are indexed for search, and the search text is the event content with tag values appended to it.
   */
  indexSearch?(event: NostrEvent): string | undefined;
  /**
   * Index NIP-50 search extensions.
   * For example: returning an object like `{ language: "pt" }` will allow searching for events with `{ search: "language:pt" }`.
   */
  indexExtensions?(event: NostrEvent): Record<string, string> | Promise<Record<string, string>>;
  /** Chunk size to use when streaming results with `.req`. Default: 20. */
  chunkSize?: number;
  /** Batch writes before commit (strict ACK waits for commit). */
  batchWrites?: boolean;
  /** Maximum queue window before flushing a batch. Default: 100ms. */
  batchWindowMs?: number;
  /** Max events per batch. Default: 200. */
  batchMaxSize?: number;
}

/** Query to select necessary fields from the `nostr_events` table. */
type SelectEventsQuery = SelectQueryBuilder<
  NPostgresSchema,
  'nostr_events',
  NPostgresSchema['nostr_events']
>;

type BatchEventPayload = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  firstseen: number;
  raw_event_base64: string;
  tags: string[][];
  tags_index: Record<string, string[]>;
  d: string | null;
  t: string | null;
  c: string | null;
  search_text: string | null;
  search_ext: Record<string, string>;
  delete_ids: string[];
  delete_addrs: string[];
};

type BatchResultRow = {
  idx: number;
  is_inserted: boolean;
  is_deleted: boolean;
  is_dublicate: boolean;
  is_timeout: boolean;
  is_error: boolean;
  error_message: string | null;
};

type QueuedEvent = {
  event: NostrEvent;
  opts: InsertEventOptions;
  payload: BatchEventPayload;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export class NPostgres implements ExtendedNRelay {
  db: Kysely<NPostgresSchema>;
  private indexTags: (event: NostrEvent) => string[][];
  private indexSearch: (event: NostrEvent) => string | undefined;
  private indexExtensions: (event: NostrEvent) => Record<string, string> | Promise<Record<string, string>>;
  private chunkSize: number;
  private readonly batchingEnabled: boolean;
  private readonly batchWindowMs: number;
  private readonly batchMaxSize: number;
  private eventQueue: QueuedEvent[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(db: Kysely<any>, opts?: NPostgresOpts) {
    this.db = db as Kysely<NPostgresSchema>;
    this.indexTags = opts?.indexTags ?? NPostgres.indexTags;
    this.indexSearch = opts?.indexSearch ?? NPostgres.indexSearch;
    this.indexExtensions = opts?.indexExtensions ?? (() => ({}));
    this.chunkSize = opts?.chunkSize ?? 20;
    this.batchWindowMs = Math.max(1, opts?.batchWindowMs ?? DEFAULT_POSTGRES_EVENT_BATCH_WINDOW_MS);
    this.batchMaxSize = Math.max(1, opts?.batchMaxSize ?? DEFAULT_POSTGRES_EVENT_BATCH_MAX_SIZE);
    this.batchingEnabled = (opts?.batchWrites ?? true) && !this.db.isTransaction;
  }

  /** Default tag index function. */
  static indexTags(event: NostrEvent): string[][] {
    return event.tags.filter(
      ([name, value]) => name.length === 1 && value && value.length < 200 && !DENORMALIZED_TAGS.has(name),
    );
  }

  /** Default search content builder. */
  static indexSearch(event: NostrEvent): string | undefined {
    if (event.kind === 0 || event.kind === 1) {
      return `${event.content} ${event.tags.map(([_name, value]) => value).join(' ')}`.substring(0, 1000);
    }
  }

  /** Insert an event (and its tags) into the database. */
  async event(event: NostrEvent, opts: InsertEventOptions = {}): Promise<void> {
    if (NKinds.ephemeral(event.kind)) return;

    if (opts.signal?.aborted) return;
    if (!this.batchingEnabled) {
      return await this.eventImmediate(event, opts);
    }

    const payload = await this.buildBatchPayload(event);
    await new Promise<void>((resolve, reject) => {
      this.eventQueue.push({ event, opts, payload, resolve, reject });
      if (this.eventQueue.length >= this.batchMaxSize) {
        this.scheduleBatchFlush(0);
      } else {
        this.scheduleBatchFlush(this.batchWindowMs);
      }
    });
  }

  private async eventImmediate(event: NostrEvent, opts: InsertEventOptions): Promise<void> {
    try {

      if (await this.isDeleted(event)) {
        opts.isDeleted = true; // indicate that the event was deleted
        opts.isInserted = false; // indicate that the event was not inserted into the database
        return;
      }
  

      await NPostgres.trx(this.db, (trx) => {
        return this.withTimeout(trx, opts.timeout, async (trx) => {
          if (event.kind === 5) await this.handleKind5(trx, event);
          opts.isInserted = await this.insertEvent(trx, event);
        });
      });
    } catch (e) {
      if (e instanceof Error) {
        opts.errorMessage = e.message;
        opts.isError = true;

        switch (e.message) {
          case 'duplicate key value violates unique constraint "nostr_events_pkey"':
            opts.isDublicate = true;
            return;
          case 'canceling statement due to statement timeout':
            opts.isTimeout = true;
            return;
        }
      }
      throw e;
    }
  }

  private scheduleBatchFlush(delayMs: number): void {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      void this.flushQueuedEvents();
    }, delayMs);
  }

  private async flushQueuedEvents(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }

    this.flushInFlight = this.flushQueuedEventsInternal();
    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
      if (this.eventQueue.length > 0) {
        this.scheduleBatchFlush(0);
      }
    }
  }

  private async flushQueuedEventsInternal(): Promise<void> {
    while (this.eventQueue.length > 0) {
      const batch = this.eventQueue.splice(0, this.batchMaxSize);
      const payload = batch.map((item) => item.payload);
      const finiteTimeouts = batch
        .map((item) => item.opts.timeout)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const batchTimeout = finiteTimeouts.length > 0 ? Math.min(...finiteTimeouts) : undefined;

      try {
        const rows = await NPostgres.trx(this.db, (trx) =>
          this.withTimeout(trx, batchTimeout, async (trx) => {
            return await this.callBatchIngestFunction(trx, payload);
          }),
        );
        const byIndex = new Map(rows.map((row) => [row.idx, row]));
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const row = byIndex.get(i);
          if (!row) {
            item.opts.isError = true;
            item.opts.errorMessage = 'Batch ingest did not return a row for this event';
            item.reject(new Error(item.opts.errorMessage));
            continue;
          }
          this.applyBatchResultToOptions(row, item.opts);
          item.resolve();
        }
      } catch (err) {
        const fallbackMessage = err instanceof Error ? err.message : String(err);
        for (const item of batch) {
          item.opts.isError = true;
          item.opts.errorMessage = fallbackMessage;
          if (fallbackMessage.includes('statement timeout')) {
            item.opts.isTimeout = true;
          }
          item.reject(err);
        }
      }
    }
  }

  private async buildBatchPayload(event: NostrEvent): Promise<BatchEventPayload> {
    const parameterized = NKinds.addressable(event.kind);
    const d = parameterized ? event.tags.find(([name]) => name === 'd')?.[1] ?? '' : null;
    const t = event.tags.find(([name]) => name === 't')?.[1] ?? null;
    const c = event.tags.find(([name]) => name === 'c')?.[1] ?? null;
    const tagsIndex = this.indexTags(event).reduce((result, [name, value]) => {
      if (!result[name]) result[name] = [];
      result[name].push(value);
      return result;
    }, {} as Record<string, string[]>);
    const searchText = this.indexSearch(event);
    const searchExt = await this.indexExtensions(event);
    const firstseen = Math.floor(Date.now() / 1000);
    const delete_ids = event.kind === 5
      ? event.tags.filter(([name]) => name === 'e').map(([, value]) => value).filter(Boolean)
      : [];
    const delete_addrs = event.kind === 5
      ? event.tags.filter(([name]) => name === 'a').map(([, value]) => value).filter(Boolean)
      : [];

    return {
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      created_at: event.created_at,
      firstseen,
      raw_event_base64: Buffer.from(packr.pack(event)).toString('base64'),
      tags: event.tags,
      tags_index: tagsIndex,
      d,
      t,
      c,
      search_text: searchText ?? null,
      search_ext: searchExt,
      delete_ids,
      delete_addrs,
    };
  }

  private async callBatchIngestFunction(
    trx: Kysely<NPostgresSchema>,
    payload: BatchEventPayload[],
  ): Promise<BatchResultRow[]> {
    const q = sql<BatchResultRow>`
      select idx, is_inserted, is_deleted, is_dublicate, is_timeout, is_error, error_message
      from trust_ingest_events_batch(CAST(${JSON.stringify(payload)} AS jsonb))
      order by idx asc
    `;
    const result = await q.execute(trx);
    return result.rows;
  }

  private applyBatchResultToOptions(row: BatchResultRow, opts: InsertEventOptions): void {
    opts.isInserted = row.is_inserted;
    opts.isDeleted = row.is_deleted;
    opts.isDublicate = row.is_dublicate;
    opts.isTimeout = row.is_timeout;
    opts.isError = row.is_error;
    opts.errorMessage = row.error_message ?? undefined;
  }

  /**
   * Check if an event has been tombstoned by an existing kind-5 delete.
   * Batched writes: same logic runs inside `trust_ingest_events_batch` (see migrate() SQL).
   */
  protected async isDeleted(event: NostrEvent): Promise<boolean> {
    const filters: NostrFilter[] = [
      { kinds: [5], authors: [event.pubkey], '#e': [event.id], limit: 1 },
    ];

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

    const events = await this.query(filters);
    return events.length > 0;
  }

  /** Delete events referenced by kind 5. */
  protected async handleKind5(db: Kysely<NPostgresSchema>, event: NostrEvent): Promise<void> {
    const ids = new Set(event.tags.filter(([name]) => name === 'e').map(([_name, value]) => value));
    const addrs: Set<string> = new Set(event.tags.filter(([name]) => name === 'a').map(([_name, value]) => value));

    const filters: NostrFilter[] = [];

    if (ids.size) {
      filters.push({ ids: [...ids], authors: [event.pubkey] });
    }

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

      if (d) {
        filter['#d'] = [d];
      }

      filters.push(filter);
    }

    if (filters.length) {
      await this.removeEvents(db, filters);
    }

    // TODO: Add the event to the DB
  }

  /** Insert the event into the database. */
  protected async insertEvent(trx: Kysely<NPostgresSchema>, event: NostrEvent): Promise<boolean> {

    const replaceable = NKinds.replaceable(event.kind);
    const parameterized = NKinds.addressable(event.kind);

    const d = parameterized ? event.tags.find(([name]) => name === 'd')?.[1] ?? null : null;
    const t = event.tags.find(([name]) => name === 't')?.[1] ?? null;
    const c = event.tags.find(([name]) => name === 'c')?.[1] ?? null;


    const tagsIndex = this.indexTags(event).reduce((result, [name, value]) => {
      if (!result[name]) {
        result[name] = [];
      }
      result[name].push(value);
      return result;
    }, {} as Record<string, string[]>);

    const searchText = this.indexSearch(event);
    const searchExt = await this.indexExtensions(event);
    const firstseen = Math.floor(Date.now() / 1000);

    let tags = jsonb(event.tags) as unknown as NPostgresSchema['nostr_events']['tags'];
    let tags_index = jsonb(tagsIndex) as unknown as NPostgresSchema['nostr_events']['tags_index'];
    let search_ext = jsonb(searchExt) as unknown as NPostgresSchema['nostr_events']['search_ext'];

    const row: NPostgresSchema['nostr_events'] = {
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      created_at: event.created_at,
      firstseen,
      raw_event: packr.pack(event),
      tags,
      tags_index,
      search_ext,
      search: searchText ? sql`to_tsvector(${searchText})` : null,
      d: parameterized ? d ?? '' : null,
      t,
      c,
    };

    let result: any = null;

    if (replaceable || parameterized) {
      result = await trx.insertInto('nostr_events')
        .values(row)
        .onConflict((oc) =>
          oc
            .columns(replaceable ? ['kind', 'pubkey'] : ['kind', 'pubkey', 'd'])
            .where(() =>
              replaceable
                ? sql`kind >= 10000 and kind < 20000 or (kind in (0, 3))`
                : sql`kind >= 30000 and kind < 40000`
            )
            .doUpdateSet((eb) => ({
              id: eb.ref('excluded.id'),
              kind: eb.ref('excluded.kind'),
              pubkey: eb.ref('excluded.pubkey'),
              created_at: eb.ref('excluded.created_at'),
              raw_event: eb.ref('excluded.raw_event'),
              tags: eb.ref('excluded.tags'),
              tags_index: eb.ref('excluded.tags_index'),
              d: eb.ref('excluded.d'),
              t: eb.ref('excluded.t'),
              c: eb.ref('excluded.c'),
              search: eb.ref('excluded.search'),
              search_ext: eb.ref('excluded.search_ext'),
            })).where((eb) =>
              // Replace only when incoming event is strictly newer by time.
              // Event id is not a time signal; equal `created_at` keeps the existing row.
              eb('nostr_events.created_at', '<', eb.ref('excluded.created_at'))
            )
        )
        .execute();
    } else {
      result = await trx.insertInto('nostr_events')
        .values(row)
        .execute();
    }

    let isInserted = false;
    if (result && result[0]) {
      let insertResult = result[0]! as InsertResult;

      isInserted = (insertResult.numInsertedOrUpdatedRows && insertResult.numInsertedOrUpdatedRows > 0) as boolean;
    }
    return isInserted;
  }

  /** Whether results should be sorted reverse-chronologically by the database. */
  static shouldOrder(filter: NostrFilter): boolean {
    const { limit = Infinity, ...rest } = filter;
    const potentialLimit = getFilterLimit(rest);
    return potentialLimit === Infinity || limit < potentialLimit;
  }

  /** Build the query for a filter. */
  protected getFilterQuery(trx: Kysely<NPostgresSchema>, filter: NostrFilter): SelectEventsQuery {
    let query = trx
      .selectFrom('nostr_events')
      .selectAll('nostr_events');

    // Avoid ORDER BY for certain queries.
    const shouldOrder = NPostgres.shouldOrder(filter);
    if (shouldOrder) {
      query = query
        .orderBy('nostr_events.created_at', 'desc')
        .orderBy('nostr_events.id', 'asc');
    }

    if (filter.ids) {
      query = query.where('nostr_events.id', '=', ({ fn, val }) => fn.any(val(filter.ids)));
    }
    if (filter.kinds) {
      query = query.where('nostr_events.kind', '=', ({ fn, val }) => fn.any(val(filter.kinds)));
    }
    if (filter.authors) {
      query = query.where('nostr_events.pubkey', '=', ({ fn, val }) => fn.any(val(filter.authors)));
    }
    if (typeof filter.since === 'number') {
      query = query.where('nostr_events.created_at', '>=', filter.since);
    }
    if (typeof filter.until === 'number') {
      query = query.where('nostr_events.created_at', '<=', filter.until);
    }
    if (typeof filter.limit === 'number') {
      query = query.limit(filter.limit);
    }
    if (filter.search) {
      const ext: Record<string, string[]> = {};
      const tsq: string[] = [];

      for (const token of NIP50.parseInput(filter.search)) {
        if (typeof token === 'object') {
          ext[token.key] ??= [];
          ext[token.key].push(token.value);
        }

        if (typeof token === 'string') {
          const t = token.replace(/[^\p{L}\p{N}-]/gu, ' ');

          const isWord = /^-?[\p{L}\p{N}]+$/u.test(t);
          const isPhrase = /^([\p{L}\p{N}]+\s+)+[\p{L}\p{N}]+$/u.test(t);

          if (isWord) {
            tsq.push(t.replace(/^-/, '!')); // handle negated words
          } else if (isPhrase) {
            tsq.push(t.split(/\s+/g).join(' <-> ')); // join words in phrase
          } else {
            // unsupported token
            return trx.selectFrom('nostr_events').selectAll().where('nostr_events.id', 'is', null);
          }
        }
      }

      for (let [key, values] of Object.entries(ext)) {
        let negated = false;

        if (key.startsWith('-')) {
          key = key.slice(1);
          negated = true;
        }

        query = query.where((eb) => {
          if (negated) {
            return eb.and(
              values.map((value) => eb.not(eb('nostr_events.search_ext', '@>', { [key]: value }))),
            );
          } else {
            return eb.or(
              values.map((value) => eb('nostr_events.search_ext', '@>', { [key]: value })),
            );
          }
        });
      }

      if (tsq.length) {
        query = query.where('nostr_events.search', '@@', sql`to_tsquery(${tsq.join(' & ')})`);
      }
    }

    let isAddressable = filter.kinds?.some((kind) => NKinds.addressable(kind));

    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        const name = key.replace(/^#/, '');

        if (name === 'd' && isAddressable) {
          query = query.where('d', '=', ({ fn, val }) => fn.any(val(values)));
        } else if (name === 't') {
          query = query.where('t', '=', ({ fn, val }) => fn.any(val(values)));
        } else if (name === 'c') {
          query = query.where('c', '=', ({ fn, val }) => fn.any(val(values)));
        } else {
          query = query.where((eb) =>
            eb.or(
              values.map(
                (value) => eb('nostr_events.tags_index', '@>', { [name]: [value] }),
              ),
            )
          );
        }
      }
    }

    return query;
  }

  /** Combine filter queries into a single union query. */
  protected getEventsQuery(trx: Kysely<NPostgresSchema>, filters: NostrFilter[]): SelectEventsQuery {
    return trx.selectFrom((eb) =>
      filters
        .map((filter) => eb.selectFrom(() => this.getFilterQuery(trx, filter).as('e')).selectAll())
        .reduce((result, query) => result.unionAll(query)).as('e')
    )
      .selectAll() as SelectEventsQuery;
  }

  async *allEvents(kinds: number[], authors: string[], contexts: string[], signal?: AbortSignal): AsyncIterable<NostrEvent> {
    let query = this.db.selectFrom('nostr_events').selectAll('nostr_events');
    if (kinds.length === 1) {
      query = query.where('kind', '=', kinds[0]);
    }
    if (kinds.length > 1) {
      query = query.where('kind', 'in', kinds);
    }

    if (authors.length === 1) {
      query = query.where('pubkey', '=', authors[0]);
    }
    if (authors.length > 1) {
      query = query.where('pubkey', 'in', authors);
    }

    if (contexts.length === 1) {
      query = query.where('c', '=', contexts[0]);
    }
    if (contexts.length > 1) {
      query = query.where('c', 'in', contexts);
    }

    // Prefer cursor-based streaming when available. Some Postgres dialect setups
    // don't provide `cursor`, in which case Kysely throws and we fall back.
    try {
      const rows = query.stream(1000);
      for await (const row of rows) {
        if (signal?.aborted) break;
        yield packr.unpack(row.raw_event) as NostrEvent;
      }
      return;
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("'cursor' is not present in your postgres dialect config")) {
        throw err;
      }
    }

    const pageSize = 1000;
    let offset = 0;
    while (!signal?.aborted) {
      const rows = await query
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(pageSize)
        .offset(offset)
        .execute();

      if (rows.length === 0) break;
      for (const row of rows) {
        if (signal?.aborted) break;
        yield packr.unpack(row.raw_event) as NostrEvent;
      }
      offset += rows.length;
    }
  }

  /**
   * Stream events, mimicking a relay.
   *
   * This method uses the database's native streaming mechanism, so both the database
   * and Kysely dialect must support it. Set the `cunkSize` in the constructor to control
   * how many rows are fetched at once.
   *
   * Yields `EVENT` messages until the query completes, then it will yield `EOSE`, then `CLOSED`.
   * If the signal is aborted, it will yield `CLOSED` on the next iteration.
   */
  async *req(
    filters: NostrFilter[],
    opts: { timeout?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    const subId = crypto.randomUUID();

    filters = this.normalizeFilters(filters);

    if (filters.length) {
      const machina = new Machina<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED>(opts.signal);

      this.withTimeout(this.db, opts.timeout, async (trx) => {
        const rows = this.getEventsQuery(trx, filters).stream(this.chunkSize);

        for await (const row of rows) {
          const event = this.parseEventRow(row);
          machina.push(['EVENT', subId, event]);
        }

        machina.push(['EOSE', subId]);
      }).catch((error) => {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.message.includes('timeout'))) {
          machina.push(['CLOSED', subId, 'error: the relay could not respond fast enough']);
        } else {
          machina.push(['CLOSED', subId, 'error: something went wrong']);
        }
      });

      try {
        for await (const msg of machina) {
          const [verb] = msg;

          yield msg;

          if (verb === 'EOSE') {
            break;
          }

          if (verb === 'CLOSED') {
            return;
          }
        }
      } catch {
        yield ['CLOSED', subId, 'error: the relay could not respond fast enough'];
        return;
      }
    }

    yield ['CLOSED', subId, 'error: realtime streaming is not supported'];
  }

  /** Get events for filters from the database. */
  async query(
    filters: NostrFilter[],
    opts: { timeout?: number; signal?: AbortSignal; limit?: number } = {},
  ): Promise<NostrEvent[]> {
    filters = this.normalizeFilters(filters);

    if (!filters.length) {
      return [];
    }

    return await this.withTimeout(this.db, opts.timeout, async (trx) => {
      let query = this.getEventsQuery(trx, filters);

      if (typeof opts.limit === 'number') {
        query = query.limit(opts.limit);
      }

      const rows = await query.execute();
      const events = rows.map((row) => this.parseEventRow(row));

      return sortEvents(events);
    });
  }

  /** Parse an event row from the database. */
  protected parseEventRow(row: NPostgresSchema['nostr_events']): NostrEvent {
    return packr.unpack(row.raw_event) as NostrEvent;
  }

  async getEvent(id: string): Promise<NostrEvent | null> {
    const row = await this.db.selectFrom('nostr_events').selectAll('nostr_events').where('id', '=', id).executeTakeFirst();
    if (!row) return null;
    return this.parseEventRow(row);
  }

  // Returns rows directly without unpacking raw_event.
  async rowQuery(
    filters: NostrFilter[],
    opts: { timeout?: number; signal?: AbortSignal; limit?: number } = {},
  ): Promise<NPostgresSchema['nostr_events'][]> {
    filters = this.normalizeFilters(filters);
    if (!filters.length) return [];

    return await this.withTimeout(this.db, opts.timeout, async (trx) => {
      let query = this.getEventsQuery(trx, filters);

      if (typeof opts.limit === 'number') {
        query = query.limit(opts.limit);
      }

      return query.execute();
    });
  }

  /** Normalize the `limit` of each filter, and remove filters that can't produce any events. */
  protected normalizeFilters(filters: NostrFilter[]): NostrFilter[] {
    return filters.reduce<NostrFilter[]>((acc, filter) => {
      const limit = getFilterLimit(filter);
      if (limit > 0) {
        acc.push(limit === Infinity ? filter : { ...filter, limit });
      }
      return acc;
    }, []);
  }

  /** Remove events from the database. */
  protected async removeEvents(db: Kysely<NPostgresSchema>, filters: NostrFilter[]): Promise<void> {
    await db
      .deleteFrom('nostr_events')
      .where('id', 'in', () => this.getEventsQuery(db, filters).clearSelect().select('id'))
      .execute();
  }

  /** Delete events based on filters from the database. */
  async remove(filters: NostrFilter[], opts: { signal?: AbortSignal; timeout?: number } = {}): Promise<void> {
    await this.withTimeout(this.db, opts.timeout, (trx) => this.removeEvents(trx, filters));
  }

  /** Get number of events that would be returned by filters. */
  async count(
    filters: NostrFilter[],
    opts: { signal?: AbortSignal; timeout?: number } = {},
  ): Promise<{ count: number; approximate: boolean }> {
    return await this.withTimeout(this.db, opts.timeout, async (trx) => {
      const query = this.getEventsQuery(trx, filters);
      const [{ count }] = await query
        .clearSelect()
        .clearOrderBy()
        .select((eb) => eb.fn.countAll().as('count'))
        .execute();

      return {
        count: Number(count),
        approximate: false,
      };
    });
  }

  /** Execute NPostgres functions in a transaction. */
  async transaction(callback: (store: NPostgres, kysely: Kysely<NPostgresSchema>) => Promise<void>): Promise<void> {
    await NPostgres.trx(this.db, async (trx) => {
      const store = new NPostgres(trx as Kysely<NPostgresSchema>, {
        indexTags: this.indexTags,
        indexSearch: this.indexSearch,
        indexExtensions: this.indexExtensions,
        chunkSize: this.chunkSize,
        batchWrites: this.batchingEnabled,
        batchWindowMs: this.batchWindowMs,
        batchMaxSize: this.batchMaxSize,
      });

      await callback(store, trx);
    });
  }

  /** Execute the callback in a new transaction, unless the Kysely instance is already a transaction. */
  private static async trx<T = unknown>(
    db: Kysely<NPostgresSchema>,
    callback: (trx: Kysely<NPostgresSchema>) => Promise<T>,
  ): Promise<T> {
    if (db.isTransaction) {
      return await callback(db);
    } else {
      return await db.transaction().execute((trx) => callback(trx));
    }
  }

  /** Maybe execute the callback in a transaction with a timeout, if a timeout is provided. */
  protected async withTimeout<T>(
    db: Kysely<NPostgresSchema>,
    timeout: number | undefined,
    callback: (trx: Kysely<NPostgresSchema>) => T | Promise<T>,
  ): Promise<T> {
    if (typeof timeout === 'number') {
      return await NPostgres.trx(db, async (trx) => {
        await sql`set local statement_timeout = ${sql.raw(timeout.toString())}`.execute(trx);
        return await callback(trx);
      });
    } else {
      return await callback(db);
    }
  }

  async close(): Promise<void> {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.eventQueue.length > 0) {
      await this.flushQueuedEvents();
    }
    await this.db.destroy();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Migrate the database schema. */
  async migrate(): Promise<void> {
    const schema = this.db.schema;

    await schema
      .createTable('nostr_events')
      .addColumn('id', 'char(64)', (col) => col.primaryKey())
      .addColumn('kind', 'integer', (col) => col.notNull())
      .addColumn('pubkey', 'char(64)', (col) => col.notNull())
      .addColumn('created_at', 'bigint', (col) => col.notNull())
      .addColumn('firstseen', 'bigint', (col) => col.notNull())
      .addColumn('raw_event', 'bytea', (col) => col.notNull())
      .addColumn('tags', 'jsonb', (col) => col.notNull())
      .addColumn('tags_index', 'jsonb', (col) => col.notNull())
      .addColumn('d', 'text')
      .addColumn('t', 'text')
      .addColumn('c', 'text')
      .addColumn('search', sql`tsvector`)
      .addColumn('search_ext', 'jsonb', (col) => col.notNull())
      .addCheckConstraint('nostr_events_kind_chk', sql`kind >= 0`)
      .addCheckConstraint('nostr_events_created_chk', sql`created_at >= 0`)
      .addCheckConstraint('nostr_events_tags_chk', sql`jsonb_typeof(tags) = 'array'`)
      .addCheckConstraint('nostr_events_tags_index_chk', sql`jsonb_typeof(tags_index) = 'object'`)
      .addCheckConstraint('nostr_events_search_ext_chk', sql`jsonb_typeof(search_ext) = 'object'`)
      .addCheckConstraint(
        'nostr_events_d_chk',
        sql`(kind >= 30000 and kind < 40000 and d is not null) or ((kind < 30000 or kind >= 40000) and d is null)`,
      )
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_created_kind_idx')
      .on('nostr_events')
      .columns(['created_at desc', 'id asc', 'kind', 'pubkey'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_pubkey_created_idx')
      .on('nostr_events')
      .columns(['pubkey', 'created_at desc', 'id asc', 'kind'])
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_tags_idx').using('gin')
      .on('nostr_events')
      .column('tags_index')
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_replaceable_idx')
      .on('nostr_events')
      .columns(['kind', 'pubkey'])
      .where(() => sql`kind >= 10000 and kind < 20000 or (kind in (0, 3))`)
      .unique()
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_parameterized_idx')
      .on('nostr_events')
      .columns(['kind', 'pubkey', 'd'])
      .where(() => sql`kind >= 30000 and kind < 40000`)
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
      .createIndex('nostr_events_search_idx').using('gin')
      .on('nostr_events')
      .column('search')
      .ifNotExists()
      .execute();

    await schema
      .createIndex('nostr_events_search_ext_idx').using('gin')
      .on('nostr_events')
      .column('search_ext')
      .ifNotExists()
      .execute();

    await sql.raw(`
      create or replace function trust_ingest_events_batch(p_events jsonb)
      returns table (
        idx integer,
        is_inserted boolean,
        is_deleted boolean,
        is_dublicate boolean,
        is_timeout boolean,
        is_error boolean,
        error_message text
      )
      language plpgsql
      as $$
      declare
        rec record;
        v_kind integer;
        v_pubkey text;
        v_created_at bigint;
        v_d text;
        v_replaceable boolean;
        v_parameterized boolean;
        v_affected bigint;
      begin
        for rec in
          select (ordinality - 1)::int as idx, value as evt
          from jsonb_array_elements(p_events) with ordinality
        loop
          idx := rec.idx;
          is_inserted := false;
          is_deleted := false;
          is_dublicate := false;
          is_timeout := false;
          is_error := false;
          error_message := null;

          begin
            v_kind := (rec.evt->>'kind')::int;
            v_pubkey := rec.evt->>'pubkey';
            v_created_at := (rec.evt->>'created_at')::bigint;
            v_parameterized := (v_kind >= 30000 and v_kind < 40000);
            v_replaceable := (v_kind >= 10000 and v_kind < 20000) or v_kind in (0, 3);
            v_d := case when v_parameterized then coalesce(rec.evt->>'d', '') else null end;

            -- Tombstone check: must match NPostgres.isDeleted() (kind 5 + #e on this id, OR for
            -- replaceable/addressable kinds + #a address + delete event created_at >= this event).
            if exists (
              select 1
              from nostr_events ne
              where ne.kind = 5
                and ne.pubkey = v_pubkey
                and (
                  ne.tags_index @> jsonb_build_object('e', jsonb_build_array(rec.evt->>'id'))
                  or (
                    (v_replaceable or v_parameterized)
                    and ne.tags_index @> jsonb_build_object('a', jsonb_build_array(concat(v_kind::text, ':', v_pubkey, ':', coalesce(v_d, ''))))
                    and ne.created_at >= v_created_at
                  )
                )
              limit 1
            ) then
              is_deleted := true;
              return next;
              continue;
            end if;

            if v_kind = 5 then
              delete from nostr_events ne
              where ne.pubkey = v_pubkey
                and (
                  ne.id in (
                    select value
                    from jsonb_array_elements_text(coalesce(rec.evt->'delete_ids', '[]'::jsonb))
                  )
                  or exists (
                    select 1
                    from jsonb_array_elements_text(coalesce(rec.evt->'delete_addrs', '[]'::jsonb)) as a(addr)
                    where split_part(a.addr, ':', 2) = v_pubkey
                      and split_part(a.addr, ':', 1) ~ '^[0-9]+$'
                      and ne.kind = split_part(a.addr, ':', 1)::int
                      and ne.created_at <= v_created_at
                      and (
                        split_part(a.addr, ':', 3) = ''
                        or ne.d = split_part(a.addr, ':', 3)
                      )
                  )
                );
            end if;

            if v_replaceable or v_parameterized then
              insert into nostr_events (
                id, kind, pubkey, created_at, firstseen, raw_event, tags, tags_index, d, t, c, search, search_ext
              )
              values (
                rec.evt->>'id',
                v_kind,
                v_pubkey,
                v_created_at,
                coalesce((rec.evt->>'firstseen')::bigint, extract(epoch from now())::bigint),
                decode(rec.evt->>'raw_event_base64', 'base64'),
                coalesce(rec.evt->'tags', '[]'::jsonb),
                coalesce(rec.evt->'tags_index', '{}'::jsonb),
                v_d,
                nullif(rec.evt->>'t', ''),
                nullif(rec.evt->>'c', ''),
                case
                  when rec.evt->>'search_text' is null then null
                  else to_tsvector(rec.evt->>'search_text')
                end,
                coalesce(rec.evt->'search_ext', '{}'::jsonb)
              )
              on conflict (kind, pubkey, d)
                where kind >= 30000 and kind < 40000
              do update set
                id = excluded.id,
                kind = excluded.kind,
                pubkey = excluded.pubkey,
                created_at = excluded.created_at,
                raw_event = excluded.raw_event,
                tags = excluded.tags,
                tags_index = excluded.tags_index,
                d = excluded.d,
                t = excluded.t,
                c = excluded.c,
                search = excluded.search,
                search_ext = excluded.search_ext
              where nostr_events.created_at < excluded.created_at;
            elsif v_replaceable then
              insert into nostr_events (
                id, kind, pubkey, created_at, firstseen, raw_event, tags, tags_index, d, t, c, search, search_ext
              )
              values (
                rec.evt->>'id',
                v_kind,
                v_pubkey,
                v_created_at,
                coalesce((rec.evt->>'firstseen')::bigint, extract(epoch from now())::bigint),
                decode(rec.evt->>'raw_event_base64', 'base64'),
                coalesce(rec.evt->'tags', '[]'::jsonb),
                coalesce(rec.evt->'tags_index', '{}'::jsonb),
                null,
                nullif(rec.evt->>'t', ''),
                nullif(rec.evt->>'c', ''),
                case
                  when rec.evt->>'search_text' is null then null
                  else to_tsvector(rec.evt->>'search_text')
                end,
                coalesce(rec.evt->'search_ext', '{}'::jsonb)
              )
              on conflict (kind, pubkey)
                where kind >= 10000 and kind < 20000 or kind in (0, 3)
              do update set
                id = excluded.id,
                kind = excluded.kind,
                pubkey = excluded.pubkey,
                created_at = excluded.created_at,
                raw_event = excluded.raw_event,
                tags = excluded.tags,
                tags_index = excluded.tags_index,
                d = excluded.d,
                t = excluded.t,
                c = excluded.c,
                search = excluded.search,
                search_ext = excluded.search_ext
              where nostr_events.created_at < excluded.created_at;
            else
              insert into nostr_events (
                id, kind, pubkey, created_at, firstseen, raw_event, tags, tags_index, d, t, c, search, search_ext
              )
              values (
                rec.evt->>'id',
                v_kind,
                v_pubkey,
                v_created_at,
                coalesce((rec.evt->>'firstseen')::bigint, extract(epoch from now())::bigint),
                decode(rec.evt->>'raw_event_base64', 'base64'),
                coalesce(rec.evt->'tags', '[]'::jsonb),
                coalesce(rec.evt->'tags_index', '{}'::jsonb),
                null,
                nullif(rec.evt->>'t', ''),
                nullif(rec.evt->>'c', ''),
                case
                  when rec.evt->>'search_text' is null then null
                  else to_tsvector(rec.evt->>'search_text')
                end,
                coalesce(rec.evt->'search_ext', '{}'::jsonb)
              );
            end if;

            get diagnostics v_affected = row_count;
            is_inserted := v_affected > 0;
            if not is_inserted then
              is_dublicate := true;
            end if;
          exception
            when unique_violation then
              is_inserted := false;
              is_dublicate := true;
            when query_canceled then
              is_inserted := false;
              is_timeout := true;
            when others then
              is_inserted := false;
              is_error := true;
              error_message := sqlerrm;
          end;

          return next;
        end loop;
      end;
      $$;
    `).execute(this.db);

    // Remove legacy graph LISTEN/NOTIFY triggers (graph updates follow the relay WebSocket instead).
    await sql.raw(`DROP TRIGGER IF EXISTS trg_nostr_events_ai_graph ON nostr_events`).execute(this.db);
    await sql.raw(`DROP TRIGGER IF EXISTS trg_nostr_events_ad_graph ON nostr_events`).execute(this.db);
    await sql.raw(`DROP FUNCTION IF EXISTS trust_pg_notify_insert_fn()`).execute(this.db);
    await sql.raw(`DROP FUNCTION IF EXISTS trust_pg_notify_delete_fn()`).execute(this.db);

    await sql`alter table nostr_events add column if not exists firstseen bigint`.execute(this.db);
    await sql`update nostr_events set firstseen = created_at where firstseen is null`.execute(this.db);
    await sql`alter table nostr_events alter column firstseen set not null`.execute(this.db);
  }
}
