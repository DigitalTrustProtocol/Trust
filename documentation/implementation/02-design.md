# NIP-32010 Design Document

This document defines the design in order: **Database first** (data structures), then **business layers** (logic built on the DB), then **commands** (CLI surface).

---

## 1. Database Design

The database holds raw Nostr events from relay sync. The trust graph is built in memory and saved/loaded by other means (graph cache file).

### 1.1 Design Principles

- **Raw event storage** – Store complete Nostr events for sync, re-broadcast, and audit.
- **Single table** – events only. No derived tables (identities, refs, trust).
- **Indexed columns** – author, d_tag, context, kind for fast queries.

### 1.2 Events Table

Stores full events as received from relays. Used for sync, re-publish, and integrity.

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- event id (hex, 64 chars)
  author TEXT NOT NULL,             -- author pubkey (hex)
  d_tag TEXT,                       -- d tag (for kind 32010)
  context TEXT NOT NULL,            -- c tag (context)
  kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  raw_event TEXT NOT NULL           -- full JSON event
);

CREATE INDEX idx_events_author ON events(author);
CREATE INDEX idx_events_author_kind ON events(author, kind);
```

### 1.3 KV Table

Stored in the same database (`trust.db`). Keys: `trust_sync_since`, `latest_timestamp`, `last_seen_timestamp`. See Section 6.2 for full schema.

**Note:** Legacy tables (identities, refs, trust) are no longer used. The current implementation uses a single `events` table.

### 1.4 References Table (Incoming) [DEPRECATED]

All references from events to identities. When an event mentions a subject in its tags, that is an incoming reference to the corresponding identity. “”
```sql
CREATE TABLE refs (
  event_id TEXT NOT NULL,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  event_kind INTEGER NOT NULL,       -- Nostr event kind (e.g. 32010, 0) for filtering by event type
  PRIMARY KEY (event_id, identity_id, event_kind)
);

CREATE INDEX idx_refs_event_kind ON refs(event_kind);

CREATE INDEX idx_refs_identity ON refs(identity_id);
CREATE INDEX idx_refs_event ON refs(event_id);
```


### 1.5 Trust Table (Incoming and Outgoing)

Trust edges between identities. Both author and subject reference the identities table. One row per (author, subject, context) with the latest trust value. Query by subject: WHERE subject_id = ?. Query by author: WHERE author_id = ?. Batch events create one row per subject.
```sql
CREATE TABLE trust (
  author_id TEXT NOT NULL REFERENCES identities(id),
  subject_id TEXT NOT NULL REFERENCES identities(id),
  context TEXT NOT NULL,
  value INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (author_id, subject_id, context)
);

