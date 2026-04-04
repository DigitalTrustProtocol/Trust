import { NPool } from "@nostrify/nostrify";
import { getStore, Store } from "./db/dbManager.js";
import { Graph } from "./trust/graph/Graph.js";
import {  ResolvedRuntimeConfig } from "../config.js";
import { getAvailableRelays, getPool } from "./nostr/pool.js";
import pino from "pino";
import { getLoadedGraph } from "./trust/graphManager.js";

let runtimeContext: RuntimeContext | null = null;

export interface RuntimeContext extends ResolvedRuntimeConfig {

    graph: Graph | null;
    store: Store | null;
    pool: NPool | null;

    statusCallback?: (status: string) => void;
    abortController: AbortController;
    loggerInstance?: pino.Logger;
}


export async function createRuntimeContext(config: ResolvedRuntimeConfig): Promise<RuntimeContext> {
    const abortController = new AbortController();

    return {
        ...config,
        graph: null,
        store: null,
        pool: null,
        statusCallback: undefined,
        abortController,
    };
}


export async function getRuntimeContext(config: ResolvedRuntimeConfig): Promise<RuntimeContext> {
    if (!runtimeContext) {  
        runtimeContext = await createRuntimeContext(config);
    }
    return runtimeContext;
}

export function setRuntimeContext(context: RuntimeContext): void {
    runtimeContext = context;
}


export async function setupRelayPool(runtimeContext: RuntimeContext): Promise<void> {
    const relaySelection = await getAvailableRelays(runtimeContext.relays);
    const relays = relaySelection.selected;
  
    if (relaySelection.offline.length > 0) {
      runtimeContext.statusCallback?.(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
    }
  
    runtimeContext.relays = relays;
    runtimeContext.pool = getPool(0, relays);
}

export async function setupStore(runtimeContext: RuntimeContext): Promise<void> {
    runtimeContext.statusCallback?.('Initializing trust database...');
    runtimeContext.store = await getStore(runtimeContext);
}

export async function setupApi(runtimeContext: RuntimeContext): Promise<void> {
    runtimeContext.statusCallback?.('Initializing API...');
    //runtimeContext.graph = await getLoadedGraph(runtimeContext.store, { author: '*', maxDepth: 4, focus: runtimeContext.focus });
}
