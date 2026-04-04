import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { whoamiCommand } from './commands/whoami.js';
import { timestampCommand } from './commands/timestamp.js';
import { addCommand } from './commands/add.js';
import { syncTrustCommand } from './commands/sync.js';
import { showTrustCommand } from './commands/show.js';
import { resolveTrustCommand } from './commands/resolve.js';
import { parseServerService, serverCommand } from './commands/server.js';
import { pingCommand } from './commands/ping.js';
import { registerConfig } from './commands/config.js';
import {
  identityGenerateCommand,
  identityImportCommand,
  identityListCommand,
  identityPrimaryCommand,
  identityRemoveCommand,
} from './commands/identity.js';


const program = new Command();

program
  .name('trust')
  .description('Trust CLI — Digital Web of Trust Reputation')
  .version('0.1.0');

// init - Initialize identity
program
  .command('init')
  .description('Initialize a new Trust identity')
  .option('-n, --name <name>', 'Profile name')
  .option('-a, --about <about>', 'Profile bio')
  .option('--skip-profile', 'Skip publishing profile to relays (useful for testing)')
  .action(async (options) => {
    try {
      await initCommand({
        name: options.name,
        about: options.about,
        skipProfile: options.skipProfile,
      });
    } finally {
    }
  });

// whoami - Display identity
program
  .command('whoami')
  .description('Display your current identity')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await whoamiCommand(options);
    } finally {
    }
  });

// timestamp - View or update the stored timestamps (infrastructure for incremental fetching)
program
  .command('timestamp')
  .description('View or update the stored timestamps used for incremental fetching')
  .option('--get', 'Print the raw latest timestamp value')
  .option('--set <value>', 'Set the latest timestamp to a specific unix value')
  .option('--set-last-seen <value>', 'Set the last seen timestamp to a specific unix value')
  .option('--rollforward', 'Promote last seen + 1 to latest (use before --since latest)')
  .option('--json', 'Output both timestamps as a JSON object')
  .action(async (options) => {
    try {
      await timestampCommand({
        get: options.get,
        set: options.set,
        setLastSeen: options.setLastSeen,
        rollforward: options.rollforward,
        json: options.json,
      });
    } finally {
    }
  });

// add - Add trust to the system (kind 32010, NIP-32010)
program
  .command('add <subject> [subjects...]')
  .description('Add trust for the given subject(s) (kind 32010)')
  .option('-c, --contexts <contexts>', 'Trust context (e.g. development, commerce)')
  .option('-v, --value <value>', 'Trust value: 1 (trust), 0 (neutral), -1 (distrust)', '1')
  .option('--content <content>', 'Optional note explaining the trust assertion')
  .option('-r, --relay <url...>', 'Relay URL(s) to publish to')
  .option(
    '--no-server',
    'Bypass Trust server and publish directly to relays (even if the server is running).',
  )
  .option('--json', 'Output event as JSON')
  .action(async (subject, subjects, options) => {
    try {
      await addCommand({
        subjects: [subject, ...(subjects || [])],
        contexts: options.contexts,
        value: parseInt(options.value, 10),
        content: options.content,
        relay: options.relay,
        json: options.json,
        // Commander sets .server default true, and to false when --no-server is passed.
        server: options.server,
      });
    } finally {

    }
  });

// sync - Sync trust events from relays
program
  .command('sync')
  .description('Sync trust events from relays into local database')
  .option('-r, --relay <url...>', 'Relay URL(s) to query')
  .option('--since <unix-ts>', 'Start sync from this unix timestamp (overwrites stored value)')
  .option(
    '--authors <value>',
    'Omitted: use config authors, else identity pubkeys. * or All = all authors; primary = primary key only; or comma-separated hex pubkeys',
  )
  .option(
    '--contexts <value>',
    'Trust `c` tag filter: All, or comma-separated contexts (overrides config; matches empty tag with an empty segment in the list)',
  )
  .option('--max-depth <n>', 'Max trust graph depth to sync (default: 3)', (val: string) => parseInt(val, 10), 3)
  .option('--sync-interval <seconds>', 'Seconds between sync runs (0 = run once)', (val: string) => parseInt(val, 10), 0)
  .option('--json', 'Output sync stats as JSON')
  .action(async (options) => {
      await syncTrustCommand({
        relay: options.relay,
        since: options.since,
        authors: options.authors,
        contexts: options.contexts,
        maxDepth: options.maxDepth,
        syncInterval: options.syncInterval,
        json: options.json,
      });
  });

