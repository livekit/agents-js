// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../voice/agent_session.js';
import { RunContext } from '../voice/run_context.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import { ChatContext, FunctionCall } from './chat_context.js';
import { MCPServer, MCPServerHTTP, MCPToolset } from './mcp.js';
import { ToolError } from './tool_context.js';

const clientMock = vi.hoisted(() => ({
  client: undefined as unknown,
  options: undefined as unknown,
}));

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
  const history = new ChatContext();
  const agent = {
    chatCtx: ChatContext.empty(),
    async updateChatCtx(chatCtx: ChatContext) {
      this.chatCtx = chatCtx;
    },
  };
  const session = {
    userData: {},
    history,
    currentAgent: agent,
    _globalRunState: undefined,
    async waitForIdle() {
      return { agent };
    },
    generateReply: () => ({ id: 'speech_reply', addDoneCallback: () => {} }),
  } as unknown as AgentSession;
  return {
    runCtx: new RunContext(session, SpeechHandle.create(), functionCall),
    history,
  };
}

class TestServer extends MCPServer {
  protected override async createTransport(): Promise<unknown> {
    return {};
  }

  setClient(client: unknown): void {
    (this as unknown as { client: unknown }).client = client;
  }

  async emitToolsChanged(): Promise<void> {
    await this.notifyToolsChanged();
  }

  setLogger(logger: unknown): void {
    (this as unknown as { logger: unknown }).logger = logger;
  }
}

describe('MCPServer', () => {
  afterEach(() => {
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
    const warn = vi.fn();
    const laterListener = vi.fn();
    const server = new TestServer();
    server.setLogger({ warn });
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
    server.setClient({
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    });

    const [lookup] = await server.listTools();
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'call', abortSignal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('forwards cancellation to the MCP SDK request', async () => {
    const server = new TestServer();
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    server.setClient({ listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }), callTool });
    const controller = new AbortController();

    const [lookup] = await server.listTools();
    await lookup!.execute({}, { ctx: {}, toolCallId: 'call', abortSignal: controller.signal });

    expect(callTool.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('logs only safe metadata when reporting progress fails', async () => {
    const warn = vi.fn();
    const server = new TestServer();
    server.setLogger({ warn });
    server.setClient({
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
    const warn = vi.fn();
    const server = new TestServer();
    server.setLogger({ warn });
    server.setClient({ close: vi.fn().mockRejectedValue(new Error('secret bearer credential')) });

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
    server.setClient({ listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }), callTool });

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
    server.setClient({ listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }), callTool });

    const [lookup] = await server.listTools();
    const error = await lookup!
      .execute({}, { ctx: {}, toolCallId: 'first', abortSignal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe('MCP tool call failed unexpectedly.');
    expect(error).not.toHaveProperty('cause');
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
      ),
    ).resolves.toBe(JSON.stringify({ type: 'text', text: 'ok' }));

    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('wraps a result resolver error without disconnecting the client', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const server = new TestServer({
      toolResultResolver: () => {
        throw new Error('resolver failed with bearer secret');
      },
    });
    server.setClient({ listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }), callTool });

    const [lookup] = await server.listTools();
    const error = await lookup!
      .execute({}, { ctx: {}, toolCallId: 'first', abortSignal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe('MCP tool result processing failed unexpectedly.');
    expect(error).not.toHaveProperty('cause');
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'second', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('MCP tool result processing failed unexpectedly.');

    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('wraps an Error returned by a result resolver', async () => {
    const server = new TestServer({
      toolResultResolver: () => new Error('returned error with bearer secret'),
    });
    server.setClient({
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    });

    const [lookup] = await server.listTools();
    await expect(
      lookup!.execute(
        {},
        { ctx: {}, toolCallId: 'call', abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('MCP tool result processing failed unexpectedly.');
  });

  it('resets the client after an MCP SDK connection error', async () => {
    const sdkConnectionError = Object.assign(new Error('connection closed'), {
      name: 'McpError',
      code: -32000,
    });
    const server = new TestServer();
    const close = vi.fn().mockResolvedValue(undefined);
    server.setClient({
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

    const options = clientMock.options as {
      listChanged?: { tools?: { autoRefresh?: boolean; onChanged: () => void } };
    };
    expect(options.listChanged?.tools?.autoRefresh).toBe(false);
    options.listChanged?.tools?.onChanged();

    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
  });

  it('invalidates cached descriptors when tools change', async () => {
    const server = new TestServer();
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor] })
      .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'new_lookup' }] });
    server.setClient({ listTools, callTool: vi.fn() });

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
    server.setClient({ listTools, callTool: vi.fn() });

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
    server.setClient({ listTools, callTool: vi.fn() });

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
    server.setClient(oldClient);

    const listing = server.listTools();
    await vi.waitFor(() => expect(oldClient.listTools).toHaveBeenCalledOnce());
    await server.aclose();
    firstPage.resolve({ tools: [descriptor], nextCursor: 'page-2' });

    expect((await listing).map((tool) => tool.name)).toEqual(['lookup', 'old_search']);

    const newListTools = vi
      .fn()
      .mockResolvedValue({ tools: [{ ...descriptor, name: 'new_lookup' }] });
    server.setClient({ listTools: newListTools });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(['new_lookup']);
    expect(newListTools).toHaveBeenCalledOnce();
  });

  it('matches Python by treating an empty allowed-tools list as no filter', async () => {
    const server = new MCPServerHTTP({ url: 'https://example.com/mcp', allowedTools: [] });
    (server as unknown as { client: unknown }).client = {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
    };

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
    server.setClient({
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

    server.setClient({
      listTools: vi.fn().mockResolvedValue({ tools: [{ ...descriptor, name: 'new_lookup' }] }),
    });
    await toolset.setup(secondContext);

    expect(firstContext.updateTools).not.toHaveBeenCalled();
    expect(secondContext.updateTools).toHaveBeenCalledOnce();
    expect(secondContext.updateTools.mock.calls[0]?.[0][0]?.name).toBe('new_lookup');
  });

  it('delivers a bounded non-cancellable result before closing the MCP server', async () => {
    const result = deferred<{ content: { type: string; text: string }[] }>();
    const close = vi.fn().mockResolvedValue(undefined);
    const server = new TestServer();
    server.setClient({
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
    server.setClient({
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

  it('interrupts an unbounded MCP call so shutdown can complete', async () => {
    const call = deferred<{ content: { type: string; text: string }[] }>();
    const close = vi.fn(async () => call.reject(new Error('connection closed')));
    const callTool = vi.fn(() => call.promise);
    const server = new TestServer({ clientSessionTimeout: null });
    server.setClient({
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
