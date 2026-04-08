import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => {
  return {
    DEFAULT_CONFIG: {
      version: 1,
      relays: [],
      createdAt: 'test',
      serverPort: 3417,
      serverHost: 'localhost',
    },
    getServerHost: () => 'localhost',
    getServerPort: () => 3417,
  };
});

import { isServerAvailable, proxyTrust, proxyResolve } from '../../src/lib/client.js';

describe('client wrapper', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('isServerAvailable returns true when health returns 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const available = await isServerAvailable();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3417/ping', expect.objectContaining({
      method: 'GET',
    }));
    expect(available).toBe(true);
  });

  it('isServerAvailable returns false on network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const available = await isServerAvailable();

    expect(available).toBe(false);
  });

  it('proxyTrust posts to /trust and returns JSON', async () => {
    const innerData = { event: { id: 'abc' }, relays: [] };
    const envelope = { ok: true, data: innerData };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(envelope) });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await proxyTrust(undefined, {
      subjects: ['npub1test'],
      contexts: 'test',
      value: 1,
      content: 'hello',
      relay: ['wss://relay.test'],
    });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3417/trust', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subjects: ['npub1test'],
        contexts: 'test',
        value: 1,
        content: 'hello',
        relay: ['wss://relay.test'],
      }),
    });
    expect(result).toEqual(innerData);
  });

  it('proxyTrust throws on non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      proxyTrust(undefined, {
        subjects: ['npub1test'],
      }),
    ).rejects.toThrow(/Server \/trust request failed with status 500/);
  });

  it('proxyResolve posts to /resolve and returns JSON', async () => {
    const innerData = { trust: 1 };
    const envelope = { ok: true, data: innerData };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(envelope) });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await proxyResolve(undefined, {
      subject: 'npub1test',
      contexts: 'test',
      strategy: 'cache',
      maxDepth: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3417/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subject: 'npub1test',
        contexts: 'test',
        strategy: 'cache',
        maxDepth: 3,
      }),
    });
    expect(result).toEqual(innerData);
  });

  it('proxyResolve throws on non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      proxyResolve(undefined, {
        subject: 'npub1missing',
      }),
    ).rejects.toThrow(/Server \/resolve request failed with status 404/);
  });
});

