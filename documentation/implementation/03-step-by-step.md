# NIP-32010 Step-by-Step Implementation

Implementation order: **Database first** (schema and access), then **business layers**, then **commands**, then **server/client architecture**. Each phase builds on the previous.

---

## Phase 1: Database

### Step 1.1: Add configuration

1. **File:** `src/config.ts`
2. Add `trustDb: join(CONFIG_DIR, 'trust.db')` to `PATHS`.
3. Add `TRUST_SYNC_SINCE: 'trust_sync_since'` to `KV_KEYS` in `src/lib/trust/trust-db.ts`.

### Step 1.2: Trust DB module

1. **Create** `src/lib/trust/trust-db.ts`.
2. **Implement:**
   - `getTrustDb()` – lazy init, create `~/.trust` if needed, open `trust.db`.
   - `initTrustDb()` – run schema creation (see design doc).
3. **Schema:** Create tables in this order (see design doc):
   - `raw_events`
   - `identities` (id TEXT PK, tag, k, first_seen_at, last_updated_at)
   - `refs` (event_id, identity_id, event_kind) PK
   - `trust` (author_id, subject_id, context, value, event_id, created_at)
4. **Implement** `closeTrustDb()`.
5. **Tests:** Unit test that schema is created and tables exist.

### Step 1.3: Trust repository – insert

1. **Create** `src/lib/trust/trust-repo.ts`.
2. **Implement** `insertTrustEvent(event: VerifiedEvent): void`:
   - Assert `event.kind === 32010`.
   - Upsert into `raw_events` (id, pubkey, created_at, kind, content, tags_json, sig, synced_at).
   - For author and each subject: upsert `identities` (id = canonical identifier, tag, k).
   - Extract subjects from tags (`p`, `e`, `a`, `h`, `r`, `i`+`k`).
   - Insert into `refs` (event_id, identity_id, event_kind) for author and each subject.
   - Upsert `trust` (one row per subject): (author_id, subject_id, context, value, event_id, created_at).
3. **Note:** For “latest wins,” `trust` uses PK `(issuer_id, subject_id, context)`. When the same author issues a newer event for the same subject+context, replace the row. Use `created_at` to decide; process events in `created_at` order during sync.
4. **Tests:** Insert a few kind 32010 events, verify `raw_events`, `identities`, `refs`, `trust` populated.

### Step 1.4: Trust repository – query by subject

1. **Implement** `queryTrustBySubject(identityId: string, context?: string): TrustRow[]`.
2. Query `trust` where `subject_id = ?`, optionally filter by `context`.
3. **Implement** `queryRefsByIdentity(identityId: string, eventKind?: number): { event_id }[]` – from `refs`, optionally filter by `event_kind`.
4. **Tests:** Insert events, resolve target to identity id, query trust, assert correct rows returned.

### Step 1.5: Sync cursor

1. **Implement** `getTrustSyncCursor(): number | undefined` and `setTrustSyncCursor(ts: number): void` using `kvGet`/`kvSet` with `KV_KEYS.TRUST_SYNC_SINCE`.
2. **Tests:** Unit test get/set cursor.

---

## Phase 2: Business Layer

### Step 2.1: Subject parsing

1. **Create** `src/lib/trust/subject.ts`.
2. **Implement** `parseSubject(input: string): ParsedSubject`:
   - Detect hex pubkey (64), hex event id (64), npub/nprofile (decode via nip19), note1/nevent1, `a:kind:pubkey:d`, URL, hash (64 hex), NIP-73 (`isbn:`, `doi:`, `geo:`, etc.).
   - Return `{ tag, value, k? }` and the corresponding tag arrays.
3. **Implement** `parseSubjects(inputs: string[]): ParsedSubject[]` – map over inputs.
4. **Tests:** Unit tests for each subject type.

### Step 2.2: Trust event builder

