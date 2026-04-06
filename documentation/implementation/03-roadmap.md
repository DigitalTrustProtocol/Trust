# Implementation Status & Roadmap

This document tracks the implementation status of each component and outlines remaining work.

---

## 1. Implementation Status

### 1.1 Core Infrastructure — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Project setup (TypeScript, ESM, Vitest) | `package.json`, `tsconfig.json`, `vitest.config.ts` | Done |
| Configuration system | `src/config.ts` | Done |
| Logging (CLI pretty / server JSON) | `src/lib/logger.ts` | Done |
| Utility helpers | `src/lib/utils.ts`, `src/lib/BitArray.ts` | Done |

### 1.2 Identity & Keys — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Keypair generation and loading | `src/lib/keys.ts` | Done |
| Identity registry (multi-key) | `src/lib/identityStore.ts` | Done |
| Event signing | `src/lib/signer.ts` | Done |
| NIP-19 encode/decode | `src/lib/nostr/nip19.ts` | Done |

### 1.3 Nostr Protocol — Complete

| Component | Files | Status |
|-----------|-------|--------|
| NIP-32010 trust event model | `src/lib/nostr/nip32010.ts` | Done |
| D-tag computation (SHA-256 / XOR) | `src/lib/nostr/nip32010.ts` | Done |
| Subject parsing (all types) | `src/lib/nostr/subject.ts`, `src/lib/trust/subject.ts` | Done |
| Relay pool (NPool) | `src/lib/nostr/pool.ts` | Done |
| Relay management / probing | `src/lib/nostr/relayManager.ts` | Done |
| Kind constants (0, 5, 32010) | `src/lib/nostr/nip01.ts`, `nip09.ts`, `nip32010.ts` | Done |

### 1.4 Database Layer — Complete

| Component | Files | Status |
|-----------|-------|--------|
| SQLite store (events, tags, KV) | `src/lib/db/NSQLite.ts` | Done |
| Postgres store (events, tags, KV) | `src/lib/db/NPostgres.ts` | Done |
| Store factory and driver selection | `src/lib/db/dbManager.ts` | Done |
| KV table (sync cursors) | `src/lib/db/kv.ts` | Done |
| Graph notify table + triggers | `src/lib/db/NSQLite.ts`, `NPostgres.ts` | Done |
| Replaceable event semantics | Both stores | Done |

### 1.5 In-Memory Graph — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Graph class (nodes, edges, context index) | `src/lib/trust/graph/Graph.ts` | Done |
| Node model (identity, EdgeMaps) | `src/lib/trust/graph/Node.ts` | Done |
| Edge model (value, context, time windows) | `src/lib/trust/graph/Edge.ts` | Done |
| EdgeMap (nested context → subject → edge) | `src/lib/trust/graph/EdgeMap.ts` | Done |
| Graph manager (singleton, insert/remove) | `src/lib/trust/graphManager.ts` | Done |
| Graph loading (full + BFS) | `src/lib/trust/graphManager.ts` | Done |
| msgpack graph cache file | `src/lib/trust/graph/Graph.ts` | Done |
| Identity model (kind 0 profile merge) | `src/lib/trust/identity.ts` | Done |

### 1.6 Trust Resolution — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Resolver strategy interface | `src/lib/trust/resolvers/IResolveStrategy.ts` | Done |
| Standard BFS resolver | `src/lib/trust/resolvers/trustResolver.ts` | Done |
| Score model (trust/distrust/degree) | `src/lib/trust/resolvers/Score.ts` | Done |
| Path strategy (explainability) | `src/lib/trust/resolvers/pathStrategy.ts` | Done |
| Reputation aggregation (DB-level) | `src/lib/trust/reputation.ts` | Done |
| Output formats (number, default, path) | `src/commands/resolve.ts` | Done |

### 1.7 Relay Sync — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Graph-based BFS sync | `src/server/graph-sync.ts` | Done |
| Subscribe-all sync | `src/server/all-sync.ts` | Done |
| Generic relay subscription | `src/server/relay-sub.ts` | Done |
| Timestamp management (KV cursors) | `src/lib/timestamp.ts` | Done |
| Automatic rollforward on startup | `src/commands/server.ts` | Done |

### 1.8 Server — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Fastify app factory | `src/server/app.ts` | Done |
| REST API plugin (/health, /trust, /resolve) | `src/server/plugins/api.ts` | Done |
| WebSocket relay plugin (NIP-01) | `src/server/plugins/relay.ts` | Done |
| Web SPA plugin (static serving) | `src/server/plugins/web.ts` | Done |
| Service splitting (relay/api/web/all) | `src/server/app.ts`, `src/commands/server.ts` | Done |
| Graph notify polling (cross-process sync) | `src/server/plugins/api.ts` | Done |
| RuntimeContext setup | `src/lib/runtimeContext.ts` | Done |

### 1.9 CLI Commands — Complete

| Command | File | Status |
|---------|------|--------|
| `trust init` | `src/commands/init.ts` | Done |
| `trust whoami` | `src/commands/whoami.ts` | Done |
| `trust add` | `src/commands/add.ts` | Done |
| `trust sync` | `src/commands/sync.ts` | Done |
| `trust resolve` | `src/commands/resolve.ts` | Done |
| `trust show` | `src/commands/show.ts` | Done |
| `trust server` | `src/commands/server.ts` | Done |
| `trust ping` | `src/commands/ping.ts` | Done |
| `trust timestamp` | `src/commands/timestamp.ts` | Done |
| `trust config` (show, authors, contexts) | `src/commands/config.ts` | Done |
| `trust identity` (list, import, generate, primary, remove) | `src/commands/identity.ts` | Done |

### 1.10 Client-Server Delegation — Complete

