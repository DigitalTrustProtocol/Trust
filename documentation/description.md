# NIP-32010 Implementation Overview

## Purpose

The **Trust CLI** implements [NIP-32010](nips/NIP-32010.md) (Digital Web of Trust Reputation) to handle trust assertions on Nostr. Users can **issue** trust events (kind 32010) and **query** reputation for any target—identity, event, content hash, URL, or NIP-73 external content ID.

## Goals

1. **Issue trust** – Publish signed kind 32010 events to Nostr relays with subject (`p`, `e`, `a`, `h`, `r`, `i`/`k`), context (`c`), and value (`v`).
2. **Regular sync** – Synchronize with Nostr relay servers to keep the local cache up to date.
3. **Local resolve** – Use a local SQLite database to cache trust events for fast reputation resolution.




Design of the DB
The DB needs to hold the full event, for syncing etc.
1 table for all identities (Noun)
1 table for all connections between identities (Verb)


The idea is to have a raw event table, and then have specialized tables for resolution of reputation.
The identity table is for aggregation of data about an indentity.






