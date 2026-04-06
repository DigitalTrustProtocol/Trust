# Trust Documentation

## Overview

Trust is a decentralized Web of Trust reputation system built on Nostr, designed for AI agents as first-class citizens. This documentation covers the project vision, technical architecture, and implementation details.

## Documents

### Project

| Document | Description |
|----------|-------------|
| [Project Description](description.md) | Vision, design principles, AI-first philosophy, quick start |
| [NIP-58 vs NIP-32010](nip58-vs-nip32010.md) | Why a dedicated trust protocol over Nostr badges |

### Implementation

| Document | Description |
|----------|-------------|
| [System Architecture](implementation/01-overview.md) | Module map, data flow, runtime context, deployment modes |
| [Technical Design](implementation/02-design.md) | Data model, in-memory graph, resolver algorithm, database layer, server plugins |
| [Implementation Status & Roadmap](implementation/03-roadmap.md) | Component completion status, remaining work, future plans |

### Algorithm

| Document | Description |
|----------|-------------|
| [Resolve Algorithm](resolve.md) | BFS trust resolution, context semantics, scoring |

### Protocol Specifications (NIPs)

| Document | Description |
|----------|-------------|
| [NIP-32010](nips/NIP-32010.md) | Trust event (kind 32010) — core protocol |
| [NIP-32011](nips/NIP-32011.md) | Event completeness index — sync optimization |
| [NIP-32012](nips/NIP-32012.md) | Subject bloom filter — membership testing |
| [NIP-32013](nips/NIP-32013.md) | Delegate trust — dual-signed delegation |
| [NIP-32014](nips/NIP-32014.md) | Subject rating — numeric scoring |
| [NIP-32015](nips/NIP-32015.md) | Subject confirmation — boolean acknowledgment |
| [NIP-32016](nips/NIP-32016.md) | Subject link — URL/source binding |

## Architecture Quick Reference

```
trust (npm package)
├── CLI Client        — Commander-based, all commands
├── HTTP Server       — Fastify, REST API (/trust, /resolve, /health)
├── Relay Facade      — WebSocket NIP-01 relay (/relay)
├── Web Dashboard     — React SPA (planned: graph viz, search, management)
├── In-Memory Graph   — Node/Edge model, BFS resolver
├── Database          — SQLite (default) or Postgres
└── Nostr Layer       — NPool relay connections, event signing
```