| Component | Files | Status |
|-----------|-------|--------|
| Server availability check | `src/lib/client.ts` | Done |
| Proxy trust (add → POST /trust) | `src/lib/client.ts` | Done |
| Proxy resolve (resolve → POST /resolve) | `src/lib/client.ts` | Done |
| Automatic fallback to local execution | `src/commands/add.ts`, `resolve.ts` | Done |

### 1.11 Testing — Partial

| Component | Files | Status |
|-----------|-------|--------|
| Unit tests (keys, signer, timestamp) | `test/unit/` | Done |
| Unit tests (trust: db, resolver, events, subject, reputation) | `test/unit/trust/` | Done |
| E2E tests (CLI flows) | `test/e2e/` | Done |
| Test fixtures | `test/fixtures/` | Done |
| Benchmark scripts | `scripts/` | Done |

---

## 2. Remaining Work

### 2.1 Web Dashboard — Not Started

The web SPA (`web/`) currently has a minimal shell (landing page, layout, router). The following features are needed to make it a functional management console:

#### Graph Visualization
- Interactive trust graph rendering (nodes = identities, edges = trust relationships)
- Filter by context, depth, author
- Node details on click (identity metadata, trust scores)
- Zoom, pan, and layout controls
- Edge coloring by trust value (green = trust, red = distrust, gray = neutral)

#### Search
- Search for identities by npub, name, or metadata
- Search for trust events by subject, context, author
- Full-text search across event content
- Results with trust score context (from current user's perspective)

#### Management Console
- View and manage the current identity
- View sync status and statistics
- Monitor graph size (nodes, edges, events)
- Configuration viewer/editor
- Server health dashboard
- Relay connection status

#### API Integration
- The web app should use the existing REST API endpoints (`/resolve`, `/trust`, `/health`)
- Add additional API endpoints as needed for dashboard data:
  - `GET /graph/stats` — Node/edge counts, graph metadata
  - `GET /graph/nodes` — Paginated node list with filtering
  - `GET /graph/edges` — Paginated edge list with filtering
  - `GET /events` — List events with filtering (extend existing)
  - `GET /identities` — List known identities with metadata

### 2.2 Additional NIP Support — Deferred

The following NIPs are specified in `documentation/nips/` but not yet implemented beyond the protocol specification:

| NIP | Feature | Priority |
|-----|---------|----------|
| NIP-32011 | Event completeness index (sync optimization) | Medium |
| NIP-32012 | Subject bloom filter (membership testing) | Medium |
| NIP-32013 | Delegate trust (dual-signed delegation) | Low |
| NIP-32014 | Subject rating (numeric scoring) | Low |
| NIP-32015 | Subject confirmation (boolean acknowledgment) | Low |
| NIP-32016 | Subject link (URL/source binding) | Low |

The current architecture supports these extensions — the database stores events of any kind, the graph model can accommodate new edge types, and the relay facade forwards events transparently.

### 2.3 Enhancements — Future

| Feature | Description | Priority |
|---------|-------------|----------|
| npm publish | Publish `@dtp/trust` to npm registry for `npm install -g` | High |
| Docker image | Containerized deployment for server mode | Medium |
| Follow graph integration | Import kind 3 (contact list) as initial trust seeds | Medium |
| Graph-limited cache loading | BFS-bounded graph loading for very large datasets | Low |
| WebSocket push for resolve | Real-time trust score updates via WebSocket | Low |
| Rate limiting | API rate limiting for public deployments | Low |
| Authentication | API key or NIP-98 HTTP auth for write endpoints | Medium |
| Metrics/monitoring | Prometheus metrics for server health | Low |

---

## 3. Architecture Decisions

These decisions were made during implementation and should be preserved:

### Single Package, Multiple Roles
The application is a single npm package that serves all roles (CLI, server, relay, web). This was a deliberate choice to keep deployment simple — install once, configure for your use case. The codebase is not large enough to justify splitting into separate packages.

### SQLite as Default, Postgres for Scale
SQLite provides zero-configuration local storage for single-node deployments and CLI usage. Postgres enables multi-instance deployments where relay and API processes share a database. Both use the same Kysely query builder and Nostr store interface.

### In-Memory Graph vs Database Queries
Trust resolution requires multi-hop graph traversal (BFS). Doing this against a relational database would be prohibitively slow for real-time queries. The in-memory graph gives sub-millisecond resolution. The trade-off is memory usage, mitigated by BFS-bounded loading and the graph cache file.

### Event Store as Source of Truth
Raw Nostr events are the canonical data. The graph is derived and disposable — it can be rebuilt from the event store at any time. This simplifies replication, backup, and debugging.

### Context as First-Class Concept
Trust is always scoped by context. An empty context acts as "general" (applies everywhere when a specific context is queried). This enables domain-specific trust without requiring separate trust graphs.

---

## 4. File Quick Reference

For developers starting work on remaining features, these are the key entry points:

| Task | Start Here |
|------|------------|
| Add a new CLI command | `src/cli.ts` (register), `src/commands/` (implement) |
| Add a new API endpoint | `src/server/plugins/api.ts` |
| Modify the graph model | `src/lib/trust/graph/` |
| Add a new resolver strategy | `src/lib/trust/resolvers/` (implement `IResolveStrategy`) |
| Change database schema | `src/lib/db/NSQLite.ts` and `NPostgres.ts` |
| Modify sync behavior | `src/server/graph-sync.ts` or `all-sync.ts` |
| Work on the web app | `web/src/` |
| Add tests | `test/unit/` or `test/e2e/` |

---

## 5. References

- [System Architecture](01-overview.md) — Module map and deployment modes
- [Technical Design](02-design.md) — Data model, graph, resolver details
- [Resolve Algorithm](../resolve.md) — BFS trust resolution
- [Project Description](../description.md) — Vision and AI-first philosophy
