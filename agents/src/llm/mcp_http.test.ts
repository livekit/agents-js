// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPServerHTTP, MCPServerStdio } from './mcp.js';
import type { ToolOptions } from './tool_context.js';

type ProtocolVersion = '2025-11-25' | '2026-07-28';
interface WireRequest {
  id?: string | number;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}
interface ReceivedRequest {
  httpMethod?: string;
  headers: IncomingHttpHeaders;
  message?: WireRequest;
}

const cleanup: (() => Promise<void>)[] = [];
function toolOptions(abortSignal = new AbortController().signal): ToolOptions {
  // The MCP adapter only uses update(); no voice session is needed for wire tests.
  const ctx = Object.create(null) as ToolOptions['ctx'];
  ctx.update = vi.fn().mockResolvedValue(undefined);
  return { ctx, toolCallId: 'call', abortSignal };
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

// No SDK server or client mocks: exercise our adapter and the installed SDK over HTTP.
async function fixture(
  version: ProtocolVersion,
  options: {
    status?: number;
    stallDiscovery?: boolean;
    clientSessionTimeout?: number | null;
  } = {},
) {
  const modern = version === '2026-07-28';
  const requests: ReceivedRequest[] = [];
  let toolName = 'lookup';
  let stalledResponse: ServerResponse | undefined;
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const received: ReceivedRequest = { httpMethod: req.method, headers: req.headers };
    requests.push(received);
    if (options.status) {
      res.writeHead(options.status).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message: WireRequest = JSON.parse(Buffer.concat(chunks).toString());
    received.message = message;
    if (message.method === 'server/discover' && options.stallDiscovery) {
      stalledResponse = res;
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: Record<string, unknown>) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { ...(modern ? { resultType: 'complete' } : {}), ...result },
        }),
      );
    };
    if (message.method === 'server/discover' && modern) {
      reply({ supportedVersions: [version], capabilities: { tools: {} } });
    } else if (message.method === 'initialize' && !modern) {
      reply({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'stateless-fixture', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      reply({
        // Nonzero TTL makes sure our explicit invalidation also bypasses the SDK's new cache.
        ttlMs: 60_000,
        cacheScope: 'private',
        tools: [{ name: toolName, inputSchema: { type: 'object' } }],
      });
    } else if (message.method === 'tools/call') {
      if (message.params?.arguments?.stall) {
        stalledResponse = res;
        return;
      }
      const result = {
        content: [{ type: 'text', text: message.params?.arguments?.fail ? 'tool failed' : 'ok' }],
        isError: message.params?.arguments?.fail === true,
      };
      if (message.params?.arguments?.progress) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken: message.params._meta?.progressToken,
              progress: 1,
              message: 'working',
            },
          })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { ...(modern ? { resultType: 'complete' } : {}), ...result },
          })}\n\n`,
        );
      } else {
        reply(result);
      }
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
    }
  };
  const http = createServer((req, res) => {
    void handleRequest(req, res).catch(() => res.writeHead(500).end());
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const server = new MCPServerHTTP({
    url: `http://127.0.0.1:${address.port}/tools`,
    transportType: 'streamable_http',
    allowInsecureHttp: true,
    headers: { authorization: 'Bearer fixture-token' },
    clientSessionTimeout:
      options.clientSessionTimeout === undefined ? 1000 : options.clientSessionTimeout,
  });
  cleanup.push(() => server.aclose());
  return {
    server,
    requests,
    renameTool: (name: string) => {
      toolName = name;
    },
    stalledResponse: () => stalledResponse,
  };
}

