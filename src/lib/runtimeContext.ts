import { NPool } from "@nostrify/nostrify";
import { getStore, Store } from "./db/dbManager.js";
import { Graph } from "./trust/graph/Graph.js";
import {  getRuntimeConfig, ResolvedRuntimeConfig } from "../config.js";
import { getAvailableRelays, getPool } from "./nostr/pool.js";
import pino from "pino";
import { loadGraph } from "./trust/graphManager.js";
import { getPinoInstance } from "./logger.js";

let runtimeContext: RuntimeContext | null = null;

export interface RuntimeContext extends ResolvedRuntimeConfig {

    graph: Graph | null;
    store: Store | null;
    pool: NPool | null;

    authorSet: Set<string> | undefined;
    contextSet: Set<string> | undefined;

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
        authorSet: config.authors ? new Set<string>(config.authors) : undefined,
        contextSet: config.contexts ? new Set<string>(config.contexts) : undefined,
        abortController,
    };
}


async function initRuntimeContext(opts?: Record<string, unknown>): Promise<RuntimeContext> {
    const cfg = getRuntimeConfig(opts);
    const runtimeContext = await getRuntimeContext(cfg);
    runtimeContext.store = await getStore(cfg);
    runtimeContext.loggerInstance = getPinoInstance();
    return runtimeContext;
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
      runtimeContext.loggerInstance?.warn(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
    }
  
    runtimeContext.relays = relays;
    runtimeContext.pool = getPool(0, relays);
    runtimeContext.loggerInstance?.flush();
}

export async function setupStore(runtimeContext: RuntimeContext): Promise<void> {
    runtimeContext.loggerInstance?.info('Initializing trust database...');
    try {
    runtimeContext.store = await getStore(runtimeContext);
    } catch (error) {
        runtimeContext.loggerInstance?.error('Error initializing trust database: ' + error);
    }
    runtimeContext.loggerInstance?.flush();
}

export async function setupApi(runtimeContext: RuntimeContext): Promise<void> {
    runtimeContext.loggerInstance?.info('Initializing API...');
    runtimeContext.graph = await loadGraph(runtimeContext);
    runtimeContext.loggerInstance?.flush();
}