1. **Create** `src/lib/trust/trust-event.ts`.
2. **Implement** `computeDTag(subjects: ParsedSubject[], context?: string): string`:
   - Per subject: fragment = raw 64-hex preimage or SHA256(preimage) hex; dedupe identical fragments; single unique → that fragment; multiple → XOR 32-byte decodes; append `|context` if context.
   - Output: `d = <hex(64)>[|context]` (no kind prefix).
3. **Implement** `buildTrustEventTemplate(params): EventTemplate`:
   - Kind 32010, tags: `d`, `c` (if context), `v`, plus subject tags.
   - Enforce content ≤ 1024, value ∈ {1, 0, -1}.
4. **Tests:** Unit tests for d-tag (single, batch) and template.

### Step 2.3: Reputation aggregation

1. **Create** `src/lib/trust/reputation.ts`.
2. **Implement** `aggregateByTarget(trustRows: TrustRow[], context?: string): { trust: number, neutral: number, distrust: number }`.
3. **Implement** `resolveLatestWins(events: VerifiedEvent[]): Map<string, { value, event }>` – key `author|subject|context`, sort by `created_at`, last wins.
4. **Tests:** Unit tests for aggregation and latest-wins.

### Step 2.4: Target resolution for query/resolve

1. In `subject.ts` or `trust-repo.ts`, add `resolveTargetForQuery(target: string): { tag, value }` – same parsing as `parseSubject` but for “the target to resolve” (canonical value only).
2. **Tests:** Resolve npub, note1, hex, URL to canonical form.

---

## Phase 3: Commands

### Step 3.1: Trust issue command

1. **Create** `src/commands/trust.ts`.
2. **Implement** `issueTrustCommand(subjects: string[], options)`:
   - Parse subjects via `parseSubjects`.
   - Build template via `buildTrustEventTemplate`.
   - Sign with `signEvent`, publish with `publishEvent`.
3. **Arguments:** `subject [subjects...]`; options: `-c, --context`, `-v, --value`, `--content`, `-r, --relay`.
4. **Wire** in `cli.ts`: `program.command('trust')` with subcommand `issue`.
5. **Manual test:** `trust trust issue npub1... -v 1 -c development`

### Step 3.2: Trust sync command

1. **Implement** `syncTrustCommand(options)`:
   - Get cursor via `getTrustSyncCursor()`.
   - Query relays: `{ kinds: [32010], since: cursor }`.
   - For each event: `insertTrustEvent(event)`.
   - Set cursor to `max(created_at) + 1`.
2. **Wire** `trust trust sync`.
3. **Manual test:** Issue events, run sync, verify DB populated.

### Step 3.3: Trust resolve command

1. **Implement** `resolveTrustCommand(target: string, options)`:
   - Resolve target via `resolveTargetForQuery` to canonical identity id.
   - Ensure identity exists in `identities` (or create on first ref). Call `queryTrustBySubject(identityId, context)`.
   - Aggregate via `aggregateByTarget`.
   - Format output (counts, optional list).
2. **Options:** `-c, --context`, `--json`.
3. **Wire** `trust trust resolve <target>`.
4. **Manual test:** Sync, then resolve by npub.

### Step 3.4: Trust query command

1. **Implement** `queryTrustCommand(target: string, options)`:
   - Resolve target.
   - Build relay filter: `{ kinds: [32010], '#p'|'#e'|...: [value] }`.
   - Call `queryEvents`.
   - Run `resolveLatestWins`, then `aggregateByTarget`.
   - Format output.
2. **Wire** `trust trust query <target>`.
3. **Manual test:** Query by npub, compare with resolve after sync.

### Step 3.5: Trust show command

1. **Implement** `showTrustCommand(eventRef: string, options)`:
   - Resolve event id from note1/nevent1/hex.
   - Try local DB first (`raw_events` by id).
   - Fallback: `queryEventById` from relays.
   - Pretty-print event.
2. **Wire** `trust trust show <event-ref>`.

### Step 3.6: Polish

