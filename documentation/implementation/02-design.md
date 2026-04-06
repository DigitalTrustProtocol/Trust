# Technical Design

This document describes the data model, algorithms, and internal architecture of the Trust application as currently implemented.

---

## 1. Nostr Event Model (NIP-32010)

Trust assertions are encoded as **kind 32010** Nostr events — parameterized replaceable events with a deterministic `d` tag.

### 1.1 Event Structure

```json
{
  "kind": 32010,
  "pubkey": "<author-hex>",
  "created_at": 1700000000,
  "tags": [
    ["d", "<deterministic-hash>"],
    ["c", "development"],
    ["v", "1"],
    ["p", "<subject-pubkey-hex>"]
  ],
  "content": "Reliable code reviewer",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

### 1.2 Subject Types

A trust event can target multiple subject types in a single event:

| Tag | Type | Example |
|-----|------|---------|
| `p` | Pubkey | `["p", "<64-hex>"]` |
| `e` | Event ID | `["e", "<64-hex>"]` |
| `a` | Addressable event | `["a", "30023:<pubkey>:<d-tag>"]` |
| `h` | Content hash | `["h", "<sha256-hex>"]` |
| `r` | URL | `["r", "https://example.com/article"]` |
| `i` | External ID (NIP-73) | `["i", "isbn:978-0-123456-47-2"]` with optional `["k", "isbn"]` |

### 1.3 D-Tag Derivation

The `d` tag is deterministically computed from subjects to enforce replaceable semantics (one assertion per author per subject combination per context):

1. For each subject tag, compute a **fragment**: if the value is already 64 hex chars, use it directly; otherwise SHA-256 hash the canonical value.
2. Deduplicate identical fragments.
3. If one unique fragment remains, that is the d-tag base. If multiple, XOR the 32-byte decoded values and hex-encode.
4. If a context is present, append `|<context>` to the base.

Result: `d = <hex64>[|context]`

### 1.4 Trust Values

| Value | Meaning |
|-------|---------|
| `1` | Trust |
| `0` | Neutral (revoke previous trust/distrust) |
| `-1` | Distrust |

A value of `0` removes the edge from the graph (neutral = no assertion).

---

## 2. Database Layer

The database stores raw Nostr events as the source of truth. The in-memory graph is a derived, disposable structure rebuilt from the database on startup.

### 2.1 Database Drivers

Two drivers are supported, sharing the same interface (`Store = NSQLite | NPostgres`):

| Driver | Backend | Use Case |
|--------|---------|----------|
| `NSQLite` | better-sqlite3 + Kysely | Single-node, CLI, development |
| `NPostgres` | pg + Kysely | Multi-instance, enterprise |

Driver selection: Postgres is used when `DATABASE_URL`, `PGHOST`, or `config.db.driver = "postgres"` is set. Otherwise SQLite.

### 2.2 Schema

**Events table** (`nostr_events`): Stores complete Nostr events with denormalized columns for fast queries.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | Event ID (hex) |
| `kind` | INTEGER | Event kind (32010, 0, 5, etc.) |
| `pubkey` | TEXT | Author pubkey (hex) |
| `content` | TEXT | Event content |
| `created_at` | INTEGER | Unix timestamp |
| `tags` | TEXT/JSONB | Full tag array |
| `sig` | TEXT | Event signature |
| `d` | TEXT | Denormalized d-tag for fast parameterized lookups |
| `c` | TEXT | Denormalized context tag |
| `t` | TEXT | Denormalized type tag |
| `raw_event` | BLOB/TEXT | msgpack (SQLite) or JSON (Postgres) of the full event |
| `search_text` | TEXT | Searchable text (for NIP-50 style queries) |

**Tags table** (`nostr_tags` / `tags_index`): Normalized tag index for relay-style `#<tag>` queries.

**KV table** (`kv`): Key-value store for sync cursors and metadata.

| Key | Purpose |
|-----|---------|
| `sync:<ns>:latest` | Sync start point (unix timestamp) |
| `sync:<ns>:last_seen` | Auto-tracked max created_at from processed events |

