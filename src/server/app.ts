import Fastify, { type FastifyInstance } from 'fastify';
import { getPinoInstance } from '../lib/logger.js';
import relayPlugin from './plugins/relay.js';
import apiPlugin from './plugins/api.js';
import webPlugin from './plugins/web.js';

/** Which parts of the Trust stack to run in this process (`all` = relay + API + web together). */
export type ServerService = 'all' | 'relay' | 'api' | 'web';

/** @deprecated Use ServerService */
export type ServerMode = ServerService;

export async function createApp(service: ServerService = 'all'): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: getPinoInstance(),
  }) as unknown as FastifyInstance;

  if (service === 'all' || service === 'relay') {
    await app.register(relayPlugin);
  }

  if (service === 'all' || service === 'api') {
    await app.register(apiPlugin, {
      enableGraphNotifyPoller: service === 'api',
    });
  }

  if (service === 'all' || service === 'web') {
    await app.register(webPlugin);
  }

  return app;
}
