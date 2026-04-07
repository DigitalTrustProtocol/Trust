# Trust — Decentralized Identity and Reputation for AI

A decentralized Web of Trust reputation system built on [Nostr](https://nostr.com/). Trust gives AI agents — and humans — a cryptographic identity and a way to build, query, and verify trust relationships across the open internet.

**AI is the first-class citizen.** Just as a RAG database gives AI long-term memory, Trust gives AI long-term identity and reputation. Every interface (CLI, HTTP API, JSON output) is optimized for machine consumption.

**One app, all roles.** A single npm package serves as CLI client, HTTP server, Nostr relay facade, and web dashboard. Install once, configure for your use case.

## Features

- **Nostr identity** — Generate and manage Nostr keypairs (`trust init`, `trust identity`)
- **Trust assertions** — Issue trust, distrust, or neutral assertions on any subject: pubkeys, events, content hashes, URLs, NIP-73 external IDs (`trust add`)
- **Context-scoped trust** — Trust is scoped by context (`development`, `commerce`, `security`, etc.)
- **Relay sync** — Graph-based or subscribe-all sync from Nostr relays (`trust sync`)
- **Trust resolution** — BFS graph traversal to determine trust paths (`trust resolve`)
- **HTTP server** — REST API for programmatic access (`trust server`)
- **Nostr relay** — WebSocket NIP-01 relay facade for client interoperability
- **Enterprise deployment** — Split services share a database (SQLite or Postgres)

## Installation

```bash
# From npm (when published)
npm install -g @dtp/trust

# From source
git clone https://gitlab.com/keutmann/trust.git
cd trust
npm install
npm run build
npm link
```

## Quick Start

```bash
# Initialize your identity
trust init --name "My Agent" --about "AI code review agent"

# View your identity
trust whoami --json

# Trust another identity
trust add npub1abc... -v 1 -c development --content "Reliable reviewer"

# Sync from relays
trust sync

# Resolve trust
trust resolve npub1xyz... -c development --json

# Resolve for scripting (returns single integer)
trust resolve npub1xyz... -c development -f number

# Run server (all services in one process)
trust server

# Run server (enterprise: split services, shared Postgres)
trust server --service relay --database postgres
trust server --service api --database postgres
```

## Commands

### Identity

| Command | Description |
|---------|-------------|
| `trust init [--name, --about, --skip-profile]` | Create identity, write config, optionally publish profile |
| `trust whoami [--json]` | Display current identity (pubkey, npub) |
| `trust identity list [--json]` | List all registered keys |
| `trust identity generate [--label]` | Generate a new keypair |
| `trust identity import --secret <hex\|nsec> [--label]` | Import an existing key |
| `trust identity primary <npub\|hex>` | Set the primary signing key |
| `trust identity remove <npub\|hex>` | Remove a key from the registry |

### Trust Operations

| Command | Description |
|---------|-------------|
| `trust add <subject> [subjects...] [-v 1\|0\|-1] [-c ctx]` | Publish a trust assertion (kind 32010) |
| `trust sync [--authors, --contexts, --max-depth]` | Sync trust events from relays into local DB |
| `trust resolve <subject> [author] [-c ctx] [-f format] [--json]` | Resolve trust from author's perspective |
| `trust show <d-tag> [--json]` | Show a trust event by d-tag |

### Server

| Command | Description |
|---------|-------------|
| `trust server [-p port] [-h host] [--service all\|relay\|api\|web]` | Run HTTP server with relay sync |
| `trust ping [-u url] [--json]` | Health check the server |

### Configuration

| Command | Description |
|---------|-------------|
| `trust config show` | Display current configuration |
| `trust config authors set\|add\|remove\|clear [values]` | Manage author focus list |
| `trust config contexts set\|add\|remove\|clear [values]` | Manage context filter list |
| `trust sync-time [--get, --set, --rollforward, --json]` | Manage sync times (incremental fetch cursors) |

## Server API

When running `trust server`, the following endpoints are available:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (`{ "status": "ok" }`) |
| GET | `/ping` | Same as health |
| POST | `/trust` | Create and publish a trust event |
| POST | `/resolve` | Resolve trust path and reputation |
| WS | `/relay` | NIP-01 Nostr relay (REQ/EVENT/CLOSE) |
| GET | `/relay-info` | NIP-11 relay information document |

### Example: Resolve via API

```bash
curl -X POST http://localhost:3417/resolve \
  -H "Content-Type: application/json" \
  -d '{"subject": "npub1...", "contexts": "development", "format": "number"}'
```

## Configuration

All configuration is stored in `~/.trust/` (override with `TRUST_CONFIG_DIR`):

```
~/.trust/
├── identity.json       # Primary pubkey + registered keys
├── keys/               # Per-pubkey secret files (mode 0600)
├── config.json         # User configuration
├── trust.db            # SQLite database (default driver)
└── graph-cache.bin     # Optional graph snapshot for fast startup
```

### config.json

| Field | Description | Default |
|-------|-------------|---------|
| `relays` | Nostr relay URLs | 4 public relays |
| `authors` | Hex pubkeys to sync, or `["All"]` | All authors |
| `contexts` | Context filter, or `["All"]` | All contexts |
| `serverPort` | HTTP server port | 3417 |
| `serverHost` | Bind host | localhost |
| `maxDepth` | Trust graph sync depth | 3 |
| `syncIntervalSeconds` | Seconds between sync runs (0 = once) | 3600 |
| `kinds` | Event kinds to sync | [32010] |
| `db.driver` | `sqlite` or `postgres` | sqlite |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TRUST_CONFIG_DIR` | Override config directory (relative to cwd) |
| `TRUST_SERVER_PORT` | Override server port |
| `TRUST_SERVER_HOST` | Override bind host |
| `DATABASE_URL` | Postgres connection string (auto-selects Postgres driver) |
| `TRUST_LOG_FILE` | Log to file instead of stdout |

### Default Relays

- `wss://relay.ditto.pub`
- `wss://relay.primal.net`
- `wss://relay.damus.io`
- `wss://nos.lol`

## Documentation

See [documentation/](documentation/) for comprehensive docs:

- [Project Description](documentation/description.md) — Vision, AI-first philosophy, design principles
- [System Architecture](documentation/implementation/01-overview.md) — Module map, data flow, deployment modes
- [Technical Design](documentation/implementation/02-design.md) — Data model, graph, resolver, database
- [Implementation Status & Roadmap](documentation/implementation/03-roadmap.md) — What's done, what's next
- [Resolve Algorithm](documentation/resolve.md) — BFS trust resolution and context semantics
- [NIP-32010](documentation/nips/NIP-32010.md) — Trust event specification

## Development

```bash
npm install
npm run build          # TypeScript + Vite (web)
npm run typecheck      # Type checking only
npm test               # Build + Vitest
npm run test:watch     # Vitest in watch mode
npm run dev            # Run CLI via tsx (no build)
npm run dev:web        # Vite dev server for web app
```

## License

MIT
