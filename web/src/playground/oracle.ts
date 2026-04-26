import { DEFAULT_ORACLE } from '../lib/nostr-wot-sdk/utils';

/** Public WoT oracle host (same default as nostr-wot / nostr-wot-sdk). Override with `VITE_WOT_ORACLE_URL`. */
export function getWotOracleBase(): string {
  const env = import.meta.env.VITE_WOT_ORACLE_URL as string | undefined;
  const raw = env?.trim() || DEFAULT_ORACLE;
  return raw.replace(/\/+$/, '');
}
