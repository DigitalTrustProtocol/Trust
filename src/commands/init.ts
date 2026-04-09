import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { getOrCreateKeyPair, hasSecretKey } from '../lib/keys.js';
import { PATHS, DEFAULT_CONFIG, type UserConfig } from '../config.js';
import { logger } from '../lib/logger.js';

export async function initCommand(options: {
  name?: string;
  about?: string;
  skipProfile?: boolean;
  json?: boolean;
}): Promise<void> {
  const isJson = options.json ?? false;

  if (hasSecretKey()) {
    if (!isJson) {
      logger.warn(`Identity already exists at ${PATHS.identity}`);
      logger.warn('To reset, remove identity storage and run init again.');
    }


    const { keyPair } = getOrCreateKeyPair();
    if (isJson) {
      console.log(JSON.stringify({
        publicKey: keyPair.publicKey,
        npub: keyPair.npub,
        configDir: PATHS.configDir,
        existing: true,
      }));
    } else {
      console.log('Your existing identity:');
      console.log(`  Public Key: ${keyPair.publicKey}`);
      console.log(`  npub:       ${keyPair.npub}`);
      console.log(`  Profile:    https://trust.dance/${keyPair.npub}`);
    }
    return;
  }

  const { keyPair, isNew } = getOrCreateKeyPair();

  if (!isJson) {
    if (isNew) {
      logger.info('Generated new Nostr keypair');
      logger.info(`Saved to: ${PATHS.identity} and ${PATHS.keysDir}/`);
    }
    console.log('Your identity:');
    console.log(`  Public Key: ${keyPair.publicKey}`);
    console.log(`  npub:       ${keyPair.npub}`);
    console.log(`  Profile:    https://trust.dance/${keyPair.npub}`);
  }

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
  if (!isJson) logger.info(`Config saved to ${PATHS.config}`);

  /*
  // This should be handled by the init.
  const runtimeContext = await initRuntimeContext(options as Record<string, unknown>);
  let store = runtimeContext.store;
  if (!store) throw new Error('Store not loaded');
  if (!isJson) logger.info(`Trust database initialized at ${PATHS.trustDb}`);
  */

  /*
  // This should not be handled by the init.
  if ((name || about) && !options.skipProfile) {
    if (!isJson) logger.info('Checking for existing profile on Nostr relays...');

    try {
      const existingProfiles = await queryEvents(
        { kinds: [0], authors: [keyPair.publicKey] },
        DEFAULT_RELAYS
      );

      if (existingProfiles.length > 0) {
        if (!isJson) {
          logger.info('Found existing profile on relays. Skipping publication to avoid overwriting.');
          logger.info('Use a profile update command if you want to modify your existing profile.');
        }
      } else {
        if (!isJson) logger.info('Publishing profile to Nostr relays...');

        const metadata = JSON.stringify({
          name: name || undefined,
          about: about || undefined,
        });

        const event = createSignedEvent(0, metadata);
        const relays = await publishEvent(event);

        if (relays.length > 0) {
          if (!isJson) logger.info(`Profile published to ${relays.length} relay(s): ${relays.join(', ')}`);
        } else {
          if (!isJson) logger.warn('Could not publish to any relays. You can retry later with a profile publish command');
        }
      }
    } catch (error) {
      if (!isJson) logger.error(`Failed to check/publish profile: ${error instanceof Error ? error.message : error}`);
    }
  }
  */

  if (isJson) {
    console.log(JSON.stringify({
      publicKey: keyPair.publicKey,
      npub: keyPair.npub,
      configDir: PATHS.configDir,
      existing: false,
    }));
  } else {
    logger.info('Initialization complete!');
    console.log('\nNext steps:');
    console.log('  trust whoami  - View your identity');
  }
}
