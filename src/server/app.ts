import Fastify, { type FastifyInstance } from 'fastify';
import { getPinoInstance } from '../lib/logger.js';
import relayPlugin from './plugins/relay.js';
import apiPlugin from './plugins/api.js';
import webPlugin from './plugins/web.js';
import { RuntimeContext } from '../lib/runtimeContext.js';

/** Which parts of the Trust stack to run in this process (`all` = relay + API + web together). */
export type ServerService = 'all' | 'relay' | 'api' | 'web';

export async function createApp(service: ServerService = 'all', runtimeContext: RuntimeContext): Promise<FastifyInstance> {

  const app = Fastify({
    loggerInstance: runtimeContext.loggerInstance ?? getPinoInstance(),
  }) as unknown as FastifyInstance;

  if (service === 'all' || service === 'relay') {
    await app.register(relayPlugin, runtimeContext);
  }

  if (service === 'all' || service === 'api') {
    await app.register(apiPlugin, runtimeContext);
  }

  if (service === 'all' || service === 'web') {
    await app.register(webPlugin, runtimeContext);
  }

  return app;
}
