import Fastify, { type FastifyInstance } from 'fastify';
import { getPinoInstance } from '../lib/logger.js';
import relayPlugin from './plugins/relay.js';
import apiPlugin from './plugins/api.js';
import webPlugin from './plugins/web.js';

export type ServerMode = 'all' | 'relay' | 'api' | 'web';

export async function createApp(mode: ServerMode = 'all'): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: getPinoInstance(),
  }) as unknown as FastifyInstance;

  if (mode === 'all' || mode === 'relay') {
    await app.register(relayPlugin);
  }

  if (mode === 'all' || mode === 'api') {
    await app.register(apiPlugin);
  }

  if (mode === 'all' || mode === 'web') {
    await app.register(webPlugin);
  }

  return app;
}
