# System Architecture

This document describes the architecture of the Trust application as implemented. Trust is a single npm package (`@dtp/trust`) that serves as CLI client, HTTP server, Nostr relay facade, and web dashboard — one app for all deployment modes.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     @dtp/trust (Node.js)                        │
│                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌────────────┐  │
│  │    CLI     │  │   HTTP     │  │  Relay   │  │    Web     │  │
│  │  Commands  │  │   API      │  │  Facade  │  │    SPA     │  │
│  │ (Commander)│  │ (Fastify)  │  │ (WS/NIP) │  │  (React)   │  │
│  └─────┬──────┘  └─────┬──────┘  └────┬─────┘  └─────┬──────┘  │
│        │               │              │               │         │
│        └───────────────┬┴──────────────┘               │         │
│                        │                               │         │
│              ┌─────────┴─────────┐                     │         │
│              │  RuntimeContext    │                     │         │
│              │  (config + graph  │                     │         │
│              │   + store + pool) │                     │         │
│              └─────────┬─────────┘                     │         │
│                        │                               │         │
│         ┌──────────────┼──────────────┐                │         │
│         │              │              │                │         │
│   ┌─────┴─────┐ ┌──────┴─────┐ ┌─────┴──────┐        │         │
│   │ In-Memory │ │  Database  │ │ Relay Pool │        │         │
│   │   Graph   │ │  (Store)   │ │  (NPool)   │        │         │
│   │ Node/Edge │ │SQLite / PG │ │ NRelay1    │        │         │
│   └───────────┘ └────────────┘ └────────────┘        │         │
│                                                       │         │
└───────────────────────────────────────────────────────┘         │
                         │                                        │
                  Nostr Relay Network                              │
                                                    Built with Vite
```

---

## 2. Entry Points

The application has a single binary (`trust`) and two build outputs:

| Entry | Path | Purpose |
|-------|------|---------|
| CLI binary | `src/index.ts` → `dist/index.js` | `#!/usr/bin/env node`, loads dotenv, runs Commander |
| Web SPA | `web/src/main.tsx` → `dist/web/` | React app built by Vite, served by the server |

The CLI binary handles all modes: client commands run directly, `trust server` starts the long-lived Fastify process.

---

## 3. Module Map

### 3.1 Source Structure

