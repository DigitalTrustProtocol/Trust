import { NPool } from "@nostrify/nostrify";
import { subscriptionOptions } from "./relay-sub.js";
import { KIND_TRUST } from "../lib/nostr/nip32010.js";
import { insertEvent } from "../lib/trust/graphManager.js";
import { trackLatestTimestamp } from "../lib/timestamp.js";
import { startRelaySubscription } from "./relay-sub.js";
import { GraphSyncParams, GraphSyncResult } from "./graph-sync.js";
import { logger } from "../lib/logger.js";

export async function subscribeToAll(params: GraphSyncParams): Promise<GraphSyncResult> {
    let visitedEvent = new Set<string>();
    const { relays, since, pool, graph, store, json, statusCallback } = params;
    const signal = params.abortController?.signal ?? new AbortSignal();
    let latestTimestamp = 0;
    let eventsReceived = 0;
    let eventsInserted = 0;
    const options: subscriptionOptions = {
      relays,
      since,
      kinds: [KIND_TRUST], // subscribe to both trust and user metadata events
      pool,
      signal,
      onEvent: async (event) => {
        eventsReceived++;
        if (visitedEvent.has(event.id)) return; // already inserted
        visitedEvent.add(event.id);
  
        let inserted = await insertEvent(event, { store: store, graph: graph });
        if (inserted) {
          eventsInserted++;
          latestTimestamp = Math.max(latestTimestamp, await trackLatestTimestamp([event]));
        }
        statusCallback?.({
          processedAuthors: visitedEvent.size,
          eventsReceived,
          eventsInserted,
          latestTimestamp: 0,
        });
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