CREATE INDEX idx_trust_subject ON trust(subject_id);
CREATE INDEX idx_trust_author ON trust(author_id);
CREATE INDEX idx_trust_context ON trust(context);
```

### 1.6 Sync Cursor and KV

Stored in the trust database (`trust.db`) in the `kv` table:

- Key: `trust_sync_since` – unix timestamp; next sync uses `since: value`
- Key: `latest_timestamp` – user-set timestamp (via `trust timestamp`)
- Key: `last_seen_timestamp` – auto-tracked from query results

### 1.7 Database Path

- `~/.trust/trust.db` – single SQLite file for events and KV.

---

## 2. Business Layer

Built on top of the database. No direct CLI I/O here; pure logic and data access.

### 2.1 Subject Module (`src/lib/trust/subject.ts`)

- Parse user input into canonical subject representation.
- Output: `{ tag: 'p'|'e'|'a'|'h'|'r'|'i', value: string, k?: string }`.
- Handles: hex pubkey, npub, event id, note1/nevent1, `a:kind:pubkey:d`, URL, hash, NIP-73 IDs.
- Used by: event building, query target resolution.

### 2.2 Trust Event Builder (`src/lib/trust/trust-event.ts`)

- `computeDTag(subjects, context?)` – per-subject fragments (hex or SHA256), dedupe before XOR, and output `d = <hex(64)>[|context]` (no kind prefix on kind `32010`; use `kinds: [32010]` to query).
- `buildTrustEventTemplate({ subjects, context?, value, content? })` – kind 32010 `EventTemplate`.
- Validation: content ≤ 1024 chars, value ∈ {1, 0, -1}.
- Used by: issue command.

### 2.3 Trust Repository (`src/lib/trust/trust-repo.ts`)

- **Insert:** Given a verified event, upsert `raw_events`, upsert `identities` for author and all subjects, insert `refs` (event_id, identity_id, event_kind), upsert `trust` (author_id → subject_id).
- **Query by subject:** Resolve target to identity id, then read from `trust` where `subject_id = ?` (incoming trust).
- **Query refs:** `queryRefsByIdentity(identityId, eventKind?)` – list events that reference an identity, optionally filtered by `event_kind` (e.g. 32010 for trust only).
- **List raw events:** `listRawEvents(options)` – query **only** the `raw_events` table with optional filters (author/pubkey, kind, since, until, subject and context from tags_json, limit, and optional event ids). Returns raw event rows or parsed events for client-side analysis. No joins to `trust` or `identities`.
- **Latest-wins:** Enforced by `trust` PK; upsert replaces older rows for same (author, subject, context).
- **Sync cursor:** Get/set via KV store.
- Used by: sync command, resolve command, list command.

### 2.4 Trust DB Module (`src/lib/trust/trust-db.ts`)

- `initTrustDb()` – create tables, run migrations.
- `getTrustDb()` – lazy init, return DB handle.
- `closeTrustDb()` – close connection.
- Raw SQL access used by `trust-repo.ts`; higher-level repo encapsulates all trust-specific queries.

### 2.5 Reputation Resolution (`src/lib/trust/reputation.ts`)

- `aggregateByTarget(identityId, context?, options)` – from `trust` where `subject_id = ?`, compute trust/distrust/neutral counts, optionally filter by context.
- `resolveLatestWins(events)` – for relay-only path: given events, apply latest-wins in memory, return canonical map.
- Resolution operates over the identity trust graph stored in `trust`, but only the portion that is available locally based on the chosen relay subscription and cache-loading strategies (subscribe-all vs graph-limited, load-all vs graph-limited).
- Used by: resolve command (DB path), query command (relay path).

---

## 3. Commands (CLI Layer)

Commands call the business layer and handle I/O (relays, stdout, config).

### 3.1 Trust Subcommand Structure

```
trust
├── issue <subject> [subjects...]   -- create & publish kind 32010
├── sync                            -- fetch from relays, write to DB
├── resolve <target>                -- resolve reputation from local DB
├── query <target>                  -- query relays for trust (no local DB)
├── show <event-ref>                -- show single event (relay or local)
├── list [event-id ...]             -- list events from DB or server (raw_events)
└── server                          -- start server mode (Web API + relay subscription)
     -p, --port <port>              -- HTTP port (default: 3417)
     -h, --host <host>              -- bind host (default: localhost)
     -r, --relay <url...>           -- relay URL(s) for subscription
