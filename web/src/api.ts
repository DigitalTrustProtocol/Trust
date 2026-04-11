/** Base URL for Trust HTTP API (no trailing slash). Empty = same origin as the web app. */
export function getApiBase(): string {
  const env = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (env && env.trim().length > 0) return env.replace(/\/+$/, '');
  return '';
}

/** OpenAPI Swagger UI (`@fastify/swagger-ui`). Same origin as the web app when `VITE_API_BASE_URL` is unset; otherwise the configured API host. */
export function getApiDocsUrl(): string {
  const base = getApiBase();
  if (!base) return '/docs';
  return `${base}/docs`;
}

export type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };

export async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json()) as ApiEnvelope<T>;
  if (body && typeof body === 'object' && 'ok' in body) {
    if (!body.ok) {
      const msg = body.error?.message ?? `Request failed with status ${res.status}`;
      throw new Error(msg);
    }
    return body.data as T;
  }
  return body as unknown as T;
}

export async function fetchGraphExport(apiBase: string, maxEdges = 10_000) {
  const base = apiBase.replace(/\/+$/, '');
  const url = `${base || ''}/graph/export?maxEdges=${maxEdges}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Graph export failed: ${res.status}`);
  return unwrap<{
    nodes: Array<{ id: string; type: string; identity?: Record<string, string> }>;
    links: Array<{ source: string; target: string; value: number; context: string }>;
    truncated: boolean;
  }>(res);
}

export async function postResolve(
  apiBase: string,
  body: { subject: string; author: string; context?: string; maxDepth?: number; format?: 'path' | 'default' | 'number' },
) {
  const base = apiBase.replace(/\/+$/, '');
  const res = await fetch(`${base || ''}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null) as ApiEnvelope<unknown> | null;
    throw new Error(err?.error?.message ?? `Resolve failed: ${res.status}`);
  }
  return unwrap<Array<Record<string, unknown>>>(res);
}
