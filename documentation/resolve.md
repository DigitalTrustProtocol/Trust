# Resolve Algorithm

This document describes how the trust resolution algorithm works, including the search strategy and context semantics.

## Overview

The resolve algorithm finds a trust path from an **author** (a pubkey) to a **subject** (any identity: pubkey, event, etc.). It traverses the trust graph using breadth-first search and aggregates trust, neutral, and distrust counts along paths to the subject.

---

## Search (Default Strategy)

The default strategy performs a **breadth-first search (BFS)** from the author outward.

### Algorithm

1. **Initialize**  
   - Author is the root. Its score is set to `degree: 1`, `trust: 1`, `trustValue: 1`, etc. (self-trust).
2. **Self-resolution**  
   - If `author === subject`, return the author’s score immediately.
3. **BFS traversal**  
   - For each node at the current degree:
     - Fetch outgoing trust edges via `queryTrustByAuthor(nodeId, context)`.
     - For each edge `(author → nextId, value)`:
       - Add `value` to `nextId`’s `trustValue` and increment `trust`, `neutral`, or `distrust` based on `value` (1, 0, or -1).
       - If `nextId === subject`, mark as found.
       - If `nextId` not yet visited and not found, enqueue it and mark visited.
4. **Follow threshold**  
   - Only follow edges from nodes whose `trustValue >= followTrustThreshold` (default: 0.0). Nodes below the threshold are skipped.
5. **Stop conditions**  
   - Stop when subject is found (`stopWhenFound`, default: true) or when `maxDepth` (default: 4) is reached.
6. **Result**  
   - Return the subject’s aggregated score, or an empty score if no path exists.

### Options

| Option                   | Default | Description                                                                 |
|--------------------------|---------|-----------------------------------------------------------------------------|
| `maxDepth`               | 4       | Max graph distance (degree) to traverse. Each strategy defines its own max; user value can be smaller. |
| `stopWhenFound`          | true    | Stop as soon as the subject is reached.                                     |
| `followTrustThreshold`   | 0.0     | Only traverse nodes with `trustValue >=` this.                              |
| `respectDirectDistrust`  | true    | If enabled, keys directly distrusted by the author would be blocked (reserved for future use). |
| `context`                | —       | Context filter for edges (see below).                                       |

### Score Result (`IScoreResult`)

Each node/subject has:

- `degree` – path length from author
- `count` – number of paths reaching it
- `trustValue` – sum of edge values (1, 0, -1)
- `trust`, `neutral`, `distrust` – counts of edges with value 1, 0, -1
- `connected` – whether a path exists

---

## Context Semantics

Trust edges can have a `context` (from the `c` tag in NIP-32010 events). The resolve algorithm filters edges by context before following them.

### Query behavior (`queryTrustByAuthor`)

| `context` value | Behavior |
|-----------------|----------|
| `undefined`     | **No filter** – include all edges, regardless of context. |
| `""` (empty string) | **Only empty context** – include only edges where `context = ''`. |
| Non-empty (e.g. `"dev"`) | **Specific or general** – include edges where `context = 'dev'` **or** `context = ''` (empty acts as general scope). |

### Why empty acts as general

Empty context `""` is treated as “applies to any scope”. So when you query with `"dev"`:

- Edges with `context = 'dev'` match (explicit dev trust).
- Edges with `context = ''` also match (general trust applies to dev too).

### CLI normalization (`normalizeContext`)

| CLI input             | Result      |
|-----------------------|------------|
| No `-c` flag          | `""`       |
| `-c undefined`        | `undefined` (no context filter) |
| `-c dev`, `-c ""`, etc. | String used as-is |

---

## Summary

- **Search**: BFS from author, level-by-level, up to `maxDepth`.
- **Context**:  
  - `undefined` = all contexts  
  - `""` = only empty-context edges  
  - Non-empty = that context or empty (general) edges.
- **Follow threshold**: Only traverse nodes with `trustValue >= followTrustThreshold`.