```

### 3.2 Command Responsibilities

| Command | Business Layer Used | I/O |
|---------|---------------------|-----|
| `issue` | `subject`, `trust-event`, `signer` | `relays.publishEvent` |
| `sync` | `trust-repo`, `relays` | `queryEvents`, trust DB |
| `resolve` | `trust-repo`, `reputation` | trust DB, stdout |
| `query` | `subject`, `reputation`, `relays` | `queryEvents`, stdout |
| `show` | `trust-repo` or `relays` | trust DB or `queryEventById`, stdout |
| `list` | `trust-repo` (raw_events only) | trust DB or server API, stdout |
| `server` | `trust-repo`, `trust-cache`, `relays` | Web API, relay subscription |

### 3.3 Options (Common)

- `-r, --relay <url...>` – relay list override.
- `-c, --context <ctx>` – filter by context.
- `--json` – machine-readable output.

### 3.4 List command

**Purpose:** List one or more raw events from the database or server for client-side analysis. All data comes from the **raw_events** table (and server equivalent).

**Command:** `trust list [event-id ...] [options]`

**Source:** `--from <source>` — `database` (default) or `server`. Database reads from local `raw_events`; server calls a list/events API that queries the server’s `raw_events`.

**Filters (all map to raw_events or tags in tags_json):**

| Option | Maps to | Description |
|--------|---------|-------------|
| `--author` | `raw_events.pubkey` | Author pubkey (hex or npub). |
| `--kind` | `raw_events.kind` | Event kind (e.g. 32010). |
| `--since` | `raw_events.created_at` | Min created_at (unix). |
| `--until` | `raw_events.created_at` | Max created_at (unix). |
| `--subject` | Tags in `tags_json` (e.g. `p`) | Events that have this subject in tags. |
| `-c, --context` | Tag `c` in `tags_json` | Trust context (e.g. dev, commerce). |
| `-n, --limit` | LIMIT | Max events to return (default 100, cap 1000). |

**Positional:** Optional event ids (hex, note1, nevent1). If provided, list only those events; otherwise list is filter-based.

**Output:** `--json` — NDJSON or single JSON array for machine parsing.

**Implementation:** Repo exposes `listRawEvents(options)`; CLI command and (when implemented) server endpoint and `proxyListEvents` in client use the same parameter set.

### 3.5 File Layout

```
src/
├── cli.ts
├── commands/
│   └── trust.ts           -- trust issue, sync, resolve, query, show, list
└── lib/
    └── trust/
        ├── trust-db.ts    -- DB init, close
        ├── trust-repo.ts  -- insert, query, sync cursor
        ├── trust-event.ts -- build kind 32010 template
        ├── subject.ts     -- parse subject strings
        └── reputation.ts  -- aggregate, latest-wins
```

---

## 4. Data Flow Summary

```
                    ┌──────────────────────────────────────┐
                    │            Commands                   │
                    │  issue | sync | resolve | query | show | list │
                    └────────────────────┬─────────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
         ▼                               ▼                               ▼
┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
│ trust-event     │            │ trust-repo      │            │ reputation      │
│ subject         │            │ (uses trust-db) │            │                 │
└────────┬────────┘            └────────┬────────┘            └────────┬────────┘
         │                              │                              │
         │                              ▼                              │
         │                     ┌─────────────────┐                     │
         │                     │   trust.db      │                     │
         │                     │ raw_events      │                     │
         │                     │ identities      │◄────────────────────┘
         │                     │ refs            │
         │                     │ trust           │
         │                     └─────────────────┘
         │
         ▼
