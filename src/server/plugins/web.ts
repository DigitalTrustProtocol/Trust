import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { logger as rootLogger } from '../../lib/logger.js';

const log = rootLogger.child({ plugin: 'web' });
const __dirname = dirname(fileURLToPath(import.meta.url));

export default fp(async function webPlugin(app) {
  const webRoot = join(__dirname, '..', '..', 'web');
  const hasBuiltSpa = existsSync(join(webRoot, 'index.html'));

  if (hasBuiltSpa) {
    log.info({ webRoot }, 'Serving web dashboard');
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: !app.hasDecorator('sendFile'),
    });

    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile('index.html');
    });
  } else {
    log.warn('Web dashboard not built — run `npm run build:web` to enable');
    app.get('/', async () => ({
      name: 'Trust',
      message: 'Web dashboard not built. Run `npm run build:web` first.',
    }));
  }
}, { name: 'trust-web' });