1. Add `--json` to issue, sync, show.
2. Add `closeTrustDb()` to CLI exit path when trust commands run.
3. Update README with `trust trust` usage.
4. Add integration/e2e tests.

### Step 3.7: Extended resolve formats

1. **Add** `--format <name>` option to the resolve command. Values: `number`, `default`, `path`.
2. **Add** `--json` to resolve; when set, output is JSON (structure depends on format).
3. **Format behaviors:**
   - **number:** Output a single integer: `trust - distrust`. Fast to parse (e.g. for scripts). With `--json`: `{ "value": number }`.
   - **default:** Output the current information level: trust, neutral, distrust counts, degree, connected. With `--json`: `{ "trust", "neutral", "distrust", "degree", "connected", "target", "author", ... }`.
   - **path:** Output the same as default, plus information about all paths from author to subject. Implement path enumeration: find all paths (author → … → subject) up to max depth. With `--json`: include a `paths` array, each path as a sequence of identity IDs or edges.
4. **Path enumeration:** Traverse the graph from author to subject, collecting all distinct paths. Each path is a list of nodes (identity IDs) or edges (author_id, subject_id, value, context). Limit by strategy max depth.
5. **Wire** in `cli.ts`: `trust resolve <subject> [author] --format number|default|path [--json]`.
6. **Server API:** Extend `POST /resolve` to accept `format?: 'number' | 'default' | 'path'`; return structure matches CLI.
7. **Tests:** Unit tests for each format; verify `number` output is parseable as integer.

### Step 3.8: List command

1. **Purpose:** List one or more raw events from the database or server for client-side analysis. All data from the **raw_events** table only.
2. **File:** `src/lib/trust/trust-repo.ts`
3. **Implement** `listRawEvents(options: ListRawEventsOptions): VerifiedEvent[]` (or return rows; parse `raw_event` JSON when returning events):
   - Options: `ids?` (event ids), `author?` (pubkey), `kind?`, `since?`, `until?`, `subject?` (filter by subject in tags), `context?` (tag `c`), `limit?` (default 100, max 1000).
   - Query only `raw_events`: use indexed columns `pubkey`, `kind`, `created_at` for filters; for `subject`/`context` filter by parsing `tags_json` (JSON in SQL or filter in code).
   - When `ids` is non-empty, `WHERE id IN (...)`; otherwise apply filters. `ORDER BY created_at DESC`, `LIMIT ?`.
4. **File:** `src/commands/list.ts`
5. **Implement** `listTrustCommand(options)`: parse `--from database|server`, `--author`, `--kind`, `--since`, `--until`, `--subject`, `-c/--context`, `-n/--limit`, `--json`, and positional event ids. If `--from server`, call `proxyListEvents` (when implemented); else `initTrustDb()`, `listRawEvents(...)`, output NDJSON or pretty.
6. **Wire** in `cli.ts`: `program.command('list [event-ids...]')` with options above.
7. **Server (later):** Add `GET /events` or `POST /events` in `src/server/api.ts` with same filter params; add `proxyListEvents` in `src/lib/client.ts`.
8. **Tests:** Unit test `listRawEvents` with various filters; integration test list from DB.

---

## Phase 4: Server/Client Architecture

Phase 4 implements the server/client mode, cache-backed DB wiring, and client delegation as described in the design doc (Section 5).

### Step 4.1: Cache update on write

1. **File:** `src/lib/trust/trust-cache.ts`
2. **Add** `addRowToCache(row: ITrustRow): void` – apply a single trust row to `authorCache` and `subjectCache` using the same logic as `loadRowToCache`. Export it.
3. **File:** `src/lib/trust/trust-repo.ts`
4. **Modify** `insertTrustEvent()`: after the DB transaction succeeds, for each trust row inserted, call `addRowToCache(row)`.
5. **Tests:** Insert event via `insertTrustEvent`, assert cache contains the new row(s).

### Step 4.2: Server config

