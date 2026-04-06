/**
 * Trust SDK — Programmatic API for AI agents and library consumers.
 *
 * Usage:
 *   import { resolve, add, whoami } from '@dtp/trust';
 */

import { existsSync, readFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools/pure';
import type { VerifiedEvent } from 'nostr-tools';
import type { FastifyInstance } from 'fastify';

import { PATHS, DEFAULT_CONFIG, type UserConfig, getRuntimeConfig, type ResolvedRuntimeConfig } from './config.js';
import { loadKeyPair, getOrCreateKeyPair, loadSecretKey, type KeyPair } from './lib/keys.js';
import { parseSubjects } from './lib/trust/subject.js';
import { resolveTargetForQuery } from './lib/trust/subject.js';
import { buildTrustEventTemplate } from './lib/nostr/nip32010.js';
import { signEvent } from './lib/signer.js';
import { getAvailableRelays, publishEvent } from './lib/nostr/pool.js';
import { Score } from './lib/trust/resolvers/Score.js';
import standardResolver from './lib/trust/resolvers/trustResolver.js';
import { loadGraph, insertEvent as graphInsertEvent } from './lib/trust/graphManager.js';
import { initTrustDb } from './lib/db/dbManager.js';
import { getRuntimeContext, setupStore, type RuntimeContext } from './lib/runtimeContext.js';
import { createApp, type ServerService } from './server/app.js';
import type { ResolveFormat } from './lib/trust/resolvers/IResolveStrategy.js';
import type { GraphSyncResult } from './server/graph-sync.js';

// ── Types ────────────────────────────────────────────────────────────

export type { Score, ResolveFormat, GraphSyncResult, KeyPair, UserConfig, ServerService };

export interface Identity {
  publicKey: string;
  npub: string;
  profile: UserConfig['profile'] | null;
  relays: string[];
}

export interface AddOptions {
  contexts?: string;
  value?: 1 | 0 | -1;
  content?: string;
  relay?: string[];
}

export interface ResolveOptions {
  authors?: string;
  contexts?: string;
  maxDepth?: number;
  format?: ResolveFormat;
}

export interface SyncOptions {
  relay?: string[];
  since?: string;
  authors?: string;
  contexts?: string;
  maxDepth?: number;
  syncInterval?: number;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  relay?: string[];
  service?: ServerService;
  database?: string;
  authors?: string;
  contexts?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────

let cachedRuntimeContext: RuntimeContext | null = null;

async function ensureRuntimeContext(opts?: Record<string, unknown>): Promise<RuntimeContext> {
  if (cachedRuntimeContext) return cachedRuntimeContext;
  const cfg = getRuntimeConfig(opts);
  const ctx = await getRuntimeContext(cfg);
  await setupStore(ctx);
  cachedRuntimeContext = ctx;
  return ctx;
}

function getAuthorPubkey(authors?: string): string {
  if (authors) {
    const parsed = resolveTargetForQuery(authors);
    if (parsed.tag !== 'p') throw new Error('Author must be a pubkey (npub or hex)');
    return parsed.value;
  }
  const sk = loadSecretKey();
  if (!sk) throw new Error('No identity configured. Run trust init first.');
  return getPublicKey(sk).toLowerCase();
}

function normalizeContext(context: string | undefined): string | undefined {
  if (context === undefined) return '';
  if (context === 'undefined') return undefined;
  return context;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Initialize a new Trust identity. Returns the identity if one already exists.
 */
export async function init(options?: { name?: string; about?: string }): Promise<Identity> {
  const { keyPair } = getOrCreateKeyPair();
  await initTrustDb();

  let config: UserConfig | null = null;
  if (existsSync(PATHS.config)) {
    try { config = JSON.parse(readFileSync(PATHS.config, 'utf-8')); } catch { /* ignore */ }
  }

  return {
    publicKey: keyPair.publicKey,
    npub: keyPair.npub,
    profile: config?.profile ?? null,
    relays: config?.relays ?? DEFAULT_CONFIG.relays,
  };
}

/**
 * Get current identity. Returns null if not initialized.
 */
export function whoami(): Identity | null {
  const keyPair = loadKeyPair();
  if (!keyPair) return null;

  let config: UserConfig | null = null;
  if (existsSync(PATHS.config)) {
    try { config = JSON.parse(readFileSync(PATHS.config, 'utf-8')); } catch { /* ignore */ }
  }

  return {
    publicKey: keyPair.publicKey,
    npub: keyPair.npub,
    profile: config?.profile ?? null,
    relays: config?.relays ?? [],
  };
}

/**
 * Issue a trust assertion (kind 32010) and publish to relays.
 */
export async function add(subjects: string[], options?: AddOptions): Promise<VerifiedEvent> {
  if (subjects.length === 0) throw new Error('At least one subject required');

  const value = options?.value ?? 1;
  const parsed = parseSubjects(subjects);
  const template = buildTrustEventTemplate({
    subjects: parsed,
    context: options?.contexts,
    value,
    content: options?.content ?? '',
  });

  const event = signEvent(template) as VerifiedEvent;
  const relaySelection = await getAvailableRelays(options?.relay);
  await publishEvent(event, relaySelection.selected);

  const ctx = await ensureRuntimeContext();
  await graphInsertEvent(event, ctx);

  return event;
}

/**
 * Resolve trust from author's perspective toward a subject.
 */
export async function resolve(subject: string, options?: ResolveOptions): Promise<Score> {
  const author = getAuthorPubkey(options?.authors);
  const { value: subjectId } = resolveTargetForQuery(subject);
  const context = normalizeContext(options?.contexts);
  const format = options?.format ?? 'default';

  const ctx = await ensureRuntimeContext();
  const graph = await loadGraph(ctx);

  return standardResolver.resolve(author, subjectId, {
    graph,
    context,
    maxDepth: options?.maxDepth,
    format,
  });
}

/**
 * Resolve trust for multiple subjects in a single call.
 * Shares the graph load across all resolutions.
 */
export async function resolveBatch(
  subjects: string[],
  options?: ResolveOptions,
): Promise<Array<{ subject: string; ok: true; score: Score } | { subject: string; ok: false; error: string }>> {
  const author = getAuthorPubkey(options?.authors);
  const context = normalizeContext(options?.contexts);
  const format = options?.format ?? 'default';

  const ctx = await ensureRuntimeContext();
  const graph = await loadGraph(ctx);

  return subjects.map((subject) => {
    try {
      const { value: subjectId } = resolveTargetForQuery(subject);
      const score = standardResolver.resolve(author, subjectId, {
        graph,
        context,
        maxDepth: options?.maxDepth,
        format,
      });
      return { subject, ok: true as const, score };
    } catch (err) {
      return { subject, ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Sync trust events from relays. Returns sync result when complete.
 */
export async function sync(options?: SyncOptions): Promise<GraphSyncResult> {
  const { runSync, initRuntimeContext } = await import('./commands/sync.js');
  const ctx = await initRuntimeContext(options as Record<string, unknown> ?? {});
  const result = await runSync(ctx);
  return result ?? { processedAuthors: 0, eventsReceived: 0, eventsInserted: 0, latestTimestamp: 0 };
}

/**
 * List subjects trusted by an author in a given context.
 */
export async function trusted(author?: string, options?: { context?: string }): Promise<string[]> {
  const authorPubkey = getAuthorPubkey(author);
  const ctx = await ensureRuntimeContext();
  const graph = await loadGraph(ctx);
  return graph.trustedSubjects(authorPubkey, options?.context);
}

/**
 * Create and return a Fastify server instance (does not start listening).
 */
export async function createServer(options?: ServerOptions): Promise<FastifyInstance> {
  const cfg = getRuntimeConfig(options as Record<string, unknown>);
  const ctx = await getRuntimeContext(cfg);
  await setupStore(ctx);
  return createApp(options?.service ?? 'all', ctx);
}
