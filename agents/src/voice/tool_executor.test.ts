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
  function buildRunContext(name: string = 'slow_lookup') {
    const functionCall = FunctionCall.create({
      callId: `call_${name}`,
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
