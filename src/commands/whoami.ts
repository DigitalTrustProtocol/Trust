import { loadKeyPair } from '../lib/keys.js';
import { getRuntimeConfig, loadUserConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { getServerRelayUrlFromState, withLocalServerRelay } from '../lib/server-state.js';

/**
 * Display current identity information
 */
export async function whoamiCommand(options: { json?: boolean; relays?: string[] }): Promise<void> {
  const keyPair = loadKeyPair();

  if (!keyPair) {
    logger.error('No identity found. Run `trust init` first.');
    process.exit(1);
  }

  const runtimeConfig = getRuntimeConfig(options);
  const resolvedRelays = withLocalServerRelay(runtimeConfig.relays);

  if (options.json) {
    const output = {
      publicKey: keyPair.publicKey,
      npub: keyPair.npub,
      profile: runtimeConfig.profile || null,
      profileUrl: `https://trust.dance/${keyPair.npub}`,
      relays: resolvedRelays
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('Trust v.0.1.0 - Identity');
  console.log('--------');
  console.log(`Public Key:  ${keyPair.publicKey}`);
  console.log(`npub:        ${keyPair.npub}`);
  console.log(`Profile URL: https://trust.dance/${keyPair.npub}`);

  if (runtimeConfig.profile) {
    console.log('');
    console.log('Profile');
    console.log('-------');
    if (runtimeConfig.profile.name) console.log(`Name:  ${runtimeConfig.profile.name}`);
    if (runtimeConfig.profile.about) console.log(`About: ${runtimeConfig.profile.about}`);
    if (runtimeConfig.profile.lud16) console.log(`Lightning: ${runtimeConfig.profile.lud16}`);
  }

  if (resolvedRelays.length > 0) {
    console.log('');
    console.log('Relays');
    console.log('------');
    resolvedRelays.forEach((relay) => {
      console.log(`  ${relay}`);
    });
  }
}
