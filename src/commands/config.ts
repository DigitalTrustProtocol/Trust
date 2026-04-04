import type { Command } from 'commander';
import { DEFAULT_CONFIG, loadUserConfig, parseAuthorsString, PATHS, saveUserConfig, type UserConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { isAllToken, normalizeAuthorsList, normalizeContextsList } from '../config.js';

function ensureConfig(): UserConfig {
  const existing = loadUserConfig();
  if (existing) return { ...DEFAULT_CONFIG, ...existing };
  return {
    ...DEFAULT_CONFIG,
    createdAt: new Date().toISOString(),
  };
}

function write(cfg: UserConfig): void {
  saveUserConfig(cfg);
  logger.info(`Updated ${PATHS.config}`);
}

export function registerConfig(program: Command): void {
  const cfg = program
    .command('config')
    .description('View or edit ~/.trust/config.json (authors, contexts; CLI overrides this at runtime)');

  cfg
    .command('show')
    .description('Print current configuration')
    .option('--json', 'JSON output')
    .action(async () => {
      const c = ensureConfig();
      console.log(JSON.stringify(c, null, 2));
    });

  const authors = cfg.command('authors').description('Manage focused author pubkeys (hex) or All');

  authors
    .command('set')
    .argument('<values>', 'Comma-separated hex pubkeys or All')
    .description('Replace authors list')
    .action(async (values: string) => {
      const c = ensureConfig();
      c.authors = parseAuthorsString(values);
      write(c);
    });

  authors
    .command('add')
    .argument('<hex...>', '64-char hex pubkey(s)')
    .description('Append pubkey(s) (replace All first if set)')
    .action(async (hexes: string[]) => {
      const c = ensureConfig();
      if (c.authors?.length === 1 && isAllToken(c.authors[0]!)) {
        throw new Error('Run `trust config authors set` with explicit hexes first (currently All).');
      }
      const merged = [...(c.authors ?? []), ...hexes];
      c.authors = normalizeAuthorsList(merged) as string[];
      write(c);
    });

  authors
    .command('remove')
    .argument('<hex...>', 'Pubkey(s) to remove')
    .action(async (hexes: string[]) => {
      const c = ensureConfig();
      if (!c.authors?.length || (c.authors.length === 1 && isAllToken(c.authors[0]!))) {
        throw new Error('Nothing to remove');
      }
      const remove = new Set(hexes.map((h) => h.trim().toLowerCase()));
      c.authors = (c.authors as string[]).filter((a) => !remove.has(a.toLowerCase()));
      write(c);
    });

  authors
    .command('clear')
    .description('Remove authors key (resolveConfig defaults to all authors)')
    .action(async () => {
      const c = ensureConfig();
      delete c.authors;
      write(c);
    });

  const contexts = cfg.command('contexts').description('Manage trust context (`c` tag) filters or All');

  contexts
    .command('set')
    .argument('<values>', 'Comma-separated contexts or All')
    .action(async (values: string) => {
      const c = ensureConfig();
      const t = values.trim();
      if (isAllToken(t)) {
        c.contexts = ['All'];
      } else {
        c.contexts = normalizeContextsList(t.split(',').map((x) => x.trim()).filter(Boolean));
      }
      write(c);
    });

  contexts
    .command('add')
    .argument('<name...>', 'Context string(s)')
    .action(async (names: string[]) => {
      const c = ensureConfig();
      if (c.contexts?.length === 1 && isAllToken(c.contexts[0]!)) {
        throw new Error('Run `trust config contexts set` with explicit values first (currently All).');
      }
      const cur = c.contexts?.filter((x) => !isAllToken(x)) ?? [];
      c.contexts = normalizeContextsList([...cur, ...names]);
      write(c);
    });

  contexts
    .command('remove')
    .argument('<name...>', 'Context(s) to remove')
    .action(async (names: string[]) => {
      const c = ensureConfig();
      if (!c.contexts?.length || (c.contexts.length === 1 && isAllToken(c.contexts[0]!))) {
        throw new Error('Nothing to remove');
      }
      const remove = new Set(names.map((n) => n.trim()));
      c.contexts = (c.contexts as string[]).filter((x) => !remove.has(x));
      write(c);
    });

  contexts
    .command('clear')
    .description('Remove contexts key (resolveConfig defaults to all contexts)')
    .action(async () => {
      const c = ensureConfig();
      delete c.contexts;
      write(c);
    });
}
