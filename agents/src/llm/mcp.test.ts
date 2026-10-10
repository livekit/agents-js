// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../voice/agent.js';
import { AgentActivity } from '../voice/agent_activity.js';
import { AgentSession } from '../voice/agent_session.js';
import { RunContext } from '../voice/run_context.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import { FunctionCall } from './chat_context.js';
import { MCPServer, MCPServerHTTP, MCPToolset } from './mcp.js';
import { ToolError } from './tool_context.js';

const clientMock = vi.hoisted<{ client?: object; options?: ClientOptions }>(() => ({}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor(_info: unknown, options: unknown) {
      if (!clientMock.client) throw new Error('MCP client mock was not configured');
      clientMock.options = options;
      return clientMock.client;
    }
  },
}));

const descriptor = { name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildRunContext(name: string) {
  const functionCall = FunctionCall.create({ callId: `call_${name}`, name, args: '{}' });
  const session = new AgentSession({
    vad: null,
    userData: {},
    turnHandling: { turnDetection: null },
  });
  const agent = new Agent({ instructions: '' });
  const activity = new AgentActivity(agent, session);
  vi.spyOn(session, 'currentAgent', 'get').mockReturnValue(agent);
  vi.spyOn(session, 'waitForIdle').mockResolvedValue(activity);
  vi.spyOn(session, 'generateReply').mockReturnValue(SpeechHandle.create());
  return {
    runCtx: new RunContext(session, SpeechHandle.create(), functionCall),
    history: session.history,
  };
}

async function attachClient(server: MCPServer, client: object): Promise<void> {
  clientMock.client = { connect: async () => {}, close: async () => {}, ...client };
  await server.initialize();
}

class TestServer extends MCPServer {
  protected override async createTransport(): Promise<Transport> {
    return {
      start: async () => {},
      send: async () => {},
      close: async () => {},
    };
  }

  async emitToolsChanged(): Promise<void> {
    await this.notifyToolsChanged();
  }

  spyOnWarn() {
    return vi.spyOn(this.logger, 'warn').mockImplementation(() => {});
  }
}

describe('MCPServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clientMock.client = undefined;
    clientMock.options = undefined;
  });

  it('closes a client that connects after shutdown starts', async () => {
    const connection = deferred<void>();
    const client = {
      connect: vi.fn(() => connection.promise),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientMock.client = client;
    const server = new TestServer();

    const initializing = server.initialize();
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    const closing = server.aclose();
    connection.resolve();
    await Promise.all([initializing, closing]);

    expect(client.close).toHaveBeenCalledOnce();
    expect(server.initialized).toBe(false);

    const reconnectedClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientMock.client = reconnectedClient;
    await server.initialize();
    expect(server.initialized).toBe(true);
    await server.aclose();
    expect(reconnectedClient.close).toHaveBeenCalledOnce();
  });

  it('reconnects when initialize overlaps an in-flight shutdown', async () => {
    const firstConnection = deferred<void>();
    const firstClient = {
      connect: vi.fn(() => firstConnection.promise),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientMock.client = firstClient;
    const server = new TestServer();

    const firstInitialization = server.initialize();
    await vi.waitFor(() => expect(firstClient.connect).toHaveBeenCalledOnce());
    const closing = server.aclose();

    const secondClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientMock.client = secondClient;
    const secondInitialization = server.initialize();
    firstConnection.resolve();

    await Promise.all([firstInitialization, closing, secondInitialization]);

    expect(secondClient.connect).toHaveBeenCalledOnce();
    expect(server.initialized).toBe(true);
    await server.aclose();
    expect(secondClient.close).toHaveBeenCalledOnce();
  });

  it('closes a stalled connecting client before awaiting initialization', async () => {
    const connection = deferred<void>();
    const close = vi.fn(async () => connection.resolve());
    const client = {
      connect: vi.fn(() => connection.promise),
      close,
    };
    clientMock.client = client;
    const server = new TestServer();

    const initializing = server.initialize();
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    const closing = server.aclose();
    await Promise.resolve();
    const closeCountWhileConnecting = close.mock.calls.length;
    connection.resolve();
    await Promise.all([initializing, closing]);

    expect(closeCountWhileConnecting).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(server.initialized).toBe(false);
  });

  it('runs later tool-change listeners when an earlier listener throws synchronously', async () => {
    const laterListener = vi.fn();
    const server = new TestServer();
    const warn = server.spyOnWarn();
    server.onToolsChanged(() => {
      throw new Error('secret listener failure');
    });
    server.onToolsChanged(laterListener);

    await server.emitToolsChanged();

    expect(laterListener).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { errorType: 'Error' },
      'failed to refresh MCP tools after change',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret listener failure');
  });

  it('turns an empty successful MCP result into a ToolError', async () => {
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    });

    const [lookup] = await server.listTools();
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'call', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow("Tool 'lookup' completed without producing a result.");
  });

  it.each([
    { type: 'string' },
    { type: 'object', description: 42 },
    { type: 'object', required: 'query' },
    { type: 'object', properties: { query: { type: 42 } } },
    { type: 'object', properties: { query: { type: 'string', minLength: 'one' } } },
    { type: 'object', properties: { query: { anyOf: [{ type: 42 }] } } },
    { type: 'object', properties: { query: { $ref: '#/$defs/missing' } } },
    { type: 'object', properties: { query: { $ref: 'https://example.com/query-schema' } } },
  ])('rejects malformed or unresolvable MCP input schema %j', async (inputSchema) => {
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'lookup', inputSchema }],
      }),
    });

    await expect(server.listTools()).rejects.toThrow("Tool 'lookup' has an invalid input schema.");
  });

  it.each([
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { query: { type: 'string', format: 'date-time' } },
    },
    {
      type: 'object',
      definitions: { query: { type: 'string' } },
      properties: { query: { $ref: '#/definitions/query' } },
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: { query: { type: 'string' } },
      properties: { query: { $ref: '#/$defs/query' } },
    },
    { type: 'object', properties: { child: { $ref: '#' } } },
    {
      type: 'object',
      properties: { query: { allOf: [{ type: 'number', minimum: 0 }, { maximum: 10 }] } },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { query: { type: ['string', 'null'], default: null } },
      'x-mcp-extension': { value: true },
    },
  ])('preserves supported MCP schema %j without mutating it', async (schema) => {
    const inputSchema = structuredClone(schema);
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'lookup', inputSchema }] }),
    });
    const [lookup] = await server.listTools();
    expect(lookup?.parameters).toBe(inputSchema);
    expect(inputSchema).toEqual(schema);
  });

  it('does not reuse a cached validator when a refreshed schema keeps its $id', async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [
          { name: 'lookup', inputSchema: { $id: 'https://example.com/lookup', type: 'object' } },
        ],
      })
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'lookup',
            inputSchema: {
              $id: 'https://example.com/lookup',
              type: 'object',
              properties: { query: { type: 42 } },
            },
          },
        ],
      });
    const server = new TestServer();
    await attachClient(server, { listTools });
    await server.listTools();
    server.invalidateCache();
    await expect(server.listTools()).rejects.toThrow("Tool 'lookup' has an invalid input schema.");
  });

  it('preserves nested MCP input schema constraints', async () => {
    const inputSchema = {
      type: 'object',
      properties: { query: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['query'],
      additionalProperties: false,
    };
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'lookup', inputSchema }] }),
    });

    const [lookup] = await server.listTools();
    expect(lookup?.parameters).toEqual(inputSchema);
  });

  it('forwards cancellation to the MCP SDK request', async () => {
    const server = new TestServer();
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
    });
    const controller = new AbortController();

    const [lookup] = await server.listTools();
    await lookup!.execute({}, { ctx: {}, toolCallId: 'call', abortSignal: controller.signal });

    expect(callTool.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('logs only safe metadata when reporting progress fails', async () => {
    const server = new TestServer();
    const warn = server.spyOnWarn();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, _schema, options) => {
        options?.onprogress?.({ progress: 1, message: 'working' });
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    });
    const [lookup] = await server.listTools({ lookup: { reportProgress: true } });

    await lookup!.execute(
      {},
      {
        ctx: { update: vi.fn().mockRejectedValue(new Error('secret progress failure')) },
        toolCallId: 'call',
        abortSignal: new AbortController().signal,
      },
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    expect(warn).toHaveBeenCalledWith(
      { errorType: 'Error', toolName: 'lookup' },
      'failed to report progress for MCP tool',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret progress failure');
  });

  it('logs only safe metadata when closing the client fails', async () => {
    const server = new TestServer();
    const warn = server.spyOnWarn();
    await attachClient(server, {
      close: vi.fn().mockRejectedValue(new Error('secret bearer credential')),
    });

    await server.aclose();

    expect(warn).toHaveBeenCalledWith({ errorType: 'Error' }, 'error closing MCP client');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret bearer credential');
  });

  it('keeps the client connected after an MCP tool error', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'database connection closed' }],
        isError: true,
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
    });

    const [lookup] = await server.listTools();
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'first', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('database connection closed');
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
      ),
    ).resolves.toBe(JSON.stringify({ type: 'text', text: 'ok' }));

    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('wraps a non-connection MCP SDK error without disconnecting the client', async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('request failed with bearer secret'), {
          name: 'McpError',
          code: -32603,
        }),
      )
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
    });

    const [lookup] = await server.listTools();
    const error = await lookup!
      .execute({}, { ctx: {}, toolCallId: 'first', abortSignal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toHaveProperty('message', 'MCP tool call failed unexpectedly.');
    expect(error).not.toHaveProperty('cause');
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
      ),
    ).resolves.toBe(JSON.stringify({ type: 'text', text: 'ok' }));

    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'thrown Error',
      () => {
        throw new Error('resolver secret');
      },
    ],
    ['returned Error', () => new Error('resolver secret')],
    [
      'custom ToolError',
      () => {
        throw new ToolError('resolver secret');
      },
    ],
  ])(
    'wraps a resolver %s without disconnecting or exposing its contents',
    async (_name, toolResultResolver) => {
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const server = new TestServer({ toolResultResolver });
      await attachClient(server, {
        listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
        callTool,
      });

      const [lookup] = await server.listTools();
      const error = await lookup!
        .execute({}, { ctx: {}, toolCallId: 'first', abortSignal: new AbortController().signal })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ToolError);
      expect(error).toHaveProperty('message', 'MCP tool result processing failed unexpectedly.');
      expect(error).not.toHaveProperty('cause');
      await expect(
        lookup!.execute(
          {},
          { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
        ),
      ).rejects.toThrow('MCP tool result processing failed unexpectedly.');

      expect(callTool).toHaveBeenCalledTimes(2);
    },
  );

  it('resets the client after an MCP SDK connection error', async () => {
    const sdkConnectionError = Object.assign(new Error('connection closed'), {
      name: 'McpError',
      code: -32000,
    });
    const server = new TestServer();
    const close = vi.fn().mockResolvedValue(undefined);
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn().mockRejectedValue(sdkConnectionError),
      close,
    });

    const [lookup] = await server.listTools();
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'call', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('MCP server connection is unavailable');
    expect(server.initialized).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('reconnects a disconnected toolset on the next call and publishes fresh tools', async () => {
    const connectionError = Object.assign(new Error('connection closed'), {
      name: 'McpError',
      code: -32000,
    });
    const oldClient = {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn().mockRejectedValue(connectionError),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const server = new TestServer();
    await attachClient(server, oldClient);
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const context = { updateTools: vi.fn() };
    await toolset.setup(context);
    const [lookup] = context.updateTools.mock.calls[0]?.[0] ?? [];

    await expect(
      lookup.execute(
        {},
        { ctx: {}, toolCallId: 'first', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('MCP server connection is unavailable');
    expect(server.initialized).toBe(false);
    expect(oldClient.close).toHaveBeenCalledOnce();

    const failedReconnect = {
      connect: vi.fn().mockRejectedValue(new Error('credential-bearing connection failure')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientMock.client = failedReconnect;
    await expect(
      lookup.execute(
        {},
        { ctx: {}, toolCallId: 'retry', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('MCP server connection is unavailable');
    expect(failedReconnect.close).toHaveBeenCalledOnce();

    const newClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [descriptor, { ...descriptor, name: 'search' }] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'recovered' }] }),
    };
    clientMock.client = newClient;
    await expect(
      lookup.execute(
        {},
        { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
      ),
    ).resolves.toContain('recovered');
    await vi.waitFor(() => expect(context.updateTools).toHaveBeenCalledTimes(2));
    expect(
      context.updateTools.mock.calls[1]?.[0].map((tool: { name: string }) => tool.name),
    ).toEqual(['lookup', 'search']);
    await toolset.aclose();

    const afterClose = { connect: vi.fn(), close: vi.fn() };
    clientMock.client = afterClose;
    await expect(
      lookup.execute(
        {},
        { ctx: {}, toolCallId: 'closed', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('MCP server connection is unavailable');
    expect(afterClose.connect).not.toHaveBeenCalled();
  });

  it('uses the SDK list-change handler to invalidate cached tools', async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor] })
      .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'new_lookup' }] });
    clientMock.client = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools,
    };
    const server = new TestServer();

    await server.initialize();
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['lookup']);

    const options = clientMock.options;
    expect(options.listChanged?.tools?.autoRefresh).toBe(false);
    options?.listChanged?.tools?.onChanged(null, null);

    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
  });

  it('invalidates cached descriptors when tools change', async () => {
    const server = new TestServer();
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor] })
      .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'new_lookup' }] });
    await attachClient(server, { listTools, callTool: vi.fn() });

    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['lookup']);
    await server.emitToolsChanged();
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('does not cache a tool list invalidated while the request is in flight', async () => {
    const firstPage = deferred<{ tools: (typeof descriptor)[] }>();
    const listTools = vi
      .fn()
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'new_lookup' }] });
    const server = new TestServer();
    await attachClient(server, { listTools, callTool: vi.fn() });

    const initialTools = server.listTools();
    await vi.waitFor(() => expect(listTools).toHaveBeenCalledOnce());
    server.invalidateCache();
    firstPage.resolve({ tools: [descriptor] });

    expect((await initialTools).map((tool) => tool.name)).toEqual(['lookup']);
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('collects every page of MCP tool descriptors', async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'search' }] });
    const server = new TestServer();
    await attachClient(server, { listTools, callTool: vi.fn() });

    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['lookup', 'search']);
    expect(listTools).toHaveBeenNthCalledWith(1, undefined, expect.anything());
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' }, expect.anything());
  });

  it('finishes pagination without caching results when the server closes between pages', async () => {
    const firstPage = deferred<{ tools: (typeof descriptor)[]; nextCursor: string }>();
    const oldClient = {
      listTools: vi
        .fn()
        .mockReturnValueOnce(firstPage.promise)
        .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'old_search' }] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const server = new TestServer();
    await attachClient(server, oldClient);

    const listing = server.listTools();
    await vi.waitFor(() => expect(oldClient.listTools).toHaveBeenCalledOnce());
    await server.aclose();
    firstPage.resolve({ tools: [descriptor], nextCursor: 'page-2' });

    expect((await listing).map((tool) => tool.name)).toEqual(['lookup', 'old_search']);

    const newListTools = vi
      .fn()
      .mockResolvedValue({ tools: [{ ...descriptor, name: 'new_lookup' }] });
    await attachClient(server, { listTools: newListTools });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
    expect(newListTools).toHaveBeenCalledOnce();
  });

  it('matches Python by treating an empty allowed-tools list as no filter', async () => {
    const server = new MCPServerHTTP({ url: 'https://example.com/mcp', allowedTools: [] });
    await attachClient(server, { listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }) });

    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['lookup']);
  });

  it('rejects plaintext HTTP transport by default', () => {
    expect(() => new MCPServerHTTP({ url: 'http://example.com/mcp' })).toThrow(
      'MCPServerHTTP requires an https: URL',
    );
  });

  it('allows plaintext HTTP transport only when explicitly enabled', () => {
    const server = new MCPServerHTTP({
      url: 'http://localhost:8000/mcp',
      allowInsecureHttp: true,
    });

    expect(server.url).toBe('http://localhost:8000/mcp');
  });

  it('rejects unsupported URL protocols even when insecure HTTP is enabled', () => {
    expect(
      () => new MCPServerHTTP({ url: 'ftp://example.com/mcp', allowInsecureHttp: true }),
    ).toThrow('MCPServerHTTP requires an https: URL');
  });

  it('does not update a stale context when setup follows an in-flight close', async () => {
    const firstPage = deferred<{ tools: (typeof descriptor)[] }>();
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockReturnValue(firstPage.promise),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const firstContext = { updateTools: vi.fn() };
    const secondContext = { updateTools: vi.fn() };

    const firstSetup = toolset.setup(firstContext);
    await vi.waitFor(() => expect(server.initialized).toBe(true));
    let closed = false;
    const closing = toolset.aclose().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    firstPage.resolve({ tools: [descriptor] });
    await Promise.all([firstSetup, closing]);

    const secondClose = vi.fn().mockResolvedValue(undefined);
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [{ ...descriptor, name: 'new_lookup' }] }),
      close: secondClose,
    });
    await toolset.setup(secondContext);

    expect(firstContext.updateTools).not.toHaveBeenCalled();
    expect(secondContext.updateTools).toHaveBeenCalledOnce();
    expect(secondContext.updateTools.mock.calls[0]?.[0][0]?.name).toBe('new_lookup');
    await toolset.aclose();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'keeps a shared server connected when one toolset closes (unbounded: %s)',
    async (unbounded) => {
      const close = vi.fn().mockResolvedValue(undefined);
      const callTool = vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'still available' }] });
      const server = new TestServer({ clientSessionTimeout: unbounded ? null : 5000 });
      await attachClient(server, {
        listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
        callTool,
        close,
      });
      const first = new MCPToolset({ id: 'first', mcpServer: server });
      const second = new MCPToolset({ id: 'second', mcpServer: server });
      const firstContext = { updateTools: vi.fn() };
      const secondContext = { updateTools: vi.fn() };
      await first.setup(firstContext);
      await second.setup(secondContext);
      const [lookup] = secondContext.updateTools.mock.calls[0]?.[0] ?? [];

      await first.aclose();

      expect(close).not.toHaveBeenCalled();
      expect(server.initialized).toBe(true);
      await expect(
        lookup.execute(
          {},
          { ctx: {}, toolCallId: 'call', abortSignal: new AbortController().signal },
        ),
      ).resolves.toContain('still available');
      expect(callTool).toHaveBeenCalledOnce();

      await second.aclose();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('waits for the final shared-server shutdown before a new toolset connects', async () => {
    const oldClose = deferred<void>();
    const close = vi.fn(() => oldClose.promise);
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      close,
    });
    const first = new MCPToolset({ id: 'first', mcpServer: server });
    await first.setup({ updateTools: vi.fn() });

    const closing = first.aclose();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    const newClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
    };
    clientMock.client = newClient;
    const second = new MCPToolset({ id: 'second', mcpServer: server });
    const context = { updateTools: vi.fn() };
    const settingUp = second.setup(context);
    await Promise.resolve();
    expect(newClient.connect).not.toHaveBeenCalled();

    oldClose.resolve();
    await Promise.all([closing, settingUp]);
    expect(newClient.connect).toHaveBeenCalledOnce();
    expect(context.updateTools).toHaveBeenCalledOnce();
    await second.aclose();
  });

  it('closes a shared unbounded toolset without disconnecting another owner', async () => {
    const stalled = deferred<{ content: { type: string; text: string }[] }>();
    const callTool = vi
      .fn()
      .mockImplementationOnce(async (_params, _schema, options) => {
        await options?.onprogress?.({ progress: 0, message: 'working' });
        return new Promise((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          stalled.promise.then(resolve, reject);
        });
      })
      .mockResolvedValue({ content: [{ type: 'text', text: 'second owner works' }] });
    const close = vi.fn().mockResolvedValue(undefined);
    const server = new TestServer({ clientSessionTimeout: null });
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
      close,
    });
    const first = new MCPToolset({
      id: 'first',
      mcpServer: server,
      toolOptions: { lookup: { reportProgress: true } },
    });
    const second = new MCPToolset({ id: 'second', mcpServer: server });
    const firstContext = { updateTools: vi.fn() };
    const secondContext = { updateTools: vi.fn() };
    await first.setup(firstContext);
    await second.setup(secondContext);
    const [firstLookup] = firstContext.updateTools.mock.calls[0]?.[0] ?? [];
    const [secondLookup] = secondContext.updateTools.mock.calls[0]?.[0] ?? [];
    const { runCtx } = buildRunContext('lookup');
    await expect(
      first._executor.execute({ tool: firstLookup, runCtx, rawArguments: {} }),
    ).resolves.toContain('working');

    let finished = false;
    const closing = first.aclose().then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 100 });
      expect(close).not.toHaveBeenCalled();
      await expect(
        secondLookup.execute(
          {},
          { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
        ),
      ).resolves.toContain('second owner works');
    } finally {
      stalled.resolve({ content: [{ type: 'text', text: 'late result' }] });
      await closing;
      await second.aclose();
    }
  });

  it('makes concurrent close callers await the same teardown', async () => {
    const result = deferred<{ content: { type: string; text: string }[] }>();
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, _schema, options) => {
        await options?.onprogress?.({ progress: 0, message: 'working' });
        return result.promise;
      }),
    });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const [lookup] = await server.listTools({ lookup: { reportProgress: true } });
    const { runCtx } = buildRunContext('lookup');
    await expect(
      toolset._executor.execute({ tool: lookup!, runCtx, rawArguments: {} }),
    ).resolves.toContain('working');

    const firstClose = toolset.aclose();
    let secondFinished = false;
    const secondClose = toolset.aclose();
    void secondClose.then(() => {
      secondFinished = true;
    });
    try {
      expect(secondClose).toBe(firstClose);
      await vi.waitFor(() => expect(secondFinished).toBe(false), { timeout: 25 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondFinished).toBe(false);
    } finally {
      result.resolve({ content: [{ type: 'text', text: 'finished' }] });
      await Promise.all([firstClose, secondClose]);
    }
  });

  it('delivers a bounded non-cancellable result before closing the MCP server', async () => {
    const result = deferred<{ content: { type: string; text: string }[] }>();
    const close = vi.fn().mockResolvedValue(undefined);
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, _schema, options) => {
        await options?.onprogress?.({ progress: 0, message: 'working' });
        return result.promise;
      }),
      close,
    });
    const toolset = new MCPToolset({
      id: 'mcp',
      mcpServer: server,
      toolOptions: { lookup: { reportProgress: true } },
    });
    const [lookup] = await server.listTools({ lookup: { reportProgress: true } });
    const { runCtx, history } = buildRunContext('lookup');

    await expect(
      toolset._executor.execute({ tool: lookup!, runCtx, rawArguments: {} }),
    ).resolves.toContain('working');

    const closing = toolset.aclose();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    result.resolve({ content: [{ type: 'text', text: 'finished' }] });
    await closing;

    expect(close).toHaveBeenCalledOnce();
    expect(history.items.some((item) => item.type === 'function_call_output')).toBe(true);
  });

  it('delivers a bounded non-cancellable resolver result before closing the MCP server', async () => {
    const resolvedResult = deferred<string>();
    const close = vi.fn().mockResolvedValue(undefined);
    const server = new TestServer({ toolResultResolver: () => resolvedResult.promise });
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, _schema, options) => {
        await options?.onprogress?.({ progress: 0, message: 'working' });
        return { content: [{ type: 'text', text: 'raw result' }] };
      }),
      close,
    });
    const toolset = new MCPToolset({
      id: 'mcp',
      mcpServer: server,
      toolOptions: { lookup: { reportProgress: true } },
    });
    const [lookup] = await server.listTools({ lookup: { reportProgress: true } });
    const { runCtx, history } = buildRunContext('lookup');

    await expect(
      toolset._executor.execute({ tool: lookup!, runCtx, rawArguments: {} }),
    ).resolves.toContain('working');

    const closing = toolset.aclose();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    resolvedResult.resolve('resolved result');
    await closing;

    expect(close).toHaveBeenCalledOnce();
    expect(
      history.items.some(
        (item) => item.type === 'function_call_output' && item.output === 'resolved result',
      ),
    ).toBe(true);
  });

  it.each([
    ['MCP error', 'not found'],
    ['SDK failure', 'MCP tool call failed unexpectedly.'],
    ['resolver failure', 'MCP tool result processing failed unexpectedly.'],
  ])('delivers a terminal %s after a progress update', async (failure, message) => {
    const server = new TestServer(
      failure === 'resolver failure'
        ? {
            toolResultResolver: () => {
              throw new Error('credential-bearing resolver failure');
            },
          }
        : {},
    );
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, _schema, options) => {
        await options?.onprogress?.({ progress: 0, message: 'working' });
        if (failure === 'SDK failure') throw new Error('credential-bearing request failure');
        return { isError: failure === 'MCP error', content: [{ type: 'text', text: 'not found' }] };
      }),
    });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const [lookup] = await server.listTools({ lookup: { reportProgress: true } });
    const { runCtx, history } = buildRunContext('lookup');

    await expect(
      toolset._executor.execute({ tool: lookup!, runCtx, rawArguments: {} }),
    ).resolves.toContain('working');
    await toolset._executor.waitForAll();
    expect(history.items.filter((item) => item.type === 'function_call_output')).toMatchObject([
      { callId: 'call_lookup_final', output: message, isError: true },
    ]);
    expect(JSON.stringify(history.items)).not.toContain('credential-bearing');
    await toolset.aclose();
  });

  it('interrupts an unbounded MCP call so shutdown can complete', async () => {
    const call = deferred<{ content: { type: string; text: string }[] }>();
    const close = vi.fn(async () => call.reject(new Error('connection closed')));
    const callTool = vi.fn(() => call.promise);
    const server = new TestServer({ clientSessionTimeout: null });
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
      close,
    });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const [lookup] = await server.listTools();
    const { runCtx } = buildRunContext('lookup');
    const execution = toolset._executor
      .execute({ tool: lookup!, runCtx, rawArguments: {} })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledOnce());

    await toolset.aclose();

    expect(close).toHaveBeenCalledOnce();
    await expect(execution).resolves.toBeInstanceOf(Error);
  });
});
