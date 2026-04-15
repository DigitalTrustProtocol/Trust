import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { logger } from '../../lib/logger.js';
import { RuntimeContext } from '../../lib/runtimeContext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default fp(async function webPlugin(app, runtimeContext: RuntimeContext) {
  const webRoot = join(__dirname, '..', '..', 'web');
  const hasBuiltSpa = existsSync(join(webRoot, 'index.html'));

  if (hasBuiltSpa) {
    logger.info(`Web: http://${runtimeContext.host}:${runtimeContext.port}/`);
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: !app.hasDecorator('sendFile'),
    });

    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile('index.html');
    });
  } else {
    logger.warn('Web: Dashboard not built — run `npm run build:web` to enable');
    app.get('/', async () => ({
      name: 'Trust',
      message: 'Web dashboard not built. Run `npm run build:web` first.',
    }));
  }
}, { name: 'trust-web' });
