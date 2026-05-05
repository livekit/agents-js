// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { delay } from '../utils.js';
import type { AgentSession } from '../voice/agent_session.js';
import { performToolExecutions } from '../voice/generation.js';
import { RunContext } from '../voice/run_context.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import { AsyncRunContext, AsyncToolset } from './async_toolset.js';
import { ChatContext, FunctionCall } from './chat_context.js';
import { tool } from './tool_context.js';

function createFunctionCallStream(functionCall: FunctionCall): ReadableStream<FunctionCall> {
  return new NodeReadableStream<FunctionCall>({
    start(controller) {
      controller.enqueue(functionCall);
      controller.close();
    },
  });
}

function createFakeSession() {
  let chatCtx = ChatContext.empty();
  const waitForInactive = vi.fn(async () => {});
  const generateReply = vi.fn();
  const agent = {
    get chatCtx() {
      return chatCtx;
    },
    updateChatCtx: vi.fn(async (nextChatCtx: ChatContext) => {
      chatCtx = nextChatCtx;
    }),
  };
  const session = {
    get currentAgent() {
      return agent;
    },
    get userData() {
      return {};
    },
    waitForInactive,
    generateReply,
  };

  return { agent, generateReply, session: session as unknown as AgentSession, waitForInactive };
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('timed out waiting for condition');
}

describe('AsyncToolset source parity', () => {
  const mockTool1 = tool({
    description: 'first mock tool',
    parameters: z.object({ arg1: z.string() }),
    execute: async ({ arg1 }) => `arg1: ${arg1}`,
  });

  const mockTool2 = tool({
    description: 'second mock tool',
    parameters: z.object({ arg1: z.string() }),
    execute: async ({ arg1 }) => `arg1: ${arg1}`,
  });

  it('two async toolsets share singleton management tools without conflict', () => {
    const ts1 = new AsyncToolset({ id: 'booking', tools: { mockTool1 } });
    const ts2 = new AsyncToolset({ id: 'search', tools: { mockTool2 } });

    const ctx = { ...ts1.toolCtx, ...ts2.toolCtx };
    const names = Object.keys(ctx);

    expect(names.filter((name) => name === 'getRunningTasks')).toHaveLength(1);
    expect(names.filter((name) => name === 'cancelTask')).toHaveLength(1);
  });

  it('two async toolsets with the same id do not conflict', () => {
    const ts1 = new AsyncToolset({ id: 'same_id', tools: { mockTool1 } });
    const ts2 = new AsyncToolset({ id: 'same_id', tools: { mockTool2 } });

    const ctx = { ...ts1.toolCtx, ...ts2.toolCtx };
    const names = Object.keys(ctx);

    expect(names.filter((name) => name === 'getRunningTasks')).toHaveLength(1);
    expect(names.filter((name) => name === 'cancelTask')).toHaveLength(1);
  });
});

describe('AsyncToolset runtime integration', () => {
  it('returns from tool execution after the first update while the tool continues running', async () => {
    const { agent, generateReply, session, waitForInactive } = createFakeSession();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let finalReturnReached = false;

    const bookFlight = tool({
      description: 'book a flight',
      parameters: z.object({}),
      execute: async (_, { ctx }) => {
        await (ctx as AsyncRunContext).update('Looking up flights.');
        await finished;
        finalReturnReached = true;
        return 'Flight booked.';
      },
    });

    const toolset = new AsyncToolset({ id: 'travel', tools: { bookFlight } });
    const speechHandle = SpeechHandle.create();
    const functionCall = FunctionCall.create({
      callId: 'call_1',
      name: 'bookFlight',
      args: '{}',
    });

    const [execTask, toolOutput] = performToolExecutions({
      session,
      speechHandle,
      toolCtx: toolset.toolCtx,
      toolCallStream: createFunctionCallStream(functionCall),
      controller: new AbortController(),
    });

    await execTask.result;

    expect(finalReturnReached).toBe(false);
    expect(toolOutput.output).toHaveLength(1);
    expect(toolOutput.output[0]?.toolCallOutput?.output).toContain('Looking up flights.');

    finish();
    await waitFor(() => generateReply.mock.calls.length === 1);

    expect(agent.chatCtx.items.some((item) => item.type === 'function_call')).toBe(true);
    expect(
      agent.chatCtx.items.some(
        (item) => item.type === 'function_call_output' && item.callId === 'call_1/finished',
      ),
    ).toBe(true);
    expect(waitForInactive).toHaveBeenCalledTimes(1);
    expect(generateReply).toHaveBeenCalledWith({
      instructions: expect.stringContaining('call_1/finished'),
      toolChoice: 'none',
    });

    await toolset.aclose();
  });

  it('lists and cancels a running background tool', async () => {
    const { session } = createFakeSession();
    let aborted = false;

    const slowTool = tool({
      description: 'slow background tool',
      parameters: z.object({}),
      execute: async (_, { ctx, abortSignal }) => {
        await (ctx as AsyncRunContext).update('Started slow work.');
        await new Promise<void>((resolve) => {
          abortSignal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    });

    const toolset = new AsyncToolset({ id: 'slow', tools: { slowTool } });
    const speechHandle = SpeechHandle.create();
    const functionCall = FunctionCall.create({
      callId: 'call_cancel',
      name: 'slowTool',
      args: '{}',
    });

    const [execTask] = performToolExecutions({
      session,
      speechHandle,
      toolCtx: toolset.toolCtx,
      toolCallStream: createFunctionCallStream(functionCall),
      controller: new AbortController(),
    });
    await execTask.result;

    const managementCtx = new RunContext(
      session,
      speechHandle,
      FunctionCall.create({ callId: 'management', name: 'getRunningTasks', args: '{}' }),
    );
    const running = await toolset.toolCtx.getRunningTasks.execute(
      {},
      { ctx: managementCtx, toolCallId: 'management' },
    );

    expect(Array.isArray(running)).toBe(true);
    expect(JSON.stringify(running)).toContain('call_cancel');

    const cancelResult = await toolset.toolCtx.cancelTask.execute(
      { callId: 'call_cancel' },
      { ctx: managementCtx, toolCallId: 'management' },
    );

    expect(cancelResult).toContain('cancelled successfully');
    await waitFor(() => aborted);

    const remaining = await toolset.toolCtx.getRunningTasks.execute(
      {},
      { ctx: managementCtx, toolCallId: 'management' },
    );
    expect(remaining).toEqual([]);

    await toolset.aclose();
  });
});