1. **File:** `src/config.ts` (or `config.json` schema)
2. Add `serverPort: 3417` and `serverHost: 'localhost'` to config / `UserConfig`.
3. Allow override via `TRUST_SERVER_PORT`, `TRUST_SERVER_HOST` env vars.

### Step 4.3: Web API

1. **Add dependency:** Express or Fastify (e.g. `fastify`).
2. **Create** `src/server/api.ts`:
   - Create HTTP app (Express/Fastify).
   - `GET /health` or `GET /available` – return 200, `{ status: 'ok' }`.
   - `POST /issue` – accept `{ subjects, context?, value?, content?, relay? }`, call issue logic, publish to relays, insert to DB (which updates cache), return event or result.
   - `POST /resolve` – accept `{ subject, author?, context?, strategy?, maxDepth? }`, run resolve via cache strategy, return JSON result.
3. **Tests:** Unit or integration test for each endpoint.

### Step 4.4: Relay subscription

1. **Create** `src/server/relay-sub.ts`:
   - `startRelaySubscription(relays: string[], since: number | undefined, onEvent: (event: VerifiedEvent) => void): () => void` – subscribe to kind 32010 on relays with `since`, call `onEvent` for each new event. Return cleanup function.
   - Use NPool or equivalent with `sub()` / subscription API for continuous listen.
2. **Logic:** `onEvent` → `insertTrustEvent(event)` (which writes to DB and updates cache via Step 4.1), then `trackLatestTimestamp([event])` to update `last_seen`.

### Step 4.5: Server command

1. **Create** `src/commands/server.ts`:
   - `serverCommand(options: { port?, host?, relay?, since?, json? })`.
   - Init trust DB, call `loadTrustCache()`.
   - **Before** starting the relay subscription: if `--since` is provided, set `latest` to that value; otherwise, automatically roll the timestamp forward (promote `last_seen + 1` → `latest` when `last_seen` is set). See Phase 5 Step 5.0.
   - Start relay subscription via `startRelaySubscription` with `since: getLatestTimestamp()`.
   - Start Web API on `host:port`.
   - Handle shutdown (close pool, close DB).
2. **Wire** in `cli.ts`: `program.command('server')` with options `-p, --port`, `-h, --host`, `-r, --relay`, `--since <unix-ts>`, `--json`.
3. **Manual test:** `trust server -p 3417`, then `curl http://localhost:3417/health`.
4. **CLI ping command:** Add a `trust ping` command that calls the server `/health` endpoint to check if the server is running.

### Step 4.6: Client wrapper

1. **Create** `src/lib/client.ts`:
   - `isServerAvailable(baseUrl?: string): Promise<boolean>` – GET `baseUrl/health`, return true on 200.
   - `proxyIssue(baseUrl: string, params): Promise<...>` – POST `/issue`, return result.
   - `proxyResolve(baseUrl: string, params): Promise<...>` – POST `/resolve`, return result.
   - Default `baseUrl` from config (e.g. `http://localhost:3417`).
2. **Tests:** Unit test with mocked HTTP or test server.

### Step 4.7: Client-aware issue and resolve

1. **File:** `src/commands/issue.ts` (or equivalent)
2. **Modify** `issueTrustCommand`: at start, call `isServerAvailable()`. If true, call `proxyIssue()` and return. Else run existing local logic.
3. **File:** `src/commands/resolve.ts`
4. **Modify** `resolveTrustCommand`: at start, call `isServerAvailable()`. If true, call `proxyResolve()` and return. Else run existing local logic; before resolve, call `loadTrustCache()` if using cache strategy.
5. **Manual test:** Start `trust server`, run `trust issue ...` and `trust resolve ...` – should hit server. Stop server, run again – should run locally.

### Step 4.8: Polish

1. Add `serverPort`, `serverHost` to README and config docs.
2. Document `trust server` usage and API endpoints.
3. Integration test: server up → client proxies; server down → client runs locally.

---