```
src/
├── index.ts                    # CLI entry (shebang, dotenv, program.parse)
├── cli.ts                      # Commander program: all commands and options
├── sdk.ts                      # Programmatic SDK (import { resolve, add } from '@dtp/trust')
├── mcp.ts                      # MCP server entry (stdio transport)
├── mcp-server.ts               # MCP tool definitions (wraps SDK)
├── config.ts                   # PATHS, UserConfig, resolveConfig, runtime config
│
├── commands/                   # CLI command implementations
│   ├── init.ts                 # trust init — create identity + config + DB
│   ├── whoami.ts               # trust whoami — display identity
│   ├── add.ts                  # trust add — create and publish trust events
│   ├── sync.ts                 # trust sync — relay → DB sync loop
│   ├── resolve.ts              # trust resolve — trust path resolution
│   ├── show.ts                 # trust show — lookup trust event by d-tag
│   ├── server.ts               # trust server — start Fastify process
│   ├── ping.ts                 # trust ping — health check
│   ├── timestamp.ts            # trust timestamp — sync cursor management
│   ├── config.ts               # trust config — edit config.json
│   └── identity.ts             # trust identity — multi-key management
│
├── server/                     # Server-mode components
│   ├── app.ts                  # Fastify factory, plugin composition, OpenAPI setup
│   ├── errors.ts               # API envelope (ok/fail), error codes
│   ├── graph-sync.ts           # BFS-based author-focused sync from relays
│   ├── relay-sub.ts            # Generic relay subscription helpers
│   ├── all-sync.ts             # Broad subscription (all authors) sync
│   └── plugins/
│       ├── relay.ts            # WebSocket /relay (NIP-01), /relay-info (NIP-11)
│       ├── api.ts              # REST: /health, /identity, /trust, /resolve, /resolve/batch,
│       │                       #       /graph/stats, /events, /trusted + OpenAPI at /docs
│       └── web.ts              # Static SPA serving from dist/web/
│
├── lib/                        # Core libraries
│   ├── runtimeContext.ts       # RuntimeContext: config + graph + store + pool
│   ├── client.ts               # HTTP client: server availability, proxy calls
│   ├── keys.ts                 # Nostr keypair generation and loading
│   ├── identityStore.ts        # Identity registry (identity.json + key files)
│   ├── signer.ts               # Event signing with stored secret key
│   ├── logger.ts               # Pino logger (CLI pretty / server JSON)
│   ├── timestamp.ts            # KV-backed sync cursors (latest / last_seen)
│   ├── utils.ts                # statusLine, chunksOf
│   ├── BitArray.ts             # Fixed-size bitset utility
│   │
│   ├── nostr/                  # Nostr protocol helpers
│   │   ├── nip32010.ts         # KIND_TRUST (32010), d-tag hashing, template builder
│   │   ├── nip01.ts            # KIND_USER_METADATA (0)
│   │   ├── nip09.ts            # Deletion request kind (5)
│   │   ├── nip19.ts            # bech32 encode/decode wrappers
│   │   ├── subject.ts          # Parse subject strings → Nostr tags
│   │   ├── pool.ts             # NPool construction, publish/query helpers
│   │   └── relayManager.ts     # Relay probing, NIP-65, availability
│   │
│   ├── trust/                  # Trust domain logic
│   │   ├── graphManager.ts     # Singleton graph lifecycle, insertEvent dispatch
│   │   ├── identity.ts         # Kind-0 profile parsing, Identity model
│   │   ├── subject.ts          # CLI subject parsing (npub, URL, hash, NIP-73)
│   │   ├── reputation.ts       # Aggregate trust counts, latest-wins
│   │   │
│   │   ├── graph/              # In-memory graph model
│   │   │   ├── Graph.ts        # Graph class: nodes, edges, context index, cache file
│   │   │   ├── Node.ts         # Vertex: id, type, identity, EdgeMaps
│   │   │   ├── Edge.ts         # EdgeT1: value, context, time windows
│   │   │   ├── EdgeMap.ts      # Nested maps: context → subject → edge
│   │   │   └── index.ts        # Re-exports
│   │   │
│   │   └── resolvers/          # Trust resolution strategies
│   │       ├── IResolveStrategy.ts  # Strategy interface and options
│   │       ├── trustResolver.ts     # Default BFS resolver (standardResolver)
│   │       ├── Score.ts             # Per-node scoring during resolution
│   │       └── pathStrategy.ts      # Trust path construction for explainability
│   │
│   └── db/                     # Database layer
│       ├── dbManager.ts        # Store factory, graph notify, Kysely dialects
│       ├── NSQLite.ts          # SQLite Nostr store (better-sqlite3 + Kysely)
│       ├── NPostgres.ts        # Postgres Nostr store (pg + Kysely)
│       └── kv.ts               # KV table for sync cursors and metadata

web/                            # React SPA (Vite)
├── src/
│   ├── main.tsx                # React entry
│   ├── App.tsx                 # Router setup
│   ├── pages/
│   │   ├── LandingPage.tsx     # Landing page
│   │   └── NotFoundPage.tsx    # 404
│   └── components/
│       └── Layout.tsx          # App layout shell
├── vite.config.ts              # Vite build config → dist/web/
└── tsconfig.json               # Web-specific TypeScript config

test/
├── setup.ts                    # Temp dir helpers, test fixtures
├── unit/                       # Unit tests (keys, signer, timestamp, trust/*)
├── e2e/                        # End-to-end CLI tests
└── fixtures/                   # Test data (trust-graph.json, etc.)

scripts/                        # Development utilities
├── seed-trust-network.ts       # Generate test trust data
├── verify-trust-graph.ts       # Graph verification
└── server/                     # Ad-hoc server scripts
```

### 3.2 Key Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| CLI | commander | Command parsing and help generation |
| Server | fastify, @fastify/static, @fastify/websocket | HTTP server, static files, WebSocket |
| Nostr | nostr-tools, @nostrify/nostrify, @nostrify/db | Event model, relay protocol, store interface |
| Crypto | @noble/hashes | SHA-256 for d-tag computation |
| Database | better-sqlite3, pg, kysely | SQLite and Postgres with query builder |
| Serialization | msgpackr | Graph cache file, compact event storage |
| Logging | pino, pino-pretty | Structured logging |
| Web | react, react-dom, react-router-dom | SPA frontend |
| Build | typescript, vite, vitest | Compilation, bundling, testing |

---

## 4. RuntimeContext

The central runtime object that ties all components together:

```typescript
interface RuntimeContext extends ResolvedRuntimeConfig {
  graph: Graph;             // In-memory trust graph
  store: Store;             // Database handle (NSQLite | NPostgres)
  pool: NPool;              // Nostr relay pool
  abortController: AbortController;
  loggerInstance?: Logger;
}
```

**Created by:** `createRuntimeContext()` in `src/lib/runtimeContext.ts`
**Used by:** Server plugins, sync commands, resolve commands — anything that needs graph + store + relays.

### Configuration Resolution

`resolveConfig(cli)` merges layers with this precedence:

```
CLI flags  →  Environment variables  →  config.json  →  Identity defaults  →  Hardcoded defaults
```

