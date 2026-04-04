import { getLatestTimestamp } from '../lib/timestamp.js';
import { rollForwardTimestamp } from '../lib/timestamp.js';
import { initLogger, logger } from '../lib/logger.js';
import { createApp, type ServerService } from '../server/app.js';
import { setDbDriverOverride, type DbDriver } from '../lib/db/dbManager.js';
import { getRuntimeConfig, resolveConfig, setRuntimeConfig, type ResolvedRuntimeConfig } from '../config.js';

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
  syncInterval?: number;
  json?: boolean;
  /** Omitted or `all`: run relay, API, and web in one process. */
  service?: ServerService;
  database?: string;
}): Promise<void> {
  initLogger('server');

  const resolved = getRuntimeConfig(options);

  setDbDriverOverride(resolved.database as DbDriver);

  const service = resolved.service;
  await runWebServer(resolved);
}

async function runWebServer(resolved: ResolvedRuntimeConfig): Promise<void> {
  const host = resolved.host;
  const port = resolved.port;
  const relays = resolved.relays;
  const json = resolved.json;
  const service = resolved.service;

  const app = await createApp(service);
  await app.listen({ host, port });

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
  await rollForwardTimestamp();
  const result = (await getLatestTimestamp()) ?? 0;
  return result;
}