## Phase 5: Relay Sync & Graph Cache Strategies

### Step 5.0: Sync timestamp management

When synchronizing with relays, we need a timestamp from where to begin so we do not resync old events. This integrates with the existing timestamp functionality in `src/lib/timestamp.ts` and `src/commands/timestamp.ts`.

1. **Storage:** Use the existing key-value table and timestamp API: `getLatestTimestamp()` / `setLatestTimestamp()` (sync start point) and `getLastSeenTimestamp()` / `updateLastSeenTimestamp()` (auto-tracked from events). See Phase 1.5 and `trust-db.ts` KV keys.
2. **Server startup – automatic rollforward:** When the server runs, **before** starting the relay subscription, automatically roll the timestamp forward: if `last_seen` is set, promote it to `latest` (e.g. `latest = last_seen + 1`). This ensures the subscription starts from the most recent processed point without requiring a manual `trust timestamp --rollforward`.
3. **Subscription behavior:** Read `getLatestTimestamp()` as the `since` value for the relay subscription. After processing each event (or batch), call `trackLatestTimestamp(events)` to update `last_seen` from `max(created_at)`.
4. **Validation:** The stored timestamp must never automatically exceed the current time. When advancing `last_seen` from event `created_at`, use `min(created_at, Math.floor(Date.now() / 1000))` so a malformed or future-dated event cannot push the cursor into the future.
5. **CLI override:** Use `trust timestamp --set <unix-ts>` to overwrite `latest` manually. Add `--since <unix-ts>` (or equivalent) to `trust trust sync` and `trust server` so callers can override the stored value for that run; if provided, it overwrites `latest` in the database for the next subscription run.



## Checklist

| Phase | Step | Task |
|-------|------|------|
| 1 | 1.1 | Add trust config (PATHS, KV_KEYS) |
| 1 | 1.2 | Trust DB module, schema |
| 1 | 1.3 | Trust repo – insert |
| 1 | 1.4 | Trust repo – query by subject |
| 1 | 1.5 | Sync cursor |
| 2 | 2.1 | Subject parsing |
| 2 | 2.2 | Trust event builder |
| 2 | 2.3 | Reputation aggregation |
| 2 | 2.4 | Target resolution |
| 3 | 3.1 | Trust issue command |
| 3 | 3.2 | Trust sync command |
| 3 | 3.3 | Trust resolve command |
| 3 | 3.4 | Trust query command |
| 3 | 3.5 | Trust show command |
| 3 | 3.6 | Polish, README, tests |
| 3 | 3.7 | Extended resolve formats (number, default, path, --json) |
| 3 | 3.8 | List command (listRawEvents, list CLI, --from/--author/--kind/--since/--until/--subject/--context/--limit, --json) |
| 4 | 4.1 | Cache update on write (addRowToCache, trust-repo wiring) |
| 4 | 4.2 | Server config (port, host) |
| 4 | 4.3 | Web API (health, issue, resolve) |
| 4 | 4.4 | Relay subscription |
| 4 | 4.5 | Server command (trust server) |
| 4 | 4.6 | Client wrapper (isServerAvailable, proxyIssue, proxyResolve) |
| 4 | 4.7 | Client-aware issue and resolve |
| 4 | 4.8 | Polish, README, integration tests |
| 5 | 5.0 | Sync timestamp management (KV storage, validation, CLI override) |
| 5 | 5.1 | Strategy configuration (config + CLI) |
| 5 | 5.2 | Relay subscription strategy interface and defaults |
| 5 | 5.3 | Wire sync strategy selection into server command |
| 5 | 5.4 | Cache load strategies (load_all vs graph_limited) |
| 5 | 5.5 | Large-memory handling and auto-fallback (auto strategy) |
| 5 | 5.6 | Keep graph-limited cache up to date on new trust events |
| 5 | 5.7 | Tests and documentation for strategies |

---

## Phase 6: SQLite Event Store and Graph (Current Implementation)

