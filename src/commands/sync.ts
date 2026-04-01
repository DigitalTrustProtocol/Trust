import { closeTrustDb, initTrustDb, Store } from '../lib/db/dbManager.js';
import { closePool, connectionErrors, getPool } from '../lib/nostr/pool.js';
import { getAvailableRelays } from '../lib/nostr/pool.js';
import { statusLine } from '../lib/utils.js';
import { DEFAULT_CONFIG, DEFAULT_RELAYS, getPublicKey, getServerHost, getServerPort } from '../config.js';
import { getSinceFromTimestamp } from './server.js';
import { logger } from '../lib/logger.js';
import { loadGraph } from '../lib/trust/graphManager.js';
import { GraphSyncParams, GraphSyncResult, runTrustedGraphSync } from '../server/graph-sync.js';
import { KIND_TRUST } from '../lib/nostr/nip32010.js';
import { subscribeToAll } from '../server/all-sync.js';


export async function syncTrustCommand(options: {
  relay?: string[];
  since?: string;
  author?: string;
  context?: string;
  kinds?: number[];
  maxDepth?: number;
  syncInterval?: number;
  json?: boolean;
}): Promise<void> {

  if (process.env.TRUST_E2E_OFFLINE === '1') {
    await initTrustDb();
    statusLine('');
    logger.info('Synced 0 events from 0 authors');
    return;
  }

  const syncParams = await createGraphSyncParams(options, (status: string) => statusLine(status));

  await runSync(syncParams);
}

export async function createGraphSyncParams(options: {
  host?: string;
  port?: number;
  relay?: string[];
  since?: string;
  author?: string;
  context?: string;
  kinds?: number[];
  maxDepth?: number;
  syncInterval?: number;
  json?: boolean;
},statusCallback?: (status: string) => void): Promise<GraphSyncParams> {

  const abortController = new AbortController();

  const author = options.author?.trim() || getPublicKey();
  const maxDepth = Math.max(1, options.maxDepth ?? 3);
  const kinds = options.kinds?.length ? options.kinds : [KIND_TRUST];


  let syncIntervalSeconds = 3600; // 1 hour
  if (options.syncInterval) {
    syncIntervalSeconds = Math.max(0, options.syncInterval);
  }

  const since = await getSinceFromTimestamp(options.since);

  const host = options.host ?? getServerHost(DEFAULT_CONFIG);
  const port = options.port ?? getServerPort(DEFAULT_CONFIG);


  const relaySelection = await getAvailableRelays(options.relay ?? DEFAULT_RELAYS);
  const relays = relaySelection.selected;
  if (relaySelection.offline.length > 0) {
    statusCallback?.(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
  }

  statusCallback?.('Initializing trust database...');
  let store = await initTrustDb();
  let pool = getPool(0, relays); // No timeout, we handle the eose timeout in the sync loop

  statusCallback?.('Loading trust data to memory...');
  let graph = await loadGraph(store, options.author, maxDepth);
  statusCallback?.('Number of Authors loaded: ' + graph.nodes.size + ' Number of Edges loaded: ' + graph.edges.size);


  const syncParams: GraphSyncParams = {
    host,
    port,
    author,
    pool,
    store,
    graph,
    relays,
    since,
    maxDepth,
    syncIntervalSeconds,
    context: options.context,
    kinds,
    abortController,
    statusCallback: (status) => {
      //statusCallback?.(JSON.stringify(status));
    },
  }

  return syncParams;
}

export async function runSync(syncParams: GraphSyncParams): Promise<GraphSyncResult | undefined> {

  let lastStatus: GraphSyncResult | undefined;
  let signal = syncParams.abortController?.signal ?? new AbortSignal();

  try {
    logger.info("Subscribing to relays " + syncParams.since ? `from ${new Date(syncParams.since! * 1000).toLocaleString()}` : 'from beginning');

    logger.info('Syncing trust graph...');
    do {

      if (syncParams.author === "*") {
        lastStatus = await subscribeToAll(syncParams);
      } else {
        lastStatus = await runTrustedGraphSync(syncParams);
      }
      logger.info(`Received ${lastStatus.eventsReceived} events. Inserted ${lastStatus.eventsInserted} events.`);


      if ((syncParams?.syncIntervalSeconds &&  syncParams.syncIntervalSeconds <= 0) || signal.aborted) {
        break;
      }

      logger.info(`Waiting ${syncParams.syncIntervalSeconds}s before next sync...`);
      let waitIntervalMs = syncParams?.syncIntervalSeconds ?? 3600;
      const waitCompleted = await waitForInterval(waitIntervalMs * 1000, signal);
      if (!waitCompleted) break;
    } while (!syncParams.abortController?.signal.aborted);
   

  } catch (err) {
    if (!syncParams.abortController?.signal.aborted) {
      syncParams.abortController?.abort("Sync stopped");
    }
    throw err;
  } finally {
    if(syncParams.pool) await closePool(syncParams.pool);
    if(syncParams.store) await closeTrustDb(syncParams.store as Store);
  }

  return lastStatus;
}

async function waitForInterval(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return true;
  return await new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(true), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(false);
    }, { once: true });
  });
}
