---
name: trust-system
description: >-
  Guides AI agents in using Trust: decentralized Web of Trust on Nostr (NIP-32010),
  identity, sync, resolve, CLI, HTTP API, SDK, and MCP tools. Use when working in
  the trust repository, with @dtp/trust, trust resolve/add/sync/init, agent
  reputation, or NIP-32010 trust events.
---

# Trust system (AI guide)

Trust is a **decentralized reputation graph** on Nostr. Participants sign **trust assertions** (kind `32010`); resolution walks the graph from an **author** (observer) toward a **subject** (who or what is being evaluated). The stack is **AI-first**: JSON output, REST, SDK, and MCP are meant for automated decisions and tooling.

## When to apply this skill

- The user asks about trust scores, “do I trust X”, Web of Trust, or Nostr trust events.
- You are implementing or debugging this repo (`@dtp/trust`), the MCP server, or integrations.
- You need to choose **context**, interpret **resolve** results, or explain **why** a path exists (`format: path`).
- The user wants to **sign with their own Nostr key** (import `nsec` / hex, set primary, use MCP/SDK/CLI).

## Mental model

| Concept | Meaning |
|--------|---------|
| **Identity** | Nostr keypair; `npub` / hex pubkey is the agent’s long-term ID. |
| **Subject** | Trust target: pubkey, event id, URL, hash, NIP-73 external id, etc. |
| **Trust event (32010)** | Signed assertion: value `1` / `0` / `-1`, optional **context** `c`, optional time windows `x`/`y`/`z`. |
| **Graph** | Directed edges from assertions; resolver does **BFS** from author with depth cap (max **4**). |
| **Context** | Scoped trust (e.g. `code-review` vs `commerce`). Empty string `""` means **general** trust that applies as fallback when querying a specific context. |

Do not confuse **Nostr follow graph (kind 3)** with **trust (32010)**; Trust models explicit vouch/warn semantics. See [nip58-vs-nip32010.md](nip58-vs-nip32010.md).

## Recommended agent workflow

