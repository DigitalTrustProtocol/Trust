import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default fp(async function webPlugin(app) {
  const webRoot = join(__dirname, '..', '..', 'web');
  const hasBuiltSpa = existsSync(join(webRoot, 'index.html'));

  if (hasBuiltSpa) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: !app.hasDecorator('sendFile'),
    });

    // SPA fallback: serve index.html for any unmatched GET request
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      name: 'Trust',
      message: 'Web dashboard not built. Run `npm run build:web` first.',
    }));
  }
}, { name: 'trust-web' });
