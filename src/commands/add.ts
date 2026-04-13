/**
 * Add command — publish kind 32010 (NIP-32010) trust events directly to relay servers.
 * Delegates to `add()` in `sdk.ts` so CLI and programmatic API share one code path.
 */

import { add as sdkAdd } from '../sdk.js';
import { getAvailableRelays } from '../lib/nostr/pool.js';
import { logger } from '../lib/logger.js';

export async function addCommand(options: {
  subjects: string[];
  /** Trust `c` tag (single context); omit for general trust. */
  context?: string;
  value: number;
  content?: string;
  relay?: string[];
  json?: boolean;
}): Promise<void> {
  const { subjects, context, value, content = '', relay, json } = options;

  if (subjects.length === 0) {
    throw new Error('At least one subject required');
  }

  let relaysResolved: string[] | undefined;
  if (process.env.TRUST_E2E_OFFLINE === '1') {
    relaysResolved = [];
  } else {
    const relaySelection = await getAvailableRelays(relay);
    relaysResolved = relaySelection.selected;
    if (relaySelection.offline.length > 0) {
      logger.warn(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
    }
  }

  const event = await sdkAdd(subjects, {
    context,
    value,
    content,
    relay,
    relaysResolved,
  });

  if (json) {
    console.log(JSON.stringify(event));
  } else {
    logger.info('Added trust to the system via relay(s)');
    logger.info(`Event ID: ${event.id}`);
    logger.info(`Relay(s): ${relaysResolved.join(', ')}`);
  }
}
