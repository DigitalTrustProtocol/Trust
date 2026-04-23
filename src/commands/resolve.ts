import { parseAuthorPubkeyInput, resolveTargetForQuery } from '../lib/trust/subject.js';
import { isServerAvailable, proxyResolve } from '../lib/client.js';
import type { ResolveFormat } from '../lib/trust/resolvers/IResolveStrategy.js';
import { Score } from '../lib/trust/resolvers/Score.js';
import { loadGraph } from '../lib/trust/graphManager.js';
import { getRuntimeConfig, type ResolvedRuntimeConfig } from '../config.js';
import { getRuntimeContext, setupStore } from '../lib/runtimeContext.js';
import { getPrimaryPublicKeyHex } from '../lib/identityStore.js';
import { getServerBaseUrlFromState } from '../lib/server-state.js';
import indexResolver from '../lib/trust/resolvers/IndexResolver.js';

export type { ResolveFormat };

/**
 * Pick the best API endpoint for resolution:
 *  1. If sqlite and the trust.db exists locally, try the localhost server first.
 *  2. Fall back to the configured remote API (trust.dance by default).
 *  3. Return null if neither is reachable (will resolve from local graph).
 */
async function pickApiHost(cfg: ResolvedRuntimeConfig): Promise<string | null> {
  if (process.env.TRUST_E2E_OFFLINE === '1') return null;

  const stateUrl = getServerBaseUrlFromState('api');
  if (stateUrl && await isServerAvailable(stateUrl)) {
    return stateUrl;
  }

  /*
  if (cfg.database === 'sqlite' && existsSync(cfg.connectionString)) {
    const localUrl = `http://${cfg.host}:${cfg.port}`;
    if (await isServerAvailable(localUrl)) {
      return localUrl;
    }
  }
  */

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
    if (!options.json && options.format !== 'number') console.log(`Using API: ${apiHost}`);
    const result = await proxyResolve(apiHost, {
      subject: options.subject,
      author: options.author,
      context: options.context,
      maxDepth: options.maxDepth,
      format,
    });
    outputResolveResult(result, options.subject, format, options.json ?? false);
    return;
  }

  if (!options.json) console.log('No API available, resolving from local database');
  const runtimeContext = await getRuntimeContext(cfg);
  await setupStore(runtimeContext);

  let author: string | null = null;
  if (options.author) {
    author = parseAuthorPubkeyInput(options.author);
  } else {
    author = getPrimaryPublicKeyHex();
  }

  if (!author) {
    throw new Error('Author is required');
  }

  const { tag, value: subjectId } = resolveTargetForQuery(options.subject);

  const graph = await loadGraph(runtimeContext);
  const scores = indexResolver.resolve(author, subjectId, {
    graph,
    context: options.context,
    maxDepth: options.maxDepth,
    format,
  });

  outputResolveResult(scores, subjectId, format, options.json ?? false);
}


function outputResolveResult(
  scores: Score[],
  subject: string,
  format: ResolveFormat,
  json: boolean,
): void {

  if (!scores || scores.length === 0) {
    if (json) {
      console.log(JSON.stringify([]));
    } else {
      console.log('No connection found');
    }
    return;
  }

  const score = scores.find(s => s.subject === subject);
  if (!score) {
    console.log('Should not happen, no score found for subject but an array of scores was returned');
    return;
  }
  const value = score.trustValue;

  if (format === 'number') {
      if (json) {
        console.log({
          value,
        });
      } else {
        console.log(value);
      }
      return;
    }
  

  if (format === 'path') {
      console.log(JSON.stringify(scores, null, 2));
      return;
  }
  if (json) {
    console.log(JSON.stringify({
      trust: score.trust,
      distrust: score.distrust,
      value,
      degree: score.degree,
    }));
    return;
  } 
  console.log(`Trust: ${score.trust}  Distrust: ${score.distrust}`);
  console.log(`Trust Value: ${value}`);
  console.log(`Degree: ${score.degree}`);
}
