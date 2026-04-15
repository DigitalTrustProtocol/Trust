/**
 * Add command — publish kind 32010 (NIP-32010) trust events directly to relay servers.
 * Delegates to `add()` in `sdk.ts` so CLI and programmatic API share one code path.
 */

import { add as sdkAdd } from '../sdk.js';
import { writeSync } from 'node:fs';
import { closePool, getRelays, type PublishReport } from '../lib/nostr/pool.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig, mergeUserConfig } from '../config.js';
import { withLocalServerRelay } from '../lib/server-state.js';
import { probeRelays } from '../lib/nostr/relayManager.js';

const CLOSE_POOL_TIMEOUT_MS = 3_000;
//const RELAY_PROBE_TIMEOUT_MS = 8_000;
function writeStdoutLine(message: string): void {
  writeSync(process.stdout.fd, `${message}\n`);
}

function writeStderrLine(message: string): void {
  writeSync(process.stderr.fd, `${message}\n`);
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
  if (!json) {
    writeStdoutLine('Publishing trust assertion...');
  }
  if (subjects.length === 0) {
    throw new Error('At least one subject required');
  }

  let publishReport: PublishReport | undefined;
  //const commandStartedAt = Date.now();
  const config = getRuntimeConfig(options);
  const requestedRelays = withLocalServerRelay(config.relays);

  /*
  const relayProbeStartedAt = Date.now();
  const availableRelays = await withTimeout(
    probeRelays(requestedRelays),
    RELAY_PROBE_TIMEOUT_MS,
    `Relay probe timed out after ${RELAY_PROBE_TIMEOUT_MS}ms`,
  );
    const relayProbeDurationMs = Date.now() - relayProbeStartedAt;
    const onlineRelays = availableRelays.filter((relay) => relay.online);
    logger.info(
      {
        requestedRelaysCount: requestedRelays.length,
        onlineRelaysCount: onlineRelays.length,
        offlineRelaysCount: availableRelays.length - onlineRelays.length,
        relayProbeDurationMs,
      },
      'add timing: relay probe complete',
    );
  if (onlineRelays.length === 0) {
    throw new Error('No online relays found');
  }

  const onlineRelayUrls = onlineRelays.map((relay) => relay.url);
*/
  try {
    const publishStartedAt = Date.now();
    const event = await sdkAdd(subjects, {
      context,
      value,
      content,
      relays: requestedRelays,
      onPublishReport: (report) => {
        publishReport = report;
      },
    });
    /*
    const publishDurationMs = Date.now() - publishStartedAt;
    logger.info(
      {
        publishDurationMs,
        relaysUsedCount: onlineRelayUrls.length,
      },
      'add timing: publish complete',
    );
*/
      //const outputStartedAt = Date.now();
      if (json) {
        writeStdoutLine(JSON.stringify(event));
      } else {
        // Write synchronously to avoid occasional dropped output on process exit.
        writeStdoutLine('Added trust to the system via relay(s)');
        writeStdoutLine(`Event ID: ${event.id}`);
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
      /*
    logger.debug(
      { outputDurationMs: Date.now() - outputStartedAt },
      'add timing: output complete',
    );
    logger.debug(
      { totalDurationMs: Date.now() - commandStartedAt },
      'add timing: command complete',
    );
    */
  } finally {
    const closePoolStartedAt = Date.now();
    await Promise.race([
      closePool(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_POOL_TIMEOUT_MS)),
    ]);
    /*
    logger.info(
      { closePoolDurationMs: Date.now() - closePoolStartedAt },
      'add timing: close pool complete',
    );
    */
  }
}

/*
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
*/