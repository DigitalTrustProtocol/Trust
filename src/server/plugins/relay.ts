import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { matchFilters, verifyEvent } from 'nostr-tools';
import type { NostrEvent, Filter } from 'nostr-tools';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NostrClientREQ } from '@nostrify/types';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import { RuntimeContext } from '../../lib/runtimeContext.js';
import { logger } from '../../lib/logger.js';
import { parseClientMessage } from '../../lib/nostr/relayManager.js';
import { asTrustEvent, isTrustEventValid, KIND_TRUST } from '../../lib/nostr/nip32010.js';
import { validateNip62Event, KIND_VANISH_REQUEST, isNip62TargetingRelay } from '../../lib/nostr/nip62.js';
import { InsertEventOptions } from '../../lib/db/dbManager.js';
import type { RelayLimitation } from '../../config.js';
import {
  applyRelayFilterLimits,
  enforceRelayEventWritePolicy,
  websocketInboundByteLength,
} from '../../lib/nostr/relayPolicy.js';
import { recordPrivacyIpForPubkey } from '../privacy/privacyAccess.js';
import { validateNip98Auth } from '../../lib/nostr/nip98.js';
import { buildPrivacyAccessPayload } from '../privacy/privacyAccess.js';
import { ok, sendError, ErrorCode } from '../errors.js';

const HEX64 = /^[0-9a-f]{64}$/i;

function optionalRelayHexPubkey(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase();
  return v && HEX64.test(v) ? v : undefined;
}

/**
 * NIP-11 relay information document.
 * @see https://nips.nostr.com/11
 *
 * Set `TRUST_RELAY_NIP11_PUBKEY` and `TRUST_RELAY_NIP11_SELF` (64-char hex) when you have
 * administrative and relay identity keys.
 */
