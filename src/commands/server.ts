import { getLatestTimestamp } from '../lib/timestamp.js';
import { rollForwardTimestamp } from '../lib/timestamp.js';
import type { FastifyInstance } from 'fastify';
import { statusLine } from '../lib/utils.js';
import { createGraphSyncParams, runSync } from './sync.js';
import { GraphSyncParams } from '../server/graph-sync.js';
import { initLogger, logger } from '../lib/logger.js';
import { createApp, type ServerMode } from '../server/app.js';
import { setDbDriverOverride, type DbDriver } from '../lib/db/dbManager.js';

export async function serverCommand(options: {
  port?: number;
  host?: string;
  relay?: string[];
  since?: string;
  author?: string;
  context?: string;
  kinds?: number[];
  maxDepth?: number;
  syncInterval?: number;
  json?: boolean;
  only?: ServerMode;
  database?: string;
}): Promise<void> {

  initLogger('server');

  if (options.database !== undefined && options.database !== '') {
    const d = options.database.trim().toLowerCase();
    if (d !== 'sqlite' && d !== 'postgres') {
      throw new Error('Invalid --database value. Use sqlite or postgres.');
    }
    setDbDriverOverride(d as DbDriver);
  }

  const mode = options.only ?? 'all';
  const needsSync = mode === 'all' || mode === 'relay';

  if (needsSync) {
    const syncParams = await createGraphSyncParams(options, (status: string) => statusLine(status));
    runWebServer(syncParams, mode);
    await runSync(syncParams);
  } else {
    await runWebServer(undefined, mode, options);
  }
}

async function runWebServer(
  syncParams: GraphSyncParams | undefined,
  mode: ServerMode,
  options?: { port?: number; host?: string; relay?: string[]; json?: boolean },
): Promise<void> {
  const host = syncParams?.host ?? options?.host ?? 'localhost';
  const port = syncParams?.port ?? options?.port ?? 3417;
  const relays = syncParams?.relays ?? options?.relay ?? [];
  const json = syncParams?.json ?? options?.json ?? false;

  const app = await createApp(mode);
  await app.listen({ host, port });

  if (json) {
    console.log(
      JSON.stringify({
        mode,
        host,
        port,
        relays,
        relayEndpoint: (mode === 'all' || mode === 'relay') ? `ws://${host}:${port}/relay` : undefined,
        relayInfo: (mode === 'all' || mode === 'relay') ? `http://${host}:${port}/relay-info` : undefined,
        status: 'listening',
      }),
    );
  } else {
    logger.info(`Trust server listening on http://${host}:${port} (mode: ${mode})`);
    if (relays.length > 0) {
      logger.info(`Relays: ${relays.join(', ')}`);
    }
    if (mode === 'all' || mode === 'relay') {
      logger.info(`Relay websocket (NIP-32010): ws://${host}:${port}/relay`);
      logger.info(`Relay info (NIP-11): http://${host}:${port}/relay-info`);
    }
    if (mode === 'all' || mode === 'api') {
      logger.info(`REST API: http://${host}:${port}/trust, /resolve, /health`);
    }
    if (mode === 'all' || mode === 'web') {
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
  await rollForwardTimestamp();
  const result = (await getLatestTimestamp()) ?? 0;
  return result;
}
