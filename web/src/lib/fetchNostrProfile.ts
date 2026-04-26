/** Minimal kind:0 profile fetch over WebSocket (same approach as nostr-wot playground). */
export type NostrProfileMeta = {
  name?: string;
  displayName?: string;
  picture?: string;
};

export async function fetchKind0Profile(pubkey: string): Promise<NostrProfileMeta | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://relay.damus.io');
    const done = (v: NostrProfileMeta | null) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 4500);

    ws.onopen = () => {
      ws.send(
        JSON.stringify(['REQ', `layout-${Date.now()}`, { kinds: [0], authors: [pubkey], limit: 1 }]),
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as unknown[];
        if (data[0] === 'EVENT' && data[2] && typeof data[2] === 'object') {
          const ev = data[2] as { kind?: number; content?: string };
          if (ev.kind === 0 && ev.content) {
            const content = JSON.parse(ev.content) as Record<string, string | undefined>;
            done({
              name: content.name,
              displayName: content.display_name,
              picture: content.picture,
            });
          }
        } else if (data[0] === 'EOSE') {
          done(null);
        }
      } catch {
        /* ignore */
      }
    };

    ws.onerror = () => done(null);
  });
}
