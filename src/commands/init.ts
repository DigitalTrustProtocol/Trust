import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { getOrCreateKeyPair, hasSecretKey } from '../lib/keys.js';
import { initTrustDb } from '../lib/db/dbManager.js';
import { createSignedEvent } from '../lib/signer.js';
import { publishEvent, queryEvents } from '../lib/nostr/pool.js';
import { PATHS, DEFAULT_CONFIG, type UserConfig, DEFAULT_RELAYS } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Initialize a new Trust identity
 */
export async function initCommand(options: {
  name?: string;
  about?: string;
  skipProfile?: boolean;
}): Promise<void> {
  logger.info('Initializing Trust identity...');

  if (hasSecretKey()) {
    logger.warn(`Secret key already exists at ${PATHS.secretKey}`);
    logger.warn('To reset, delete the file and run init again.');

    await initTrustDb();

    const { keyPair } = getOrCreateKeyPair();
    console.log('Your existing identity:');
    console.log(`  Public Key: ${keyPair.publicKey}`);
    console.log(`  npub:       ${keyPair.npub}`);
    console.log(`  Profile:    https://trust.dance/${keyPair.npub}`);
    return;
  }

  const { keyPair, isNew } = getOrCreateKeyPair();

  if (isNew) {
    logger.info('Generated new Nostr keypair');
    logger.info(`Saved to: ${PATHS.secretKey}`);
  }

  console.log('Your identity:');
  console.log(`  Public Key: ${keyPair.publicKey}`);
  console.log(`  npub:       ${keyPair.npub}`);
  console.log(`  Profile:    https://trust.dance/${keyPair.npub}`);

  if (!existsSync(PATHS.configDir)) {
    mkdirSync(PATHS.configDir, { recursive: true, mode: 0o700 });
  }

  const name = options.name;
  const about = options.about;

  const config: UserConfig = {
    ...DEFAULT_CONFIG,
    createdAt: new Date().toISOString(),
    profile: name || about ? { name, about } : undefined,
  };

  writeFileSync(PATHS.config, JSON.stringify(config, null, 2), { mode: 0o600 });
  logger.info(`Config saved to ${PATHS.config}`);

  await initTrustDb();
  logger.info(`Trust database initialized at ${PATHS.trustDb}`);

  if ((name || about) && !options.skipProfile) {
    logger.info('Checking for existing profile on Nostr relays...');

    try {
      const existingProfiles = await queryEvents(
        { kinds: [0], authors: [keyPair.publicKey] },
        DEFAULT_RELAYS
      );

      if (existingProfiles.length > 0) {
        logger.info('Found existing profile on relays. Skipping publication to avoid overwriting.');
        logger.info('Use a profile update command if you want to modify your existing profile.');
      } else {
        logger.info('Publishing profile to Nostr relays...');

        const metadata = JSON.stringify({
          name: name || undefined,
          about: about || undefined,
        });

        const event = createSignedEvent(0, metadata);
        const relays = await publishEvent(event);

        if (relays.length > 0) {
          logger.info(`Profile published to ${relays.length} relay(s): ${relays.join(', ')}`);
        } else {
          logger.warn('Could not publish to any relays. You can retry later with a profile publish command');
        }
      }
    } catch (error) {
      logger.error(`Failed to check/publish profile: ${error instanceof Error ? error.message : error}`);
    }
  }

  logger.info('Initialization complete!');
  console.log('\nNext steps:');
  console.log('  trust whoami  - View your identity');
}