### Step 6.1: SQLite Event Store

1. **Add dependency:** `better-sqlite3` package.
2. **Create** `src/lib/trust/trust-sqlite.ts`:
   - `openTrustDb()`, `closeTrustDb()`
   - **Events table:** `id`, `author`, `d_tag`, `context`, `kind`, `created_at`, `raw_event`
   - **KV table:** sync cursor and timestamps
   - `putEvent(event)`, `putEvents(events[])` – bulk write
   - `getEvent(id)`, `iterateAllEvents(kind?)`, `iterateEventsByAuthor(pubkey, kind?)` – bulk read
   - `kvGet`, `kvSet`, `kvDelete` for sync cursor and timestamps
3. **Update** `src/config.ts`: Add `trustDb` to PATHS.

### Step 6.2: Graph Model

1. **Create** `src/lib/trust/graph/`:
   - `Edge.ts` – `id`, `value`, `createdAt` (no author/subject/context – implied by position)
   - `Node.ts` – `id`, `outgoing`, `incoming` (Map<context, Map<subjectType, Map<neighborId, Edge[]>>>)
   - `Graph.ts` – `nodes`, `getOrCreateNode(id)`
   - `graphBuilder.ts` – `applyEventToGraph(graph, event)` parses NIP-32010, creates nodes/edges
   - `index.ts` – exports

### Step 6.3: Trust DB Facade

1. **Create** `src/lib/trust/trust-db.ts`:
   - Wrap `trust-sqlite`
   - `initTrustDb()` → `openTrustDb()`
   - `closeTrustDb()` → `closeTrustDb()`
   - `getLatestTimestamp`, `setLatestTimestamp`, etc. → async, use `kvGet`/`kvSet`

### Step 6.4: Trust Repository

1. **Create** `src/lib/trust/trust-repo.ts`:
   - `insertTrustEvent(event)` → async, `putEvent(event)` + `applyEventToGraph(graph, event)`
   - `queryTrustByAuthor`, `queryTrustBySubject` → read from graph (not DB)
   - `getRawEventById` → `getEvent(id)`
   - `listRawEvents` → iterate events from SQLite, filter in memory
   - All queries go through graph or SQLite iteration

### Step 6.5: Trust Cache (Graph)

1. **Create** `src/lib/trust/trust-cache.ts`:
   - Hold `Graph` instance
   - `loadTrustCache()` → iterate SQLite trust events, `applyEventToGraph` for each
   - `getOutgoingTrusts(authorId, context?, subjectType?)` → traverse `node.outgoing`, return `Map<subjectId, ITrustRow>`
   - `getIncomingTrusts(subjectId, context?, subjectType?)` → traverse `node.incoming`
   - `addRowToCache` / `addEventToCache` → `applyEventToGraph` (for write-through)
   - Optional: `saveGraphCache()` – serialize graph to msgpackr file

### Step 6.6: Update Consumers

1. **Async migration:** All `initTrustDb`, `closeTrustDb`, `insertTrustEvent`, `loadTrustCache`, `getLatestTimestamp`, etc. are async. Update:
   - `cli.ts` – `await closeTrustDb()`
   - `commands/sync.ts`, `resolve.ts`, `list.ts`, `show.ts`, `server.ts`, `init.ts`, `timestamp.ts` – await all DB/cache calls
   - `lib/timestamp.ts` – `resolveTimestampParam`, `trackLatestTimestamp`, `rollForwardTimestamp` → async
   - `server/relay-sub.ts` – `onEvent` callback async, `await insertTrustEvent`, `await trackLatestTimestamp`
2. **Resolvers:** `cacheStrategy`, `pathStrategy` – use `getOutgoingTrusts`/`getIncomingTrusts` (unchanged API).
3. **Scripts:** `seed-trust-network.ts`, `verify-trust-graph.ts` – await `initTrustDb`, `insertTrustEvent`, `loadTrustCache`, `closeTrustDb`.
