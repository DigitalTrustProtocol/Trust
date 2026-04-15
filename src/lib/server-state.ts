import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from '../config.js';
import type { ServerService } from '../server/app.js';

const SERVER_STATE_VERSION = 1;

export interface ServerState {
  version: number;
  pid: number;
  service: ServerService;
  host: string;
  port: number;
  startedAt: string;
  updatedAt: string;
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

function writeState(state: ServerState): void {
  const dir = dirname(PATHS.serverState);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(PATHS.serverState, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readServerState(): ServerState | null {
  if (!existsSync(PATHS.serverState)) return null;
  try {
    const raw = readFileSync(PATHS.serverState, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ServerState>;
    if (
      parsed.version !== SERVER_STATE_VERSION ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.service !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.updatedAt !== 'string'
    ) {
      return null;
    }
    return parsed as ServerState;
  } catch {
    return null;
  }
}

export function writeServerState(input: {
  host: string;
  port: number;
  service: ServerService;
  pid?: number;
}): ServerState {
  const now = new Date().toISOString();
  const state: ServerState = {
    version: SERVER_STATE_VERSION,
    pid: input.pid ?? process.pid,
    service: input.service,
    host: input.host,
    port: input.port,
    startedAt: now,
    updatedAt: now,
  };
  writeState(state);
  return state;
}

export function touchServerState(pid = process.pid): ServerState | null {
  const current = readServerState();
  if (!current || current.pid !== pid) return null;
  const next: ServerState = {
    ...current,
    updatedAt: new Date().toISOString(),
  };
  writeState(next);
  return next;
}

export function clearServerState(pid = process.pid): void {
  const current = readServerState();
  if (!current || current.pid !== pid) return;
  try {
    unlinkSync(PATHS.serverState);
  } catch {
    // Ignore cleanup errors on shutdown.
  }
}

export function getServerBaseUrlFromState(requiredCapability?: ServerCapability): string | null {
  const state = readServerState();
  if (!state) return null;
  if (!isPidRunning(state.pid)) return null;
  if (requiredCapability && !serviceSupportsCapability(state.service, requiredCapability)) return null;
  return normalizeBaseUrl(state.host, state.port);
}

export function getServerRelayUrlFromState(): string | null {
  const state = readServerState();
  if (!state) return null;
  if (!isPidRunning(state.pid)) return null;
  if (!serviceSupportsCapability(state.service, 'relay')) return null;
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
