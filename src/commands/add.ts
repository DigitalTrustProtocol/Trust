/**
 * Add command — publish kind 32010 (NIP-32010) trust events directly to relay servers.
 * Delegates to `add()` in `sdk.ts` so CLI and programmatic API share one code path.
 */

import { add as sdkAdd } from '../sdk.js';
//import { writeSync } from 'node:fs';
import { closePool, type PublishReport } from '../lib/nostr/pool.js';
import { getRuntimeConfig } from '../config.js';
import { withLocalServerRelay } from '../lib/server-state.js';
import { getDTagFromTags } from '../lib/nostr/nip32010.js';
import { logger } from '../lib/logger.js';

const CLOSE_POOL_TIMEOUT_MS = 3_000;

function writeStdoutLine(message: string): void {
  //console.log(message);
  //writeSync(process.stdout.fd, `${message}\n`);
  logger.info(message);
  logger.flush();
}

function writeStderrLine(message: string): void {
  //writeSync(process.stderr.fd, `${message}\n`);
  logger.error(message);
  logger.flush();
  //console.error(message);
}



function writeDebugLine(message: string): void {
  //console.debug(message);
  
}

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

  const config = getRuntimeConfig(options);
  const requestedRelays = withLocalServerRelay(config.relays);

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
      writeStdoutLine(JSON.stringify(event));
    } else {
      // Write synchronously to avoid occasional dropped output on process exit.
      writeStdoutLine('Added trust to the system via relay(s)');
      writeStdoutLine(`Event ID: ${event.id}`);
      writeStdoutLine(`Event d tag: ${getDTagFromTags(event)}`);

      logger.trace('Event:\r\n' + JSON.stringify(event, null, 2));
      
      //writeStdoutLine(`Relay(s) requested: ${requestedRelays?.join(', ')}`);
      if (publishReport) {
        writeStdoutLine(`Relay(s) successful: ${publishReport.successful.join(', ') || '(none)'}`);
        if (publishReport.failed.length > 0) {
          writeStderrLine(
            `Relay(s) failed: ${publishReport.failed.map((failure) => `${failure.relay} (${failure.error})`).join(', ')}`
          );
        }
      }
    }

  } finally {
    await Promise.race([
      closePool(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_POOL_TIMEOUT_MS)),
    ]);

  }
}
