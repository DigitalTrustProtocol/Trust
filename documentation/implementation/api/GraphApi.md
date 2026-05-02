# Graph API Interface

This document describes the HTTP API needed by the web graph integration in
`documentation/implementation/04-web.md`.

All responses use the existing API envelope:

```json
{ "ok": true, "data": {} }
```

Errors use:

```json
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "..." } }
```

## Identity

### `GET /v1/whoami`

Returns the server identity. This is the preferred name for the existing
identity API because it answers "who is this Trust server?".

`GET /v1/identity` remains available as a compatibility alias.

Response:

```json
{
  "ok": true,
  "data": {
    "publicKey": "<64-hex-pubkey>",
    "npub": "npub1...",
    "profile": {
      "name": "Trust Server"
    }
  }
}
```

## Graph Overview View

The overview expands a node by loading all direct trust connections from or to
that node. The web app can render positive values in green and negative values
in red.

Contexts are hierarchical. A query for `development:web` includes edges in:

1. `development:web`
2. `development`
3. the empty/general context

A query for `development` does not include child contexts like
`development:web`.

### `GET /v1/out`

Returns trust edges issued by an author.

Query:

| Name | Required | Description |
| --- | --- | --- |
| `author` | no | Pubkey as hex or npub. Defaults to the server identity. |
| `context` | no | Hierarchical context filter. Empty/general if omitted. |
| `value` | no | `1`, `0`, or `-1`. |
| `subjectType` | no | `p` for pubkeys or `i` for item keys. |
| `includeInactive` | no | `true` to include expired/not-yet-active edges. |

Response:

```json
{
  "ok": true,
  "data": {
    "author": "<author-pubkey>",
    "direction": "out",
    "connections": [
      {
        "author": "<author-pubkey>",
        "subject": "<subject-id>",
        "subjectType": "p",
        "edge": {
          "dTag": "<author+d-tag>",
          "author": "<author-pubkey>",
          "kind": 32010,
          "value": 1,
          "context": "development",
          "createdAt": 1700000000,
          "activate": 1700000000,
          "expire": 1800000000,
          "content": "optional explanation"
        }
      }
    ]
  }
}
```

### `GET /v1/in`

Returns incoming trust edges for a subject.

Query:

| Name | Required | Description |
| --- | --- | --- |
| `subject` | no | Subject id/input (hex, npub, URL, hash, etc.). Defaults to `author` alias or server identity. |
| `author` | no | Pubkey alias for `subject` when looking up incoming trust to a pubkey. |
| `context` | no | Hierarchical context filter. |
| `value` | no | `1`, `0`, or `-1`. |
| `subjectType` | no | `p` or `i`. Usually inferred by the stored node. |
| `includeInactive` | no | `true` to include expired/not-yet-active edges. |

Response shape is the same as `/v1/out`, with:

```json
{
  "subject": "<subject-id>",
  "direction": "in",
  "connections": []
}
```

## Resolve Detail View

### `POST /v1/resolve`

Already implemented. The graph detail view should call it with:

```json
{
  "author": "<from-pubkey>",
  "subject": "<to-subject>",
  "context": "development",
  "maxDepth": 4,
  "format": "path"
}
```

The result contains the path edges used for the author -> subject resolution.
The web app should render only those edges in the detail view, preserving the
overview graph state so users can navigate back without reopening nodes.

## Privacy / Account Actions

Existing endpoints:

- `GET /v1/privacy/access`
- `POST /v1/privacy/vanish`

These are account-level actions and should be exposed from a logged-in user's
privacy/settings page. The header dropdown should link to that page once it is
implemented.

## Metadata Notes

Pubkey metadata is currently populated from Nostr kind `0` events already
applied to graph nodes. Item-key metadata (`i` subjects such as hashes, URLs,
external IDs) is not modeled yet. For now:

- Return `identity` when present on a node.
- Render item nodes with the raw id or a deterministic generated icon/name.
- Add a future identity service that can map item ids to labels, URLs, and
  thumbnails without changing the `author` / `subject` / `edge` response shape.
