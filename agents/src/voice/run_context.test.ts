// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import { Future } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { RunContext } from './run_context.js';
import { SpeechHandle } from './speech_handle.js';

describe('RunContext async updates', () => {
  function buildContext() {
    const functionCall = FunctionCall.create({
      callId: 'call_123',
      name: 'slow_lookup',
      args: '{"query":"flights"}',
    });
    const speechHandle = SpeechHandle.create();
    const session = { userData: { userId: 'user_1' } } as unknown as AgentSession<{
      userId: string;
    }>;
    const ctx = new RunContext(session, speechHandle, functionCall);
    return { ctx, functionCall };
  }

  it('first update resolves dispatch and later updates enqueue deferred replies', async () => {
    const { ctx, functionCall } = buildContext();
    const firstUpdate = new Future<unknown>();
    const enqueued: Array<[FunctionCall, FunctionCallOutput]> = [];

    ctx._attachExecutor(
      {
        toolOptions: {
          updateTemplate: 'Tool {functionName} update for {callId}: {message}',
        },
        enqueueReply: async (_ctx, items) => {
          enqueued.push(items as [FunctionCall, FunctionCallOutput]);
        },
      },
      firstUpdate,
    );

    await ctx.update('started');

    expect(await firstUpdate.await).toBe('Tool slow_lookup update for call_123: started');
    expect(functionCall.extra.__livekit_agents_tool_non_blocking).toBe(true);
    expect(enqueued).toHaveLength(0);

    await ctx.update('halfway');

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]![0].callId).toBe('call_123_update_1');
    expect(enqueued[0]![0].name).toBe('slow_lookup');
    expect(enqueued[0]![1].callId).toBe('call_123_update_1');
    expect(enqueued[0]![1].output).toContain('halfway');
  });

  it('detached contexts record updates without enqueueing replies', async () => {
    const { ctx } = buildContext();

    await ctx.update('standalone');

    expect(ctx.updates).toHaveLength(1);
    expect(ctx.updates[0]![0].callId).toBe('call_123');
    expect(ctx.updates[0]![1].output).toContain('standalone');
  });
});
