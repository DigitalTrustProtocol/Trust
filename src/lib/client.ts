import { DEFAULT_CONFIG, getServerHost, getServerPort } from '../config.js';
import type { Score } from '../lib/trust/resolvers/Score.js';
import type { ApiEnvelope } from '../server/errors.js';
import { getServerBaseUrlFromState } from './server-state.js';

function getDefaultBaseUrl(): string {
  const fromState = getServerBaseUrlFromState('api');
  if (fromState) return fromState;
  const host = getServerHost(DEFAULT_CONFIG);
  const port = getServerPort(DEFAULT_CONFIG);
  const base = `http://${host}:${port}`;
  return base.replace(/\/+$/, '');
}

export function normalizeBaseUrl(baseUrl?: string): string {
  const base = (baseUrl && baseUrl.trim().length > 0 ? baseUrl : getDefaultBaseUrl()).replace(
    /\/+$/,
    '',
  );
  return base;
}

export async function isServerAvailable(baseUrl?: string, timeoutMs = 2000): Promise<boolean> {
  const base = normalizeBaseUrl(baseUrl);

  try {
    const res = await fetch(`${base}/v1/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Unwrap the API envelope, throwing on error responses. */
async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json() as ApiEnvelope<T>;
  if (body && typeof body === 'object' && 'ok' in body) {
    if (!body.ok) {
      const msg = body.error?.message ?? `Request failed with status ${res.status}`;
      throw new Error(msg);
    }
    return body.data as T;
  }
  return body as unknown as T;
}

export interface TrustParams {
  subjects: string[];
  contexts?: string;
  value?: number;
  content?: string;
  relay?: string[];
}

export interface ResolveParams {
  subject: string;
  author?: string;
  context?: string;
  strategy?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
}

export interface ResolveBatchParams {
  subjects: string[];
  authors?: string;
  contexts?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
}

export async function proxyTrust(
  baseUrl: string | undefined,
  params: TrustParams,
): Promise<unknown> {
  const base = normalizeBaseUrl(baseUrl);

  const res = await fetch(`${base}/v1/trust`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as ApiEnvelope | null;
    throw new Error(body?.error?.message ?? `Server /trust request failed with status ${res.status}`);
  }

  return unwrap(res);
}

export async function proxyResolve(
  baseUrl: string | undefined,
  params: ResolveParams,
): Promise<Score[]> {
  const base = normalizeBaseUrl(baseUrl);

  const res = await fetch(`${base}/v1/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as ApiEnvelope | null;
    throw new Error(body?.error?.message ?? `Server /resolve request failed with status ${res.status}`);
  }

  return unwrap<Score[]>(res);
}

export async function proxyResolveBatch(
  baseUrl: string | undefined,
  params: ResolveBatchParams,
): Promise<unknown[]> {
  const base = normalizeBaseUrl(baseUrl);

  const res = await fetch(`${base}/v1/resolve/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as ApiEnvelope | null;
    throw new Error(body?.error?.message ?? `Server /resolve/batch request failed with status ${res.status}`);
  }

  return unwrap<unknown[]>(res);
}
