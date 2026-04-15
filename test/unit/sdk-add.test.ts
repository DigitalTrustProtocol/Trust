import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

const TEST_SECRET_KEY = 'a'.repeat(64);

vi.mock('../../src/lib/nostr/pool.js', () => ({
  getRelays: vi.fn((relayOpt?: string[] | string) => {
    if (Array.isArray(relayOpt)) return relayOpt;
    if (typeof relayOpt === 'string') return [relayOpt];
    return [];
  }),
  publishEventWithReport: vi.fn().mockResolvedValue({
    attempted: [],
    successful: [],
    failed: [],
  }),
  getAvailableRelays: vi.fn().mockResolvedValue({
    selected: ['wss://relay.mock'],
    offline: [],
  }),
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  const dir = join(tmpdir(), 'trust-sdk-add-' + process.pid + '-' + Date.now());
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      configDir: dir,
      config: join(dir, 'config.json'),
      identity: join(dir, 'identity.json'),
      keysDir: join(dir, 'keys'),
      trustDb: join(dir, 'trust.db'),
      graphCache: join(dir, 'graph-cache.bin'),
    },
    DEFAULT_RELAYS: ['wss://relay.test'],
  };
});

import { add } from '../../src/sdk.js';
import { publishEventWithReport } from '../../src/lib/nostr/pool.js';
import {
  encodeNpub,
  encodeNote,
  encodeNevent,
  encodeNprofile,
  encodeNaddr,
} from '../../src/lib/nostr/nip19.js';
import { addIdentityKey } from '../../src/lib/identityStore.js';
import { PATHS } from '../../src/config.js';

/** Tags from first subject tag through end (skips d, v, c). */
function subjectWireTags(tags: string[][]): string[][] {
  const skip = new Set(['d', 'v', 'c']);
  let i = 0;
  while (i < tags.length && skip.has(tags[i]![0]!)) i++;
  return tags.slice(i);
}

describe('sdk add() subject parsing and k tags', () => {
  let TEST_PUBKEY: string;
  const TEST_EVENT_ID = 'c'.repeat(64);

  beforeEach(() => {
    const dir = PATHS.configDir;
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const sk = hexToBytes(TEST_SECRET_KEY);
    addIdentityKey(sk);
    TEST_PUBKEY = getPublicKey(sk).toLowerCase();
    vi.mocked(publishEventWithReport).mockClear();
  });

  afterEach(() => {
    if (existsSync(PATHS.configDir)) rmSync(PATHS.configDir, { recursive: true });
  });

  async function addOne(subject: string) {
    return add([subject], {
      relays: [],
      value: 1,
    });
  }

  it('npub → p, no k', async () => {
    const event = await addOne(encodeNpub(TEST_PUBKEY));
    expect(event.kind).toBe(32010);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['p', TEST_PUBKEY]]);
  });

  it('nprofile → p, no k', async () => {
    const event = await addOne(encodeNprofile(TEST_PUBKEY));
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['p', TEST_PUBKEY]]);
  });

  it('note → e then k=1', async () => {
    const event = await addOne(encodeNote(TEST_EVENT_ID));
    const seq = subjectWireTags(event.tags);
    expect(seq[0]).toEqual(['e', TEST_EVENT_ID.toLowerCase()]);
    expect(seq[1]).toEqual(['k', '1']);
    expect(seq).toHaveLength(2);
  });

  it('nevent without kind → e, no k', async () => {
    const event = await addOne(encodeNevent(TEST_EVENT_ID));
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['e', TEST_EVENT_ID.toLowerCase()]]);
  });

  it('nevent with kind → e then k (decimal kind)', async () => {
    const event = await addOne(encodeNevent(TEST_EVENT_ID, undefined, undefined, 30023));
    const seq = subjectWireTags(event.tags);
    expect(seq[0]).toEqual(['e', TEST_EVENT_ID.toLowerCase()]);
    expect(seq[1]).toEqual(['k', '30023']);
    expect(seq).toHaveLength(2);
  });

  it('naddr → a, no k', async () => {
    const event = await addOne(encodeNaddr(30023, TEST_PUBKEY, 'article-id'));
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['a', `30023:${TEST_PUBKEY}:article-id`]]);
  });

  it('a:<kind>:<pubkey>:<d> → a, no k', async () => {
    const pk = '4'.repeat(64);
    const event = await addOne(`a:0:${pk}:param-d`);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['a', `0:${pk.toLowerCase()}:param-d`]]);
  });

  it('p:<64-hex> → p, no k', async () => {
    const pk = 'd'.repeat(64);
    const event = await addOne(`p:${pk}`);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['p', pk.toLowerCase()]]);
  });

  it('pubkey:<64-hex> → p, no k', async () => {
    const pk = 'e'.repeat(64);
    const event = await addOne(`pubkey:${pk}`);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['p', pk.toLowerCase()]]);
  });

  it('e:<64-hex> → e, no k', async () => {
    const id = 'f'.repeat(64);
    const event = await addOne(`e:${id}`);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['e', id.toLowerCase()]]);
  });

  it('h:<64-hex> → h, no k', async () => {
    const hash = '1'.repeat(64);
    const event = await addOne(`h:${hash}`);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['h', hash.toLowerCase()]]);
  });

  it('bare 64-hex → h (content hash), no k', async () => {
    const hash = '2'.repeat(64);
    const event = await addOne(hash);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['h', hash.toLowerCase()]]);
  });

  it('https URL → r, no k', async () => {
    const event = await addOne('https://example.com/path?q=1');
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['r', 'https://example.com/path?q=1']]);
  });

  it('r:<host/path> → r, no k', async () => {
    const event = await addOne('r:example.com/foo');
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['r', 'https://example.com/foo']]);
  });

  it('kind:pubkey:d → a, no k', async () => {
    const pk = '3'.repeat(64);
    const event = await addOne(`0:${pk}:dval`);
    const seq = subjectWireTags(event.tags);
    expect(seq).toEqual([['a', `0:${pk.toLowerCase()}:dval`]]);
  });

  it('isbn: → i then k', async () => {
    const event = await addOne('isbn:978-0-76-538203-0');
    const seq = subjectWireTags(event.tags);
    expect(seq[0]).toEqual(['i', 'isbn:9780765382030']);
    expect(seq[1]).toEqual(['k', 'isbn']);
    expect(seq).toHaveLength(2);
  });

  it('i:<nip73> → i then k', async () => {
    const event = await addOne('i:doi:10.1234/example.paper');
    const seq = subjectWireTags(event.tags);
    expect(seq[0]).toEqual(['i', 'doi:10.1234/example.paper']);
    expect(seq[1]).toEqual(['k', 'doi']);
  });

  it('batch: note + isbn preserves e,k then i,k order', async () => {
    const event = await add([encodeNote(TEST_EVENT_ID), 'isbn:9780000000001'], {
      relays: [],
      value: 1,
    });
    const seq = subjectWireTags(event.tags);
    expect(seq[0]).toEqual(['e', TEST_EVENT_ID.toLowerCase()]);
    expect(seq[1]).toEqual(['k', '1']);
    expect(seq[2]).toEqual(['i', 'isbn:9780000000001']);
    expect(seq[3]).toEqual(['k', 'isbn']);
    expect(seq).toHaveLength(4);
  });

  it('calls publishEventWithReport with empty relay list when relaysResolved is []', async () => {
    await addOne(encodeNpub(TEST_PUBKEY));
    expect(publishEventWithReport).toHaveBeenCalledTimes(1);
    const [, relays] = vi.mocked(publishEventWithReport).mock.calls[0]!;
    expect(relays).toEqual([]);
  });
});
