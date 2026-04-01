import { finalizeEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import { loadSecretKey } from './keys.js';

/**
 * Sign a Nostr event template with the stored secret key
 */
export function signEvent(template: EventTemplate): VerifiedEvent {
  const secretKey = loadSecretKey();
  if (!secretKey) {
    throw new Error('No secret key found. Run `trust init` first.');
  }

  return finalizeEvent(template, secretKey);
}

/**
 * Create an event template with current timestamp
 */
export function createEventTemplate(
  kind: number,
  content: string,
  tags: string[][] = []
): EventTemplate {
  return {
    kind,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Sign and return a complete event
 */
export function createSignedEvent(
  kind: number,
  content: string,
  tags: string[][] = []
): VerifiedEvent {
  const template = createEventTemplate(kind, content, tags);
  return signEvent(template);
}