**Graph notify table** (`trust_graph_notify`): Queue for cross-process graph synchronization.

| Column | Type | Purpose |
|--------|------|---------|
| `seq` | INTEGER PK AUTO | Sequence number |
| `event_id` | TEXT | The event that was inserted or deleted |
| `op` | TEXT | `INSERT` or `DELETE` |
| `raw_event` | BLOB/TEXT | Event data (for DELETE operations, since the event is gone from the events table) |

Populated by database triggers on `nostr_events` insert/delete. Consumed by the API plugin's `drainGraphNotifyBatch()`.

### 2.3 Replaceable Event Semantics

Kind 32010 events are **parameterized replaceable** (NIP-01): for a given `(pubkey, kind, d-tag)` triple, only the event with the highest `created_at` is retained. The database enforces this on insert — older events for the same triple are replaced.

Kind 5 (deletion) events trigger removal of the referenced event from the database and graph.

---

## 3. In-Memory Graph

The trust graph is an in-memory directed graph optimized for fast BFS traversal.

### 3.1 Data Structures

**Graph** (`src/lib/trust/graph/Graph.ts`):
- `nodes: Map<string, Node>` — All vertices (authors and subjects)
- `edges: Map<string, EdgeT1>` — All edges keyed by `<authorPubkey>:<d_tag>`
- Context interning for memory-efficient indexing
- Optional msgpack cache file (`~/.trust/graph-cache.bin`) for fast startup

**Node** (`src/lib/trust/graph/Node.ts`):
- `id: string` — Hex pubkey or subject identifier
- `type: SubjectType` — `'p'`, `'e'`, `'a'`, `'h'`, `'r'`, `'i'`
- `identity?: Identity` — NIP-01 profile metadata (name, about, picture, etc.)
- `outgoing: EdgeMap` — Edges from this node (trust assertions made by this identity)
- `incoming: EdgeMap` — Edges to this node (trust assertions targeting this identity)

**EdgeT1** (`src/lib/trust/graph/Edge.ts`):
- `id: string` — Source event ID
- `value: 1 | 0 | -1` — Trust value
- `context: string` — Context tag value (empty string for no context)
- `createdAt: number` — Event timestamp
- `activate?: number` — Optional activation time (`x` tag from NIP-32010)
- `expire?: number` — Optional expiration time (`y` tag from NIP-32010)
- References to author `Node` and subject `Node`

**EdgeMap** (`src/lib/trust/graph/EdgeMap.ts`):
Nested map structure for efficient context-aware traversal:
```
EdgeMap → Map<EdgeKindKey, Map<context, Map<subjectId, IEdge>>>
```
Where `EdgeKindKey` combines event kind and subject type (e.g., `32010:p` for pubkey trust).

### 3.2 Graph Operations

**applyTrustEvent(event)**: Parse subjects from the event, create/update nodes and edges. If the event is newer than the existing edge for the same `(author, d-tag)`, replace it. If value is `0`, remove the edge (neutral = retracted assertion).

**removeTrustEvent(event)**: Remove the edge and clean up node references. Used when processing kind 5 deletions or graph notify DELETE operations.

**trustedSubjects(author, context?)**: Walk outgoing edges from an author node, return pubkey subjects with positive trust. Used by graph-sync to discover the next BFS level.

**loadGraph(config)**: Two modes:
- **Full load**: Stream all trust events from the database, apply each to the graph. Used for small datasets and focused deployments.
- **BFS load**: Starting from configured root authors, iteratively load trusted authors up to `maxDepth`. More memory-efficient for large networks.

### 3.3 Graph Cache

The graph can be serialized to `~/.trust/graph-cache.bin` using msgpack for fast startup. On subsequent starts, the cache is loaded first, then new events since the cache was saved are applied incrementally from the database.

---

## 4. Trust Resolution

The resolver answers the question: **"From author A's perspective, is subject S trusted in context C?"**

### 4.1 Standard Resolver (BFS)

