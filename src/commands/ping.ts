import { isServerAvailable, normalizeBaseUrl } from '../lib/client.js';
import { logger } from '../lib/logger.js';
import { getServerBaseUrlFromState } from '../lib/server-state.js';

export interface PingOptions {
  url?: string;
  json?: boolean;
}

export async function pingCommand(options: PingOptions): Promise<void> {

  let url = options.url ?? getServerBaseUrlFromState('api');
  if(!url) {
    url = 'https://trust.dance';
  }
  const baseUrl = normalizeBaseUrl(url);
  const available = await isServerAvailable(baseUrl);


  if (options.json) {
    const out = {
      baseUrl: baseUrl ?? undefined,
      available
    };
    console.log(JSON.stringify(out));
    if (!available) {
      process.exitCode = 1;
    }
    return;
  }

  const resolvedBase = baseUrl ?? 'default server URL';

  if (available) {
    logger.info(`Server ${resolvedBase}: online`);
  } else {
    logger.error(`Server ${resolvedBase}: offline`);
    process.exitCode = 1;
  }
}
