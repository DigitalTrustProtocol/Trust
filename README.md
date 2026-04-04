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
# Options: -c, --context, -v, --value (1|0|-1), --content, -r, --relay, --json
```

### `trust sync`

Sync trust events from relays into local DB.

```bash
trust sync [options]
# Options: -r, --relay, --json
```

### `trust resolve`

Resolve trust path and reputation from local DB.

```bash
trust resolve <subject> [issuer] [options]
# Subject: pubkey to resolve. Issuer: optional, defaults to primary key
# Options: -c, --context, -s/--strategy <name>, --max-depth <n>, --issuer <npub|hex>, --json
```

### `trust query`

Query trust from relays (no local DB).

```bash
trust query <target> [options]
# Options: -c, --context, -r, --relay, --json
```

### `trust show`

Show a trust event by ID (note1/nevent1/hex).

```bash
trust show <event-ref> [options]
# Options: -r, --relay, --json
```

### `trust server`

Run the HTTP server and relay subscription loop.

```bash
trust server [options]

Options:
  -p, --port <port>     HTTP port for the Web API (default: 3417 or config/serverPort)
  -h, --host <host>     Bind host (e.g. localhost, 0.0.0.0; default: localhost or config/serverHost)
  -r, --relay <url...>  Relay URL(s) for websocket subscription (default: config relays)
  --json                Output startup info as JSON
```

When running, the server exposes a small HTTP API:

- `GET /health` – returns `{ "status": "ok" }` when the server is running.
- `POST /trust` – add trust to the system (same semantics as `trust add`).
- `POST /resolve` – resolve trust and reputation (same semantics as `trust resolve`).

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
├── secret.key    # Nostr private key (hex, mode 0600)
├── config.json   # User config (relays, server settings, profile)
└── trust.db      # Trust events, timestamps, KV (NIP-32010)
```

`config.json` includes:

- `relays`: default relay URLs.
- `serverPort`: default HTTP port for `trust server` (default: 3417).
- `serverHost`: default bind host for `trust server` (default: localhost).
- `profile`: optional identity/profile metadata.

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
