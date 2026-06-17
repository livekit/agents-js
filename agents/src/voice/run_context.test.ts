// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FunctionCall, type FunctionCallOutput } from '../llm/chat_context.js';
import { Future } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
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

  it('does not let scheduler shutdown errors replace the callback result', async () => {
    const functionCall = FunctionCall.create({
      callId: 'call_123',
      name: 'slow_lookup',
      args: '{"query":"flights"}',
    });
    const speechHandle = SpeechHandle.create();
    const session = new FakeFillerSession({
      waitForIdleError: new Error('AgentSession is closing'),
    });
    const ctx = new RunContext(
      session as unknown as AgentSession<unknown>,
      speechHandle,
      functionCall,
    );

    await expect(ctx.filler('Still searching.', async () => 'lookup result')).resolves.toBe(
      'lookup result',
    );
  });

  it('does not create filler when maxSteps is zero', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('Disabled.', { delay: 0, interval: 1, maxSteps: 0 }, async () => {
      await sleep(20);
    });

    expect(session.sayTexts).toEqual([]);
  });

  it('repeats filler on an interval until maxSteps is reached', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('Still working.', { delay: 0, interval: 5, maxSteps: 3 }, async () => {
      await sleep(40);
    });

    expect(session.sayTexts).toEqual(['Still working.', 'Still working.', 'Still working.']);
  });

  it('invokes callable sources lazily and only advances step for created speeches', async () => {
    const { ctx, session } = buildContext();
    const steps: number[] = [];

    await ctx.filler(
      (step) => {
        steps.push(step);
        return steps.length === 1 ? null : `step ${step}`;
      },
      { delay: 0, interval: 5, maxSteps: 1 },
      async () => {
        expect(steps).toEqual([]);
        await sleep(25);
      },
    );

    expect(steps).toEqual([0, 0]);
    expect(session.sayTexts).toEqual(['step 0']);
  });

  it('accepts SpeechHandle sources without calling session.say', async () => {
    const { ctx, session } = buildContext();
    const fillerHandle = SpeechHandle.create();
    fillerHandle._markDone();

    await ctx.filler(
      () => fillerHandle,
      { delay: 0 },
      async () => {
        await sleep(10);
      },
    );

    expect(session.sayTexts).toEqual([]);
  });

  it('honors an external abort signal before the dwell completes', async () => {
    const { ctx, session } = buildContext();
    const abortController = new AbortController();

    await ctx.filler('Cancelled.', { delay: 30, signal: abortController.signal }, async () => {
      await sleep(10);
      abortController.abort();
      await sleep(30);
    });

    expect(session.sayTexts).toEqual([]);
  });

  it('honors an already-aborted external signal', async () => {
    const { ctx, session } = buildContext();
    const abortController = new AbortController();
    abortController.abort();

    await ctx.filler(
      'Already cancelled.',
      { delay: 0, signal: abortController.signal },
      async () => {
        await sleep(10);
      },
    );

    expect(session.sayTexts).toEqual([]);
  });

  it('exits promptly while still waiting for the session to become idle', async () => {
    const functionCall = FunctionCall.create({
      callId: 'call_123',
      name: 'slow_lookup',
      args: '{"query":"flights"}',
    });
    const speechHandle = SpeechHandle.create();
    const session = new FakeFillerSession({ waitForIdleNeverResolves: true });
    const ctx = new RunContext(
      session as unknown as AgentSession<unknown>,
      speechHandle,
      functionCall,
    );

    await expect(
      ctx.filler('Still waiting.', { delay: 0 }, async () => {
        await sleep(5);
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(session.sayTexts).toEqual([]);
  });

  it('does not let session.say shutdown errors replace the callback result', async () => {
    const functionCall = FunctionCall.create({
      callId: 'call_123',
      name: 'slow_lookup',
      args: '{"query":"flights"}',
    });
    const speechHandle = SpeechHandle.create();
    const session = new FakeFillerSession({
      sayError: new Error('AgentSession is closing, cannot use say()'),
    });
    const ctx = new RunContext(
      session as unknown as AgentSession<unknown>,
      speechHandle,
      functionCall,
    );

    await expect(
      ctx.filler('Still searching.', { delay: 0 }, async () => {
        await sleep(10);
        return 'lookup result';
      }),
    ).resolves.toBe('lookup result');
  });

  it('requires a callback scope', async () => {
    const { ctx } = buildContext();
    const filler = ctx.filler as unknown as (source: string) => Promise<unknown>;

    await expect(filler('x')).rejects.toThrow('RunContext.filler requires a callback scope');
  });

  it('restarts the idle dwell when agent speech or thinking starts', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('After agent state.', { delay: 30 }, async () => {
      await sleep(20);
      session.emitAgentState('speaking');
      await sleep(20);
      expect(session.sayTexts).toEqual([]);
      session.emitAgentState('thinking');
      await sleep(20);
      expect(session.sayTexts).toEqual([]);
      await sleep(20);
    });

    expect(session.sayTexts).toEqual(['After agent state.']);
  });

  it('restarts the idle dwell when the user starts speaking', async () => {
    const { ctx, session } = buildContext();

    await ctx.filler('After user state.', { delay: 30 }, async () => {
      await sleep(20);
      session.emitUserState('speaking');
      await sleep(20);
      expect(session.sayTexts).toEqual([]);
      await sleep(20);
    });

    expect(session.sayTexts).toEqual(['After user state.']);
  });

  it('stops repeating filler after the owning speech handle is interrupted', async () => {
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

    await ctx.filler('Repeat.', { delay: 0, interval: 5 }, async () => {
      await sleep(15);
      speechHandle.interrupt();
      const countAtInterrupt = session.sayTexts.length;
      await sleep(30);
      expect(session.sayTexts).toHaveLength(countAtInterrupt);
    });
  });

  it('validates filler timing options', async () => {
    const { ctx } = buildContext();

    await expect(ctx.filler('x', { delay: -1 }, async () => undefined)).rejects.toThrow(
      'delay must be non-negative',
    );
    await expect(ctx.filler('x', { interval: -1 }, async () => undefined)).rejects.toThrow(
      'interval must be non-negative when set',
    );
    await expect(ctx.filler('x', { maxSteps: -1 }, async () => undefined)).rejects.toThrow(
      'maxSteps must be non-negative when set',
    );
  });
});

class FakeFillerSession extends EventEmitter {
  userData = {};
  sayTexts: string[] = [];

  constructor(
    private readonly options: {
      waitForIdleError?: Error;
      waitForIdleNeverResolves?: boolean;
      sayError?: Error;
    } = {},
  ) {
    super();
  }

  async waitForIdle(): Promise<void> {
    if (this.options.waitForIdleError) {
      throw this.options.waitForIdleError;
    }
    if (this.options.waitForIdleNeverResolves) {
      await new Promise(() => undefined);
    }
    return;
  }

  say(text: string): SpeechHandle {
    if (this.options.sayError) {
      throw this.options.sayError;
    }
    this.sayTexts.push(text);
    const handle = SpeechHandle.create();
    handle._markDone();
    return handle;
  }

  emitAgentState(newState: 'speaking' | 'thinking'): void {
    this.emit(AgentSessionEventTypes.AgentStateChanged, {
      type: 'agent_state_changed',
      oldState: 'idle',
      newState,
      createdAt: Date.now(),
    });
  }

  emitUserState(newState: 'speaking'): void {
    this.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'listening',
      newState,
      createdAt: Date.now(),
    });
  }
}
