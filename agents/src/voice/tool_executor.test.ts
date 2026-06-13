// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import { ToolFlag, tool } from '../llm/tool_context.js';
import { Future } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { RunContext } from './run_context.js';
import { SpeechHandle } from './speech_handle.js';
import { ToolExecutor, getRunningTasks } from './tool_executor.js';

describe('ToolExecutor', () => {
  function buildRunContext(name: string = 'slow_lookup', callId: string = `call_${name}`) {
    const functionCall = FunctionCall.create({
      callId,
      name,
      args: '{"query":"flights"}',
    });
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
    const speechHandle = SpeechHandle.create();
    return {
      runCtx: new RunContext(session, speechHandle, functionCall),
      history,
      agent,
    };
  }

  it('preserves blocking tool return semantics when no update is sent', async () => {
    const executor = new ToolExecutor();
    const { runCtx } = buildRunContext('blocking_lookup');
    const lookup = tool({
      name: 'blocking_lookup',
      description: 'Blocking lookup',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => `result:${query}`,
    });

    const result = await executor.execute({
      tool: lookup,
      runCtx,
      rawArguments: { query: 'flights' },
    });

    expect(result).toBe('result:flights');
  });

  it('returns on first update and later enqueues final return', async () => {
    const executor = new ToolExecutor();
    const { runCtx, history, agent } = buildRunContext('async_lookup');
    const releaseFinal = new Future<void>();
    const lookup = tool({
      name: 'async_lookup',
      description: 'Async lookup',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }, { ctx }) => {
        await ctx.update(`started:${query}`);
        await releaseFinal.await;
        return `final:${query}`;
      },
    });

    const resultPromise = executor.execute({
      tool: lookup,
      runCtx,
      rawArguments: { query: 'flights' },
    });

    await expect(resultPromise).resolves.toContain('started:flights');
    expect(runCtx.functionCall.extra.__livekit_agents_tool_non_blocking).toBe(true);
    expect(history.items).toHaveLength(0);

    releaseFinal.resolve();
    await executor.waitForAll();

    expect(history.items.some((item) => item.type === 'function_call_output')).toBe(true);
    expect(agent.chatCtx.items.some((item) => item.type === 'function_call_output')).toBe(true);
  });

  it('rejects duplicate calls when onDuplicate is reject', async () => {
    const executor = new ToolExecutor();
    const first = buildRunContext('dedupe_lookup');
    const second = buildRunContext('dedupe_lookup');
    const neverFinish = new Future<void>();
    const lookup = tool({
      name: 'dedupe_lookup',
      description: 'Dedupe lookup',
      flags: ToolFlag.CANCELLABLE,
      onDuplicate: 'reject',
      execute: async (_, { ctx }) => {
        await ctx.update('started');
        await neverFinish.await;
        return 'done';
      },
    });

    await executor.execute({ tool: lookup, runCtx: first.runCtx, rawArguments: {} });
    const duplicate = await executor.execute({
      tool: lookup,
      runCtx: second.runCtx,
      rawArguments: {},
    });

    expect(String(duplicate)).toContain('Same tool `dedupe_lookup` is already running');

    neverFinish.resolve();
    await executor.waitForAll();
  });

  it('rejects concurrent duplicate calls when onDuplicate is reject', async () => {
    const executor = new ToolExecutor();
    const first = buildRunContext('concurrent_dedupe', 'concurrent_dedupe_1');
    const second = buildRunContext('concurrent_dedupe', 'concurrent_dedupe_2');
    const neverFinish = new Future<void>();
    const lookup = tool({
      name: 'concurrent_dedupe',
      description: 'Concurrent dedupe lookup',
      flags: ToolFlag.CANCELLABLE,
      onDuplicate: 'reject',
      execute: async (_, { ctx }) => {
        await ctx.update('started');
        await neverFinish.await;
        return 'done';
      },
    });

    const outputs = await Promise.all([
      executor.execute({ tool: lookup, runCtx: first.runCtx, rawArguments: {} }),
      executor.execute({ tool: lookup, runCtx: second.runCtx, rawArguments: {} }),
    ]);

    expect(outputs.filter((output) => String(output).includes('started'))).toHaveLength(1);
    expect(
      outputs.filter((output) =>
        String(output).includes('Same tool `concurrent_dedupe` is already running'),
      ),
    ).toHaveLength(1);

    neverFinish.resolve();
    await executor.waitForAll();
  });

  it('returns from cancel even when a cancellable tool ignores abortSignal', async () => {
    const executor = new ToolExecutor();
    const { runCtx } = buildRunContext('non_cooperative_cancel');
    const neverFinish = new Future<void>();
    const lookup = tool({
      name: 'non_cooperative_cancel',
      description: 'Non-cooperative cancellable lookup',
      flags: ToolFlag.CANCELLABLE,
      execute: async (_, { ctx }) => {
        await ctx.update('started');
        await neverFinish.await;
        return 'done';
      },
    });

    await executor.execute({ tool: lookup, runCtx, rawArguments: {} });

    const cancelled = await Promise.race([
      executor.cancel(runCtx.functionCall.callId).then(() => 'cancelled'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 25)),
    ]);

    expect(cancelled).toBe('cancelled');
    expect(getRunningTasks(runCtx.session)).toHaveLength(0);
  });

  // An abortable tool that resolves as soon as its abortSignal fires — mirrors how
  // the example tools (abortable sleep / fetch signal) honor cancellation.
  function abortableTool(name: string, started: Future<void>, stopped: Future<void>) {
    return tool({
      name,
      description: 'Abortable cancellable lookup',
      flags: ToolFlag.CANCELLABLE,
      execute: async (_, { ctx, abortSignal }) => {
        await ctx.update('started');
        started.resolve();
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) return resolve();
          abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        stopped.resolve();
        return 'done';
      },
    });
  }

  it('explicit cancel aborts the tool so an abortable execute() actually stops', async () => {
    const executor = new ToolExecutor();
    const { runCtx } = buildRunContext('abortable_cancel');
    const started = new Future<void>();
    const stopped = new Future<void>();

    await executor.execute({
      tool: abortableTool('abortable_cancel', started, stopped),
      runCtx,
      rawArguments: {},
    });
    await started.await;
    expect(stopped.done).toBe(false);

    await executor.cancel(runCtx.functionCall.callId);
    // The tool observes the abort signal and stops on its own (no deadline needed).
    await Promise.race([
      stopped.await,
      new Promise((_, reject) => setTimeout(() => reject(new Error('tool never stopped')), 1000)),
    ]);
    expect(stopped.done).toBe(true);
  });

  it('drain (handoff) aborts cancellable tools so an abortable execute() stops', async () => {
    const executor = new ToolExecutor();
    const { runCtx } = buildRunContext('abortable_drain');
    const started = new Future<void>();
    const stopped = new Future<void>();

    await executor.execute({
      tool: abortableTool('abortable_drain', started, stopped),
      runCtx,
      rawArguments: {},
    });
    await started.await;

    await executor.drain();
    await Promise.race([
      stopped.await,
      new Promise((_, reject) => setTimeout(() => reject(new Error('tool never stopped')), 1000)),
    ]);
    expect(stopped.done).toBe(true);
  });

  it('keeps running task visibility scoped to one session', async () => {
    const executor = new ToolExecutor();
    const first = buildRunContext('session_scoped_lookup');
    const second = buildRunContext('session_scoped_lookup');
    const neverFinish = new Future<void>();
    const lookup = tool({
      name: 'session_scoped_lookup',
      description: 'Session scoped lookup',
      flags: ToolFlag.CANCELLABLE,
      execute: async (_, { ctx }) => {
        await ctx.update('started');
        await neverFinish.await;
        return 'done';
      },
    });

    await executor.execute({ tool: lookup, runCtx: first.runCtx, rawArguments: {} });

    expect(getRunningTasks(first.runCtx.session)).toHaveLength(1);
    expect(getRunningTasks(second.runCtx.session)).toHaveLength(0);

    neverFinish.resolve();
    await executor.waitForAll();
  });
});
