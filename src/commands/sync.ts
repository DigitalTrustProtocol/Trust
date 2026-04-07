import { closeTrustDb, getStore, initTrustDb, Store } from '../lib/db/dbManager.js';
import { closePool, getPool } from '../lib/nostr/pool.js';
import { getAvailableRelays } from '../lib/nostr/pool.js';
import { statusLine } from '../lib/utils.js';
import { getRuntimeConfig } from '../config.js';
import { getSinceFromTimestamp } from './server.js';
import { logger } from '../lib/logger.js';
import { GraphSyncResult, runTrustedGraphSync } from '../server/graph-sync.js';
import { subscribeToAll } from '../server/all-sync.js';
import { getRuntimeContext, RuntimeContext, setRuntimeContext, setupRelayPool, setupStore } from '../lib/runtimeContext.js';


export async function syncTrustCommand(options: {
  relay?: string[];
  since?: string;
  authors?: string;
  contexts?: string;
  kinds?: number[];
  maxDepth?: number;
  syncInterval?: number;
  json?: boolean;
}): Promise<void> {
  const isJson = options.json ?? false;

  if (process.env.TRUST_E2E_OFFLINE === '1') {
    await initTrustDb();
    statusLine('');
    if (isJson) {
      console.log(JSON.stringify({ eventsReceived: 0, eventsInserted: 0, processedAuthors: 0 }));
    } else {
      logger.info('Synced 0 events from 0 authors');
    }
    return;
  }

  const runtimeContext = await initRuntimeContext(options);
  const result = await runSync(runtimeContext);

  if (isJson && result) {
    console.log(JSON.stringify({
      eventsReceived: result.eventsReceived,
      eventsInserted: result.eventsInserted,
      processedAuthors: result.processedAuthors,
      latestTimestamp: result.latestTimestamp,
    }));
  }
}

export async function initRuntimeContext(
  cli: Record<string, unknown>
): Promise<RuntimeContext> {

  const cfg = getRuntimeConfig(cli);
  const runtimeContext = await getRuntimeContext(cfg);
  
  runtimeContext.syncSince = await getSinceFromTimestamp(undefined);

  runtimeContext.statusCallback = (status: string) => statusLine(status);

  await setupRelayPool(runtimeContext);
  await setupStore(runtimeContext);

  return runtimeContext;
}

export async function runSync(runtimeContext: RuntimeContext): Promise<GraphSyncResult | undefined> {
  let lastStatus: GraphSyncResult | undefined;
  const signal = runtimeContext.abortController?.signal ?? new AbortSignal();

  try {
    const sinceLabel = runtimeContext.syncSince
      ? `from ${new Date(runtimeContext.syncSince * 1000).toLocaleString()}`
      : 'from beginning';
    logger.info(`Subscribing to relays ${sinceLabel}`);

    logger.info('Syncing trust (relay → database)…');
    do {
      if (!runtimeContext.authors?.length) {
        lastStatus = await subscribeToAll(runtimeContext);
      } else {
        lastStatus = await runTrustedGraphSync(runtimeContext);
      }
      logger.info(`Received ${lastStatus.eventsReceived} events. Inserted ${lastStatus.eventsInserted} events.`);

      if ((runtimeContext?.syncIntervalSeconds && runtimeContext.syncIntervalSeconds <= 0) || signal.aborted) {
        break;
      }

      logger.info(`Waiting ${runtimeContext.syncIntervalSeconds}s before next sync...`);
      const waitIntervalMs = runtimeContext?.syncIntervalSeconds ?? 3600;
      const waitCompleted = await waitForInterval(waitIntervalMs * 1000, signal);
      if (!waitCompleted) break;
    } while (!runtimeContext.abortController?.signal.aborted);
  } catch (err) {
    if (!runtimeContext.abortController?.signal.aborted) {
      runtimeContext.abortController?.abort('Sync stopped');
    }
    throw err;
  } finally {
    if (runtimeContext.pool) await closePool(runtimeContext.pool);
    if (runtimeContext.store) await closeTrustDb(runtimeContext.store as Store);
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
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}
