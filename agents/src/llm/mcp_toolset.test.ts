// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withResolvers } from '../utils.js';
import { Agent } from '../voice/agent.js';
import { AgentActivity } from '../voice/agent_activity.js';
import { AgentSession } from '../voice/agent_session.js';
import { RunContext } from '../voice/run_context.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import { AsyncToolset } from './async_toolset.js';
import { FunctionCall } from './chat_context.js';
import { MCPToolset } from './mcp.js';
import { TestServer, attachClient, clientMock, descriptor } from './mcp_test_helpers.js';
import { ToolFlag, type ToolsetContext, tool } from './tool_context.js';

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

describe('MCPToolset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clientMock.client = undefined;
    clientMock.options = undefined;
  });

  it.each([false, true])('applies options during setup (configured: %s)', async (configured) => {
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({
        tools: [descriptor, { ...descriptor, name: 'book_flight' }],
      }),
    });
    const toolset = new MCPToolset({
      id: 'mcp',
      mcpServer: server,
      toolOptions: configured
        ? {
            book_flight: {
              flags: ToolFlag.CANCELLABLE,
              onDuplicate: 'confirm',
              reportProgress: true,
            },
          }
        : undefined,
    });
    try {
      expect(toolset).toBeInstanceOf(AsyncToolset);
      await toolset.setup({ updateTools: (tools) => toolset._setTools(tools) });
      expect(toolset.tools).toMatchObject([
        { name: 'lookup', flags: ToolFlag.NONE, onDuplicate: 'allow' },
        {
          name: 'book_flight',
          flags: configured ? ToolFlag.CANCELLABLE : ToolFlag.NONE,
          onDuplicate: configured ? 'confirm' : 'allow',
        },
      ]);
    } finally {
      await toolset.aclose();
    }
  });

  it('clears its tools on close without publishing to the inactive context', async () => {
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
    });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const updateTools = vi.fn<ToolsetContext['updateTools']>((tools) => toolset._setTools(tools));
    await toolset.setup({ updateTools });
    expect(toolset.tools).toMatchObject([{ name: 'lookup' }]);

    await toolset.aclose();

    expect(toolset.tools).toEqual([]);
    expect(updateTools).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'processes a refresh at publication completion (microtask offset: %i)',
    async (offset) => {
      const server = new TestServer();
      const initialTool = tool({ name: 'lookup', description: '', execute: async () => undefined });
      const latestTool = tool({
        name: 'latest_lookup',
        description: '',
        execute: async () => undefined,
      });
      let discoveredTools = [initialTool];
      vi.spyOn(server, 'initialize').mockResolvedValue(undefined);
      const listTools = vi
        .spyOn(server, 'listTools')
        .mockImplementation(async () => discoveredTools);
      const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
      const queuedRefresh = withResolvers<void>();
      const updateTools = vi.fn<ToolsetContext['updateTools']>(() => {
        if (updateTools.mock.calls.length !== 2) return;
        let publicationSettled = Promise.resolve();
        for (let tick = 0; tick < offset; tick++) {
          publicationSettled = publicationSettled.then(() => undefined);
        }
        void publicationSettled.then(() => {
          discoveredTools = [latestTool];
          void toolset.refresh().then(queuedRefresh.resolve, queuedRefresh.reject);
        });
      });

      try {
        await toolset.setup({ updateTools });
        await Promise.all([toolset.refresh(), queuedRefresh.promise]);
        expect(listTools).toHaveBeenCalledTimes(3);
        expect(updateTools.mock.lastCall?.[0].map(({ id }) => id)).toEqual(['latest_lookup']);
      } finally {
        await toolset.aclose();
      }
    },
  );

  it('reconnects a disconnected toolset on the next call and publishes fresh tools', async () => {
    const connectionError = Object.assign(new Error('connection closed'), {
      name: 'SdkError',
      code: 'CONNECTION_CLOSED',
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

  it('keeps a tool filter across refreshes and allows excluded tools to be restored', async () => {
    const listTools = vi.fn().mockResolvedValue({
      tools: [descriptor, { ...descriptor, name: 'delete_order' }],
    });
    const server = new TestServer();
    await attachClient(server, { listTools });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    expect(toolset.filterTools(({ name }) => name !== 'delete_order')).toBe(toolset);
    const context = { updateTools: vi.fn() };
    await toolset.setup(context);
    expect(
      context.updateTools.mock.lastCall?.[0].map((tool: { name: string }) => tool.name),
    ).toEqual(['lookup']);

    listTools.mockResolvedValue({
      tools: [
        descriptor,
        { ...descriptor, name: 'delete_order' },
        { ...descriptor, name: 'list_orders' },
      ],
    });
    await server.emitToolsChanged();
    expect(
      context.updateTools.mock.lastCall?.[0].map((tool: { name: string }) => tool.name),
    ).toEqual(['lookup', 'list_orders']);
    await toolset.refresh();
    expect(
      context.updateTools.mock.lastCall?.[0].map((tool: { name: string }) => tool.name),
    ).toEqual(['lookup', 'list_orders']);

    toolset.filterTools(() => true);
    expect(
      context.updateTools.mock.lastCall?.[0].map((tool: { name: string }) => tool.name),
    ).toEqual(['lookup', 'delete_order', 'list_orders']);
    expect(listTools).toHaveBeenCalledTimes(3);
    await toolset.aclose();
  });

  it.each(['success', 'failure'])(
    'reloads again when a manual refresh arrives during discovery (%s)',
    async (outcome) => {
      const stalePage = withResolvers<{ tools: (typeof descriptor)[] }>();
      const listTools = vi
        .fn()
        .mockResolvedValueOnce({ tools: [descriptor] })
        .mockReturnValueOnce(stalePage.promise)
        .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'latest_lookup' }] });
      const server = new TestServer();
      await attachClient(server, { listTools });
      const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
      const context = { updateTools: vi.fn() };
      await toolset.setup(context);
      const firstRefresh = toolset.refresh();
      await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(2));
      const secondRefresh = toolset.refresh();
      if (outcome === 'success') {
        stalePage.resolve({ tools: [{ ...descriptor, name: 'stale_lookup' }] });
      } else {
        stalePage.reject(new Error('discovery failed'));
      }
      await Promise.all([firstRefresh, secondRefresh]);
      expect(context.updateTools.mock.lastCall?.[0][0]?.name).toBe('latest_lookup');
      expect(listTools).toHaveBeenCalledTimes(3);
      await toolset.aclose();
    },
  );

  it('rejects concurrent refreshes when the final discovery fails', async () => {
    const pendingPage = withResolvers<{ tools: (typeof descriptor)[] }>();
    const lastError = new Error('latest discovery failed');
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor] })
      .mockReturnValueOnce(pendingPage.promise)
      .mockRejectedValueOnce(lastError)
      .mockResolvedValueOnce({ tools: [{ ...descriptor, name: 'latest_lookup' }] });
    const server = new TestServer();
    await attachClient(server, { listTools });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const context = { updateTools: vi.fn() };
    await toolset.setup(context);
    const firstRefresh = toolset.refresh();
    await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(2));
    const secondRefresh = toolset.refresh();
    const results = Promise.allSettled([firstRefresh, secondRefresh]);
    pendingPage.reject(new Error('first discovery failed'));
    expect(await results).toEqual([
      { status: 'rejected', reason: lastError },
      { status: 'rejected', reason: lastError },
    ]);
    expect(listTools).toHaveBeenCalledTimes(3);
    expect(context.updateTools).toHaveBeenCalledOnce();

    await toolset.refresh();
    expect(context.updateTools.mock.lastCall?.[0][0]?.name).toBe('latest_lookup');
    expect(listTools).toHaveBeenCalledTimes(4);
    await toolset.aclose();
  });

  it('does not publish a refresh that finishes after close', async () => {
    const pendingPage = withResolvers<{ tools: (typeof descriptor)[] }>();
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor] })
      .mockReturnValueOnce(pendingPage.promise);
    const server = new TestServer();
    await attachClient(server, { listTools });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    await expect(toolset.refresh()).rejects.toThrow('MCPToolset is not active');
    const context = { updateTools: vi.fn() };
    await toolset.setup(context);
    const refreshing = toolset.refresh();
    await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(2));
    const closing = toolset.aclose();
    pendingPage.resolve({ tools: [{ ...descriptor, name: 'late_lookup' }] });
    await Promise.all([closing, refreshing]);
    expect(context.updateTools).toHaveBeenCalledOnce();
    await expect(toolset.refresh()).rejects.toThrow('MCPToolset is not active');
  });

  it('does not update a stale context when setup follows an in-flight close', async () => {
    const firstPage = withResolvers<{ tools: (typeof descriptor)[] }>();
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

  it('keeps a shared server connected when one toolset closes', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'still available' }] });
    const server = new TestServer();
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
  });

  it('waits for the final shared-server shutdown before a new toolset connects', async () => {
    const oldClose = withResolvers<void>();
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

  it('cancels a shared toolset call without disconnecting another owner', async () => {
    const stalled = withResolvers<{ content: { type: string; text: string }[] }>();
    const callTool = vi
      .fn()
      .mockImplementationOnce(async (_params, options) => {
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
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
      close,
    });
    const first = new MCPToolset({
      id: 'first',
      mcpServer: server,
      toolOptions: { lookup: { reportProgress: true, flags: ToolFlag.CANCELLABLE } },
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
    const result = withResolvers<{ content: { type: string; text: string }[] }>();
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, options) => {
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
    const result = withResolvers<{ content: { type: string; text: string }[] }>();
    const close = vi.fn().mockResolvedValue(undefined);
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, options) => {
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
    const resolvedResult = withResolvers<string>();
    const close = vi.fn().mockResolvedValue(undefined);
    const server = new TestServer({ toolResultResolver: () => resolvedResult.promise });
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool: vi.fn(async (_params, options) => {
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
      callTool: vi.fn(async (_params, options) => {
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

  it('interrupts a cancellable MCP call so shutdown can complete', async () => {
    const call = withResolvers<{ content: { type: string; text: string }[] }>();
    const close = vi.fn(async () => call.reject(new Error('connection closed')));
    const callTool = vi.fn(() => call.promise);
    const server = new TestServer();
    await attachClient(server, {
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor] }),
      callTool,
      close,
    });
    const toolset = new MCPToolset({ id: 'mcp', mcpServer: server });
    const [lookup] = await server.listTools({ lookup: { flags: ToolFlag.CANCELLABLE } });
    const { runCtx } = buildRunContext('lookup');
    const execution = toolset._executor
      .execute({ tool: lookup!, runCtx, rawArguments: {} })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledOnce());

    await toolset.aclose();

    expect(close).toHaveBeenCalledOnce();
    await expect(execution).resolves.toBeUndefined();
    expect(toolset._executor.hasRunningTasks).toBe(false);
  });
});
