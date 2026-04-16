import fp from 'fastify-plugin';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { parseAuthorPubkeyInput, resolveTargetForQuery } from '../../lib/trust/subject.js';
import { loadSecretKey, loadKeyPair } from '../../lib/keys.js';
import { getPublicKey } from 'nostr-tools/pure';
import type { VerifiedEvent } from 'nostr-tools';
import { Score } from '../../lib/trust/resolvers/Score.js';
import {
  applyTrustEventToGraph,
  getLoadedGraph,
  loadGraph,
  removeTrustEventFromGraphPacked,
} from '../../lib/trust/graphManager.js';
import standardResolver from '../../lib/trust/resolvers/trustResolver.js';
import { NPostgres } from '../../lib/db/NPostgres.js';
import { NSQLite } from '../../lib/db/NSQLite.js';
import { RuntimeContext } from '../../lib/runtimeContext.js';
import { ok, sendError, ErrorCode } from '../errors.js';
import { getRuntimeConfig, PATHS, type UserConfig } from '../../config.js';
import { kvGet, kvSet } from '../../lib/db/kv.js';
import { logger } from '../../lib/logger.js';
import { KIND_TRUST, KIND_TRUST_MAX, KIND_TRUST_MIN } from '../../lib/nostr/nip32010.js';
import { getLatestSyncTime, SYNC_TIME_NS_SYNC } from '../../lib/syncTime.js';
import prettyBytes from 'pretty-bytes';

type ResolveBody = {
  subject: string;
  author?: string;
  context?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
};

type ResolveBatchBody = {
  subjects: string[];
  authors?: string;
  contexts?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
};

function normalizeContext(context: string | undefined): string | undefined {
  if (context === undefined) return '';
  if (context === 'undefined') return undefined;
  return context;
}

function resolveAuthor(author?: string): { author: string | null; error?: string } {
  if (author) {
    try {
      return { author: parseAuthorPubkeyInput(author) };
    } catch {
      return { author: null, error: 'Author must be a pubkey (npub or hex)' };
    }
  }
  const sk = loadSecretKey();
  return { author: sk ? getPublicKey(sk).toLowerCase() : null };
}

const startTime = Date.now();
const KV_GRAPH_LAST_CREATED_AT = 'graph_last_created_at';

