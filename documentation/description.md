# Trust — Decentralized Identity and Reputation for AI

## Vision

**Trust** is a decentralized Web of Trust reputation system built on [Nostr](https://nostr.com/). It gives AI agents — and humans — a cryptographic identity and a way to build, query, and verify trust relationships across the open internet.

Just as a RAG database gives AI long-term memory, **Trust gives AI long-term identity and reputation**. An agent can accumulate trust from the entities it interacts with, present that trust to new counterparts, and make informed decisions about who and what to trust — all without a central authority.

AI is the **first-class citizen**. Every design decision — the CLI, the HTTP API, the JSON output, the programmatic resolve — is optimized for machine consumption. Humans benefit from the same system, but the interface is built for agents first.

## The Problem

AI agents operate in an open, adversarial environment. They encounter other agents, services, content, and identities with no built-in way to assess trustworthiness. Current solutions are centralized (API keys, OAuth tokens, platform-specific reputation) and break down in decentralized or cross-platform contexts.

Humans face the same problem: trust is siloed inside platforms, non-portable, and opaque.

## The Solution

Trust builds a **portable, verifiable, decentralized trust graph** using Nostr's signed event model:

- **Identity** — Each participant (AI or human) gets a Nostr keypair. The private key signs trust assertions; the public key is the verifiable identity.
- **Trust assertions** — Signed statements (`kind 32010`) that say "I trust/distrust this subject in this context." Subjects can be identities, events, content hashes, URLs, or external IDs (ISBN, DOI, etc.).
- **Trust graph** — The collection of all trust assertions forms a directed graph. Trust is resolved by traversing this graph from a chosen perspective (author) toward a subject.
- **Decentralized storage** — Assertions are published to Nostr relays, replicated across the network, and cached locally for fast resolution.

## Design Principles

1. **AI-first** — JSON everywhere, machine-readable output, HTTP API for programmatic access, CLI flags for scripting, structured resolve results.
2. **One app, all roles** — A single `npm` package serves as CLI client, HTTP server, Nostr relay facade, and web dashboard. Install once, configure for your role.
3. **Enterprise-ready** — Split services (`--service relay`, `--service api`, `--service web`) share a database for multi-instance deployments. SQLite for single-node, Postgres for scale.
4. **Nostr-native** — Built on [NIP-32010](nips/NIP-32010.md) (trust events) with the full Nostr relay protocol. Interoperable with any Nostr client or relay.
5. **Context-aware** — Trust is scoped by context (`development`, `commerce`, `security`, etc.). An agent trusted for code review is not automatically trusted for financial advice.
6. **Offline-capable** — The local database and in-memory graph allow trust resolution without network access. Sync when connected, resolve when not.

## How AI Uses Trust

### Gaining Identity
```bash
trust init --name "CodeReview-Agent-v3" --about "Automated code review agent"
```
The agent now has a Nostr keypair — a persistent, verifiable identity.

### Building Reputation
```bash
trust add <agent-npub> -v 1 -c "code-review" --content "Reliable reviewer"
```
Other agents or human operators issue trust assertions toward the agent, building its reputation in specific contexts.

### Querying Trust
```bash
trust resolve <subject-npub> -c "code-review" --json
```
Before acting on output from another agent, an AI can resolve trust from its own perspective: "Do I have a path of trust to this entity in the code-review context?"

### Programmatic API
```
POST /resolve
{ "subject": "<npub>", "context": "code-review", "format": "number" }
→ { "value": 3 }
```
The HTTP server provides the same capabilities for agents that prefer REST over CLI.

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────┐
│                    trust (npm package)                   │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────┐  ┌───────────┐  │
│  │   CLI    │  │  Server  │  │ Relay │  │    Web    │  │
│  │ (client) │  │ (HTTP)   │  │ (WS)  │  │ (SPA)    │  │
│  └────┬─────┘  └────┬─────┘  └───┬───┘  └─────┬─────┘  │
│       │              │            │             │        │
│       └──────────────┴────────────┴─────────────┘        │
│                          │                               │
│              ┌───────────┴───────────┐                   │
│              │   In-Memory Graph     │                   │
│              │  (Node / Edge / BFS)  │                   │
│              └───────────┬───────────┘                   │
│                          │                               │
│              ┌───────────┴───────────┐                   │
│              │   Database Layer      │                   │
│              │  (SQLite / Postgres)  │                   │
│              └───────────────────────┘                   │
└─────────────────────────────────────────────────────────┘
                           │
                    Nostr Relay Network
```

## Quick Start

```bash
# Install from npm
npm install -g @dtp/trust

# Initialize identity
trust init --name "My Agent"

# Trust someone
trust add npub1abc... -v 1 -c development

# Sync from relays
trust sync

# Resolve trust
trust resolve npub1xyz... -c development --json

# Run server (all services)
trust server

# Run server (enterprise split)
trust server --service relay --database postgres
trust server --service api --database postgres
```

## Project Status

The core implementation is complete:

| Component | Status |
|-----------|--------|
| Identity management (keypairs, multi-key) | Done |
| Trust event creation and publishing (NIP-32010) | Done |
| Relay sync (graph-based and subscribe-all) | Done |
| In-memory trust graph (Node/Edge model) | Done |
| BFS trust resolution with context support | Done |
| SQLite storage | Done |
| Postgres storage | Done |
| HTTP server (Fastify) with REST API | Done |
| WebSocket relay facade (NIP-01) | Done |
| Split service architecture | Done |
| CLI with full command set | Done |
| Web dashboard (graph visualization, search, management) | Planned |

## Related Documentation

- [Implementation Overview](implementation/01-overview.md) — System architecture and module map
- [Technical Design](implementation/02-design.md) — Data model, graph, resolver, database
- [Implementation Status & Roadmap](implementation/03-roadmap.md) — What's done, what's next
- [Resolve Algorithm](resolve.md) — BFS trust resolution and context semantics
- [NIP-32010 Specification](nips/NIP-32010.md) — The trust event protocol
- [NIP-58 vs NIP-32010](nip58-vs-nip32010.md) — Why a dedicated trust protocol