┌─────────────────┐
│ relays / signer │
└─────────────────┘
```

---

## 5. Phase 2: Server/Client Architecture

Phase 2 adds a cache-backed DB layer, server mode (Web API + continuous relay sync), and client mode that can delegate to the server or run locally.

### 5.1 Cache-Backed DB Layer

**Principle:** When the application is running, all searches (resolve, query paths) go against the in-memory cache. Reads and writes go to the database and update the cache.

**Existing cache** (`src/lib/trust/trust-cache.ts`): `authorCache`, `subjectCache`, `loadTrustCache()`, `getIncomingTrusts()`, `getOutgoingTrusts()`. The public API stays minimal; internal behavior is driven by a configurable cache loading strategy.

**Wiring (new code):**

- **Trust repository:** After `insertTrustEvent()` writes to the DB, call a cache-update helper that applies the same row(s) to `authorCache` and `subjectCache` using the same logic as `loadRowToCache` (or invoke a new exported `addRowToCache(row)` if added to trust-cache).
- **Resolve/query commands:** Use the cache strategy by default when the app is running. Ensure `loadTrustCache()` is called at startup (server mode) or before the first resolve (client local mode).
- **Data flow:** DB write → `insertTrustEvent` → DB transaction → (on success) update cache with new trust row(s).

#### 5.1.1 Cache load strategies

The cache layer supports two strategies that trade off warm-up time, memory usage, and flexibility of the resolve algorithm:

- **Load-all cache (default for small datasets):**
  - `loadTrustCache()` reads all trust rows from `trust.db` into `authorCache`/`subjectCache`.
  - Best for small and medium-sized deployments where memory is not a bottleneck and fast start-up is important.
  - Simplifies resolve logic, because the entire locally-synced trust graph is available in memory.

- **Graph-limited cache (for large graphs):**
  - `loadTrustCache()` (or an internal helper it calls) limits the dataset to trust edges that are on, or adjacent to, the client's current web-of-trust graph.
  - The graph frontier (root identities, max depth, contexts) is derived from configuration and/or the user's trusted identities.
  - Reduces peak memory usage and cache size for very large global datasets, at the cost of slower initial loading and more frequent DB reads when the graph changes.

Strategy selection is runtime-configurable (e.g. via config or CLI flags) so that operators can switch between load-all and graph-limited behavior without changing the database schema.

### 5.2 Server Mode

**Purpose:** Long-lived process with a warm cache and continuous sync with relays. Resolve requests are fast and reflect live data.

**Components:**

| Component | Responsibility |
|-----------|----------------|
| Web API | HTTP server (e.g. Express or Fastify) on localhost for submitting events and resolves |
| Relay subscription | WebSocket connections to relay servers; subscribe to trust-related events using a pluggable subscription strategy (subscribe-all vs graph-based authors) |
| Startup | Load DB into cache via `loadTrustCache()`, then open relay subscriptions |
| On event | For each new kind 32010 event: `insertTrustEvent(event)` (writes to DB and updates cache) |

**Web API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` or `/available` | Server availability check (used by client mode) |
| POST | `/issue` | Submit new trust event (equivalent to `trust issue`) |
| POST | `/resolve` | Resolve trust path and reputation (equivalent to `trust resolve`) |
| GET or POST | `/events` | List raw events (equivalent to `trust list`; queries server’s raw_events) |

**CLI command:** `trust server` – starts the Web API and relay subscription.

**Server options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <port>` | HTTP port for the Web API | 3417 |
| `-h, --host <host>` | Bind host (e.g. `localhost`, `0.0.0.0`) | `localhost` |
| `-r, --relay <url...>` | Relay URL(s) for websocket subscription | from config |
| `--json` | Output startup info as JSON | — |

**Config fallback:** If options are not given, use `serverPort` and `serverHost` from config (e.g. `~/.trust/config.json`).

**File layout addition:**

```
src/
├── server/
│   ├── api.ts          -- Express/Fastify app, routes
│   ├── relay-sub.ts    -- relay subscription, on-event → insertTrustEvent
│   └── index.ts        -- start server, loadTrustCache, start relay sub
```

#### 5.2.1 Relay subscription strategies

The relay subscription layer is responsible for deciding **which events** to request from relays. It supports at least two strategies:

- **Subscribe-all (filter on server side):**
  - Open subscriptions that match all relevant trust-related kinds (initially kind `32010`; later extended to additional sync kinds from NIP-32011 and NIP-32012).
  - Do not restrict `authors` or other filters beyond what is required for the protocol.
  - Let the server apply filtering based on its local trust graph and query context.
  - Pros: simple, complete for the kinds subscribed; cons: can be very heavy on busy relays and for very large global datasets.

- **Graph-based authors (trusted npubs only):**
  - Derive a set of npub hex pubkeys from the current trust graph (e.g. identities with positive trust, or within a configured depth from the root).
  - Create subscriptions that include an `authors` filter for this set, optionally chunked into multiple subscriptions if relay limits require it.
  - This dramatically reduces network and processing overhead by ignoring events from authors outside the client's current web-of-trust.
  - Pros: efficient for large graphs where only a subset of authors are relevant; cons: can miss new authors that are not yet in the graph until the graph is updated.

The active subscription strategy is **runtime-selectable** (e.g. via `trust server` options or config). This allows operators to quickly switch between subscribe-all and graph-based behavior if one strategy proves problematic with a specific relay or dataset.

### 5.3 Client Mode

**Principle:** Same app runs as CLI. Before executing issue or resolve, check if the server is available.

**Flow:**

1. **Check server:** `GET http://localhost:3417/health` (or `/available`).
2. **If available:** Proxy the command to the server via HTTP (POST `/issue` or POST `/resolve`).
3. **If not available:** Run the command locally.
4. **Local resolve:** Call `loadTrustCache()` before any resolve request so the cache is populated from the DB.

