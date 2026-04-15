import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedEvent } from 'nostr-tools';

vi.mock('@nostrify/nostrify', () => {
  class NPool {
    async event(_event: unknown, opts?: { relays?: string[] }): Promise<void> {
      const relay = opts?.relays?.[0];
      if (relay === 'wss://hang.example') {
        return await new Promise<void>(() => {});
      }
      return;
    }

    async close(): Promise<void> {
      return;
    }
  }

  class NRelay1 {}

  return { NPool, NRelay1 };
});

import { publishEventWithReport } from '../../src/lib/nostr/pool.js';

describe('publishEventWithReport', () => {
  afterEach(() => {
    delete process.env.TRUST_RELAY_PUBLISH_TIMEOUT_MS;
  });

  it('marks non-responsive relay as failed after timeout', async () => {
    process.env.TRUST_RELAY_PUBLISH_TIMEOUT_MS = '20';
    const event = { id: 'a'.repeat(64), kind: 1, tags: [], content: '', pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), created_at: 1 } as unknown as VerifiedEvent;

    const report = await publishEventWithReport(event, ['wss://ok.example', 'wss://hang.example']);

    expect(report.successful).toEqual(['wss://ok.example']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.relay).toBe('wss://hang.example');
    expect(report.failed[0]?.error).toContain('Publish timed out');
  });
});
