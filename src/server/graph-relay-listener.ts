import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent, VerifiedEvent } from 'nostr-tools';
import { createTrustFilters } from './graph-sync.js';
import { applyTrustEventToGraph } from '../lib/trust/graphManager.js';
import { KIND_TRUST, KIND_TRUST_MAX, KIND_TRUST_MIN } from '../lib/nostr/nip32010.js';
import type { RuntimeContext } from '../lib/runtimeContext.js';
import type { Graph } from '../lib/trust/graph/Graph.js';
import { logger } from '../lib/logger.js';
import { parseClientMessage } from '../lib/nostr/relayManager.js';

function connectHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1';
  if (host === 'localhost') return '127.0.0.1';
  return host;
}

/**
 * Optional extra wait (ms) before the first WebSocket connect, after the API plugin starts the listener.
 * Useful when the relay process binds slightly later than the API (`TRUST_GRAPH_RELAY_WS` to another host).
 * Reconnects after a dropped connection are unaffected. Clamped to 0–60_000.
 */
function initialConnectDelayMs(): number {
  const raw = process.env.TRUST_GRAPH_RELAY_CONNECT_DELAY_MS?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(60_000, Math.floor(n));
}

/**
 * WebSocket URL of the Trust relay to follow for in-memory graph updates (split `api` process).
 * Set `TRUST_GRAPH_RELAY_WS` when the relay is not reachable at the default local URL.
 */
export function resolveGraphRelayWsUrl(runtime: RuntimeContext): string {
  const env = process.env.TRUST_GRAPH_RELAY_WS?.trim();
  if (env) return env;
  const h = connectHost(runtime.host);
  return `ws://${h}:${runtime.port}/relay`;
}

/** Subscribe to the relay; apply matching trust `EVENT` messages to the graph. */
export function startGraphRelayListener(runtimeContext: RuntimeContext, graph: Graph): { close: () => void } {
  const fromCfg = runtimeContext.kinds?.filter((k) => k >= KIND_TRUST_MIN && k <= KIND_TRUST_MAX) ?? [];
  const effectiveKinds = fromCfg.length ? fromCfg : [KIND_TRUST];

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let subId = `g${randomBytes(6).toString('hex')}`;

  const buildFilters = () => {
    const sinceSec = Math.max(0, Math.floor(Date.now() / 1000) - 120);
    //const authors = runtimeContext.graphLoadMode === 'author' ? runtimeContext.authors : undefined;
    const authors = undefined; // load all authors trust events
    return createTrustFilters(effectiveKinds, authors, sinceSec, runtimeContext.contexts);
  };

  const handleMessage = (data: WebSocket.RawData): void => {
    try {
      const result = parseClientMessage(data);
      if (!result.ok) {
        logger.debug({ error: result.error }, 'Graph relay listener: Invalid client message');
        return;
      }
      const msg = result.msg as unknown as unknown[];
      const type = msg[0];
      if (type !== 'EVENT') return;
      // NIP-01 relay→client: ["EVENT", <subscription_id>, <event>] (not ["EVENT", <event>]).
      const payload =
        msg.length >= 3 && typeof msg[2] === 'object' && msg[2] !== null
          ? msg[2]
          : typeof msg[1] === 'object' && msg[1] !== null
            ? msg[1]
            : null;
      if (!payload) {
        logger.debug('Graph relay listener: EVENT without event object');
        return;
      }
      const event = payload as NostrEvent;
      if (typeof event.kind !== 'number' || event.kind < KIND_TRUST_MIN || event.kind > KIND_TRUST_MAX) return;

      let ok: boolean;
      try {
        ok = verifyEvent(event);
      } catch (err) {
        logger.debug({ err }, 'Graph relay listener: verifyEvent threw (malformed event)');
        return;
      }
      if (!ok) return;

      applyTrustEventToGraph(event as VerifiedEvent, graph);
    } catch (err) {
      logger.warn({ err }, 'Graph relay listener: failed to handle message (ignored)');
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearInitialTimer = (): void => {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
  };

  const connect = (): void => {
    if (closed) return;
    const url = resolveGraphRelayWsUrl(runtimeContext);
    logger.info({ url }, 'Graph: Subscribing to relay WebSocket for trust event updates');
    ws = new WebSocket(url);
    ws.on('open', () => {
      try {
        subId = `g${randomBytes(6).toString('hex')}`;
        const filters = buildFilters();
        ws?.send(JSON.stringify(['REQ', subId, ...filters]));
      } catch (err) {
        logger.warn({ err }, 'Graph relay listener: failed to send REQ after connect (ignored)');
      }
    });
    ws.on('message', handleMessage);
    ws.on('error', (err) => {
      logger.warn({ err, url }, 'Graph relay listener: WebSocket error');
    });
    ws.on('close', () => {
      ws = null;
      if (closed) return;
      clearReconnect();
      reconnectTimer = setTimeout(connect, 3000);
    });
  };

  const delayMs = initialConnectDelayMs();
  if (delayMs > 0) {
    logger.info({ delayMs }, 'Graph relay listener: delaying first connect');
    initialTimer = setTimeout(() => {
      initialTimer = null;
      connect();
    }, delayMs);
  } else {
    connect();
  }

  return {
    close: (): void => {
      closed = true;
      clearInitialTimer();
      clearReconnect();
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(['CLOSE', subId]));
        } catch {
          /* ignore */
        }
      }
      ws?.close();
      ws = null;
    },
  };
}