**Implementation:** Add a thin client wrapper (e.g. `src/lib/client.ts`) that:
- `isServerAvailable(baseUrl?: string): Promise<boolean>`
- `proxyIssue(...)`, `proxyResolve(...)` – HTTP calls to the server
- `proxyListEvents(...)` – HTTP call to list events (when server exposes `/events`)

Commands (issue, resolve) call this wrapper first; on success, return the HTTP response; on failure, fall back to existing local logic.

### 5.4 Phase 2 Data Flow

```
                    ┌─────────────────────────────────────────────────────┐
                    │                  Server Mode                         │
                    │  Web API (issue, resolve)  |  Relay Subscription     │
                    └────────────────────────────┬────────────────────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────────┐
                    │                            ▼                        │
                    │  insertTrustEvent ──► DB ──► Cache (write-through)  │
                    │       ▲                     ▲                        │
                    │       │                     │                        │
                    │  Relay events          loadTrustCache() at startup   │
                    └─────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────────────┐
                    │                  Client Mode                         │
                    │  CLI (issue | resolve)                               │
                    └────────────────────────────┬────────────────────────┘
                                                 │
                    ┌────────────────────────────┴────────────────────────┐
                    │  GET /health ──► available?                         │
                    │       │ yes: POST /issue or POST /resolve            │
                    │       │ no:  loadTrustCache() + run locally          │
                    └─────────────────────────────────────────────────────┘
```

### 5.5 File Layout (Phase 2)

```
src/
├── cli.ts
├── commands/
│   └── trust.ts           -- issue, sync, resolve, query, show, list (client-aware)
├── lib/
│   ├── client.ts          -- isServerAvailable, proxyIssue, proxyResolve
│   └── trust/
│       ├── trust-db.ts
│       ├── trust-repo.ts  -- insertTrustEvent + cache update wiring
│       ├── trust-cache.ts -- unchanged
│       ├── trust-event.ts
│       ├── subject.ts
│       └── reputation.ts
└── server/
    ├── api.ts             -- Web API routes
    ├── relay-sub.ts       -- relay WebSocket subscription
    └── index.ts           -- server entrypoint
```

### 5.6 Entrypoints

- **CLI (client mode):** `trust issue`, `trust resolve` — check server, proxy or run locally.
- **CLI (server mode):** `trust server` — start Web API and relay subscription. Options: `-p/--port`, `-h/--host`, `-r/--relay`.

### 5.7 Future sync NIPs (32011, 32012)

NIP-32011 and NIP-32012 introduce additional event kinds that are relevant for synchronization and richer trust-related workflows. The current design and implementation focus on **kind 32010** only, but the following principles ensure that these NIPs can be added later without major redesign:

- The `raw_events` and `refs` tables already record `kind`/`event_kind`, so additional sync-related kinds can be stored alongside 32010 events.
- Relay subscription strategies (subscribe-all vs graph-based authors) are defined in terms of "trust-related kinds", so adding new kinds is a matter of extending the filter sets.
- Cache loading and resolve logic operate over the `trust` table and identity graph; they remain valid regardless of how many event kinds feed into that graph.

Implementation of the concrete event flows and semantics for NIP-32011 and NIP-32012 is **explicitly deferred** until after the efficient resolve algorithm and the subscription/cache strategies described above are in place.

---

## 6. SQLite and In-Memory Graph Architecture (Current Implementation)

The implementation uses **SQLite** for event storage and an **in-memory graph** of Node/Edge objects for fast resolution. This section describes the current design.

### 6.1 Design Principles

