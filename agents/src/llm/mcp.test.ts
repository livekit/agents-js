// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withResolvers } from '../utils.js';
import { StopResponse } from '../voice/agent.js';
import { MCPServerHTTP } from './mcp.js';
import { TestServer, attachClient, clientMock, descriptor } from './mcp_test_helpers.js';
import { ToolError, ToolFlag } from './tool_context.js';

describe('MCPServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clientMock.client = undefined;
    clientMock.options = undefined;
  });

  it('defaults to blocking tools and applies named options independently', async () => {
    const server = new TestServer();
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({
        tools: [descriptor, { ...descriptor, name: 'book_flight' }],
      }),
      callTool,
    });
    try {
      expect(await server.listTools()).toMatchObject([
        { name: 'lookup', flags: ToolFlag.NONE, onDuplicate: 'allow' },
        { name: 'book_flight', flags: ToolFlag.NONE, onDuplicate: 'allow' },
      ]);
      const tools = await server.listTools({
        book_flight: {
          flags: ToolFlag.CANCELLABLE | ToolFlag.IGNORE_ON_ENTER,
          onDuplicate: 'reject',
        },
      });
      expect(tools).toMatchObject([
        { name: 'lookup', flags: ToolFlag.NONE, onDuplicate: 'allow' },
        {
          name: 'book_flight',
          flags: ToolFlag.CANCELLABLE | ToolFlag.IGNORE_ON_ENTER,
          onDuplicate: 'reject',
        },
      ]);
      for (const tool of tools) {
        await tool.execute(
          {},
          { ctx: {}, toolCallId: tool.name, abortSignal: new AbortController().signal },
        );
      }
      expect(callTool.mock.calls.map(([, options]) => options.onprogress)).toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      await server.aclose();
    }
  });

  it.each([undefined, false, true])(
    'forwards progress only when enabled (reportProgress: %s)',
    async (reportProgress) => {
      const server = new TestServer();
      const update = vi.fn().mockResolvedValue(undefined);
      await attachClient(server, {
        listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
        callTool: vi.fn(async (_params, options) => {
          options?.onprogress?.({ progress: 0, message: '' });
          options?.onprogress?.({ progress: 1, message: 'working' });
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      });
      try {
        const [lookup] = await server.listTools({ lookup: { reportProgress } });
        await lookup!.execute(
          {},
          { ctx: { update }, toolCallId: 'call', abortSignal: new AbortController().signal },
        );
        if (reportProgress) {
          expect(update).toHaveBeenCalledExactlyOnceWith('working');
        } else {
          expect(update).not.toHaveBeenCalled();
        }
      } finally {
        await server.aclose();
      }
    },
  );

  it('caches descriptors but rebuilds wrappers for each option set', async () => {
    const server = new TestServer();
    const listTools = vi.fn().mockResolvedValue({ tools: [descriptor] });
    await attachClient(server, { listTools });
    try {
      const [blocking] = await server.listTools();
      const [cancellable] = await server.listTools({
        lookup: { flags: ToolFlag.CANCELLABLE, reportProgress: true },
      });
      expect(listTools).toHaveBeenCalledOnce();
      expect(cancellable).not.toBe(blocking);
      expect(blocking?.flags).toBe(ToolFlag.NONE);
      expect(cancellable?.flags).toBe(ToolFlag.CANCELLABLE);

      server.invalidateCache();
      const [refreshed] = await server.listTools();
      expect(listTools).toHaveBeenCalledTimes(2);
      expect(refreshed).not.toBe(blocking);
      expect(refreshed?.flags).toBe(ToolFlag.NONE);
    } finally {
      await server.aclose();
    }
  });

  it.each([undefined, {}])('omits absent or empty descriptor metadata: %j', async (_meta) => {
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [{ ...descriptor, _meta }] }),
    });
    try {
      const [lookup] = await server.listTools();
      expect(lookup).not.toHaveProperty('meta');
    } finally {
      await server.aclose();
    }
  });

  it('closes a client that connects after shutdown starts', async () => {
    const connection = withResolvers<void>();
    let resourceActive = false;
    const client = {
      connect: vi.fn(async () => {
        await connection.promise;
        resourceActive = true;
      }),
      close: vi.fn(async () => {
        resourceActive = false;
      }),
    };
    clientMock.client = client;
    const server = new TestServer();

    const initializing = expect(server.initialize()).rejects.toThrow(
      'MCP server closed during initialization',
    );
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    await server.aclose();
    await initializing;
    expect(client.close).toHaveBeenCalledOnce();
    expect(server.initialized).toBe(false);

    connection.resolve();
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(2));
    expect(resourceActive).toBe(false);
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
    const firstConnection = withResolvers<void>();
    const firstClient = {
      connect: vi.fn(() => firstConnection.promise),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientMock.client = firstClient;
    const server = new TestServer();

    const firstInitialization = expect(server.initialize()).rejects.toThrow(
      'MCP server closed during initialization',
    );
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
    const connection = withResolvers<void>();
    const close = vi.fn(async () => connection.resolve());
    const client = {
      connect: vi.fn(() => connection.promise),
      close,
    };
    clientMock.client = client;
    const server = new TestServer();

    const initializing = expect(server.initialize()).rejects.toThrow(
      'MCP server closed during initialization',
    );
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    const closing = server.aclose();
    const closeCountWhileConnecting = close.mock.calls.length;
    await Promise.all([initializing, closing]);

    expect(closeCountWhileConnecting).toBe(1);
    expect(close).toHaveBeenCalledTimes(2);
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
    { type: 'object', properties: { query: { prefixItems: [{ type: 42 }] } } },
    { type: 'object', properties: { query: { unevaluatedProperties: 'no' } } },
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
    {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      type: 'object',
      properties: { query: { type: 'string' } },
      unevaluatedProperties: false,
    },
    {
      type: 'object',
      properties: { query: { type: 'array', prefixItems: [{ type: 'string' }], items: false } },
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

    expect(callTool.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it('logs only safe metadata when reporting progress fails', async () => {
    const server = new TestServer();
    const warn = server.spyOnWarn();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, options) => {
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

  it.each([new ToolError('Please provide an order ID'), new StopResponse()])(
    'preserves an intentional resolver %s whether returned or thrown',
    async (error) => {
      for (const returned of [false, true]) {
        const server = new TestServer({
          toolResultResolver: async () => {
            if (returned) return error;
            throw error;
          },
        });
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
        ).rejects.toBe(error);
        expect(server.initialized).toBe(true);
        await server.aclose();
      }
    },
  );

  it.each([null, 0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
    'rejects an unsupported clientSessionTimeout (%s)',
    (clientSessionTimeout) => {
      expect(
        () => new TestServer({ clientSessionTimeout: clientSessionTimeout as number }),
      ).toThrow('clientSessionTimeout must be an integer from 1 to 2147483647 milliseconds');
    },
  );

  it.each([undefined, 2000])(
    'applies the configured timeout to every request (%s)',
    async (timeout) => {
      const connect = vi.fn().mockResolvedValue(undefined);
      const listTools = vi.fn().mockResolvedValue({ tools: [descriptor] });
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const server = new TestServer({ clientSessionTimeout: timeout });
      await attachClient(server, { connect, listTools, callTool });
      const [lookup] = await server.listTools();
      await lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'call', abortSignal: new AbortController().signal },
      );
      for (const request of [connect, listTools, callTool]) {
        expect(request.mock.calls[0]?.[1]).toMatchObject({ timeout: timeout ?? 5000 });
      }
      await server.aclose();
    },
  );

  it.each([
    { name: 'ProtocolError', code: -32602 },
    { name: 'SdkError', code: 'INVALID_RESULT' },
  ])('does not disconnect for non-connection SDK errors %j', async (errorType) => {
    const error = Object.assign(new Error('remote database connection closed'), errorType);
    const server = new TestServer();
    const close = vi.fn().mockResolvedValue(undefined);
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn().mockRejectedValue(error),
      close,
    });
    const [lookup] = await server.listTools();
    await expect(
      lookup!.execute(
        {},
        {
          ctx: {},
          toolCallId: 'call',
          abortSignal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('MCP tool call failed unexpectedly.');
    expect(server.initialized).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('resets the client after an MCP SDK connection error', async () => {
    const sdkConnectionError = Object.assign(new Error('opaque transport failure'), {
      name: 'SdkError',
      code: 'CONNECTION_CLOSED',
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
    expect(options.versionNegotiation).toEqual({ mode: 'auto' });
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
    const firstPage = withResolvers<{ tools: (typeof descriptor)[] }>();
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

  it('matches Python by treating an empty allowed-tools list as no filter', async () => {
    const server = new MCPServerHTTP({ url: 'https://example.com/mcp', allowedTools: [] });
    await attachClient(server, { listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }) });

    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['lookup']);
  });

  it.each([
    ['/mcp', 'streamable_http'],
    ['/MCP', 'streamable_http'],
    ['/nested/McP///?key=value', 'streamable_http'],
    ['/sse/', 'sse'],
    ['/other', 'sse'],
  ] as const)('infers %s as %s transport', (path, transportType) => {
    const server = new MCPServerHTTP({ url: `https://example.com${path}` });
    expect(server.transportType).toBe(transportType);
  });

  it('uses an explicit transport instead of URL inference', () => {
    const server = new MCPServerHTTP({
      url: 'https://example.com/MCP///',
      transportType: 'sse',
    });
    expect(server.transportType).toBe('sse');
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
});
