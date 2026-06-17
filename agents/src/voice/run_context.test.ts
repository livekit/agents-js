// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FunctionCall, type FunctionCallOutput } from '../llm/chat_context.js';
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

describe('RunContext filler', () => {
  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildContext() {
    const functionCall = FunctionCall.create({
      callId: 'call_123',
      name: 'slow_lookup',
      args: '{"query":"flights"}',
    });
    const speechHandle = SpeechHandle.create();
    const session = new FakeFillerSession();
    const ctx = new RunContext(
      session as unknown as AgentSession<unknown>,
      speechHandle,
      functionCall,
    );
    return { ctx, session };
  }

  it('speaks filler after the session stays idle for the delay', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('Still searching.', { delay: 10 }, async () => {
      await sleep(30);
    });

    expect(session.sayTexts).toEqual(['Still searching.']);
  });

  it('cancels pending filler when the scope exits before the delay', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('Too late.', { delay: 50 }, async () => {
      await sleep(5);
    });

    expect(session.sayTexts).toEqual([]);
  });

  it('restarts the idle dwell when update takes the floor', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('Still working.', { delay: 30 }, async () => {
      await sleep(20);
      await ctx.update('halfway');
      await sleep(20);
      expect(session.sayTexts).toEqual([]);
      await sleep(20);
    });

    expect(session.sayTexts).toEqual(['Still working.']);
  });
});

class FakeFillerSession extends EventEmitter {
  userData = {};
  sayTexts: string[] = [];

  async waitForIdle(): Promise<void> {
    return;
  }

  say(text: string): SpeechHandle {
    this.sayTexts.push(text);
    const handle = SpeechHandle.create();
    handle._markDone();
    return handle;
  }
}
