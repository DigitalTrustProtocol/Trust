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
import {
  applyTrustEventToGraph,
  getLoadedGraph,
  insertEvent,
  loadGraph,
  removeTrustEventFromGraphPacked,
} from '../../lib/trust/graphManager.js';
import standardResolver from '../../lib/trust/resolvers/trustResolver.js';
import { initTrustDb, Store } from '../../lib/db/dbManager.js';
import { fanOutEvent } from './relay.js';
import { KIND_TRUST } from '../../lib/nostr/nip32010.js';
import { RuntimeContext } from '../../lib/runtimeContext.js';

type TrustBody = {
  subjects: string[];
  contexts?: string;
  value?: number;
  content?: string;
  relay?: string[];
};

type ResolveBody = {
  subject: string;
  authors?: string;
  contexts?: string;
  strategy?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
};

function normalizeContext(context: string | undefined): string | undefined {
  if (context === undefined) return '';
  if (context === 'undefined') return undefined;
  return context;
}

export default fp(async function apiPlugin(app, runtimeContext: RuntimeContext) {
  const healthHandler = async () => {
    return { status: 'ok' };
  };

  app.addHook('onReady', async () => {

    await loadGraph(runtimeContext);

    const pollMs = Math.max(250, Number(process.env.TRUST_GRAPH_NOTIFY_POLL_MS ?? 2000));
    const timer = setInterval(() => {
      void (async () => {
        const graph = getLoadedGraph();
        if (!graph) return;
        const st = await initTrustDb();
        const rows = await st.drainGraphNotifyBatch(500);
        for (const row of rows) {
          if (row.op === 'INSERT') {
            const ev = await st.getEvent(row.event_id);
            if (ev?.kind === KIND_TRUST) {
              applyTrustEventToGraph(ev as VerifiedEvent, graph);
            }
          } else if (row.op === 'DELETE' && row.raw_event) {
            removeTrustEventFromGraphPacked(row.raw_event, graph);
          }
        }
      })();
    }, pollMs);

    app.addHook('onClose', async () => {
      clearInterval(timer);
    });
  });

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
        context: body.contexts,
        value,
        content: body.content ?? '',
      });

      const event = signEvent(template) as VerifiedEvent;
      const relaySelection = await getAvailableRelays(body.relay);
      const relays = relaySelection.selected;

      await publishEvent(event, relays);
      await insertEvent(event, runtimeContext);

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

      const context = normalizeContext(body.contexts);

      let author: string | null = null;
      if (body.authors) {
        const parsedAuthor = resolveTargetForQuery(body.authors);
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

      const graph = await loadGraph(runtimeContext);
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
