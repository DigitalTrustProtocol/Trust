import { getLatestSyncTime, rollForwardSyncTime, SYNC_TIME_NS_SYNC } from '../lib/syncTime.js';
import { getPinoInstance, initLogger, logger } from '../lib/logger.js';
import { createApp, type ServerService } from '../server/app.js';
import { getStore } from '../lib/db/dbManager.js';
import { getRuntimeConfig,type ResolvedRuntimeConfig } from '../config.js';
import { getRuntimeContext, RuntimeContext, setupApi, setupRelayPool } from '../lib/runtimeContext.js';

const VALID_SERVICES = new Set<string>(['all', 'relay', 'api', 'web']);

export function parseServerService(raw: string | undefined): ServerService {
  if (raw === undefined || raw.trim() === '') return 'all';
  const s = raw.trim().toLowerCase();
  if (!VALID_SERVICES.has(s)) {
    throw new Error(`Invalid --service "${raw}". Use all, relay, api, or web.`);
  }
  return s as ServerService;
}

export async function serverCommand(options: {
  port?: number;
  host?: string;
  relay?: string[];
  since?: string;
  authors?: string;
  contexts?: string;
  kinds?: number[];
  maxDepth?: number;
  json?: boolean;
  /** Omitted or `all`: run relay, API, and web in one process. */
  service?: ServerService;
  database?: string;
  connectionString?: string;
}): Promise<void> {
  initLogger('server');

  const cfg = getRuntimeConfig(options);

  logger.info({
    service: cfg.service,
    database: cfg.database,
    connectionString: cfg.database === 'postgres' ? '***' : cfg.connectionString,
    host: cfg.host,
    port: cfg.port,
    logLevel: process.env.TRUST_LOG_LEVEL ?? 'info',
    relays: cfg.relays.length,
    authors: cfg.authors?.length ?? 'all',
    contexts: cfg.contexts?.length ?? 'all',
    maxDepth: cfg.maxDepth,
  }, 'Starting Trust server');

  const runtimeContext = await initRuntimeContext(cfg);

  await runWebServer(runtimeContext);
}


async function initRuntimeContext(resolved: ResolvedRuntimeConfig): Promise<RuntimeContext> {
  const runtimeContext = await getRuntimeContext(resolved);
  runtimeContext.store = await getStore(resolved);

  runtimeContext.loggerInstance = getPinoInstance();

  if(runtimeContext.service === 'all' || runtimeContext.service === 'relay') {
    await setupRelayPool(runtimeContext);
  }
  if(runtimeContext.service === 'all' || runtimeContext.service === 'api') {

    //await setupApi(runtimeContext);
  }
  if(runtimeContext.service === 'all' || runtimeContext.service === 'web') {
  }

  
  return runtimeContext;
}

async function runWebServer(runtimeContext: RuntimeContext): Promise<void> {
  const host = runtimeContext.host;
  const port = runtimeContext.port;
  const relays = runtimeContext.relays;
  const json = runtimeContext.json;
  const service = runtimeContext.service;

  const app = await createApp(service, runtimeContext);
  try {
    await app.listen({ host, port });
  } catch (error) {
    logger.error({ err: error, host, port, service }, 'Failed to start Trust server');
    throw error;
  }

  if (json) {
    console.log(
      JSON.stringify({
        service,
        host,
        port,
        relays,
        relayEndpoint: service === 'all' || service === 'relay' ? `ws://${host}:${port}/relay` : undefined,
        relayInfo: service === 'all' || service === 'relay' ? `http://${host}:${port}/relay-info` : undefined,
        status: 'listening',
      }),
    );
  } else {
    logger.info(`Trust server listening on http://${host}:${port} (service: ${service})`);
    if (relays.length > 0) {
      logger.info(`Relays: ${relays.join(', ')}`);
    }
    if (service === 'all' || service === 'relay') {
      logger.info(`Relay websocket (NIP-32010): ws://${host}:${port}/relay`);
      logger.info(`Relay info (NIP-11): http://${host}:${port}/relay-info`);
    }
    if (service === 'all' || service === 'api') {
      logger.info(`REST API: http://${host}:${port}/trust, /resolve, /health`);
    }
    if (service === 'all' || service === 'web') {
      logger.info(`Web: http://${host}:${port}/`);
    }
  }
}

export async function getSinceFromTimestamp(since: string | undefined): Promise<number> {
  if (since !== undefined) {
    const num = parseInt(since, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid --since value "${since}". Must be a unix timestamp.`);
    }
    return num;
  }
  await rollForwardSyncTime(SYNC_TIME_NS_SYNC);
  const result = (await getLatestSyncTime(SYNC_TIME_NS_SYNC)) ?? 0;
  return result;
}
