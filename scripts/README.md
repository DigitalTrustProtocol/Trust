# Scripts

## seed-trust-network

Generates keys and creates a trust network. Uses the primary key from `./trust` as the root identity. Posts trust events to relays and inserts into the local DB.

**Fixture mode:** If `test/fixtures/trust-graph.json` exists (or `TRUST_GRAPH_FILE` points to a JSON file), the script loads it and builds the graph from its keys and connections. Otherwise it uses the built-in 100-key scenario.

### Prerequisites

1. Create a local trust config for testing:

   ```bash
   mkdir -p trust
   # Copy your secret key to trust/secret.key, or run init:
   TRUST_CONFIG_DIR=trust trust init --skip-profile
   ```

2. Ensure `trust/secret.key` exists (hex format, 64 chars).

### Usage

```bash
# Use ./trust as config dir (default for this script)
npm run seed

# Or explicitly:
TRUST_CONFIG_DIR=trust npm run seed

# Custom graph file:
TRUST_GRAPH_FILE=./my-graph.json npm run seed
```

### trust-graph.json (fixture mode)

| Field | Description |
|-------|-------------|
| `keys` | Array of `{ label?: string }` – one per key (index 0 = primary) |
| `connections` | Array of `{ from, to, value, context }` – value: 1=trust, 0=neutral, -1=distrust |
| `expected` | Array of `{ issuer, subject, context?, degree?, connected? }` – used by tests |

### Scenarios (100-key mode)

| Scenario | Description |
|----------|-------------|
| 1 | Primary trusts cluster leads (keys 1-5) in "development" |
| 2 | Primary trusts leads 1-3 in "commerce" |
| 3 | Cluster leads trust their members (chains: lead 1→10-19, 2→20-29, etc.) |
| 4 | Batch distrust: primary distrusts keys 80-89 (spam ring) |
| 5 | Individual distrust: primary distrusts key 50 in "security" |
| 6 | Cross-trust between cluster leads |
| 7 | Hub: members 10-19 trust lead 1 |
| 8 | Neutral/revocation: primary revokes commerce trust for key 4 |

### bench-load-graph-1m

Benchmarks Graph load from DB with 1M nodes. Creates a test DB with:
- 1 issuer (key from config)
- 100 degree-1 nodes (issuer trusts each)
- 10,000 degree-2 nodes (each degree-1 trusts 100)
- 1,000,000 degree-3 nodes (each degree-2 trusts 100)

Measures time to load issuer + first degree (100 subjects + edges) via `loadGraphFromDB(issuer, 1)`.

```bash
# First run: init bench dir
TRUST_CONFIG_DIR=bench-1m trust init --skip-profile

# Run benchmark (creates DB, inserts 1M events, then times the load)
npm run bench:load-graph-1m
```

### After seeding

```bash
# Resolve trust path from primary (default issuer)
TRUST_CONFIG_DIR=trust trust resolve <subject-npub> -c dev

# Resolve from another issuer (positional or flag)
TRUST_CONFIG_DIR=trust trust resolve <subject-npub> <issuer-npub> -c dev
TRUST_CONFIG_DIR=trust trust resolve <subject-npub> --issuer <issuer-npub> -c dev
```
