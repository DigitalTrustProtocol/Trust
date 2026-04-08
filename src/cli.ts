import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { whoamiCommand } from './commands/whoami.js';
import { syncTimeCommand } from './commands/syncTime.js';
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
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await initCommand({
        name: options.name,
        about: options.about,
        skipProfile: options.skipProfile,
        json: options.json,
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
const syncCmd = program
  .command('sync')
  .description('Sync trust events from relays into local database');

syncCmd
  .command('run', { isDefault: true })
  .description('Run sync (default when no subcommand is given)')
  .option('-r, --relay <url...>', 'Relay URL(s) to query')
  .option('--since <unix-ts>', 'Start sync from this unix timestamp (overwrites stored cursor)')
  .option('--all', 'Sync from the very beginning, ignoring the stored cursor')
  .option(
    '--authors <value>',
    'CLI → TRUST_AUTHORS → config: comma-separated hex/npub pubkeys. Omitted flag falls through. * or All = no author filter (subscribe-all sync).',
  )
  .option(
    '--contexts <value>',
    'CLI → TRUST_CONTEXTS → config: comma-separated `c` tag values. Omitted falls through. * or All = no context filter.',
  )
  .option('--max-depth <n>', 'Max trust graph depth to sync (default: 3)', (val: string) => parseInt(val, 10), 3)
  .option('--sync-interval <seconds>', 'Seconds between sync runs (0 = run once)', (val: string) => parseInt(val, 10), 0)
  .option('--json', 'Output sync stats as JSON')
  .action(async (options) => {
    await syncTrustCommand({
      relay: options.relay,
      since: options.since,
      all: options.all,
      authors: options.authors,
      contexts: options.contexts,
      maxDepth: options.maxDepth,
      syncInterval: options.syncInterval,
      json: options.json,
    });
  });

// sync cursor - View or manage the incremental-fetch cursor (replaces sync-time)
syncCmd
  .command('cursor')
  .description('View or manage the sync cursor (latest / last-seen timestamps used for incremental fetching)')
  .option('--get', 'Print the raw latest sync time value')
  .option('--set <value>', 'Set the latest sync time to a specific unix timestamp')
  .option('--set-last-seen <value>', 'Set the last-seen sync time to a specific unix timestamp')
  .option('--rollforward', 'Promote last-seen + 1 to latest')
  .option('--reset', 'Clear both cursors so the next sync starts from the beginning')
  .option('--json', 'Output both cursor values as JSON')
  .action(async (options) => {
    await syncTimeCommand({
      get: options.get,
      set: options.set,
      setLastSeen: options.setLastSeen,
      rollforward: options.rollforward,
      reset: options.reset,
      json: options.json,
    });
  });

// resolve - Resolve trust path and reputation
program
  .command('resolve <subject> [authors]')
  .description('Resolve trust path and reputation for subject (from authors perspective, default: primary key)')
  .option('-c, --contexts <contexts>', 'Filter by context (default: ""). Use -c undefined for all contexts')
  .option('--max-depth <n>', 'Max trust path depth (1-4, default: 4).', '4')
  .option('--authors <npub|hex>', 'Author pubkey (alternative to positional)')
  .option('-f, --format <name>', 'Output format: number, default, path', 'default')
  .option('--json', 'Output as JSON')
  .action(async (subject, authors, options) => {
    try {
      await resolveTrustCommand({
        subject,
        author: authors ?? options.authors,
        context: options.contexts,
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
