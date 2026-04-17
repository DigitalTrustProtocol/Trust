import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from '../config.js';
import type { ServerService } from '../server/app.js';

/** Per-entry payload version inside `services`. */
const SERVER_STATE_ENTRY_VERSION = 1;
/** File format: 1 = legacy single `ServerState` at root; 2 = `{ version, services }`. */
const SERVER_STATE_FILE_VERSION = 2;

export interface ServerState {
  version: number;
  pid: number;
  service: ServerService;
  host: string;
  port: number;
  startedAt: string;
  updatedAt: string;
}

/** On-disk aggregate (v2). */
export interface ServerStateFile {
  version: typeof SERVER_STATE_FILE_VERSION;
  services: Partial<Record<ServerService, ServerState>>;
}

export type ServerCapability = 'api' | 'relay' | 'web';

function serviceSupportsCapability(service: ServerService, capability: ServerCapability): boolean {
  if (service === 'all') return true;
  return service === capability;
}

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`.replace(/\/+$/, '');
}

function normalizeRelayUrl(host: string, port: number): string {
  return `ws://${host}:${port}/relay`.replace(/\/+$/, '');
}

function isValidServerState(parsed: Partial<ServerState>): parsed is ServerState {
  return (
    parsed.version === SERVER_STATE_ENTRY_VERSION &&
    typeof parsed.pid === 'number' &&
    typeof parsed.host === 'string' &&
    typeof parsed.port === 'number' &&
    typeof parsed.service === 'string' &&
    typeof parsed.startedAt === 'string' &&
    typeof parsed.updatedAt === 'string'
  );
}

function readRawFile(): string | null {
  if (!existsSync(PATHS.serverState)) return null;
  try {
    return readFileSync(PATHS.serverState, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse file contents into a service map. Supports legacy v1 (single object at root)
 * and v2 (`{ version: 2, services: { ... } }`).
 */
function parseServerStateFile(raw: string): Partial<Record<ServerService, ServerState>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const root = parsed as Record<string, unknown>;

  if (root.services && typeof root.services === 'object' && root.services !== null) {
    if (root.version !== SERVER_STATE_FILE_VERSION) return null;
    const out: Partial<Record<ServerService, ServerState>> = {};
    for (const key of ['all', 'relay', 'api', 'web'] as const) {
      const entry = (root.services as Record<string, unknown>)[key];
      if (entry && typeof entry === 'object' && isValidServerState(entry as Partial<ServerState>)) {
        out[key] = entry as ServerState;
      }
    }
    return Object.keys(out).length > 0 ? out : {};
  }

  // Legacy: entire file is one ServerState
  if (isValidServerState(root as Partial<ServerState>)) {
    const s = root as unknown as ServerState;
    return { [s.service]: s };
  }
  return null;
}

function readServicesMap(): Partial<Record<ServerService, ServerState>> | null {
  const raw = readRawFile();
  if (raw === null) return null;
  return parseServerStateFile(raw);
}

function writeServicesMap(services: Partial<Record<ServerService, ServerState>>): void {
  const dir = dirname(PATHS.serverState);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const payload: ServerStateFile = {
    version: SERVER_STATE_FILE_VERSION,
    services,
  };
  writeFileSync(PATHS.serverState, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/**
 * Read the stored state for one service slot (`all` | `relay` | `api` | `web`).
 * Does not apply cross-slot precedence; use {@link getServerBaseUrlFromState} / {@link getServerRelayUrlFromState} for that.
 */
export function readServerState(service: ServerService = 'all'): ServerState | null {
  const map = readServicesMap();
  if (!map) return null;
  const entry = map[service];
  if (!entry || !isValidServerState(entry)) return null;
  return entry;
}

function pickStateForCapability(
  services: Partial<Record<ServerService, ServerState>>,
  capability: ServerCapability,
): ServerState | null {
  const specificKey = capability;
  const specific = services[specificKey];
  const combined = services.all;

  const specificOk =
    specific && isValidServerState(specific) && isPidRunning(specific.pid)
      ? specific
      : null;
  const combinedOk =
    combined && isValidServerState(combined) && isPidRunning(combined.pid) && serviceSupportsCapability(combined.service, capability)
      ? combined
      : null;

  if (combinedOk && specificOk) {
    if (combinedOk.updatedAt > specificOk.updatedAt) return combinedOk;
    if (serviceSupportsCapability(specificOk.service, capability)) return specificOk;
    return combinedOk;
  }
  if (specificOk && serviceSupportsCapability(specificOk.service, capability)) return specificOk;
  if (combinedOk) return combinedOk;
  return null;
}

export function writeServerState(input: {
  host: string;
  port: number;
  service: ServerService;
  pid?: number;
}): ServerState {
  const now = new Date().toISOString();
  const map = readServicesMap() ?? {};
  const prev = map[input.service];
  const state: ServerState = {
    version: SERVER_STATE_ENTRY_VERSION,
    pid: input.pid ?? process.pid,
    service: input.service,
    host: input.host,
    port: input.port,
    startedAt: prev?.pid === (input.pid ?? process.pid) ? (prev.startedAt ?? now) : now,
    updatedAt: now,
  };
  map[input.service] = state;
  writeServicesMap(map);
  return state;
}

export function touchServerState(service: ServerService, pid = process.pid): ServerState | null {
  const map = readServicesMap();
  if (!map) return null;
  const current = map[service];
  if (!current || current.pid !== pid) return null;
  const next: ServerState = {
    ...current,
    updatedAt: new Date().toISOString(),
  };
  map[service] = next;
  writeServicesMap(map);
  return next;
}

export function clearServerState(service: ServerService, pid = process.pid): void {
  const map = readServicesMap();
  if (!map) return;
  const current = map[service];
  if (!current || current.pid !== pid) return;
  delete map[service];
  if (Object.keys(map).length === 0) {
    try {
      unlinkSync(PATHS.serverState);
    } catch {
      // Ignore cleanup errors on shutdown.
    }
    return;
  }
  writeServicesMap(map);
}

/**
 * HTTP base URL for a running local server. When `requiredCapability` is set, uses the
 * matching service slot, except `all` wins when it is newer than that slot (typical localhost layout).
 * When omitted, defaults to API discovery (same as `'api'`).
 */
export function getServerBaseUrlFromState(requiredCapability: ServerCapability = 'api'): string | null {
  const map = readServicesMap();
  if (!map) return null;
  const state = pickStateForCapability(map, requiredCapability);
  if (!state) return null;
  return normalizeBaseUrl(state.host, state.port);
}

export function getServerRelayUrlFromState(): string | null {
  const map = readServicesMap();
  if (!map) return null;
  const state = pickStateForCapability(map, 'relay');
  if (!state) return null;
  return normalizeRelayUrl(state.host, state.port);
}

/**
 * Add local server relay URL when local server is running relay service.
 */
export function withLocalServerRelay(relays: string[]): string[] {
  const localRelay = getServerRelayUrlFromState();
  if (!localRelay) return relays;
  return Array.from(new Set([...relays, localRelay]));
}
