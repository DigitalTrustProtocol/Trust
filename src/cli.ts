import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { whoamiCommand } from './commands/whoami.js';
import { timestampCommand } from './commands/timestamp.js';
import { trustCommand } from './commands/trust.js';
import { syncTrustCommand } from './commands/sync.js';
import { showTrustCommand } from './commands/show.js';
import { resolveTrustCommand } from './commands/resolve.js';
import { serverCommand } from './commands/server.js';
import { pingCommand } from './commands/ping.js';


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

// trust - Publish kind 32010 trust event (NIP-32010)
program
  .command('trust <subject> [subjects...]')
  .description('Publish a trust event (kind 32010) for the given subject(s)')
  .option('-c, --context <context>', 'Trust context (e.g. development, commerce)')
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
      await trustCommand({
        subjects: [subject, ...(subjects || [])],
        context: options.context,
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
  .option('--author <hex>', 'Root author pubkey to sync from (default: primary key), use "*" to sync all authors')
  .option('--max-depth <n>', 'Max trust graph depth to sync (default: 3)', (val: string) => parseInt(val, 10), 3)
  .option('--sync-interval <seconds>', 'Seconds between sync runs (0 = run once)', (val: string) => parseInt(val, 10), 0)
  .option('--json', 'Output sync stats as JSON')
  .action(async (options) => {
      await syncTrustCommand({
        relay: options.relay,
        since: options.since,
        author: options.author,
        maxDepth: options.maxDepth,
        syncInterval: options.syncInterval,
        json: options.json,
      });
  });

// resolve - Resolve trust path and reputation
program
  .command('resolve <subject> [author]')
  .description('Resolve trust path and reputation for subject (from author, default: primary key)')
  .option('-c, --context <context>', 'Filter by context (default: ""). Use -c undefined for all contexts')
  .option('-s, --strategy <name>', 'Resolve strategy (default: cache)', 'cache')
  .option('--max-depth <n>', 'Max trust path depth (1-4, default: 4). Limited by strategy max.', '4')
  .option('--author <npub|hex>', 'Author pubkey (alternative to positional)')
  .option('-f, --format <name>', 'Output format: number, default, path', 'default')
  .option('--json', 'Output as JSON')
  .action(async (subject, author, options) => {
    try {
      await resolveTrustCommand({
        subject,
        author: author ?? options.author,
        context: options.context,
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
  .description('Run Trust server (default: all services). Use --only to run a single service.')
  .option('-p, --port <port>', 'HTTP port for the Web API', (val: string) => parseInt(val, 10))
  .option('-h, --host <host>', 'Bind host (e.g. localhost, 0.0.0.0)')
  .option('-r, --relay <url...>', 'Relay URL(s) for websocket subscription')
  .option('--since <unix-ts>', 'Start subscription from this unix timestamp (overwrites stored value)')
  .option('--author <hex>', 'Root author pubkey to sync from (default: primary key), use "*" to sync all authors')
  .option('--max-depth <n>', 'Max trust graph depth to sync (default: 3)', (val: string) => parseInt(val, 10), 3)
  .option('--sync-interval <seconds>', 'Seconds between graph sync runs (0 = run once)', (val: string) => parseInt(val, 10), 0)
  .option('--only <service>', 'Run a single service: relay, api, or web (default: all)')
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
        author: options.author,
        maxDepth: options.maxDepth,
        syncInterval: options.syncInterval,
        only: options.only,
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

export { program };
