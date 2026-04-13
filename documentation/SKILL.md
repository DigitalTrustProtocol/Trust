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
| `trust_add` | Publish kind 32010 (`subjects[]`, `value` 1/0/-1, optional `context`, `content`). |
| `trust_whoami` | Current identity or error if not initialized. |
| `trust_trusted` | List subjects trusted by author in context. |
| `trust_graph_stats` | Node/edge counts for loaded graph. |

Schema details: `src/mcp-server.ts`.

### CLI

Typical flow: `trust init` → `trust add` / `trust sync` → `trust resolve … --json`. Commands live under `src/commands/`. Full command surface: `src/cli.ts`.

### HTTP API

Server mode (`trust server`): REST routes include `/health`, `/identity`, `/trust`, `/resolve`, `/resolve/batch`, graph/stats, events, trusted; OpenAPI at `/docs`. Envelope: `{ ok, data }` / errors with codes. See [implementation/01-overview.md](implementation/01-overview.md).

### SDK (Node)

```ts
import { resolve, resolveBatch, add, whoami } from '@dtp/trust';
```

Options types: `ResolveOptions` (`authors`, `contexts`, `maxDepth`, `format`), `AddOptions` (`context`, `value`, `content`). File: `src/sdk.ts`.

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
- **Subject spelling**: Use stable canonical forms (hex pubkeys on wire; CLI/SDK accept npub and other parsers per `subject` helpers).
- **Do not infer global reputation**: Scores are **subjective** from the chosen author’s view, not an objective platform rating.

## Documentation map

Start at [README.md](README.md). Deep dives: [description.md](description.md) (vision, quick start), [resolve.md](resolve.md) (algorithm), NIPs under [nips/](nips/), implementation under [implementation/](implementation/).

## Using this file as a Cursor skill

Cursor loads skills from a folder containing `SKILL.md`. To use **this** guide as a project skill, copy or symlink this repo’s instructions into `.cursor/skills/<name>/SKILL.md` (for example `.cursor/skills/trust/SKILL.md`). Keep a single directory per skill; optional `reference.md` / `examples.md` can sit beside it. Do not place custom skills in `~/.cursor/skills-cursor/` (reserved for built-ins).
