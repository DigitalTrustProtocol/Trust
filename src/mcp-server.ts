import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as sdk from './sdk.js';

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'trust', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'trust_resolve',
        description: 'Resolve trust from author perspective toward a subject. Returns trust score with degree, trust/distrust counts, and connection status.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            subject: { type: 'string', description: 'Subject to resolve (npub, hex pubkey, URL, etc.)' },
            author: { type: 'string', description: 'Author perspective (npub or hex). Defaults to primary identity.' },
            context: { type: 'string', description: 'Trust context (e.g. "development", "commerce"). Empty string for general.' },
            format: { type: 'string', enum: ['number', 'default', 'path'], description: 'Output format. "number" returns single integer.' },
            maxDepth: { type: 'number', description: 'Max graph hops (1-4, default 4).' },
          },
          required: ['subject'],
        },
      },
      {
        name: 'trust_resolve_batch',
        description: 'Resolve trust for multiple subjects in one call. Efficient for evaluating groups.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            subjects: { type: 'array', items: { type: 'string' }, description: 'Array of subjects to resolve' },
            author: { type: 'string', description: 'Author perspective (npub or hex)' },
            context: { type: 'string', description: 'Trust context' },
            format: { type: 'string', enum: ['number', 'default', 'path'] },
          },
          required: ['subjects'],
        },
      },
      {
        name: 'trust_add',
        description: 'Issue a trust assertion (kind 32010) toward one or more subjects and publish to Nostr relays.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            subjects: { type: 'array', items: { type: 'string' }, description: 'Subjects to trust (npub, hex, URL, etc.)' },
            value: { type: 'number', enum: [1, 0, -1], description: '1 = trust, 0 = neutral/revoke, -1 = distrust' },
            context: { type: 'string', description: 'Trust context' },
            content: { type: 'string', description: 'Human-readable explanation for the trust assertion' },
          },
          required: ['subjects', 'value'],
        },
      },
      {
        name: 'trust_whoami',
        description: 'Get the current Trust identity (public key, npub, profile).',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'trust_trusted',
        description: 'List subjects trusted by an author in a given context.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            author: { type: 'string', description: 'Author pubkey (npub or hex). Defaults to primary identity.' },
            context: { type: 'string', description: 'Trust context filter' },
          },
        },
      },
      {
        name: 'trust_graph_stats',
        description: 'Get trust graph statistics: node count, edge count.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'trust_resolve': {
          const a = args as { subject: string; author?: string; context?: string; format?: string; maxDepth?: number };
          const score = await sdk.resolve(a.subject, {
            authors: a.author,
            contexts: a.context,
            format: (a.format as any) ?? 'default',
            maxDepth: a.maxDepth,
          });
          return { content: [{ type: 'text', text: JSON.stringify(score, null, 2) }] };
        }

        case 'trust_resolve_batch': {
          const a = args as { subjects: string[]; author?: string; context?: string; format?: string };
          const results = await sdk.resolveBatch(a.subjects, {
            authors: a.author,
            contexts: a.context,
            format: (a.format as any) ?? 'default',
          });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }

        case 'trust_add': {
          const a = args as { subjects: string[]; value: number; context?: string; content?: string };
          const event = await sdk.add(a.subjects, {
            value: a.value as 1 | 0 | -1,
            contexts: a.context,
            content: a.content,
          });
          return { content: [{ type: 'text', text: JSON.stringify({ id: event.id, pubkey: event.pubkey, kind: event.kind }, null, 2) }] };
        }

        case 'trust_whoami': {
          const identity = sdk.whoami();
          if (!identity) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'No identity configured. Run trust init first.' }) }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(identity, null, 2) }] };
        }

        case 'trust_trusted': {
          const a = args as { author?: string; context?: string };
          const subjects = await sdk.trusted(a.author, { context: a.context });
          return { content: [{ type: 'text', text: JSON.stringify(subjects, null, 2) }] };
        }

        case 'trust_graph_stats': {
          const { getLoadedGraph } = await import('./lib/trust/graphManager.js');
          const graph = getLoadedGraph();
          const stats = {
            nodes: graph?.nodes.size ?? 0,
            edges: graph?.edges.size ?? 0,
          };
          return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
    }
  });

  return server;
}
