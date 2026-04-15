import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { matchFilters, verifyEvent } from 'nostr-tools';
import type { NostrEvent, Filter, VerifiedEvent } from 'nostr-tools';
import { insertEvent } from '../../lib/trust/graphManager.js';
import type { NostrClientMsg, NostrClientREQ } from '@nostrify/types';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import { RuntimeContext } from '../../lib/runtimeContext.js';
import { logger } from '../../lib/logger.js';


interface ActiveSubscription {
  id: string;
  filters: Filter[];
  timer?: ReturnType<typeof setInterval>;
  seen: Set<string>;
  latestCreatedAt: number;
  polling: boolean;
}

interface RelayClient {
  socket: WebSocket;
  subscriptions: Map<string, ActiveSubscription>;
}

declare module 'fastify' {
  interface FastifyInstance {
    relayClients: Set<RelayClient>;
  }
}

export default fp(async function relayPlugin(app, runtimeContext: RuntimeContext) {
  await app.register(websocket);

  const clients = new Set<RelayClient>();
  app.decorate('relayClients', clients);

  logger.info(`Relay: Websocket (NIP-32010): ws://${runtimeContext.host}:${runtimeContext.port}/relay`);
  logger.info(`Relay: Info (NIP-11): http://${runtimeContext.host}:${runtimeContext.port}/relay-info`);
  logger.info(`Relay: Relays: ${runtimeContext.relays.join(', ')}`);

  const relayInfo = {
    name: 'Trust Relay',
    description:
      'Trust server relay endpoint backed by local store. Supports NIP-01 relay messaging and NIP-11 relay info document.',
    software: '@dtp/trust',
    version: process.env.npm_package_version ?? '0.1.0',
    supported_nips: [1, 11, 32010],
  };

  app.get('/relay-info', async (_request, reply) => {
    reply.header('content-type', 'application/nostr+json');
    return relayInfo;
  });

  app.get('/relay', { websocket: true }, (socket, _request) => {
    const client: RelayClient = {
      socket,
      subscriptions: new Map<string, ActiveSubscription>(),
    };
    clients.add(client);
    logger.debug({ clients: clients.size }, 'Relay: WebSocket client connected');

    socket.on('message', async (raw: RawData) => {
      const result = parseClientMessage(raw);
      if (!result.ok) {
        logger.debug({ error: result.error }, 'Relay: Invalid client message');
        sendRelayMessage(socket, ['NOTICE', `invalid: ${result.error}`]);
        return;
      }

      const msg = result.msg;
      const type = msg[0];

      try {
        switch (type) {
          case 'REQ':
            await handleReq(client, msg, runtimeContext);
            break;
          case 'CLOSE':
            handleClose(client, msg[1]);
            break;
          case 'EVENT':
            await handleEvent(msg[1], socket, runtimeContext);
            await fanOutEvent(msg[1], clients);
            break;
          default:
            logger.warn({ type }, 'Relay: Unknown client message type');
            sendRelayMessage(socket, ['NOTICE', `unsupported: unknown client message ${type}`]);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, msgType: type }, 'Relay: Error handling relay message');
        sendRelayMessage(socket, ['NOTICE', `error: ${reason}`]);
      }
    });

    socket.on('close', () => {
      closeAllSubscriptions(client);
      clients.delete(client);
      logger.debug({ clients: clients.size }, 'Relay: WebSocket client disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ err }, 'Relay: WebSocket error');
      closeAllSubscriptions(client);
      clients.delete(client);
    });
  });
}, { name: 'trust-relay' });

// Exported so the API plugin can fan out events to relay subscribers.
export async function fanOutEvent(event: NostrEvent, clients: Set<RelayClient>): Promise<void> {
  for (const client of clients) {
    if (client.socket.readyState !== client.socket.OPEN) continue;
    for (const sub of client.subscriptions.values()) {
      if (!matchFilters(sub.filters, event)) continue;
      sub.latestCreatedAt = Math.max(sub.latestCreatedAt, event.created_at);
      sub.seen.add(event.id);
      sendRelayMessage(client.socket, ['EVENT', sub.id, event]);
    }
  }
}

