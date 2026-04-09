import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
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

  if (service === 'all' || service === 'api') {
    await app.register(cors, {
      origin: [
        'https://trust.dance',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://localhost:3417',
        'http://127.0.0.1:3417',
      ],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    });

    await app.register(fastifySwagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'Trust API',
          description: 'Decentralized Web of Trust identity and reputation for AI agents',
          version: '0.1.0',
        },
        servers: [{ url: '/' }],
        tags: [
          { name: 'health', description: 'Health and status' },
          { name: 'trust', description: 'Trust assertions' },
          { name: 'resolve', description: 'Trust resolution' },
          { name: 'graph', description: 'Graph queries' },
          { name: 'identity', description: 'Identity management' },
        ],
      },
    });
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

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