export default fp(async function apiPlugin(app, runtimeContext: RuntimeContext) {
  const isSplitApi = runtimeContext.service === 'api';

  app.addHook('onReady', async () => {
    const prettyInt = (value: number): string => value.toLocaleString();
    const beforeMem = process.memoryUsage();
    logger.info('Graph: Loading trust into memory');
    logger.flush();

    await loadGraph(runtimeContext);

    const afterMem = process.memoryUsage();
    const nodeCount = runtimeContext.graph?.nodes.size ?? 0;
    const edgeCount = runtimeContext.graph?.edges.size ?? 0;
    logger.info(`Graph: Loaded with ${prettyInt(nodeCount)} nodes and ${prettyInt(edgeCount)} edges`);
    logger.info(`Graph: Memory usage delta: ${prettyBytes(afterMem.rss - beforeMem.rss, { locale: true, minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    logger.info(`API: http://${runtimeContext.host}:${runtimeContext.port}/v1/resolve`);

    logger.flush();

    if (!isSplitApi) return;

    const store = runtimeContext.store;
    if (!store) throw new Error('Store not loaded');
    const graph = runtimeContext.graph; 
    if (!graph) throw new Error('Graph not loaded');

    // ── Postgres: direct LISTEN/NOTIFY from DB triggers ──────────
    if (store instanceof NPostgres && store.pgPool) {
      logger.info('Graph: Subscribing to Postgres LISTEN/NOTIFY for graph changes');
      await store.listenForGraphChanges((payload) => {
        void (async () => {
          if (payload.kind < KIND_TRUST_MIN || payload.kind > KIND_TRUST_MAX) return;
          if (payload.c && runtimeContext.contextSet && !runtimeContext.contextSet.has(payload.c!)) return;

          try {
            if (payload.op === 'INSERT') {
              const ev = await store.getEvent(payload.event_id);
              if (ev) {
                applyTrustEventToGraph(ev as VerifiedEvent, graph);
                logger.debug({ op: 'INSERT', eventId: payload.event_id }, 'Graph updated via NOTIFY');
              }
            } else if (payload.op === 'DELETE' && payload.raw_event) {
              const raw = Buffer.from(payload.raw_event, 'base64');
              removeTrustEventFromGraphPacked(new Uint8Array(raw), graph);
              logger.debug({ op: 'DELETE', eventId: payload.event_id }, 'Graph edge removed via NOTIFY');
            }
          } catch (err) {
            logger.error({ err, eventId: payload.event_id, op: payload.op }, 'Failed to apply NOTIFY payload to graph');
          }
        })();
      });

      app.addHook('onClose', async () => {
        logger.info('Graph: Stopping Postgres LISTEN/NOTIFY');
        await store.stopListening();
      });
      return;
    }

    // ── SQLite: poll nostr_events by created_at ──────────────────
    if (store instanceof NSQLite) {
      const savedTs = await kvGet(KV_GRAPH_LAST_CREATED_AT);
      let lastCreatedAt = savedTs ? Number(savedTs) : 0;

      const pollMs = Math.max(1000, Number(process.env.TRUST_GRAPH_NOTIFY_POLL_MS ?? 5000));
      logger.info({ pollMs }, 'Graph: Starting SQLite graph poll');
      const timer = setInterval(() => {
        void (async () => {
          try {
            const events = await store.getEventsSince(lastCreatedAt, [KIND_TRUST], 500);
            for (const ev of events) {
              applyTrustEventToGraph(ev as VerifiedEvent, graph);
              if (ev.created_at > lastCreatedAt) {
                lastCreatedAt = ev.created_at;
              }
            }
            if (events.length > 0) {
              logger.debug({ count: events.length }, 'Graph: SQLite poll applied new events to graph');
              await kvSet(KV_GRAPH_LAST_CREATED_AT, String(lastCreatedAt));
            }
          } catch (err) {
            logger.error({ err }, 'Graph: SQLite graph poll failed');
          }
        })();
      }, pollMs);

      app.addHook('onClose', async () => {
        logger.info('Graph: Stopping SQLite graph poll');
        clearInterval(timer);
      });
    }
  });

  // ── Health & Ping ──────────────────────────────────────────────────
  /*
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const graph = runtimeContext.graph;
    if (!graph) {
      return sendError(reply, 500, ErrorCode.GRAPH_NOT_FOUND, 'Graph not loaded');
    }
    const lastSeenRaw = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
    return ok({
      status: 'ok',
      graph: {
        nodes: graph?.nodes.size ?? 0,
        edges: graph?.edges.size ?? 0,
      },
      sync: {
        lastSeen: lastSeenRaw ? Number(lastSeenRaw) : null,
      },
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });
  */
  app.get(
    '/v1/ping',
    {
      schema: {
        tags: ['default'],
      },
    },
    async () => ok({ status: 'ok' }),
  );

  // ── Identity ───────────────────────────────────────────────────────

  app.get(
    '/v1/identity',
    {
      schema: {
        tags: ['identity'],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
    const keyPair = loadKeyPair();
    if (!keyPair) {
      return sendError(reply, 404, ErrorCode.NO_IDENTITY, 'No identity configured. Run trust init first.');
    }


    let config = getRuntimeConfig();

    return ok({
      publicKey: keyPair.publicKey,
      npub: keyPair.npub,
      profile: config?.profile ?? null
    });
    },
  );

  // ── Trust (add) ────────────────────────────────────────────────────

  
/*
½   // There should not be a trust endpoint in the API, it should be the client who publishes the trust event
  app.post<{ Body: TrustBody }>(
    '/trust',
    async (request: FastifyRequest<{ Body: TrustBody }>, reply: FastifyReply) => {
      const body = request.body;
      const subjects = body.subjects ?? [];

      if (!Array.isArray(subjects) || subjects.length === 0) {
        return sendError(reply, 400, ErrorCode.MISSING_SUBJECT, 'At least one subject required');
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

      log.debug({ eventId: event.id, relays: relays.length, subjects: subjects.length }, 'Publishing trust event');
      await publishEvent(event, relays);
      await insertEvent(event, runtimeContext);

      if (app.hasDecorator('relayClients')) {
        await fanOutEvent(event, app.relayClients);
      }

      log.info({ eventId: event.id, relays: relays.length }, 'Trust event published');
      return ok({ event, relays });
    },
  );
*/
  // ── Resolve (single) ──────────────────────────────────────────────

  app.post<{ Body: ResolveBody }>(
    '/v1/resolve',
    {
      schema: {
        tags: ['resolve'],
      },
    },
    async (request: FastifyRequest<{ Body: ResolveBody }>, reply: FastifyReply) => {
      const body = request.body;
      const context = normalizeContext(body.context);
      const { author, error: authorError } = resolveAuthor(body.author);

      if (authorError) {
        return sendError(reply, 400, ErrorCode.INVALID_SUBJECT, authorError);
      }
      if (!author) {
        return sendError(reply, 400, ErrorCode.MISSING_AUTHOR, 'Author is required');
      }

      let subjectId: string;
      try {
        subjectId = resolveTargetForQuery(body.subject).value;
      } catch {
        return sendError(reply, 400, ErrorCode.INVALID_SUBJECT, `Invalid subject: ${body.subject}`);
      }

      const graph = runtimeContext.graph;
      if (!graph) {
        return sendError(reply, 500, ErrorCode.GRAPH_NOT_FOUND, 'Graph not loaded');
      }

      const scoreArray: Array<Score> = standardResolver.resolve(author, subjectId, {
        graph,
        context,
        maxDepth: body.maxDepth,
        format: body.format ?? 'default',
      });

      return ok(scoreArray);
    },
  );

  // ── Resolve (batch) ────────────────────────────────────────────────

  app.post<{ Body: ResolveBatchBody }>(
    '/v1/resolve/batch',
    {
      schema: {
        tags: ['resolve'],
      },
    },
    async (request: FastifyRequest<{ Body: ResolveBatchBody }>, reply: FastifyReply) => {
      const body = request.body;
      const subjects = body.subjects ?? [];

      if (!Array.isArray(subjects) || subjects.length === 0) {
        return sendError(reply, 400, ErrorCode.MISSING_SUBJECT, 'At least one subject required');
      }

      const context = normalizeContext(body.contexts);
      const { author, error: authorError } = resolveAuthor(body.authors);

      if (authorError) {
        return sendError(reply, 400, ErrorCode.INVALID_SUBJECT, authorError);
      }
      if (!author) {
        return sendError(reply, 400, ErrorCode.MISSING_AUTHOR, 'Author is required');
      }

      const graph = runtimeContext.graph;
      if (!graph) {
        return sendError(reply, 500, ErrorCode.GRAPH_NOT_FOUND, 'Graph not loaded');
      }
      const format = body.format ?? 'default';

      const results = subjects.map((subject) => {
        try {
          const { value: subjectId } = resolveTargetForQuery(subject);
          const scores = standardResolver.resolve(author, subjectId, {
            graph,
            context,
            maxDepth: body.maxDepth,
            format,
          });
          return { subject, ok: true as const, score: scores };
        } catch (err) {
          return {
            subject,
            ok: false as const,
            error: { code: ErrorCode.INVALID_SUBJECT, message: err instanceof Error ? err.message : String(err) },
          };
        }
      });

      return ok(results);
    },
  );

  // ── Graph Stats ────────────────────────────────────────────────────

  app.get(
    '/v1/graph/stats',
    {
      schema: {
        tags: ['graph'],
      },
    },
    async () => {
    const graph = getLoadedGraph();
    const lastSeenRaw = await getLatestSyncTime(SYNC_TIME_NS_SYNC);
    return ok({
      nodes: graph?.nodes.size ?? 0,
      edges: graph?.edges.size ?? 0,
      lastSync: lastSeenRaw ? Number(lastSeenRaw) : null,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
    },
  );

  // ── Graph export (visualization) ───────────────────────────────────
  /*
  app.get<{
    Querystring: { maxEdges?: string };
  }>('/graph/export', async (request, reply) => {
    const graph = runtimeContext.graph;
    if (!graph) {
      return sendError(reply, 500, ErrorCode.GRAPH_NOT_FOUND, 'Graph not loaded');
    }
    const maxEdges = Math.min(Math.max(100, Number(request.query.maxEdges) || 10_000), 50_000);
    const snapshot = exportGraphForViz(graph, { maxEdges });
    return ok(snapshot);
  });
  */
  // ── Events Query ───────────────────────────────────────────────────
 /*
  app.get<{
    Querystring: {
      author?: string;
      context?: string;
      kind?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>('/events', async (request, reply) => {
    const q = request.query;
    const limit = Math.min(Math.max(1, Number(q.limit) || 100), 1000);
    const kind = q.kind ? Number(q.kind) : KIND_TRUST;

    const filter: { kinds: number[]; limit: number; authors?: string[]; since?: number; until?: number; '#c'?: string[] } = { kinds: [kind], limit };
    if (q.author) filter.authors = [q.author];
    if (q.since) filter.since = Number(q.since);
    if (q.until) filter.until = Number(q.until);
    if (q.context) filter['#c'] = [q.context];

    const store = runtimeContext.store;
    if (!store) {
      return sendError(reply, 500, ErrorCode.STORE_NOT_FOUND, 'Store not loaded');
    }
    const events = await store.query([filter as any]);

    const offset = Number(q.offset) || 0;
    const page = offset > 0 ? events.slice(offset, offset + limit) : events;
    return ok(page);
  });
*/
  // ── Trusted Subjects ───────────────────────────────────────────────

  app.get<{
    Querystring: { author?: string; context?: string };
  }>('/v1/trusted', {
    schema: {
      tags: ['graph'],
    },
  }, async (request, reply) => {
    const q = request.query;
    const { author, error: authorError } = resolveAuthor(q.author);

    if (authorError) {
      return sendError(reply, 400, ErrorCode.INVALID_SUBJECT, authorError);
    }
    if (!author) {
      return sendError(reply, 400, ErrorCode.MISSING_AUTHOR, 'Author is required');
    }

    
    const graph = runtimeContext.graph;
    if (!graph) {
      return sendError(reply, 500, ErrorCode.GRAPH_NOT_FOUND, 'Graph not loaded');
    }
    const subjects = graph.trustedSubjects(author, q.context);
    return ok(subjects);
  });

}, { name: 'trust-api' });
