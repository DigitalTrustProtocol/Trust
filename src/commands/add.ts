/**
 * Add command — publish kind 32010 (NIP-32010) trust events directly to relay servers.
 * Delegates to `add()` in `sdk.ts` so CLI and programmatic API share one code path.
 */

import { add as sdkAdd } from '../sdk.js';
import { closePool, getRelays, type PublishReport } from '../lib/nostr/pool.js';
import { logger } from '../lib/logger.js';

export async function addCommand(options: {
  subjects: string[];
  /** Trust `c` tag (single context); omit for general trust. */
  context?: string;
  value: number;
  content?: string;
  relays?: string[];
  json?: boolean;
}): Promise<void> {
  const { subjects, context, value, content = '', relays, json } = options;

  if (subjects.length === 0) {
    throw new Error('At least one subject required');
  }

  let publishReport: PublishReport | undefined;
  let requestedRelays = getRelays(relays);
  

  try {
    const event = await sdkAdd(subjects, {
      context,
      value,
      content,
      relays: requestedRelays,
      onPublishReport: (report) => {
        publishReport = report;
      },
    });

    if (json) {
      console.log(JSON.stringify(event));
    } else {
      logger.info('Added trust to the system via relay(s)');
      logger.info(`Event ID: ${event.id}`);
      logger.info(`Relay(s) requested: ${requestedRelays?.join(', ')}`);
      if (publishReport) {
        logger.info(`Relay(s) successful: ${publishReport.successful.join(', ') || '(none)'}`);
        if (publishReport.failed.length > 0) {
          logger.warn(
            `Relay(s) failed: ${publishReport.failed.map((failure) => `${failure.relay} (${failure.error})`).join(', ')}`
          );
        }
      }
    }
  } finally {
    await closePool();
  }
}
