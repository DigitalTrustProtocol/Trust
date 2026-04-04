import { NPool } from "@nostrify/nostrify";
import { getStore, initTrustDb, Store } from "./db/dbManager.js";
import { Graph } from "./trust/graph/Graph.js";
import { getRuntimeConfig, ResolvedRuntimeConfig } from "../config.js";
import { getPool } from "./nostr/pool.js";
import { clearGraphMemory, loadGraph } from "./trust/graphManager.js";

let runtimeContext: RuntimeContext | null = null;

export interface RuntimeContext extends ResolvedRuntimeConfig {

    graph: Graph | null;
    store: Store | null;
    pool: NPool | null;

    statusCallback?: (status: string) => void;
    abortController: AbortController;
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
