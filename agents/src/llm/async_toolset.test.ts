// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { delay } from '../utils.js';
import type { AgentSession } from '../voice/agent_session.js';
import type { RunContext } from '../voice/run_context.js';
import { type AsyncToolOptions, AsyncToolset } from './async_toolset.js';
import { ChatContext, FunctionCall, type FunctionCallOutput } from './chat_context.js';
import { tool } from './tool_context.js';

type TestAgent = {
  readonly chatCtx: ChatContext;
  updateChatCtx: (nextChatCtx: ChatContext) => Promise<void>;
};

type TestSession = {
  agentState: 'listening';
  currentAgent: TestAgent;
  generateReply: ReturnType<typeof vi.fn>;
  _toolItemsAdded: (items: (FunctionCall | FunctionCallOutput)[]) => void;
};

function createRunContext(callId: string, name: string, session: TestSession): RunContext {
  return {
    session: session as unknown as AgentSession,
    speechHandle: { id: 'speech_test', allowInterruptions: true },
    functionCall: FunctionCall.create({
      callId,
      name,
      args: '{}',
    }),
  } as unknown as RunContext;
}

function createSession(): TestSession {
  let chatCtx = ChatContext.empty();
  const generateReply = vi.fn();
  const agent = {
    get chatCtx() {
      return chatCtx;
    },
    updateChatCtx: async (nextChatCtx: ChatContext) => {
      chatCtx = nextChatCtx;
    },
  };

  return {
    agentState: 'listening',
    currentAgent: agent,
    generateReply,
    _toolItemsAdded: () => {},
  };
}

describe('AsyncToolset', () => {
  it('returns the first update immediately and delivers the final output later', async () => {
    const session = createSession();
    const asyncToolset = new AsyncToolset({
      tools: {
        long_task: tool({
          description: 'Long task',
          parameters: z.object({}),
          execute: async (_, { ctx }: AsyncToolOptions) => {
            await ctx.update('started');
            await delay(10);
            return 'finished';
          },
        }),
      },
    });

    const result = await asyncToolset.tools.long_task!.execute(
      {},
      {
        ctx: createRunContext('call_async', 'long_task', session),
        toolCallId: 'call_async',
      },
    );

    expect(result).toContain('started');

    await vi.waitFor(() => {
      expect(session.currentAgent.chatCtx.items).toHaveLength(2);
      expect(session.generateReply).toHaveBeenCalledOnce();
    });

    expect(session.currentAgent.chatCtx.items[0]?.type).toBe('function_call');
    expect(session.currentAgent.chatCtx.items[1]?.type).toBe('function_call_output');
  });

  it('rejects duplicate calls when configured', async () => {
    const session = createSession();
    const asyncToolset = new AsyncToolset({
      onDuplicateCall: 'reject',
      tools: {
        long_task: tool({
          description: 'Long task',
          parameters: z.object({}),
          execute: async (_, { ctx }: AsyncToolOptions) => {
            await ctx.update('running');
            await delay(50);
            return 'done';
          },
        }),
      },
    });

    await asyncToolset.tools.long_task!.execute(
      {},
      {
        ctx: createRunContext('call_one', 'long_task', session),
        toolCallId: 'call_one',
      },
    );

    const duplicate = await asyncToolset.tools.long_task!.execute(
      {},
      {
        ctx: createRunContext('call_two', 'long_task', session),
        toolCallId: 'call_two',
      },
    );

    expect(duplicate).toContain('Same tool `long_task` is already running');
  });

  it('exposes running task cancellation', async () => {
    const session = createSession();
    const asyncToolset = new AsyncToolset({
      tools: {
        long_task: tool({
          description: 'Long task',
          parameters: z.object({}),
          execute: async (_, { ctx, abortSignal }: AsyncToolOptions) => {
            await ctx.update('running');
            await delay(1000, { signal: abortSignal });
            return 'done';
          },
        }),
      },
    });

    await asyncToolset.tools.long_task!.execute(
      {},
      {
        ctx: createRunContext('call_cancel', 'long_task', session),
        toolCallId: 'call_cancel',
      },
    );

    const result = await asyncToolset.tools.cancel_task!.execute(
      { call_id: 'call_cancel' },
      {
        ctx: createRunContext('call_cancel_tool', 'cancel_task', session),
        toolCallId: 'call_cancel_tool',
      },
    );

    expect(result).toBe('Task call_cancel cancelled successfully.');
  });
});
