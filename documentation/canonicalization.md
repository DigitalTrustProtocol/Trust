# Canonicalization Rules

This document defines how Trust data is canonicalized before storage, graph processing, and `d` derivation.

The goal is to minimize subtle input differences caused by human entry (extra spaces, inconsistent case, duplicate separators, trailing slashes) and produce stable identifiers across implementations.

## Scope

These rules apply to:
- Subject values (`p`, `i`, and legacy tags mapped to `i`)
- Context scopes (`c`)
- Derived identifiers (`d`)

## General Principles

- Trim surrounding whitespace.
- Normalize case where the data type is treated case-insensitively.
- Remove structurally empty segments.
- Keep one canonical representation for semantically equivalent input.
- Prefer deterministic behavior over preserving cosmetic input formatting.

## Data Type Rules

### 1) Pubkey (`p`)

Rules:
- `trim()`
- lowercase

Example:
- Input: ` " ABCDEF... " `
- Output: `abcdef...`

## 2) Context scope (`c`)

Rules:
- null/undefined -> `""`
- `trim()`
- lowercase
- split by `:`
- trim each segment
- drop empty segments
- rejoin with `:`

Effects:
- leading/trailing `:` are removed
- repeated separators collapse
- colon only remains between non-empty segments

Examples:
- `":security"` -> `security`
- `"security:"` -> `security`
- `"software::security:::validated"` -> `software:security:validated`
- `"  software : security  "` -> `software:security`
- `"::"` -> `""`

## 3) Typed subject (`i`)

Base parsing:
- `trim()`
- normalize whitespace around colons (`a : b : c` -> `a:b:c`)
- parse as `<kind>:<rest>`
- lowercase `kind`

Dispatch by kind:

### 3.1) `nostr:<type>:<value>`

Rules:
- normalize and lowercase `<type>`
- `trim()` and lowercase `<value>`
- output `nostr:<type>:<value>`

Examples:
- `" nostr : event : ABCDEF "` -> `nostr:event:abcdef`

### 3.2) `hash:<value>`

Rules:
- `trim()`
- lowercase
- remove leading `0x` if present
- remove non-hex characters
- output `hash:<hex>`

Examples:
- `"hash: 0xAA-BB_cc 11"` -> `hash:aabbcc11`

### 3.3) `web:<url>`

Rules:
- `trim()`
- if scheme missing, prefix `https://`
- parse with URL parser if possible
- lowercase scheme + host (and final output is lowercased)
- remove default port (`:80` for `http`, `:443` for `https`)
- collapse duplicate `/` in path
- remove trailing `/` from path except root
- keep query string
- drop fragment (`#...`)
- output `web:<normalized-url>`
- if parsing fails, fallback to lowercased input with repeated/trailing slash cleanup

Examples:
- `HTTPS://Example.COM:443//Trust///Path/?q=1#frag`
  -> `web:https://example.com/trust/path?q=1`
- `example.com/path/`
  -> `web:https://example.com/path`

### 3.4) `ext:<value>` and `email:<value>`

Rules:
- `trim()`
- lowercase

Outputs:
- `ext:<normalized>`
- `email:<normalized>`

### 3.5) Unknown typed kinds

Rule:
- output `<kind>:<rest.toLowerCase()>` after base parsing.

## 4) Legacy subject tags -> typed `i`

Mappings:
- `e` -> `nostr:event:<value>`
- `a` -> `nostr:addr:<value>`
- `h` -> `hash:<value>`
- `r` -> `web:<value>`

These then follow the typed canonicalization behavior above.

## 5) `d` derivation interactions

Canonicalization impacts `d`:
- Subject values are canonicalized before preimage/fragment generation.
- Context is canonicalized before appending `|context`.
- Empty canonical context means no suffix is appended.

Therefore, equivalent dirty inputs should produce the same `d`.

---

## External Standards and Guidance

This project aligns with widely used standards where practical, while documenting project-specific choices.

- URI generic syntax and normalization guidance: [RFC 3986](https://datatracker.ietf.org/doc/html/rfc3986)
- Internationalized domain names framework: [RFC 5890 (IDNA)](https://datatracker.ietf.org/doc/html/rfc5890)
- Unicode normalization forms: [UAX #15](https://www.unicode.org/reports/tr15/)
- URL parsing behavior widely used by runtimes/browsers: [WHATWG URL Standard](https://url.spec.whatwg.org/)
- Email syntax/transport semantics: [RFC 5321](https://datatracker.ietf.org/doc/html/rfc5321), [RFC 5322](https://datatracker.ietf.org/doc/html/rfc5322)

### Notes on standards vs project policy

- RFC 3986 normalization is conservative; not all transformations are always semantics-preserving for every server.
- This project intentionally applies stronger normalization in some places (for example lowercasing the full normalized `web:` URL output) to maximize deduplication and interoperability inside Trust graphs.
- Implementations should follow this document for protocol compatibility with this system, even where behavior is stricter than generic web URL equivalence guidance.

---

## Conformance Recommendations

For compatible implementations:
- Reproduce these rules exactly at ingest and before event construction.
- Add golden tests for:
  - mixed case
  - leading/trailing whitespace
  - repeated separators (`::`, `//`)
  - trailing slash/no trailing slash
  - default ports
  - `0x` and punctuation in hashes
- Ensure the same canonical inputs always produce the same `d` output.

