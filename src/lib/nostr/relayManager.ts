import { NRelay1 } from '@nostrify/nostrify';
import type { Filter, VerifiedEvent } from 'nostr-tools';

export type RelayAccess = 'read' | 'write' | 'read-write';

export interface RelayListEntry {
  url: string;
  access: RelayAccess;
}

export interface RelayStatus {
  url: string;
  online: boolean;
  checkedAt: number;
  latencyMs?: number;
  responseType?: 'EVENT' | 'EOSE' | 'CLOSED';
  error?: string;
}

export interface RelayProbeOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export interface RelaySelection {
  requested: string[];
  selected: string[];
  online: RelayStatus[];
  offline: RelayStatus[];
}

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_TTL_MS = 60_000;

const relayStatusCache = new Map<string, RelayStatus>();

function normalizeRelayUrl(url: string): string {
  return url.trim();
}

function uniqueRelays(relays: string[]): string[] {
  return [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function fromMarker(marker: string | undefined): RelayAccess {
  if (marker === 'read') return 'read';
  if (marker === 'write') return 'write';
  return 'read-write';
}

function canRead(entry: RelayListEntry): boolean {
  return entry.access === 'read' || entry.access === 'read-write';
}

export function parseNip65RelayList(event: Pick<VerifiedEvent, 'kind' | 'tags'>): RelayListEntry[] {
  if (event.kind !== 10002) return [];

  const entries: RelayListEntry[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || !tag[1]) continue;
    entries.push({
      url: normalizeRelayUrl(tag[1]),
      access: fromMarker(tag[2]),
    });
  }

  return entries;
}

export function readRelaysFromNip65(event: Pick<VerifiedEvent, 'kind' | 'tags'>): string[] {
  return parseNip65RelayList(event)
    .filter(canRead)
    .map((entry) => entry.url);
}

export async function probeRelay(url: string, options: RelayProbeOptions = {}): Promise<RelayStatus> {
  const relayUrl = normalizeRelayUrl(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const cached = relayStatusCache.get(relayUrl);
  if (cached && Date.now() - cached.checkedAt <= cacheTtlMs) {
    return cached;
  }

  const startedAt = Date.now();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort('relay probe timeout'), timeoutMs);
  let relay: NRelay1 | null = null;
  let iterator: AsyncIterator<any> | null = null;

  let status: RelayStatus;
  try {
    relay = new NRelay1(relayUrl, { backoff: false, idleTimeout: false });
    const probeFilter: Filter[] = [{ kinds: [1], limit: 1 }];
    iterator = relay.req(probeFilter, { signal: timeoutController.signal })[Symbol.asyncIterator]();
    if (!iterator) throw new Error('Failed to create relay probe iterator');

    const first = await iterator.next();
    if (first.done) {
      status = {
        url: relayUrl,
        online: false,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        error: 'Relay closed subscription without response',
      };
    } else {
      status = {
        url: relayUrl,
        online: true,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        responseType: first.value[0],
      };
    }
  } catch (error) {
    status = {
      url: relayUrl,
      online: false,
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      error: toErrorMessage(error),
    };
  } finally {
    clearTimeout(timer);
    if (iterator) {
      await iterator.return?.(undefined).catch(() => {});
    }
    if (relay) {
      await relay.close().catch(() => {});
    }
  }

  relayStatusCache.set(relayUrl, status);
  return status;
}

export async function probeRelays(relays: string[], options: RelayProbeOptions = {}): Promise<RelayStatus[]> {
  const unique = uniqueRelays(relays);
  return Promise.all(unique.map((relay) => probeRelay(relay, options)));
}

export async function selectAvailableRelays(relays: string[], options: RelayProbeOptions = {}): Promise<RelaySelection> {
  const requested = uniqueRelays(relays);
  const statuses = await probeRelays(requested, options);
  const online = statuses.filter((status) => status.online);
  const offline = statuses.filter((status) => !status.online);

  return {
    requested,
    selected: online.length > 0 ? online.map((status) => status.url) : requested,
    online,
    offline,
  };
}

export function clearRelayStatusCache(): void {
  relayStatusCache.clear();
}