function buildRelayNip11Document(
  runtimeContext: RuntimeContext
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    name: 'Trust Relay (DWoTR)',
    description: [
      'Trust is a decentralized web-of-trust Reputation system for identities and AI agents. This relay stores Nostr events, with first-class support for kind 32010 (NIP-32010).',
      'The public community relay is wss://relay.trust.dance on the same path as this software. Subscribe with REQ/CLOSE (NIP-01); the server answers with EVENT, EOSE, OK, and NOTICE.',
      'Use HTTP GET on this URL with Accept: application/nostr+json to retrieve this document (NIP-11).',
    ].join('\n\n'),
    icon: runtimeContext.relayIconUrl,
    contact: runtimeContext.publicOrigin,
    supported_nips: [1, 9, 11, 50, 62, 32010],
    software: 'https://github.com/DigitalTrustProtocol/Trust',
    version: process.env.npm_package_version ?? '0.1.0',
    terms_of_service: runtimeContext.termsOfServiceUrl,
    privacy_policy: runtimeContext.privacyPolicyUrl,
    limitation: { ...runtimeContext.relay.limitation },
  };

  const pubkey = optionalRelayHexPubkey(process.env.TRUST_RELAY_NIP11_PUBKEY);
  const self = optionalRelayHexPubkey(process.env.TRUST_RELAY_NIP11_SELF);
  if (pubkey) doc.pubkey = pubkey;
  if (self) doc.self = self;

  return doc;
}

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
  logger.info(
    `Relay: Info (NIP-11): http://${runtimeContext.host}:${runtimeContext.port}/relay (Accept: application/nostr+json)`,
  );

  const relayInfo = buildRelayNip11Document(runtimeContext);

  function addNip11CorsHeaders(reply: FastifyReply): void {
    // NIP-11: "Relays MUST accept CORS requests by sending
    // Access-Control-Allow-Origin, Access-Control-Allow-Headers, and Access-Control-Allow-Methods headers."
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Accept, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }

  function addRelayPrivacyCorsHeaders(reply: FastifyReply): void {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Accept, Content-Type, Authorization');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }

  function wantsNip11Json(request: FastifyRequest): boolean {
    const accept = request.headers?.accept;
    if (typeof accept !== 'string') return false;
    return accept
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .some((part) => part === 'application/nostr+json' || part.startsWith('application/nostr+json;'));
  }

  // Preflight for NIP-11 CORS on the same URI as the websocket.
  app.options('/relay', {
    schema: {
      hide: true,
    },
  }, async (_request, reply) => {
    addNip11CorsHeaders(reply);
    return reply.status(204).send();
  });

  app.options('/relay/privacy/access', {
    schema: {
      hide: true,
    },
  }, async (_request, reply) => {
    addRelayPrivacyCorsHeaders(reply);
    return reply.status(204).send();
  });

  app.get('/relay/privacy/access', {
    schema: {
      hide: true,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    addRelayPrivacyCorsHeaders(reply);

    const auth = validateNip98Auth(request);
    if (!auth.ok) {
      return sendError(reply, 401, ErrorCode.UNAUTHORIZED, `NIP-98 auth failed: ${auth.reason}`);
    }

    if (!runtimeContext.store) {
      return sendError(reply, 503, ErrorCode.STORE_UNAVAILABLE, 'Store not loaded');
    }

    const payload = await buildPrivacyAccessPayload(auth.pubkey, runtimeContext);
    return ok(payload);
  });


  // NIP-11 + NIP-01 on the same URI.
  app.route({
    method: 'GET',
    url: '/relay',
    schema: {
      // Hidden from Swagger/OpenAPI docs – this is a websocket/NIP-11 utility endpoint.
      hide: true,
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      // NIP-11: serve the relay information document over HTTP on the same URI as the websocket.
      if (wantsNip11Json(request)) {
        addNip11CorsHeaders(reply);
        reply.header('content-type', 'application/nostr+json');
        return relayInfo;
      }

      // For plain HTTP requests without the NIP-11 Accept header, guide clients to use websockets.
      addNip11CorsHeaders(reply);
      return reply.status(426).send({
        error: 'upgrade_required',
        message: 'Connect via WebSocket, or send Accept: application/nostr+json for relay info.',
      });
    },

    wsHandler: (socket, request) => {
    const client: RelayClient = {
      socket,
      subscriptions: new Map<string, ActiveSubscription>(),
    };
    clients.add(client);
    logger.debug({ clients: clients.size }, 'Relay: WebSocket client connected');

    socket.on('message', async (raw: RawData) => {
      const lim = runtimeContext.relay.limitation;
      const inboundBytes = websocketInboundByteLength(raw);
      if (inboundBytes > lim.max_message_length) {
        logger.debug({ inboundBytes, max: lim.max_message_length }, 'Relay: Message too large');
        sendRelayMessage(socket, [
          'NOTICE',
          `policy: message exceeds max_message_length (${lim.max_message_length} bytes, NIP-11)`,
        ]);
        return;
      }

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
            const subscriptionId: string = msg[1];
            handleClose(client, subscriptionId);
            break;
          case 'EVENT':
            const event: NostrEvent = msg[1];
            const accepted = await handleEvent(event, socket, runtimeContext, request.ip);
            if (accepted) 
              await fanOutEvent(event, clients);            
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
    },
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
  const lim = runtimeContext.relay.limitation;
  const [, subscriptionId, ...filters] = req;
  if (!subscriptionId) {
    sendRelayMessage(client.socket, ['NOTICE', 'invalid: missing subscription id']);
    return;
  }
  if (subscriptionId.length > lim.max_subid_length) {
    sendRelayMessage(client.socket, [
      'CLOSED',
      subscriptionId,
      `policy: subscription id exceeds max_subid_length (${lim.max_subid_length}, NIP-11)`,
    ]);
    return;
  }
  if (!filters.length) {
    sendRelayMessage(client.socket, ['CLOSED', subscriptionId, 'invalid: missing filter']);
    return;
  }

  const hadSubscription = client.subscriptions.has(subscriptionId);
  handleClose(client, subscriptionId);
  if (!hadSubscription && client.subscriptions.size >= lim.max_subscriptions) {
    sendRelayMessage(client.socket, [
      'CLOSED',
      subscriptionId,
      `policy: max_subscriptions (${lim.max_subscriptions}) per connection (NIP-11)`,
    ]);
    return;
  }

  const normalizedFilters = (filters as Filter[]).map((f) => applyRelayFilterLimits(f, lim));

  const sub: ActiveSubscription = {
    id: subscriptionId,
    filters: normalizedFilters,
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

async function handleEvent(
  event: NostrEvent,
  socket: WebSocket,
  runtimeContext: RuntimeContext,
  clientIp?: string,
): Promise<boolean> {
  const store = runtimeContext.store;
  const lim = runtimeContext.relay.limitation;

  if (!verifyEvent(event)) {
    logger.debug({ eventId: event.id }, 'Relay: Event rejected: invalid signature');
    sendRelayMessage(socket, ['OK', event.id, false, 'invalid: failed event signature verification']);
    return false;
  }

  const policyReason = enforceRelayEventWritePolicy(event, lim, Math.floor(Date.now() / 1000));
  if (policyReason) {
    logger.debug({ eventId: event.id, policyReason }, 'Relay: Event rejected by policy');
    sendRelayMessage(socket, ['OK', event.id, false, policyReason]);
    return false;
  }

  if (event.kind === KIND_TRUST) {
    const trustEvent = asTrustEvent(event);
    if (!isTrustEventValid(trustEvent)) {
      logger.debug({ eventId: event.id }, 'invalid: invalid trust event');
      sendRelayMessage(socket, ['OK', event.id, false, 'invalid: invalid trust event']);
      return false; // reject the event if it is not a valid trust event
    }
  }

  if (event.kind === KIND_VANISH_REQUEST) {
    const nip62 = validateNip62Event(runtimeContext.host, event);
    if (!nip62.ok) {
      sendRelayMessage(socket, ['OK', event.id, false, `invalid: ${nip62.reason}`]);
      return false;
    }

    await store?.remove([{ authors: [nip62.pubkey], until: event.created_at }]);
    sendRelayMessage(socket, ['OK', event.id, true, '']);
    return true;
  }

  const opt: InsertEventOptions = {};
  await store?.event(event, opt); // add the event to the database

  if (opt.isInserted) {
    if (clientIp) {
      recordPrivacyIpForPubkey(event.pubkey, clientIp, 'relay_write');
    }
    //logger.debug({ eventId: event.id }, 'Relay: Event accepted');
    sendRelayMessage(socket, ['OK', event.id, true, '']);
    return true;
  } 

  if (opt.isDeleted) {
    //logger.debug({ eventId: event.id }, 'Relay: Event rejected: deleted');
    sendRelayMessage(socket, ['OK', event.id, false, 'deleted: Event was deleted by another event (Kind 5)']);
    return false;
  }

  if (opt.isDublicate) {
    //logger.debug({ eventId: event.id }, 'Relay: Event rejected: duplicate');
    sendRelayMessage(socket, ['OK', event.id, false, 'duplicate: Event already exists in the database']);
    return false;
  }

  if (opt.isTimeout) {
    //logger.debug({ eventId: event.id }, 'Relay: Event rejected: timeout');
    sendRelayMessage(socket, ['OK', event.id, false, 'timeout: Timeout while adding event to the database']);
    return false;
  }

  if (opt.isError) {
    //logger.debug({ eventId: event.id }, 'Relay: Event rejected: error');
    sendRelayMessage(socket, ['OK', event.id, false, opt.errorMessage ?? 'error: filtered or rejected']);
    return false;
  }
  
  return false;
}

function sendRelayMessage(socket: WebSocket, msg: unknown[]): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(msg));
}