- **Database stores only Nostr events** – One table: `events`. Raw events are the source of truth.
- **Indexes for fast lookup** – By author, and by author+kind. Enables bulk read by author for graph building.
- **In-memory graph for resolution** – Querying the DB on every resolve is slow. The graph is built in memory from events.
- **Nodes = authors and subjects** – Edges = trust events. One event can spawn multiple edges (batch trust).
- **Graph cache file** – Optional msgpackr-serialized snapshot for fast startup; new events applied incrementally.

### 6.2 SQLite Schema

Path: `~/.trust/trust.db`

**Events table** – Stores raw events from relay with indexed columns for fast queries:

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  d_tag TEXT,
  context TEXT NOT NULL,
  kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  raw_event TEXT NOT NULL
);
CREATE INDEX idx_events_author ON events(author);
CREATE INDEX idx_events_author_kind ON events(author, kind);
```

**KV table** – Sync cursor and timestamps:

```sql
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Bulk write:** `putEvent(event)` or `putEvents(events[])` – inserts or replaces event row.

**Bulk read:** `iterateAllEvents(kind?)` – stream all events; `iterateEventsByAuthor(pubkey, kind?)` – stream events for author.

### 6.3 In-Memory Graph Model

**Node** – Identity (author or subject):

- `id: string` – hex pubkey or subject identifier
- `outgoing: Map<context, Map<subjectType, Map<neighborId, Edge[]>>>` – outgoing edges grouped by context and npub/items
- `incoming: Map<context, Map<subjectType, Map<neighborId, Edge[]>>>` – incoming edges, same structure

**Edge** – Structural position (author, subject, context, subjectType) is implied by where the edge lives in Node maps. Edge only stores:

- `id: string` – event id
- `value: 1 | 0 | -1`
- `createdAt: number`

**Graph** – `nodes: Map<NodeId, Node>`, `getOrCreateNode(id)`.

### 6.4 Graph Loading Strategies

- **Full load:** Iterate all trust events from LevelDB, apply each to graph via `applyEventToGraph(graph, event)`. Used for testing and small datasets.
- **Graph-limited (future):** BFS from author/subject, load only events for reachable nodes. Reduces memory for large DBs.

### 6.5 Graph Cache File

- Path: `~/.trust/graph-cache.bin`
- Format: msgpackr-serialized `{ nodes, edges }` with compact representation.
- **Startup:** Load from cache if present; else load from LevelDB.
- **New events:** Apply to graph immediately; optionally add to pending list until cache is saved.
- **Periodic save:** Serialize graph to file at interval. DB and graph stay synchronized.

### 6.6 File Layout (Current)

```
src/lib/trust/
├── trust-db.ts        -- init, close, KV (wraps trust-sqlite)
├── trust-sqlite.ts    -- SQLite open, putEvent, getEvent, iterate*, kv*
├── trust-repo.ts      -- insertTrustEvent, queryTrustBy*, listRawEvents (uses graph + SQLite)
├── trust-cache.ts     -- Graph, loadTrustCache, getOutgoingTrusts, getIncomingTrusts
├── graph/
│   ├── Edge.ts
│   ├── Node.ts
│   ├── Graph.ts
│   ├── graphBuilder.ts  -- applyEventToGraph
│   └── index.ts
└── ...
```

### 6.7 Data Flow (Current)

```
                    ┌──────────────────────────────────────┐
                    │            Commands / Server           │
                    └────────────────────┬─────────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
         ▼                               ▼                               ▼
┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
│ trust-repo      │            │ trust-cache      │            │ trust-sqlite     │
│ insertTrustEvent│            │ (Graph)          │            │ (SQLite)         │
└────────┬────────┘            └────────┬────────┘            └────────┬────────┘
         │                              │                              │
         │ putEvent + applyEventToGraph │ loadTrustCache()             │
         │──────────────────────────────┼──────────────────────────────┤
         │                              │ iterateAllEvents → graph     │
         │                              │ getOutgoingTrusts           │
         │                              │ getIncomingTrusts            │
         └────────────────────────────┴──────────────────────────────┘
```