1. **Ensure data**: Local graph comes from `trust sync` (or server-side sync). Stale graph ⇒ wrong resolve. If the user has never initialized: `trust init`.
2. **Fix perspective**: Default author is the **configured primary identity** (`trust whoami` / SDK / MCP `trust_whoami`).
3. **Pick context** deliberately (see [Context semantics](#context-semantics) below).
4. **Resolve** before high-impact actions (execute code, send funds, delegate authority). Use `format: number` for thresholds; use `path` when the user needs an audit trail.
5. **Publish carefully**: `trust add` / MCP `trust_add` signs and sends to relays—treat as **public, attributable statements**.

## Importing a Nostr key (sign as your own pubkey)

Trust signs events with the **primary** secret key in local identity storage (`~/.trust` by default, or override with **`TRUST_CONFIG_DIR`**). The CLI, SDK, and MCP all use that same store—there is no separate “API key”; control **who signs** by importing the right Nostr secret and setting it primary.

### CLI

1. **Import** a secret (creates `identity.json` + `keys/<pubkey>.key` if needed):
   - **`trust identity import --secret '<value>'`** where `<value>` is either **`nsec1…`** (NIP-19) or **64 hex characters** (32-byte secp256k1 secret; letters case-insensitive).
   - Optional: **`--label 'my-agent'`** for humans listing keys.
2. **Confirm**: **`trust whoami`** or **`trust identity list`** (add **`--json`** for scripts).
3. **Several keys?** Set which one signs: **`trust identity primary <npub|64-hex-pubkey>`**.
4. **Remove** a registered key (does not delete relay-side data): **`trust identity remove <npub|hex>`**.

You do **not** have to run **`trust init`** first if you only want your own key: **`trust identity import`** is enough. **`trust init`** is mainly for generating a new keypair and optional profile scaffolding.

### Agents and automation

- Point the process at a dedicated config dir so the agent’s key is isolated: e.g. set **`TRUST_CONFIG_DIR`** (or `HOME` with a fresh home) before running `trust` / `trust-mcp`.
- Avoid putting **`nsec`** or raw hex in shell history or committed files; prefer a secret manager, short-lived env var, or secure file read into **`--secret`** in a wrapper script.
- On disk, the key file stores the secret as **hex** (see `src/lib/identityStore.ts`); **`nsec`** is only an input format for **`identity import`**.

### SDK / MCP

There is no separate `importKey` on the public SDK today: configure identity **via the CLI** (or the same files written by **`trust identity import`**), then call **`add`**, **`resolve`**, or MCP tools—they load the **primary** key via `loadSecretKey()`.

## Context semantics

Resolver edge filter (query `context` vs stored `c` tag):

| Query `context` | Edges included |
|-----------------|----------------|
| `undefined` | All edges (no filter). |
| `""` | Only edges with **empty** context. |
| `"dev"` (example) | Edges with `c = "dev"` **or** `c = ""` (general carries into specific). |

**CLI normalization** (see [resolve.md](resolve.md)): no `-c` ⇒ treated as `""`; `-c undefined` ⇒ no filter.

## Resolve output formats

| `format` | Use |
|----------|-----|
| `number` | Single integer `trust - distrust`; good for policies and comparisons. |
| `default` | Full score object: `degree`, counts, `trustValue`, `connected`, etc. |
| `path` | Same plus per-hop trace for explanations. |

Score fields and BFS options (`maxDepth`, `stopWhenFound`, `followTrustThreshold`) are documented in [resolve.md](resolve.md). Implementation: `src/lib/trust/resolvers/trustResolver.ts`.

## Interfaces (how to invoke Trust)

### MCP (stdio)

Binary: `trust-mcp` (see package `bin`). Tools wrap the SDK and return **JSON text** content:

| Tool | Role |
|------|------|
| `trust_resolve` | Resolve one subject (`subject`, optional `author`, `context`, `format`, `maxDepth`). |
| `trust_resolve_batch` | Many subjects in one call. |
| `trust_add` | Publish kind 32010 (`subjects[]` as strings—see [Add: subject strings](#add-subject-strings), `value` 1/0/-1, optional `context`, `content`). |
| `trust_whoami` | Current identity or error if not initialized. |
| `trust_trusted` | List subjects trusted by author in context. |
| `trust_graph_stats` | Node/edge counts for loaded graph. |

Schema details: `src/mcp-server.ts`.

### CLI

Typical flow: `trust init` **or** `trust identity import …` → `trust add` / `trust sync` → `trust resolve … --json`. Identity subcommands: `trust identity import|list|generate|primary|remove`. Commands live under `src/commands/`. Full command surface: `src/cli.ts`.

### HTTP API

Server mode (`trust server`): REST routes include `/health`, `/identity`, `/trust`, `/resolve`, `/resolve/batch`, graph/stats, events, trusted; OpenAPI at `/docs`. Envelope: `{ ok, data }` / errors with codes. See [implementation/01-overview.md](implementation/01-overview.md).

### SDK (Node)

```ts
import { resolve, resolveBatch, add, whoami } from '@dtp/trust';
```

Options types: `ResolveOptions` (`authors`, `contexts`, `maxDepth`, `format`), `AddOptions` (`context`, `value`, `content`, `relay`, `relaysResolved`, `persistLocal`). File: `src/sdk.ts`. CLI `trust add` delegates to SDK `add()` (same parsing and tags).

## Add: subject strings

Strings passed to **`trust add`**, SDK **`add(subjects, …)`**, and MCP **`trust_add`** are parsed into NIP-32010 subject tags (`p`, `e`, `a`, `h`, `r`, `i`) plus optional **`k`** where the protocol allows.

| Input | Tag | `k` (when present) |
|--------|-----|---------------------|
| **`npub` / `nprofile`** | `p` | — |
| **`note` (NIP-19)** | `e` | **`1`** (short note kind) |
| **`nevent`** | `e` | Decimal kind string **only if** the pointer includes a kind |
| **`naddr`** or `kind:pubkey:d` | `a` | — |
| **Bare 64-char hex** | **`h`** (content hash) | — |
| **`p:` / `pubkey:`** + hex, `npub`, … | `p` | — |
| **`e:`** + hex, `note`, `nevent`, … | `e` | Same rules as bare `note`/`nevent` when value is NIP-19 |
| **`h:`** + 64 hex | `h` | — |
| **`a:`** + `naddr` or `kind:pubkey:d` | `a` | — |
| **`r:`** or `http(s)://…` | `r` | — |
| **NIP-73** (`isbn:`, `doi:`, …) or **`i:`** + id | `i` | Scheme (e.g. `isbn`, `doi`)—**`k` immediately after that `i` on the wire** |

**Authors** (`trust resolve --authors`, SDK `authors`, MCP `author`): bare 64-char hex is still treated as a **pubkey** (`p`), not a hash—this differs from **trust target** parsing.

Implementation: `src/lib/trust/subject.ts`, tag order in events: `src/lib/nostr/nip32010.ts`.

## Protocol and extensions

- **Core trust event**: [nips/NIP-32010.md](nips/NIP-32010.md).
- **Related NIPs** (indexes, bloom, delegate, rating, confirmation, link): listed in [README.md](README.md).
- **Architecture & design**: [implementation/01-overview.md](implementation/01-overview.md), [implementation/02-design.md](implementation/02-design.md).

## Examples

**CLI: resolve for automation**

```bash
trust resolve npub1… --json -c code-review
```

**HTTP: numeric policy**

```http
POST /resolve
Content-Type: application/json

{"subject": "npub1…", "context": "code-review", "format": "number"}
```

**SDK**

```ts
const score = await resolve('npub1…', {
  contexts: 'code-review',
  format: 'number',
});
```

## Pitfalls

- **No sync ⇒ empty or stale graph**: Resolve only sees what is loaded locally (or what the server has loaded).
- **`maxDepth` is hard-capped at 4** in the standard resolver; larger values are clamped.
- **Publishing trust is public**: Content and signatures are visible on relays; write sober, minimal `content`.
- **Subject spelling (add vs resolve target)**: For **trust targets**, bare 64-hex is a **hash** (`h`); use `p:` / `pubkey:` / `npub` for people. For **author** fields, bare 64-hex is still a **pubkey**. See [Add: subject strings](#add-subject-strings).
- **Do not infer global reputation**: Scores are **subjective** from the chosen author’s view, not an objective platform rating.
- **Protect signing keys**: `nsec` / hex secrets grant full Nostr signing for that pubkey; treat `~/.trust` (or `TRUST_CONFIG_DIR`) like SSH keys—restricted permissions, no leaks in logs or repos.

## Documentation map

Start at [README.md](README.md). Deep dives: [description.md](description.md) (vision, quick start), [resolve.md](resolve.md) (algorithm), NIPs under [nips/](nips/), implementation under [implementation/](implementation/).

## Using this file as a Cursor skill

Cursor loads skills from a folder containing `SKILL.md`. To use **this** guide as a project skill, copy or symlink this repo’s instructions into `.cursor/skills/<name>/SKILL.md` (for example `.cursor/skills/trust/SKILL.md`). Keep a single directory per skill; optional `reference.md` / `examples.md` can sit beside it. Do not place custom skills in `~/.cursor/skills-cursor/` (reserved for built-ins).
