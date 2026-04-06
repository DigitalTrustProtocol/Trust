import fp from 'fastify-plugin';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { parseSubjects } from '../../lib/trust/subject.js';
import { buildTrustEventTemplate } from '../../lib/nostr/nip32010.js';
import { signEvent } from '../../lib/signer.js';
import { getAvailableRelays, publishEvent } from '../../lib/nostr/pool.js';
import { resolveTargetForQuery } from '../../lib/trust/subject.js';
import { loadSecretKey, loadKeyPair } from '../../lib/keys.js';
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
import { ok, fail, sendError, ErrorCode } from '../errors.js';
import { PATHS, type UserConfig } from '../../config.js';
import { kvGet, kvKeyLastSeenTimestamp } from '../../lib/db/kv.js';

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

function resolveAuthor(authors?: string): { author: string | null; error?: string } {
  if (authors) {
    const parsed = resolveTargetForQuery(authors);
    if (parsed.tag !== 'p') {
      return { author: null, error: 'Author must be a pubkey (npub or hex)' };
    }
    return { author: parsed.value };
  }
  const sk = loadSecretKey();
  return { author: sk ? getPublicKey(sk).toLowerCase() : null };
}

const startTime = Date.now();

export default fp(async function apiPlugin(app, runtimeContext: RuntimeContext) {

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

  // ── Health & Ping ──────────────────────────────────────────────────

  app.get('/health', async () => {
    const graph = getLoadedGraph();
    const lastSeenRaw = await kvGet(kvKeyLastSeenTimestamp('sync'));
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

  app.get('/ping', async () => ok({ status: 'ok' }));

  // ── Identity ───────────────────────────────────────────────────────

  app.get('/identity', async (_request: FastifyRequest, reply: FastifyReply) => {
    const keyPair = loadKeyPair();
    if (!keyPair) {
      return sendError(reply, 404, ErrorCode.NO_IDENTITY, 'No identity configured. Run trust init first.');
    }

    let config: UserConfig | null = null;
    if (existsSync(PATHS.config)) {
      try { config = JSON.parse(readFileSync(PATHS.config, 'utf-8')); } catch { /* ignore */ }
    }

    return ok({
      publicKey: keyPair.publicKey,
      npub: keyPair.npub,
      profile: config?.profile ?? null,
      relays: config?.relays ?? [],
    });
  });

  // ── Trust (add) ────────────────────────────────────────────────────

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

      await publishEvent(event, relays);
      await insertEvent(event, runtimeContext);

      if (app.hasDecorator('relayClients')) {
        await fanOutEvent(event, app.relayClients);
      }

      return ok({ event, relays });
    },
  );

  // ── Resolve (single) ──────────────────────────────────────────────

  app.post<{ Body: ResolveBody }>(
    '/resolve',
    async (request: FastifyRequest<{ Body: ResolveBody }>, reply: FastifyReply) => {
      const body = request.body;
      const context = normalizeContext(body.contexts);
      const { author, error: authorError } = resolveAuthor(body.authors);

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

      const graph = await loadGraph(runtimeContext);
      const score: Score = standardResolver.resolve(author, subjectId, {
        graph,
        context,
        maxDepth: body.maxDepth,
        format: body.format ?? 'default',
      });

      return ok(score);
    },
  );

  // ── Resolve (batch) ────────────────────────────────────────────────

  app.post<{ Body: ResolveBatchBody }>(
    '/resolve/batch',
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

      const graph = await loadGraph(runtimeContext);
      const format = body.format ?? 'default';

      const results = subjects.map((subject) => {
        try {
          const { value: subjectId } = resolveTargetForQuery(subject);
          const score = standardResolver.resolve(author, subjectId, {
            graph,
            context,
            maxDepth: body.maxDepth,
            format,
          });
          return { subject, ok: true as const, score };
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

  app.get('/graph/stats', async () => {
    const graph = getLoadedGraph();
    const lastSeenRaw = await kvGet(kvKeyLastSeenTimestamp('sync'));
    return ok({
      nodes: graph?.nodes.size ?? 0,
      edges: graph?.edges.size ?? 0,
      lastSync: lastSeenRaw ? Number(lastSeenRaw) : null,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  // ── Events Query ───────────────────────────────────────────────────

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

    const store = runtimeContext.store ?? await initTrustDb();
    const events = await store.query([filter as any]);

    const offset = Number(q.offset) || 0;
    const page = offset > 0 ? events.slice(offset, offset + limit) : events;
    return ok(page);
  });

  // ── Trusted Subjects ───────────────────────────────────────────────

  app.get<{
    Querystring: { author?: string; context?: string };
  }>('/trusted', async (request, reply) => {
    const q = request.query;
    const { author, error: authorError } = resolveAuthor(q.author);

    if (authorError) {
      return sendError(reply, 400, ErrorCode.INVALID_SUBJECT, authorError);
    }
    if (!author) {
      return sendError(reply, 400, ErrorCode.MISSING_AUTHOR, 'Author is required');
    }

    const graph = await loadGraph(runtimeContext);
    const subjects = graph.trustedSubjects(author, q.context);
    return ok(subjects);
  });

}, { name: 'trust-api' });
