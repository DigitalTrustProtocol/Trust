import fp from 'fastify-plugin';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { parseSubjects } from '../../lib/trust/subject.js';
import { buildTrustEventTemplate } from '../../lib/nostr/nip32010.js';
import { signEvent } from '../../lib/signer.js';
import { getAvailableRelays, publishEvent } from '../../lib/nostr/pool.js';
import { resolveTargetForQuery } from '../../lib/trust/subject.js';
import { loadSecretKey } from '../../lib/keys.js';
import { getPublicKey } from 'nostr-tools/pure';
import type { VerifiedEvent } from 'nostr-tools';
import { Score } from '../../lib/trust/resolvers/Score.js';
import { insertEvent, loadGraph } from '../../lib/trust/graphManager.js';
import standardResolver from '../../lib/trust/resolvers/trustResolver.js';
import { initTrustDb } from '../../lib/db/dbManager.js';
import { fanOutEvent } from './relay.js';

type TrustBody = {
  subjects: string[];
  context?: string;
  value?: number;
  content?: string;
  relay?: string[];
};

type ResolveBody = {
  subject: string;
  author?: string;
  context?: string;
  strategy?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
};

function normalizeContext(context: string | undefined): string | undefined {
  if (context === undefined) return '';
  if (context === 'undefined') return undefined;
  return context;
}

export default fp(async function apiPlugin(app) {
  const healthHandler = async () => {
    return { status: 'ok' };
  };

  app.get('/health', healthHandler);
  app.get('/ping', healthHandler);

  app.post<{ Body: TrustBody }>(
    '/trust',
    async (request: FastifyRequest<{ Body: TrustBody }>, reply: FastifyReply) => {
      const body = request.body;
      const subjects = body.subjects ?? [];

      if (!Array.isArray(subjects) || subjects.length === 0) {
        return reply.code(400).send({ error: 'At least one subject required' });
      }

      const vInput = body.value ?? 1;
      const value: 1 | 0 | -1 = vInput === 1 ? 1 : vInput === -1 ? -1 : 0;

      const parsed = parseSubjects(subjects);
      const template = buildTrustEventTemplate({
        subjects: parsed,
        context: body.context,
        value,
        content: body.content ?? '',
      });

      const event = signEvent(template) as VerifiedEvent;
      const relaySelection = await getAvailableRelays(body.relay);
      const relays = relaySelection.selected;

      await publishEvent(event, relays);
      await insertEvent(event);

      if (app.hasDecorator('relayClients')) {
        await fanOutEvent(event, app.relayClients);
      }

      return {
        event,
        relays,
      };
    },
  );

  app.post<{ Body: ResolveBody }>(
    '/resolve',
    async (request: FastifyRequest<{ Body: ResolveBody }>, reply: FastifyReply) => {
      const body = request.body;

      const context = normalizeContext(body.context);

      let author: string | null = null;
      if (body.author) {
        const parsedAuthor = resolveTargetForQuery(body.author);
        if (parsedAuthor.tag !== 'p') {
          return reply.code(400).send({ error: 'Author must be a pubkey (npub or hex)' });
        }
        author = parsedAuthor.value;
      } else {
        const sk = loadSecretKey();
        author = sk ? getPublicKey(sk).toLowerCase() : null;
      }

      const { value: subjectId } = resolveTargetForQuery(body.subject);

      if (!author) {
        throw new Error('Author is required');
      }

      let store = await initTrustDb();
      const graph = await loadGraph(store);
      const score: Score = standardResolver.resolve(author, subjectId, {
        graph,
        context,
        maxDepth: body.maxDepth,
        format: body.format ?? 'default',
      });

      return reply.send(score);
    },
  );
}, { name: 'trust-api' });