The default resolver (`standardResolver` in `src/lib/trust/resolvers/trustResolver.ts`) performs bounded breadth-first search:

```
Input:  author (pubkey), subject (any identity), options
Output: Score { trustValue, trust, distrust, neutral, count, degree, connected, path? }
```

**Algorithm:**

1. **Seed**: Author starts with `trustValue = 1` (self-trust), `degree = 0`.
2. **Self-check**: If `author === subject`, return immediately with score.
3. **Precompute**: Build a map of incoming edges to the subject, valid at current time.
4. **BFS loop** (up to `maxDepth`, hard cap = 4):
   - For each node at current level:
     - Check if it has a direct edge to the subject → if yes, accumulate score.
     - Expand outgoing trust edges (context-specific + empty context as fallback).
     - Apply `followTrustThreshold` filter — only traverse nodes with sufficient accumulated trust.
   - If `stopWhenFound` and subject is found, stop.
5. **Path**: If `format === 'path'`, construct the trust path using `pathStrategy`.

### 4.2 Context Semantics in Resolution

| Query context | Edges included |
|---------------|----------------|
| `undefined` | All edges (no filter) |
| `""` (empty) | Only edges with empty context |
| `"dev"` | Edges with context `"dev"` **or** empty context (empty = general, applies everywhere) |

### 4.3 Score Model

Each reached node accumulates a `Score`:

```typescript
interface IScore {
  degree: number;      // Hop count from author
  count: number;       // Number of paths reaching this node
  trustValue: number;  // Sum of edge values along paths
  trust: number;       // Count of positive (1) edges
  neutral: number;     // Count of neutral (0) edges
  distrust: number;    // Count of negative (-1) edges
  connected: boolean;  // Whether any path reached the subject
  from: Set<string>;   // Predecessor pubkeys (deduplication)
  path?: TrustPath;    // Detailed path trace (when format = 'path')
}
```

### 4.4 Resolution Formats

| Format | Output | Use Case |
|--------|--------|----------|
| `number` | Single integer (`trust - distrust`) | Scripts, AI decision-making |
| `default` | Full score object | General inspection |
| `path` | Score + detailed trust path with per-hop metadata | Explainability, audit |

---

## 5. Server Architecture

### 5.1 Fastify Application

The server (`src/server/app.ts`) composes Fastify with three plugins, selectable via `--service`:

| Plugin | Route | Protocol | Purpose |
|--------|-------|----------|---------|
| `relay` | `/relay` | WebSocket (NIP-01) | Nostr relay facade — accepts REQ/EVENT/CLOSE |
| `relay` | `/relay-info` | HTTP GET | NIP-11 relay information document |
| `api` | `/health`, `/ping` | HTTP GET | Health check |
| `api` | `/trust` | HTTP POST | Create and publish trust events |
| `api` | `/resolve` | HTTP POST | Resolve trust from the graph |
| `web` | `/*` | HTTP GET | Static SPA files from `dist/web/` |

### 5.2 Service Modes

| `--service` | Plugins loaded | Typical use |
|-------------|----------------|-------------|
| `all` (default) | relay + api + web | Single-instance deployment |
| `relay` | relay only | Dedicated event ingestion |
| `api` | api only | Dedicated query serving |
| `web` | web only | Dedicated SPA hosting |

### 5.3 REST API

**POST /trust**
```json
Request:  { "subjects": ["npub1..."], "value": 1, "contexts": "dev", "content": "..." }
Response: { "event": { ... }, "relays": ["wss://..."] }
```

**POST /resolve**
```json
Request:  { "subject": "npub1...", "authors": "npub1...", "contexts": "dev", "format": "default" }
Response: { "trustValue": 3, "trust": 3, "distrust": 0, "degree": 2, "connected": true, ... }
```

### 5.4 Relay Facade

The WebSocket endpoint at `/relay` implements NIP-01:

- **REQ**: Query the local database, stream matching events, then poll for new events at 1-second intervals.
- **EVENT**: Verify the event, insert into the database, update the graph, fan out to active subscribers.
- **CLOSE**: Terminate a subscription.

