import { getStore, initTrustDb } from '../lib/db/dbManager.js';
import { resolveTargetForQuery } from '../lib/trust/subject.js';
import { loadSecretKey } from '../lib/keys.js';
import { getPublicKey } from 'nostr-tools/pure';
import { isServerAvailable, proxyResolve } from '../lib/client.js';
import type { ResolveFormat } from '../lib/trust/resolvers/IResolveStrategy.js';
import { Score } from '../lib/trust/resolvers/Score.js';
import standardResolver from '../lib/trust/resolvers/trustResolver.js';
import { loadGraph } from '../lib/trust/graphManager.js';
import { logger } from '../lib/logger.js';

export type { ResolveFormat };


function normalizeContext(context: string | undefined): string | undefined {
  if (context === undefined) return '';
  if (context === 'undefined') return undefined;
  return context;
}

export async function resolveTrustCommand(options: {
  subject: string;
  authors?: string;
  contexts?: string;
  strategy?: string;
  maxDepth?: number;
  format?: ResolveFormat;
  json?: boolean;
}): Promise<void> {
  const format = options.format ?? 'default';
  const serverUp = await isServerAvailable();

  if (serverUp) {
    const result = await proxyResolve(undefined, {
      subject: options.subject,
      authors: options.authors,
      contexts: options.contexts,
      strategy: options.strategy,
      maxDepth: options.maxDepth,
      format,
    });
    outputResolveResult(result, format, options.json ?? false);
    return;
  }

  let store = await initTrustDb();
  const context = normalizeContext(options.contexts);

  let author: string | null = null;
  if (options.authors) {
    const parsed = resolveTargetForQuery(options.authors);
    if (parsed.tag !== 'p') {
      throw new Error('Author must be a pubkey (npub or hex)');
    }
    author = parsed.value;
  } else {
    const sk = loadSecretKey();
    author = sk ? getPublicKey(sk).toLowerCase() : null;
  }

  const { tag, value: subjectId } = resolveTargetForQuery(options.subject);

  let score: Score | undefined;

  if (author) {
    const graph = await loadGraph(store);
    score = standardResolver.resolve(author, subjectId, {
      graph,
      context,
      maxDepth: options.maxDepth,
      format,
    });

    outputResolveResult(score, format, options.json ?? false);
    return;
  }

  throw new Error('Author is required');
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
