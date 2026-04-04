# Trust CLI

The command-line interface for [Trust](https://trust.dance) — Digital Web of Trust Reputation. Handles trust on Nostr (NIP-32010): issue and query trust, resolve reputation from the graph.

## Features

- **Nostr identity** – Generate and manage Nostr keypairs (init, whoami)
- **Database infrastructure** – SQLite trust.db for timestamps and trust data
- **Nostr API** – Relay pool for querying and publishing events
- **Trust (NIP-32010)** – Issue trust, sync from relays, resolve reputation (see implementation docs)

## Installation

```bash
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
trust init --name "My Identity" --about "Trust user"

# View your identity
trust whoami

# Timestamp cursor (for incremental sync)
trust timestamp --json
```

## Commands

### `trust init`

Initialize a new Trust identity by generating a Nostr keypair.

```bash
trust init [options]

Options:
  -n, --name <name>     Profile name
  -a, --about <about>   Profile bio
  --skip-profile        Skip publishing profile to relays
```

The secret key is stored at `~/.trust/secret.key` with restricted permissions (0600).

### `trust whoami`

Display your current identity.

```bash
trust whoami [options]

Options:
  --json    Output as JSON
```

### `trust timestamp`

View or update stored timestamps for incremental fetching (used by sync).

```bash
trust timestamp [options]

Options:
  --get                     Print the raw latest timestamp value
  --set <value>             Set the latest timestamp
  --set-last-seen <value>   Set the last seen timestamp
  --rollforward             Promote last_seen + 1 to latest
  --json                    Output both timestamps as JSON
```

### `trust add`

Add trust to the system (kind 32010, NIP-32010). Requires `trust init`.

```bash
trust add <subject> [subjects...] [options]
# Options: -c, --contexts, -v, --value (1|0|-1), --content, -r, --relay, --json
```

### `trust sync`

Sync trust events from relays into local DB.

```bash
trust sync [options]
# Options: -r, --relay, --authors, --contexts,
#          --max-depth, --sync-interval, --json
```

### `trust resolve`

Resolve trust path and reputation from local DB.

```bash
trust resolve <subject> [authors] [options]
# Subject: pubkey to resolve. Authors: optional perspective (npub/hex), defaults to primary key
# Options: -c, --contexts, -s/--strategy <name>, --max-depth <n>, --authors <npub|hex>, --json
```

### `trust query`

Query trust from relays (no local DB).

```bash
trust query <target> [options]
# Options: -c, --contexts, -r, --relay, --json
```

### `trust show`

Show a trust event by ID (note1/nevent1/hex).

```bash
trust show <event-ref> [options]
# Options: -r, --relay, --json
```

### `trust server`

Run the HTTP server and optional relay subscription loop.

```bash
trust server [options]

Options:
  -p, --port <port>     HTTP port for the Web API (default: 3417 or config/serverPort)
  -h, --host <host>     Bind host (e.g. localhost, 0.0.0.0; default: localhost or config/serverHost)
  -r, --relay <url...>  Relay URL(s) for websocket subscription (default: config relays)
  --authors <value>     Sync root / focus: primary (default), * or All, or comma-separated hex pubkeys
  --contexts <value>    Trust `c` tag filter: All or comma-separated contexts (overrides config)
  --service <name>      `all` (default), `relay`, `api`, or `web` — which components run in this process
  --database <driver>   `sqlite` or `postgres`
  --json                Output startup info as JSON
```

**Default:** Omitting **`--service`** runs **relay, REST API, and web** in a single process (`--service all`). **Data scope** comes from **`config.json`** (`authors`, `contexts`) or from **`--authors`** / **`--contexts`** on this command. Use **`All`** as the only value when you want no filter on that axis. Multiple pubkeys or contexts use **commas** in the same `--authors` or `--contexts` argument.

**Split processes:** With **`--service relay`**, another process can run **`--service api`** against the same database; the API loads the graph and polls `trust_graph_notify` rows written by DB triggers when events are inserted or deleted (so the graph stays in sync without in-process relay code).

When running, the server exposes a small HTTP API:

- `GET /health` – returns `{ "status": "ok" }` when the server is running.
- `POST /trust` – add trust to the system (same semantics as `trust add`).
- `POST /resolve` – resolve trust and reputation (same semantics as `trust resolve`).

### `trust config`

Edit `~/.trust/config.json` without hand-editing JSON (see **Configuration**).

```bash
trust config show
trust config authors set All
trust config authors add <hex> [<hex>...]
trust config authors remove <hex> [<hex>...]
trust config authors clear
trust config contexts set All
trust config contexts add <name> [<name>...]
trust config contexts remove <name> [<name>...]
trust config contexts clear
```

### `trust identity`

Manage multiple signing keys; the **primary** key is used for `trust add`, `POST /trust`, and other signing operations.

```bash
trust identity list [--json]
trust identity generate [--label <text>]
trust identity import --secret <64-hex|nsec> [--label <text>]
trust identity primary <npub|hex>
trust identity remove <npub|hex>
```

Secrets live under `~/.trust/keys/<pubkey>.key` with metadata in `~/.trust/identity.json`. A legacy `~/.trust/secret.key` is still supported.

### `trust ping`

Check whether the Trust server is reachable (health check).

```bash
trust ping [options]

Options:
  -u, --url <baseUrl>   Base URL of the server (default: from config/env, e.g. http://localhost:3417)
  --json                Output result as JSON
```

**Examples:**
```bash
trust add npub1abc... -v 1 -c development
trust sync
trust resolve npub1abc... -c development
trust query npub1abc...
```

## Configuration

All configuration is stored in `~/.trust/`:

```
~/.trust/
├── secret.key     # Legacy single private key (hex, mode 0600)
├── identity.json  # Optional: primary pubkey + registered keys
├── keys/          # Per-pubkey secret files (hex) when using `trust identity`
├── config.json    # User config (relays, focus, server, profile)
└── trust.db       # Trust events, timestamps, KV (NIP-32010) when using SQLite
```

`config.json` includes:

- `relays`: default relay URLs.
- `authors`: optional list of 64-char hex pubkeys, or `["All"]` to retain events from any author (subject to trust rules below); omitted means all authors.
- `contexts`: optional list of trust context strings (NIP-32010 `c` tag), or `["All"]`; include `""` if you need events with no context tag.
- `serverPort`: default HTTP port for `trust server` (default: 3417).
- `serverHost`: default bind host for `trust server` (default: localhost).
- `maxDepth`: default trust graph depth for sync/server (default: 3).
- `syncIntervalSeconds`: seconds between sync runs; `0` means run once (default: 3600).
- `since`: optional unix timestamp string for incremental sync when `--since` is not passed.
- `kinds`: trust event kinds to sync (default: `[32010]`).
- `serverService`: default `trust server --service` value (`all`, `relay`, `api`, or `web`).
- `db`: optional `{ "driver": "sqlite" | "postgres", ... }` for the trust store.
- `profile`: optional identity/profile metadata.

`resolveConfig(cli)` (used by **`trust sync`** and **`trust server`**) takes a plain object (e.g. Commander options) and merges **`config.json`** + defaults + identity for any **present** keys — there is no fixed input type. **`trust sync`** only passes sync-related fields (no `host`/`port`); **`trust server`** adds bind and `service`. Omitted keys keep file/env defaults (host/port still come from `serverHost`/`serverPort` and `TRUST_SERVER_*` when not in `cli`).

On **`trust sync`** and **`trust server`**, any CLI flag overrides the corresponding file value for that process.

You can override the server host/port at runtime with environment variables:

- `TRUST_SERVER_PORT` – overrides the HTTP port.
- `TRUST_SERVER_HOST` – overrides the bind host.

You can set `TRUST_CONFIG_DIR` to a path relative to the current working directory to use an alternate config directory instead of `~/.trust`.

### Default Relays

- `wss://relay.ditto.pub`
- `wss://relay.primal.net`
- `wss://relay.damus.io`
- `wss://nos.lol`

## Implementation

See [documentation/implementation/](documentation/implementation/) for the NIP-32010 design and step-by-step implementation guide.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## License

MIT
