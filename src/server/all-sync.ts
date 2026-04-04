import { NPool } from "@nostrify/nostrify";
import { subscriptionOptions } from "./relay-sub.js";
import { KIND_TRUST } from "../lib/nostr/nip32010.js";
import { insertEvent } from "../lib/trust/graphManager.js";
import { TIMESTAMP_NS_SYNC, trackLatestTimestamp } from "../lib/timestamp.js";
import { startRelaySubscription } from "./relay-sub.js";
import { createTrustFilters, GraphSyncResult } from "./graph-sync.js";
import { logger } from "../lib/logger.js";
import { RuntimeContext } from "../lib/runtimeContext.js";
import { Store } from "../lib/db/dbManager.js";
import { Graph } from "../lib/trust/graph/Graph.js";
import { run } from "node:test";
import { Filter } from "nostr-tools";

export async function subscribeToAll(runtimeContext: RuntimeContext): Promise<GraphSyncResult> {
    let visitedEvent = new Set<string>();
    const { relays, since, pool, graph, store, contexts, json, statusCallback } = runtimeContext;
    const signal = runtimeContext.abortController?.signal ?? new AbortSignal();
    let latestTimestamp = 0;
    let eventsReceived = 0;
    let eventsInserted = 0;

    const filters: Filter[] = createTrustFilters(runtimeContext.kinds, undefined, since, contexts);

    const options: subscriptionOptions = {
      relays,
      filters,
      pool: pool as NPool,
      signal,
      onEvent: async (event) => {
        eventsReceived++;
        if (visitedEvent.has(event.id)) return; // already inserted
        visitedEvent.add(event.id);
  
        let inserted = await insertEvent(event, runtimeContext);
        if (inserted) {
          eventsInserted++;
          latestTimestamp = Math.max(latestTimestamp, await trackLatestTimestamp(TIMESTAMP_NS_SYNC, [event]));
        }
        statusCallback?.(`Received ${eventsReceived} events. Inserted ${eventsInserted} events.` as string);
      },
      onClosed: (subscriptionID, reason) => {
        return true; // stop the subscription
      },
      onEose: (subscriptionID) => {
        return true; // stop the subscription
      },
      onError: (error) => {
        logger.error(`Relay subscription error: ${error}`);
      },
    };

    await startRelaySubscription(options);

    return {
      processedAuthors: visitedEvent.size,
      eventsReceived,
      eventsInserted,
      latestTimestamp: 0,
    };
  }