# Why NIP-32010 Is Needed

This document explains why a dedicated trust event (`kind:32010`) is still needed, even if clients also consume computed assertions like [NIP-85](https://nips.nostr.com/85).

## Short answer

`32010` is needed because it stores the **raw, user-authored trust intent** (trust/neutral/distrust) that trust graphs are built from.  
NIP-85 is primarily a **derived-results layer** produced by trusted service providers.

They solve different problems and are best used together.

---

## Problem to solve

A decentralized trust system needs a canonical way to represent:

- who trusts whom (or distrusts),
- in which context,
- with what current state (latest assertion),
- and for which subject type (user, event, address, content, external id).

This must be directly authored by users and independently recomputable by any client.

---

## What `32010` provides that is essential

1. **First-class trust edge primitive**
   - `v` is explicit (`1`, `0`, `-1`).
   - This is graph input data, not an interpretation.

2. **User-origin trust intent**
   - Any observer can recompute trust outcomes from signed user assertions.
   - No mandatory dependence on a scoring provider.

3. **Contextual trust**
   - `c` scope allows "trust in development" and "distrust in commerce" to coexist.
   - Critical for real-world trust where competence is domain-specific.

4. **Deterministic replaceable state**
   - Same author + subject + context resolves to latest event.
   - Revocation and correction are native behavior.

5. **Pure trust graph traversal semantics**
   - Positive trust edges are the t1 expansion basis.
   - Other attribute kinds (`32014`, `32015`, `32016`) are intentionally non-traversal.

6. **Subject universality**
   - Trust targets include pubkeys and non-pubkey subjects (events, addressables, hashes, URLs, external ids).

---

## What NIP-85 is great at

NIP-85 is strong for **computed assertions**:

- offloading heavy ranking/aggregation to providers,
- standardized result tags (`rank`, counts, etc.),
- fast client UX without full local graph computation,
- user-chosen providers via kind `10040`.

This makes NIP-85 excellent as a **serving/distribution layer** for computed reputation-like outputs.

Reference: [NIP-85 - Trusted Assertions](https://nips.nostr.com/85)

---

## Why NIP-85 cannot fully replace `32010`

NIP-85 does not natively replace the role of `32010` when the goal is **pure trust**:

1. **Different abstraction level**
   - `32010`: raw trust assertions (input layer).
   - NIP-85: computed metrics/assertions (output layer).

2. **Provider dependency**
   - NIP-85 assumes trusted service keys for calculation/publication.
   - `32010` can operate without delegated computation.

3. **Trust intent vs trust score**
   - A rank is not equivalent to a signed per-edge trust/distrust statement.
   - Many trust policies require explicit negative edges and contextual logic.

4. **Auditability of reasoning**
   - With `32010`, any client can inspect and recompute from base assertions.
   - With NIP-85 alone, users trust provider methodology and freshness.

5. **Protocol role in this stack**
   - `32010` is foundational in this project's trust model.
   - `32011`/`32012` optimize retrieval/completeness of that base data.

---

## Recommended model

Use a two-layer approach:

- **Layer 1 (ground truth):** `32010` user-authored trust assertions.
- **Layer 2 (derived service):** NIP-85 computed assertions for convenience and scale.

In practical terms:

- `32010` answers: **"What do I (or my trusted graph) explicitly trust?"**
- NIP-85 answers: **"What did my selected provider compute for me?"**

This keeps trust sovereign and verifiable while still enabling high-performance UX.

