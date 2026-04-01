import { existsSync, readFileSync } from 'node:fs';
import { loadKeyPair } from '../lib/keys.js';
import { PATHS, type UserConfig } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Display current identity information
 */
export async function whoamiCommand(options: { json?: boolean }): Promise<void> {
  const keyPair = loadKeyPair();

  if (!keyPair) {
    logger.error('No identity found. Run `trust init` first.');
    process.exit(1);
  }

  let config: UserConfig | null = null;
  if (existsSync(PATHS.config)) {
    try {
      config = JSON.parse(readFileSync(PATHS.config, 'utf-8'));
    } catch {
      // Ignore config errors
    }
  }

  if (options.json) {
    const output = {
      publicKey: keyPair.publicKey,
      npub: keyPair.npub,
      profile: config?.profile || null,
      profileUrl: `https://trust.dance/${keyPair.npub}`,
      relays: config?.relays || [],
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('Trust v.0.1.0 - Identity');
  console.log('--------');
  console.log(`Public Key:  ${keyPair.publicKey}`);
  console.log(`npub:        ${keyPair.npub}`);
  console.log(`Profile URL: https://dpeep.com/profile/${keyPair.npub}`);

  if (config?.profile) {
    console.log('');
    console.log('Profile');
    console.log('-------');
    if (config.profile.name) console.log(`Name:  ${config.profile.name}`);
    if (config.profile.about) console.log(`About: ${config.profile.about}`);
    if (config.profile.lud16) console.log(`Lightning: ${config.profile.lud16}`);
  }

  if (config?.relays && config.relays.length > 0) {
    console.log('');
    console.log('Relays');
    console.log('------');
    config.relays.forEach((r) => console.log(`  ${r}`));
  }
}