This allows any Nostr client to interact with the Trust database as if it were a standard relay.

### 5.5 Graph Synchronization Between Processes

When relay and API run as separate processes:

1. The **relay** process writes events to the shared database. DB triggers insert rows into `trust_graph_notify`.
2. The **API** process calls `drainGraphNotifyBatch()` on a polling interval, reads pending notify rows, and applies INSERT/DELETE operations to its in-memory graph.
3. This keeps the API graph consistent with the database without requiring inter-process communication beyond the shared DB.

---

## 6. Sync Strategies

### 6.1 Graph-Based Sync (Focused)

`runTrustedGraphSync()` in `src/server/graph-sync.ts`:

1. Start from root authors (configured via `authors`).
2. Build relay filters: `{ kinds: [32010, 0], authors: [...chunk], since }`.
3. Fetch events, insert into DB + graph.
4. Discover new trusted pubkeys from the graph (`trustedSubjects`).
5. Repeat up to `maxDepth` levels.
6. Author batches are chunked (`AUTHOR_CHUNK_SIZE`) to respect relay filter limits.
7. Quiet timeout between reads prevents busy-spinning.

### 6.2 Subscribe-All Sync (Broad)

`subscribeToAll()` in `src/server/all-sync.ts`:

1. Create a broad filter: `{ kinds: [32010], since }` with optional context filtering.
2. Subscribe to all configured relays.
3. Insert every received event.
4. Track timestamps for incremental sync.

### 6.3 Strategy Selection

Determined by configuration:

- If `authors` resolves to specific pubkeys → **graph-based sync** (efficient, targeted).
- If `authors` is `All` or omitted with `syncSubscribeAll = true` → **subscribe-all** (complete, broad).

---

## 7. CLI Client Architecture

### 7.1 Server Delegation

Commands that can benefit from a warm cache (`add`, `resolve`) check for a running server first:

```
1. isServerAvailable(baseUrl)  →  GET /ping
2. If available:  proxy to server via HTTP
3. If not:        run locally (load DB, build graph, execute)
```

This is transparent to the user — the same command works whether a server is running or not.

### 7.2 Identity Management

Multiple signing keys are supported:

- **Primary key**: Used for signing trust events and other operations.
- **Additional keys**: Registered in `identity.json`, switchable via `trust identity primary`.
- **Storage**: Private keys in `~/.trust/keys/<pubkey>.key` (mode 0600). Public key list and labels in `~/.trust/identity.json`.

### 7.3 Subject Parsing

The CLI accepts subjects in many formats and normalizes them to Nostr tags:

| Input | Parsed As |
|-------|-----------|
| 64 hex chars | Pubkey (`p` tag) |
| `npub1...` | Pubkey (`p` tag, decoded) |
| `note1...` / `nevent1...` | Event ID (`e` tag, decoded) |
| `naddr1...` | Addressable event (`a` tag, decoded) |
| `http://...` / `https://...` | URL (`r` tag) |
| `isbn:...`, `doi:...`, etc. | NIP-73 external ID (`i` tag + `k` tag) |
| 64 hex (ambiguous) | Resolved by prefix or context |

---

## 8. Timestamp and Incremental Sync

Sync cursors are stored in the KV table under namespaced keys:

- **`latest`**: The timestamp from which the next sync starts. Set explicitly by the user or rolled forward from `last_seen`.
- **`last_seen`**: The maximum `created_at` value from processed events. Updated automatically during sync.

**Rollforward**: Before starting a subscription, `last_seen + 1` is promoted to `latest` so the sync resumes from where it left off. This is automatic on server startup.

**Safety**: The stored timestamp is clamped to `min(event.created_at, now)` to prevent future-dated events from advancing the cursor past the current time.

---

## 9. References

- [System Architecture](01-overview.md) — Module map and deployment modes
- [Implementation Status & Roadmap](03-roadmap.md) — Completion status
- [Resolve Algorithm](../resolve.md) — Detailed BFS and context semantics
- [NIP-32010](../nips/NIP-32010.md) — Trust event specification
