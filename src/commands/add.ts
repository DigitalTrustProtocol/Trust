/**
 * Add command — publish kind 32010 (NIP-32010) trust events to add trust to the system.
 */

import { parseSubjects } from '../lib/trust/subject.js';
import { buildTrustEventTemplate } from '../lib/nostr/nip32010.js';
import { signEvent } from '../lib/signer.js';
import { getAvailableRelays, publishEvent } from '../lib/nostr/pool.js';
import { isServerAvailable, proxyTrust } from '../lib/client.js';
import { logger } from '../lib/logger.js';

export async function addCommand(options: {
  subjects: string[];
  context?: string;
  value: number;
  content?: string;
  relay?: string[];
  json?: boolean;
  server?: boolean;
}): Promise<void> {
  const { subjects, context, value, content = '', relay, json, server } = options;

  if (server) {
    const serverUp = await isServerAvailable();
    if (serverUp) {
      const result = await proxyTrust(undefined, {
        subjects,
        context,
        value,
        content,
        relay,
      });

      if (json) {
        console.log(JSON.stringify(result));
      } else {
        const anyResult = result as {
          event?: { id?: string };
          relays?: string[];
        };

        logger.info('Added trust via server');
        if (anyResult.event?.id) {
          logger.info(`Event ID: ${anyResult.event.id}`);
        }
        if (Array.isArray(anyResult.relays) && anyResult.relays.length > 0) {
          logger.info(`Relay(s): ${anyResult.relays.join(', ')}`);
        }
      }
      return;
    }
  }

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
  const relaySelection = await getAvailableRelays(relay);
  const relays = relaySelection.selected;
  if (relaySelection.offline.length > 0) {
    logger.warn(`Skipping offline relays: ${relaySelection.offline.map((status) => status.url).join(', ')}`);
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