function closeAllSubscriptions(client: RelayClient): void {
  for (const sub of client.subscriptions.values()) {
    if (sub.timer) clearInterval(sub.timer);
  }
  client.subscriptions.clear();
}

function handleClose(client: RelayClient, subscriptionId: string): void {
  const existing = client.subscriptions.get(subscriptionId);
  if (!existing) return;
  if (existing.timer) clearInterval(existing.timer);
  client.subscriptions.delete(subscriptionId);
}

async function handleReq(client: RelayClient, req: NostrClientREQ, runtimeContext: RuntimeContext): Promise<void> {
  const [, subscriptionId, ...filters] = req;
  if (!subscriptionId) {
    sendRelayMessage(client.socket, ['NOTICE', 'invalid: missing subscription id']);
    return;
  }
  if (!filters.length) {
    sendRelayMessage(client.socket, ['CLOSED', subscriptionId, 'invalid: missing filter']);
    return;
  }

  handleClose(client, subscriptionId);

  const sub: ActiveSubscription = {
    id: subscriptionId,
    filters: filters as Filter[],
    seen: new Set<string>(),
    latestCreatedAt: 0,
    polling: false,
  };
  client.subscriptions.set(subscriptionId, sub);

  const store = runtimeContext.store;
  if (!store) throw new Error('Store not loaded');
  const initialEvents = await store.query(sub.filters, {});

  for (const event of initialEvents) {
    sub.latestCreatedAt = Math.max(sub.latestCreatedAt, event.created_at);
    sub.seen.add(event.id);
    sendRelayMessage(client.socket, ['EVENT', subscriptionId, event]);
  }

  sendRelayMessage(client.socket, ['EOSE', subscriptionId]);
  sub.timer = setInterval(() => {
    void pollSubscription(client, sub, runtimeContext);
  }, 1000);
}

async function pollSubscription(client: RelayClient, sub: ActiveSubscription, runtimeContext: RuntimeContext): Promise<void> {
  if (sub.polling) return;
  if (client.socket.readyState !== client.socket.OPEN) return;
  sub.polling = true;
  try {
    const store = runtimeContext.store;
    if (!store) throw new Error('Store not loaded');
    const pollFilters = sub.filters.map((filter) => ({
      ...filter,
      since: Math.max(filter.since ?? 0, sub.latestCreatedAt),
    }));
    const events = await store.query(pollFilters, {});

    for (const event of events) {
      if (sub.seen.has(event.id)) continue;
      sub.seen.add(event.id);
      if (sub.seen.size > 10_000) {
        const first = sub.seen.values().next();
        if (!first.done) sub.seen.delete(first.value);
      }
      sub.latestCreatedAt = Math.max(sub.latestCreatedAt, event.created_at);
      sendRelayMessage(client.socket, ['EVENT', sub.id, event]);
    }
  } finally {
    sub.polling = false;
  }
}

async function handleEvent(event: NostrEvent, socket: WebSocket, runtimeContext: RuntimeContext): Promise<void> {
  if (!verifyEvent(event)) {
    logger.debug({ eventId: event.id }, 'Relay: Event rejected: invalid signature');
    sendRelayMessage(socket, ['OK', event.id, false, 'invalid: failed event signature verification']);
    return;
  }

  const accepted = await insertEvent(event as VerifiedEvent, runtimeContext);
  if (accepted) {
    logger.debug({ eventId: event.id, kind: event.kind }, 'Relay: Event accepted');
  }
  sendRelayMessage(socket, ['OK', event.id, accepted, accepted ? '' : 'duplicate: filtered or rejected']);
}

function parseClientMessage(raw: RawData):
  | { ok: true; msg: NostrClientMsg }
  | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw : raw.toString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'message is not valid JSON' };
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
    return { ok: false, error: 'message must be a JSON array with a message type' };
  }

  return { ok: true, msg: parsed as NostrClientMsg };
}

function sendRelayMessage(socket: WebSocket, msg: unknown[]): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(msg));
}