// resolve - Resolve trust path and reputation
program
  .command('resolve <subject> [authors]')
  .description('Resolve trust path and reputation for subject (from authors perspective, default: primary key)')
  .option('-c, --contexts <contexts>', 'Filter by context (default: ""). Use -c undefined for all contexts')
  .option('-s, --strategy <name>', 'Resolve strategy (default: cache)', 'cache')
  .option('--max-depth <n>', 'Max trust path depth (1-4, default: 4). Limited by strategy max.', '4')
  .option('--authors <npub|hex>', 'Author pubkey (alternative to positional)')
  .option('-f, --format <name>', 'Output format: number, default, path', 'default')
  .option('--json', 'Output as JSON')
  .action(async (subject, authors, options) => {
    try {
      await resolveTrustCommand({
        subject,
        authors: authors ?? options.authors,
        contexts: options.contexts,
        strategy: options.strategy,
        maxDepth: parseInt(options.maxDepth, 10),
        format: options.format as 'number' | 'default' | 'path',
        json: options.json,
      });
    } finally {
    }
  });

// show - Show trust event by d tag
program
  .command('show <d-tag>')
  .description('Show a trust event by d tag value')
  .option('-r, --relay <url...>', 'Relay URL(s) if not in local DB')
  .option('--source <source>', 'Where to look: database, server, relay (default: database/server then relay)')
  .option('--json', 'Output event as JSON')
  .action(async (dTag, options) => {
    try {
      await showTrustCommand({
        dTag,
        relay: options.relay,
        json: options.json,
        source: options.source,
      });
    } finally {
    }
  });

// server - Run HTTP server and relay subscription
program
  .command('server')
  .description(
    'Run Trust server (default: relay + API + web in one process). Use --service to run one component.',
  )
  .option('-p, --port <port>', 'HTTP port for the Web API', (val: string) => parseInt(val, 10))
  .option('-h, --host <host>', 'Bind host (e.g. localhost, 0.0.0.0)')
  .option('-r, --relay <url...>', 'Relay URL(s) for websocket subscription')
  .option('--since <unix-ts>', 'Start subscription from this unix timestamp (overwrites stored value)')
  .option(
    '--authors <value>',
    'Same as sync: omitted → config then identity; * or All = all; primary = primary only; or comma-separated hex (overrides config when set)',
  )
  .option(
    '--contexts <value>',
    'Trust `c` tag filter: All or comma-separated contexts (overrides config)',
  )
  .option('--max-depth <n>', 'Max trust graph depth to sync (default: 3)', (val: string) => parseInt(val, 10), 3)
  .option('--sync-interval <seconds>', 'Seconds between graph sync runs (0 = run once)', (val: string) => parseInt(val, 10), 0)
  .option(
    '--service <name>',
    'Component to run: all (default), relay, api, or web',
    (val: string) => parseServerService(val),
  )
  .option(
    '--database <driver>',
    'Trust store: sqlite or postgres (default: postgres if DATABASE_URL / PG* / config URL is set, else sqlite)',
  )
  .option('--json', 'Output startup info as JSON')
  .action(async (options) => {
    try {
      await serverCommand({
        port: options.port,
        host: options.host,
        relay: options.relay,
        since: options.since,
        authors: options.authors,
        contexts: options.contexts,
        maxDepth: options.maxDepth,
        syncInterval: options.syncInterval,
        service: options.service,
        database: options.database,
        json: options.json,
      });
    } finally {
    }
  });

// ping - Check if server is running
program
  .command('ping')
  .description('Ping the Trust server (health check)')
  .option('-u, --url <baseUrl>', 'Base URL of the server (default from config)')
  .option('--json', 'Output result as JSON')
  .action(async (options) => {
    try {
      await pingCommand({
        url: options.url,
        json: options.json,
      });
    } finally {
      // No relay or DB resources are used directly here
    }
  });

registerConfig(program);

const identity = program.command('identity').description('Manage signing keys (primary + additional identities)');

identity
  .command('list')
  .description('List known public keys and which is primary')
  .option('--json', 'JSON output')
  .action(async (options: { json?: boolean }) => {
    await identityListCommand(options);
  });

identity
  .command('import')
  .description('Import a secret key (hex or nsec) into ~/.trust/keys/')
  .requiredOption('--secret <hex|nsec>', '64 hex chars or nsec1...')
  .option('--label <text>', 'Optional label')
  .action(async (options: { secret: string; label?: string }) => {
    await identityImportCommand(options);
  });

identity
  .command('generate')
  .description('Generate a new keypair and register it')
  .option('--label <text>', 'Optional label')
  .action(async (options: { label?: string }) => {
    await identityGenerateCommand(options);
  });

identity
  .command('primary')
  .description('Set which registered key signs new events')
  .argument('<npub|hex>', 'npub or hex pubkey')
  .action(async (target: string) => {
    await identityPrimaryCommand(target);
  });

identity
  .command('remove')
  .description('Remove a key from the registry (does not erase relay data)')
  .argument('<npub|hex>', 'npub or hex pubkey')
  .action(async (target: string) => {
    await identityRemoveCommand(target);
  });

export { program };
