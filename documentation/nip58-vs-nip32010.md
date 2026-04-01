# NIP-58 Badges vs NIP-32010: Trust Graph Comparison

This document compares using NIP-58 badges vs NIP-32010 for building a trust graph on Nostr.

## Overview

**NIP-58 Badges:** Define badges (e.g., 1=trust, 0=neutral, -1=distrust) and issue kind 8 events to pubkeys with one of those badges.

**NIP-32010:** A dedicated trust event kind (32010) with subject tags, context, value, and replaceable semantics.

---

## NIP-58 Badges (Kind 8)

- **Badge Definition (30009):** Issuer creates badges, e.g. `trust`, `neutral`, `distrust`.
- **Badge Award (8):** `a` tag points to the definition, `p` tags list recipients.
- **Subjects:** Pubkeys only (`p` tags).
- **Structure:** One kind 8 = one badge type awarded to many recipients.
- **Mutation:** Immutable; no revocation or replacement built-in.
- **Context:** None; badges are global.

---

## NIP-32010

- **Subjects:** Pubkeys (`p`), events (`e`), addressable events (`a`), hashes (`h`), URLs (`r`), NIP-73 IDs (`i`).
- **Context:** `c` tag (e.g. "development", "commerce", "security").
- **Value:** `v` tag: 1, 0, or -1.
- **Mutation:** Replaceable event (latest-wins per author+subject+context).
- **Content:** Optional human-readable note per assertion.
- **Batching:** Multiple subjects in one event (e.g. batch distrust botnet).

---

## Benefits Comparison

| Aspect | NIP-58 Badges | NIP-32010 |
|--------|---------------|-----------|
| **Subject types** | Pubkeys only | Pubkeys, events, content hashes, URLs, ISBN, DOI, etc. |
| **Context** | None | Arbitrary (per-context trust) |
| **Revocation / update** | Immutable; awkward | Replaceable; latest-wins |
| **Profile display** | Native (Profile Badges 30008) | None (trust is computed) |
| **Semantics** | Generic "award" | Explicit trust/distrust/neutral |
| **Batch operations** | One badge, many `p` tags | One event, many subjects |
| **Explanation** | Badge description only | Per-assertion content |
| **Interop** | Badge-aware clients (profiles, leaderboards) | Trust-aware clients (reputation, filters) |
| **Complexity** | 3 event kinds (30009, 8, 30008) | 1 event kind |

---

## Does NIP-32010 Still Make Sense?

**Yes**, especially for trust graphs and reputation.

1. **Trust extends beyond identities.** You may want to rate events, content hashes, URLs, articles (NIP-73), etc. Badges only point at pubkeys. NIP-32010 supports `p`, `e`, `a`, `h`, `r`, `i`.

2. **Context is essential.** Trust in "code review" vs "commerce" are different edges. Badges have no context; NIP-32010's `c` tag models this directly.

3. **Trust changes over time.** Replaceable events with latest-wins support revocation and updates. Badges are immutable—revocation would require awarding a different badge or custom logic.

4. **Trust graph semantics.** NIP-32010 is designed for graph resolution: query by subject, apply latest-wins, aggregate. Badges are designed for "who has which badge" and profile display.

5. **Complementary purposes.** Badges are for recognition and display. Trust events are for reputation computation, moderation, and risk assessment.

---

## When NIP-58 Alone Suffices

NIP-58 badges can be enough if:

- You only care about **identity-level** trust (no events, hashes, URLs).
- You don't need **contexts** (all trust is global).
- You don't need **revocation** (or can model it with multiple badge types).
- You prefer **profile display** (badges shown on profiles) over algorithmic trust resolution.

---

## Using Both Together

You can use both:

- **Badges** for user-facing recognition and profile display.
- **NIP-32010** for contextual trust, event/content trust, revocation, and reputation computation.

The badge system does not supersede NIP-32010 for trust graphs; they serve different purposes and can coexist.
