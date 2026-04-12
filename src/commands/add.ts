/**
 * Add command — publish kind 32010 (NIP-32010) trust events directly to relay servers.
 * The default relay list includes the local relay when one is running.
 */

import { parseSubjects } from '../lib/trust/subject.js';
import { buildTrustEventTemplate } from '../lib/nostr/nip32010.js';
import { signEvent } from '../lib/signer.js';
import { getAvailableRelays, publishEvent } from '../lib/nostr/pool.js';
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

  const v = value === 1 ? 1 : value === -1 ? -1 : 0;
  const parsed = parseSubjects(subjects);
  const template = buildTrustEventTemplate({
    subjects: parsed,
    context,
    value: v as 1 | 0 | -1,
    content,
  });

  const event = signEvent(template);

  let relays: string[] = [];
  if (process.env.TRUST_E2E_OFFLINE !== '1') {
    const relaySelection = await getAvailableRelays(relay);
    relays = relaySelection.selected;
    if (relaySelection.offline.length > 0) {
      logger.warn(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
    }
  }

  await publishEvent(event, relays);

  if (json) {
    console.log(JSON.stringify(event));
  } else {
    logger.info('Added trust to the system via relay(s)');
    logger.info(`Event ID: ${event.id}`);
    logger.info(`Relay(s): ${relays.join(', ')}`);
  }
}
