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

export type GraphTrustValue = 1 | 0 | -1;
export type GraphSubjectType = 'p' | 'i';

export type GraphTrustConnection = {
  author: string;
  subject: string;
  subjectType: GraphSubjectType;
  edge: {
    dTag: string;
    author: string;
    kind: number;
    value: GraphTrustValue;
    context: string;
    createdAt: number;
    activate?: number;
    expire?: number;
    content?: string;
  };
};

export type GraphConnectionsResponse =
  | { author: string; direction: 'out'; connections: GraphTrustConnection[] }
  | { subject: string; direction: 'in'; connections: GraphTrustConnection[] };

export type GraphConnectionQuery = {
  author?: string;
  subject?: string;
  context?: string;
  value?: GraphTrustValue;
  subjectType?: GraphSubjectType;
  includeInactive?: boolean;
};

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
  const url = `${base || ''}/v1/graph/export?maxEdges=${maxEdges}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Graph export failed: ${res.status}`);
  return unwrap<{
    nodes: Array<{ id: string; type: string; identity?: Record<string, string> }>;
    links: Array<{ source: string; target: string; value: number; context: string }>;
    truncated: boolean;
  }>(res);
}

function graphConnectionSearchParams(query: GraphConnectionQuery): string {
  const params = new URLSearchParams();
  if (query.author) params.set('author', query.author);
  if (query.subject) params.set('subject', query.subject);
  if (query.context) params.set('context', query.context);
  if (query.value !== undefined) params.set('value', String(query.value));
  if (query.subjectType) params.set('subjectType', query.subjectType);
  if (query.includeInactive) params.set('includeInactive', 'true');
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function fetchGraphOut(apiBase: string, query: GraphConnectionQuery = {}) {
  const base = apiBase.replace(/\/+$/, '');
  const res = await fetch(`${base || ''}/v1/out${graphConnectionSearchParams(query)}`);
  if (!res.ok) throw new Error(`Graph out failed: ${res.status}`);
  return unwrap<GraphConnectionsResponse>(res);
}

export async function fetchGraphIn(apiBase: string, query: GraphConnectionQuery = {}) {
  const base = apiBase.replace(/\/+$/, '');
  const res = await fetch(`${base || ''}/v1/in${graphConnectionSearchParams(query)}`);
  if (!res.ok) throw new Error(`Graph in failed: ${res.status}`);
  return unwrap<GraphConnectionsResponse>(res);
}

export async function fetchWhoami(apiBase: string) {
  const base = apiBase.replace(/\/+$/, '');
  const res = await fetch(`${base || ''}/v1/whoami`);
  if (!res.ok) throw new Error(`Whoami failed: ${res.status}`);
  return unwrap<{ publicKey: string; npub: string; profile: Record<string, unknown> | null }>(res);
}

export async function postResolve(
  apiBase: string,
  body: { subject: string; author: string; context?: string; maxDepth?: number; format?: 'path' | 'default' | 'number' },
) {
  const base = apiBase.replace(/\/+$/, '');
  const res = await fetch(`${base || ''}/v1/resolve`, {
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