Key resolved fields: `primaryPubkey`, `authors`, `contexts`, `relays`, `host`, `port`, `database`, `sqlitePath`, `postgresUrl`, `syncAuthor`, `syncSubscribeAll`, `since`, `maxDepth`, `syncIntervalSeconds`.

---

## 5. Data Flow

### 5.1 Trust Event Lifecycle

```
1. CREATE       trust add <subject> -v 1 -c dev
                    │
2. SIGN         signEvent(template, secretKey)
                    │
3. PUBLISH      ┌───┴───────────────────────┐
                │ Server available?          │
                │ Yes → POST /trust          │
                │ No  → publishEvent(relays) │
                └───┬───────────────────────┘
                    │
4. STORE        insertEvent(store, event)
                    │  → DB write (events table)
                    │  → trust_graph_notify trigger
                    │
5. GRAPH        applyTrustEvent(graph, event)
                    │  → create/update nodes
                    │  → create/update edges
                    │
6. RESOLVE      standardResolver.resolve(author, subject, options)
                    │  → BFS traversal of in-memory graph
                    │  → Score aggregation
                    └  → optional path trace
```

### 5.2 Sync Flow

Two sync strategies feed events into the database and graph:

**Graph-based sync** (`graph-sync.ts`): BFS from configured root authors, expanding along trusted pubkeys up to `maxDepth`. Efficient — only fetches events from authors in the trust graph.

**Subscribe-all sync** (`all-sync.ts`): Subscribes to all kind 32010 events without author filtering. Simple, complete, but high bandwidth on large networks.

```
Nostr Relays
    │
    ├── [graph-sync] BFS: author₁ → trusted authors → depth N
    │       │
    │       └── For each batch of authors:
    │           Filter: { kinds: [32010], authors: [...chunk] }
    │           → insertEvent per event
    │           → Discover new trusted authors → next BFS level
    │
    └── [all-sync] Broad: { kinds: [32010], since: cursor }
            │
            └── insertEvent per event
                → trackLatestTimestamp
```

### 5.3 Server Graph Refresh

When running split services (relay and API as separate processes sharing a database), the API process stays in sync through the **graph notify** mechanism:

```
Relay process                    Database                    API process
     │                              │                            │
     │── insertEvent ──────────────►│                            │
     │                              │── trigger ─► notify row    │
     │                              │                            │
     │                              │◄──── drainGraphNotifyBatch │
     │                              │                  │         │
     │                              │         apply to graph ────┘
```

The `trust_graph_notify` table is populated by DB triggers on insert/delete of events. The API plugin polls this table and applies changes to the in-memory graph.

---

## 6. Deployment Modes

### 6.1 CLI Client

```bash
trust init && trust add <subject> -v 1 && trust sync && trust resolve <subject>
```

Short-lived process. If a server is running, commands like `add` and `resolve` proxy to it automatically. Otherwise, they operate directly against the local database and graph.

### 6.2 Single-Instance Server

```bash
trust server
```

Runs all services (relay + API + web) in one process. Default for development and small deployments.

### 6.3 Enterprise Split Services

```bash
# Process 1: Relay facade + sync (writes events)
trust server --service relay --database postgres

# Process 2: REST API + graph (serves queries)
trust server --service api --database postgres

# Process 3: Web dashboard (static SPA)
trust server --service web
```

Each service runs independently. The relay and API share the same Postgres database. The API stays in sync via `trust_graph_notify` polling. This enables horizontal scaling and service isolation.

### 6.4 Configuration Scoping

The `authors` and `contexts` configuration controls what data each instance retains:

- **Focused** (default): Only events from `authors` in the trust graph, scoped to configured `contexts`. Efficient for per-agent or per-team deployments.
- **All** (`--authors All --contexts All`): Retain everything. For central aggregation nodes or network-wide analysis.
- **Custom**: Any combination of specific pubkeys and contexts.

---

## 7. File System Layout

```
~/.trust/                       # Default config directory (override: TRUST_CONFIG_DIR)
├── identity.json               # Primary pubkey + registered key list
├── keys/                       # Per-pubkey secret files (hex, mode 0600)
│   └── <pubkey>.key
├── config.json                 # User configuration
├── trust.db                    # SQLite database (when using SQLite driver)
└── graph-cache.bin             # Optional msgpack graph snapshot for fast startup
```

---

## 8. References

- [Technical Design](02-design.md) — Data model, graph internals, resolver algorithm
- [Implementation Status & Roadmap](03-roadmap.md) — What's complete, what's planned
- [Resolve Algorithm](../resolve.md) — BFS details and context semantics
- [NIP-32010](../nips/NIP-32010.md) — Trust event specification
