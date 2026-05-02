/** Oracle/API host for WoT fallback queries. Defaults to current site origin. */
export function getWotOracleBase(): string {
  const env = import.meta.env.VITE_WOT_ORACLE_URL as string | undefined;
  const raw = env?.trim() || (typeof window !== 'undefined' ? window.location.origin : '');
  return raw.replace(/\/+$/, '');
}
