# Resolve Algorithm

This document describes how the trust resolution algorithm works, including the search strategy, context semantics, and scoring model.

---

## Overview

The resolve algorithm finds a trust path from an **author** (a pubkey) to a **subject** (any identity: pubkey, event, content hash, URL, or external ID). It traverses the in-memory trust graph using breadth-first search and aggregates trust, neutral, and distrust counts along all paths to the subject.

**Implementation:** `src/lib/trust/resolvers/trustResolver.ts` (`standardResolver`)

---

## Algorithm (Standard BFS Resolver)

### 1. Initialize

- The author is the root node with `degree = 0`, `trustValue = 1` (self-trust).
- Create a `ScoreMap` to track accumulated scores for all visited nodes.

### 2. Self-Resolution

- If `author === subject`, return the author's score immediately (trivially trusted).

### 3. Precompute Subject Incoming Edges

- Build a map of all incoming edges to the subject that are valid at the current time.
- This allows O(1) checks for "does this node have a direct edge to the subject?" during BFS.
- Time validity is enforced via `x` (activate) and `y` (expire) tags from NIP-32010.

### 4. BFS Traversal

For each depth level from 1 to `maxDepth` (hard cap = 4):

1. **Check direct connections:** For each node in the current queue, look up precomputed incoming edges from that node to the subject. If found, accumulate score on the subject.

2. **Expand outgoing edges:** Walk the node's outgoing trust edges:
   - Include edges matching the requested **context**.
   - Also include edges with **empty context** (`""`) as fallback — empty context acts as "general trust" that applies to any specific context.
   - Only expand to nodes not yet visited.

3. **Follow threshold:** Only traverse through nodes whose accumulated `trustValue >= followTrustThreshold` (default: 0.0). Nodes below the threshold are dead ends.

4. **Stop condition:** If `stopWhenFound` (default: true) and the subject has been reached, stop expanding.

### 5. Result

Return the subject's `Score` from the `ScoreMap`, or an empty score (`connected: false`) if no path exists.

---

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxDepth` | 4 | Maximum hops from author to subject. Hard-capped at 4 by the resolver. User-provided values can be smaller but not larger. |
| `stopWhenFound` | true | Stop BFS as soon as any path reaches the subject. Set to false to explore all paths up to maxDepth. |
| `followTrustThreshold` | 0.0 | Minimum accumulated `trustValue` for a node to be traversed. Filters out nodes that have been distrusted by earlier hops. |
| `context` | — | Context filter for edge selection (see Context Semantics below). |
| `format` | `default` | Output format: `number`, `default`, or `path`. |

---

## Score Result

Each node reached by BFS accumulates a score:

| Field | Type | Description |
|-------|------|-------------|
| `degree` | number | Shortest path length from author (hop count) |
| `count` | number | Number of distinct edges reaching this node |
| `trustValue` | number | Sum of edge values along all paths (positive = net trust) |
| `trust` | number | Count of positive (+1) edges |
| `neutral` | number | Count of neutral (0) edges |
| `distrust` | number | Count of negative (-1) edges |
| `connected` | boolean | Whether any path from author reached the subject |
| `from` | Set | Predecessor pubkeys (for deduplication — each author counted once) |
| `path` | TrustPath? | Detailed per-hop trace (only when `format = 'path'`) |

---

## Output Formats

| Format | Output | Use Case |
|--------|--------|----------|
| `number` | Single integer: `trust - distrust` | AI decision-making, scripts, threshold checks |
| `default` | Full score object with all fields | General inspection and debugging |
| `path` | Score + array of trust path elements with per-hop edge metadata | Explainability, audit trails, understanding why trust exists |

The `path` format uses `pathStrategy` (`src/lib/trust/resolvers/pathStrategy.ts`) to reconstruct the chain of edges from author through intermediaries to the subject.

---

## Context Semantics

Trust edges carry a `context` from the `c` tag in NIP-32010 events. The resolver filters edges by context during traversal.

### Query Behavior

| Query `context` | Edges Included | Rationale |
|-----------------|----------------|-----------|
| `undefined` | **All edges**, regardless of context | No filtering — see the full picture |
| `""` (empty string) | **Only** edges where `context = ""` | Explicitly query "general/unscoped" trust only |
| `"dev"` (specific) | Edges where `context = "dev"` **or** `context = ""` | Specific context + general trust as fallback |

### Why Empty Context Acts as General

Empty context (`""`) means "this trust applies universally." When resolving with a specific context like `"dev"`:

- Edges with `context = "dev"` match explicitly.
- Edges with `context = ""` also match because general trust applies to all domains.

This allows a trust assertion with no context to serve as a baseline that carries into any specific context query, while still allowing context-specific overrides.

### CLI Context Normalization

| CLI Input | Resolved Value | Effect |
|-----------|---------------|--------|
| No `-c` flag | `""` | Query with empty context (general trust only) |
| `-c undefined` | `undefined` | No context filter (all contexts) |
| `-c dev` | `"dev"` | Specific context + general fallback |
| `-c ""` | `""` | Explicit empty context |

---

## Examples

### Simple Trust Chain

```
Alice  ──trust(dev)──►  Bob  ──trust(dev)──►  Charlie
```

`trust resolve Charlie Alice -c dev` → `{ trustValue: 1, trust: 1, degree: 2, connected: true }`

### Trust with General Fallback

```
Alice  ──trust("")──►  Bob  ──trust(dev)──►  Charlie
```

`trust resolve Charlie Alice -c dev` → connected: Alice's general trust in Bob carries into the dev context.

### Distrust Blocks Traversal

```
Alice  ──trust──►  Bob  ──trust──►  Eve  ──trust──►  Charlie
Alice  ──distrust──►  Eve
```

With `followTrustThreshold = 0`: Eve's `trustValue` becomes 0 (trust from Bob + distrust from Alice), so traversal stops at Eve.

---

## Performance Characteristics

- **Time complexity:** O(N + E) where N = nodes visited, E = edges traversed. Bounded by `maxDepth` (max 4) and graph density.
- **Space complexity:** O(N) for the score map and BFS queue.
- **In practice:** Resolution is sub-millisecond for typical trust graphs (hundreds to thousands of nodes) since it operates on the in-memory graph with no database access.

---

## References

- [Technical Design](implementation/02-design.md) — Graph model and resolver internals
- [NIP-32010](nips/NIP-32010.md) — Trust event specification (context, time windows, subjects)