describe('MCP HTTP protocol integration', () => {
  it.each<ProtocolVersion>(['2026-07-28', '2025-11-25'])(
    'lists and calls tools on a stateless %s server without notifications or persistent streams',
    async (version) => {
      const { server, requests, renameTool } = await fixture(version);
      await server.initialize();
      const [lookup] = await server.listTools();
      expect(lookup?.name).toBe('lookup');
      const options = toolOptions();
      await expect(lookup!.execute({}, options)).resolves.toBe('{"type":"text","text":"ok"}');
      await expect(lookup!.execute({ fail: true }, options)).rejects.toThrow('tool failed');
      expect(server.initialized).toBe(true);

      renameTool('new_lookup');
      server.invalidateCache();
      expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
      await server.aclose();
      expect(server.initialized).toBe(false);

      const messages = requests.flatMap(({ message }) => (message ? [message] : []));
      expect(messages[0]?.method).toBe('server/discover');
      expect(messages.some(({ method }) => method === 'initialize')).toBe(version === '2025-11-25');
      expect(messages.some(({ method }) => method === 'notifications/initialized')).toBe(
        version === '2025-11-25',
      );
      expect(messages.some(({ method }) => method === 'subscriptions/listen')).toBe(false);
      expect(
        requests.every(({ headers }) => headers.authorization === 'Bearer fixture-token'),
      ).toBe(true);
      expect(requests.every(({ headers }) => headers['mcp-session-id'] === undefined)).toBe(true);
      expect(requests.some(({ httpMethod }) => httpMethod === 'DELETE')).toBe(false);
      if (version === '2026-07-28') {
        expect(requests.every(({ httpMethod }) => httpMethod === 'POST')).toBe(true);
        for (const message of messages) {
          expect(message.params?._meta).toMatchObject({
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientInfo': { name: 'livekit-agents' },
            'io.modelcontextprotocol/clientCapabilities': {},
          });
        }
      }
    },
  );

  it.each<ProtocolVersion>(['2026-07-28', '2025-11-25'])(
    'cancels an in-flight %s HTTP call without disconnecting the shared client',
    async (version) => {
      const { server, requests, stalledResponse } = await fixture(version);
      await server.initialize();
      const [lookup] = await server.listTools();
      const controller = new AbortController();
      const options = toolOptions(controller.signal);
      const calling = lookup!.execute({ stall: true }, options);
      // Attach the rejection handler before aborting to avoid an unhandled rejection.
      const rejected = expect(calling).rejects.toThrow('MCP tool call failed unexpectedly.');
      await vi.waitFor(() => expect(stalledResponse()).toBeDefined());
      controller.abort();
      await rejected;
      if (version === '2026-07-28') {
        await vi.waitFor(() => expect(stalledResponse()?.destroyed).toBe(true));
      } else {
        await vi.waitFor(() =>
          expect(
            requests.some(({ message }) => message?.method === 'notifications/cancelled'),
          ).toBe(true),
        );
      }
      expect(server.initialized).toBe(true);
      await expect(
        lookup!.execute({}, { ...options, abortSignal: new AbortController().signal }),
      ).resolves.toBe('{"type":"text","text":"ok"}');
    },
  );

  it.each<ProtocolVersion>(['2026-07-28', '2025-11-25'])(
    'reports progress and preserves terminal tool errors over %s HTTP',
    async (version) => {
      const { server } = await fixture(version);
      await server.initialize();
      const [lookup] = await server.listTools({ lookup: { reportProgress: true } });
      const options = toolOptions();
      await expect(lookup!.execute({ progress: true, fail: true }, options)).rejects.toThrow(
        'tool failed',
      );
      expect(options.ctx.update).toHaveBeenCalledWith('working');
      expect(server.initialized).toBe(true);
    },
  );

  it.each<ProtocolVersion>(['2026-07-28', '2025-11-25'])(
    'lists and calls tools over %s stdio, including legacy servers that exit on discovery',
    async (version) => {
      const server = new MCPServerStdio({
        command: process.execPath,
        clientSessionTimeout: 1000,
        args: [
          '--input-type=module',
          '-e',
          `
          import { createInterface } from 'node:readline';
          const modern = ${JSON.stringify(version)} === '2026-07-28';
          createInterface({ input: process.stdin }).on('line', (line) => {
            const request = JSON.parse(line);
            if (request.id === undefined) return;
            let result;
            if (request.method === 'server/discover') {
              if (!modern) process.exit(0);
              result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
            } else if (request.method === 'initialize') {
              result = { protocolVersion: '2025-11-25', capabilities: { tools: {} },
                serverInfo: { name: 'stdio-fixture', version: '1.0.0' } };
            } else if (request.method === 'tools/list') {
              result = { ttlMs: 0, cacheScope: 'private', tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] };
            } else if (request.method === 'tools/call') {
              result = { content: [{ type: 'text', text: 'stdio ok' }] };
            } else {
              throw new Error('Unexpected request: ' + request.method);
            }
            console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id,
              result: { ...(modern ? { resultType: 'complete' } : {}), ...result } }));
          });
        `,
        ],
      });
      cleanup.push(() => server.aclose());
      await server.initialize();
      const [lookup] = await server.listTools();
      await expect(lookup!.execute({}, toolOptions())).resolves.toBe(
        '{"type":"text","text":"stdio ok"}',
      );
      await server.aclose();
      expect(server.initialized).toBe(false);
    },
  );

  it.each([401, 403])(
    'does not treat HTTP %i as a legacy server or retry initialization',
    async (status) => {
      const { server, requests } = await fixture('2026-07-28', { status });
      await expect(server.initialize()).rejects.toThrow();
      expect(server.initialized).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.httpMethod).toBe('POST');
    },
  );

  it('closes a stalled discovery probe without waiting for an unbounded connection request', async () => {
    const { server, stalledResponse } = await fixture('2026-07-28', {
      stallDiscovery: true,
      clientSessionTimeout: null,
    });
    const initializing = expect(server.initialize()).rejects.toThrow();
    await vi.waitFor(() => expect(stalledResponse()).toBeDefined());
    let closed = false;
    const closing = server.aclose().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 250 });
    await Promise.all([closing, initializing]);
    expect(server.initialized).toBe(false);
  });
});
