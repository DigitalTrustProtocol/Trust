import { getLatestSyncTime, rollForwardSyncTime, SYNC_TIME_NS_SYNC } from '../lib/syncTime.js';
import { getPinoInstance, initLogger, logger } from '../lib/logger.js';
import { createApp, type ServerService } from '../server/app.js';
import { getStore } from '../lib/db/dbManager.js';
import { getRuntimeConfig, type ResolvedRuntimeConfig } from '../config.js';
import { getRuntimeContext, RuntimeContext, setupRelayPool } from '../lib/runtimeContext.js';
import { clearServerState, touchServerState, writeServerState } from '../lib/server-state.js';
import { FastifyInstance } from 'fastify';
import { createServer } from 'node:net';

const VALID_SERVICES = new Set<string>(['all', 'relay', 'api', 'web']);
let heartbeat: NodeJS.Timeout | null = null;


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
  /** Omitted or `all`: run relay, API, and web in one process. */
  service?: ServerService;
  database?: string;
  connectionString?: string;
}): Promise<void> {


  try {
    const cfg = getRuntimeConfig(options);
    await assertPortAvailable(cfg.host, cfg.port);

    logger.info(`Starting Trust server on http://${cfg.host}:${cfg.port} (service: ${cfg.service})`);
    logger.info(`Database: ${cfg.database}`);
    
    const runtimeContext = await initRuntimeContext(cfg);

    await runWebServer(runtimeContext);

  } catch (error) {
    logger.error({ err: error }, 'Failed to start Trust server');
    logger.flush();
  }
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  const hostsToCheck = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  for (const targetHost of hostsToCheck) {
    await assertPortAvailableOnHost(targetHost, port, host);
  }
}

async function assertPortAvailableOnHost(targetHost: string, port: number, displayHost: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Could not verify port ${port} availability on host "${displayHost}" (probe timeout).`));
    }, 3000);

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        finish(new Error(`Port ${port} is already in use on host "${displayHost}". Stop the existing process or use --port.`));
        return;
      }
      finish(err);
    });

    server.once('listening', () => {
      clearTimeout(timeout);
      server.close((closeErr) => {
        if (closeErr) {
          finish(closeErr);
          return;
        }
        finish();
      });
    });

    server.listen({ host: targetHost, port, exclusive: true });
  });
}


async function initRuntimeContext(resolved: ResolvedRuntimeConfig): Promise<RuntimeContext> {
  const runtimeContext = await getRuntimeContext(resolved);
  runtimeContext.store = await getStore(resolved);

  if (runtimeContext.service === 'all' || runtimeContext.service === 'relay') {
    await setupRelayPool(runtimeContext);
  }
  if (runtimeContext.service === 'all' || runtimeContext.service === 'api') {

    //await setupApi(runtimeContext);
  }
  if (runtimeContext.service === 'all' || runtimeContext.service === 'web') {
  }


  return runtimeContext;
}

async function runWebServer(runtimeContext: RuntimeContext): Promise<void> {
  const host = runtimeContext.host;
  const port = runtimeContext.port;
  const relays = runtimeContext.relays;
  const service = runtimeContext.service;

  const app = await createApp(service, runtimeContext);
  const serverState = setupServerState(app, runtimeContext);

  await app.listen({ host, port });
  serverState.start();
}

function setupServerState(app: FastifyInstance, runtimeContext: RuntimeContext): { start: () => void } {
  let shutdownStarted = false;
  
  const cleanupServerState = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    clearServerState(process.pid);
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info({ signal }, 'Shutting down Trust server');
    cleanupServerState();
    await app.close();
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  app.addHook('onClose', async () => {
    cleanupServerState();
  });

  const start = (): void => {
    const { host, port, service } = runtimeContext;
    writeServerState({ host, port, service });
    heartbeat = setInterval(() => {
      touchServerState(process.pid);
    }, 5000);
    heartbeat.unref();
  };

  return { start };
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
