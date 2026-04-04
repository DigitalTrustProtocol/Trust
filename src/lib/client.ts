import { DEFAULT_CONFIG, getServerHost, getServerPort } from '../config.js';
import type { Score } from '../lib/trust/resolvers/Score.js';

function getDefaultBaseUrl(): string {
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

export async function isServerAvailable(baseUrl?: string): Promise<boolean> {
  const base = normalizeBaseUrl(baseUrl);

  try {
    const res = await fetch(`${base}/ping`, {
      method: 'GET',
    });
    return res.ok;
  } catch {
    return false;
  }
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
  authors?: string;
  contexts?: string;
  strategy?: string;
  maxDepth?: number;
  format?: 'number' | 'default' | 'path';
}

export async function proxyTrust(
  baseUrl: string | undefined,
  params: TrustParams,
): Promise<unknown> {
  const base = normalizeBaseUrl(baseUrl);

  const res = await fetch(`${base}/trust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    throw new Error(`Server /trust request failed with status ${res.status}`);
  }

  return res.json() as Promise<unknown>;
}

export async function proxyResolve(
  baseUrl: string | undefined,
  params: ResolveParams,
): Promise<Score> {
  const base = normalizeBaseUrl(baseUrl);

  const res = await fetch(`${base}/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    throw new Error(`Server /resolve request failed with status ${res.status}`);
  }

  return res.json() as Promise<Score>;
}
