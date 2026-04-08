import { existsSync } from 'node:fs';
import { resolveTargetForQuery } from '../lib/trust/subject.js';
import { loadSecretKey } from '../lib/keys.js';
import { getPublicKey } from 'nostr-tools/pure';
import { isServerAvailable, proxyResolve } from '../lib/client.js';
import type { ResolveFormat } from '../lib/trust/resolvers/IResolveStrategy.js';
import { Score } from '../lib/trust/resolvers/Score.js';
import standardResolver from '../lib/trust/resolvers/trustResolver.js';
import { loadGraph } from '../lib/trust/graphManager.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig, type ResolvedRuntimeConfig } from '../config.js';
import { getRuntimeContext, setupStore } from '../lib/runtimeContext.js';

export type { ResolveFormat };

/**
 * Pick the best API endpoint for resolution:
 *  1. If sqlite and the trust.db exists locally, try the localhost server first.
 *  2. Fall back to the configured remote API (trust.dance by default).
 *  3. Return null if neither is reachable (will resolve from local graph).
 */
async function pickApiHost(cfg: ResolvedRuntimeConfig): Promise<string | null> {
  if (process.env.TRUST_E2E_OFFLINE === '1') return null;

  if (cfg.database === 'sqlite' && existsSync(cfg.sqlitePath)) {
    const localUrl = `http://${cfg.host}:${cfg.port}`;
    if (await isServerAvailable(localUrl)) {
      return localUrl;
    }
  }

  if (await isServerAvailable(cfg.remoteApiUrl)) {
    return cfg.remoteApiUrl;
  }

  return null;
}

export async function resolveTrustCommand(options: {
  subject: string;
  author?: string;
  context?: string;
  maxDepth?: number;
  format?: ResolveFormat;
  apiUrl?: string;
  json?: boolean;
}): Promise<void> {
  const format = options.format ?? 'default';
  const cfg = getRuntimeConfig(options);

  const apiHost = options.apiUrl ?? await pickApiHost(cfg);

  if (apiHost) {
    if (!options.json) logger.info(`Using API: ${apiHost}`);
    const result = await proxyResolve(apiHost, {
      subject: options.subject,
      author: options.author,
      context: options.context,
      maxDepth: options.maxDepth,
      format,
    });
    outputResolveResult(result, format, options.json ?? false);
    return;
  }

  if (!options.json) logger.info('No API available, resolving from local database');
  const runtimeContext = await getRuntimeContext(cfg);
  await setupStore(runtimeContext);

  let author: string | null = null;
  if (options.author) {
    const parsed = resolveTargetForQuery(options.author);
    if (parsed.tag !== 'p') {
      throw new Error('Author must be a pubkey (npub or hex)');
    }
    author = parsed.value;
  } else {
    const sk = loadSecretKey();
    author = sk ? getPublicKey(sk).toLowerCase() : null;
  }

  if (!author) {
    throw new Error('Author is required');
  }

  const { tag, value: subjectId } = resolveTargetForQuery(options.subject);

  const graph = await loadGraph(runtimeContext);
  const score = standardResolver.resolve(author, subjectId, {
    graph,
    context: options.context,
    maxDepth: options.maxDepth,
    format,
  });

  outputResolveResult(score, format, options.json ?? false);
}


function outputResolveResult(
  score: Score,
  format: ResolveFormat,
  json: boolean,
): void {

  if (format === 'number') {
    const value =
      score.trustValue !== undefined
        ? (score.trustValue as number)
        : ((score.trustValue as number) ?? 0) - ((score.distrust as number) ?? 0);
    if (json) {
      console.log(JSON.stringify({ value }));
    } else {
      console.log(String(value));
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(score));
    return;
  }

  if (score !== undefined) {
    if (score.connected) {
      logger.info(`Connected (degree ${score.degree})`);
    } else {
      logger.info('No connection');
    }
  }
  logger.info(`Trust: ${score.trust}  Distrust: ${score.distrust}`);
  logger.info(`Trust Value: ${score.trustValue}`);
  logger.info(`Degree: ${score.degree}`);
}
