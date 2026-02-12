// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future, Task } from '../utils.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { CloseReason } from './events.js';
import { SpeechHandle } from './speech_handle.js';

initializeLogger({ pretty: false, level: 'error' });

describe('AgentSession', () => {
  it('serializes updateAgent transitions and watches run-state tasks', async () => {
    const session = new AgentSession({});
    const agent1 = new Agent({ instructions: 'agent one' });
    const agent2 = new Agent({ instructions: 'agent two' });

    (session as any).started = true;
    const order: string[] = [];

    let firstCall = true;
    (session as any)._updateActivity = vi.fn(async (agent: Agent) => {
      order.push(`start:${agent.id}`);
      if (firstCall) {
        firstCall = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      order.push(`end:${agent.id}`);
    });

    const watchHandle = vi.fn();
    (session as any)._globalRunState = { _watchHandle: watchHandle };

    session.updateAgent(agent1);
    session.updateAgent(agent2);

    await ((session as any).updateActivityTask as { result: Promise<void> }).result;

    expect(order).toEqual([
      `start:${agent1.id}`,
      `end:${agent1.id}`,
      `start:${agent2.id}`,
      `end:${agent2.id}`,
    ]);
    expect(watchHandle).toHaveBeenCalledTimes(2);
  });

  it('routes say() to nextActivity when current activity is paused', () => {
    const session = new AgentSession({});
    const handle = SpeechHandle.create();

    const pausedActivity = {
      schedulingPaused: true,
      say: vi.fn(() => {
        throw new Error('should not call paused activity say()');
      }),
    };
    const nextActivity = {
      say: vi.fn(() => handle),
    };

    const watchHandle = vi.fn();

    (session as any).activity = pausedActivity;
    (session as any).nextActivity = nextActivity;
    (session as any)._globalRunState = { _watchHandle: watchHandle };

    const result = session.say('hello');

    expect(result).toBe(handle);
    expect(nextActivity.say).toHaveBeenCalledTimes(1);
    expect(pausedActivity.say).not.toHaveBeenCalled();
    expect(watchHandle).toHaveBeenCalledWith(handle);
  });

  it('forces interrupt and commits user turn during non-error close', async () => {
    const session = new AgentSession({});
    (session as any).started = true;

    const interruptFuture = new Future<void>();
    interruptFuture.resolve();

    const activity = {
      interrupt: vi.fn(() => interruptFuture),
      drain: vi.fn(async () => {}),
      currentSpeech: { waitForPlayout: vi.fn(async () => {}) },
      commitUserTurn: vi.fn(),
      detachAudioInput: vi.fn(),
      close: vi.fn(async () => {}),
    };

    (session as any).activity = activity;
    await (session as any).closeImplInner(CloseReason.USER_INITIATED, null, false);

    expect(activity.interrupt).toHaveBeenCalledWith({ force: true });
    expect(activity.commitUserTurn).toHaveBeenCalledWith({
      audioDetached: true,
      throwIfNotReady: false,
    });
    expect(activity.drain).toHaveBeenCalledTimes(1);
    expect(activity.close).toHaveBeenCalledTimes(1);
  });

  it('does not commit user turn during error close', async () => {
    const session = new AgentSession({});
    (session as any).started = true;

    const interruptFuture = new Future<void>();
    interruptFuture.resolve();

    const activity = {
      interrupt: vi.fn(() => interruptFuture),
      drain: vi.fn(async () => {}),
      currentSpeech: { waitForPlayout: vi.fn(async () => {}) },
      commitUserTurn: vi.fn(),
      detachAudioInput: vi.fn(),
      close: vi.fn(async () => {}),
    };

    (session as any).activity = activity;
    await (session as any).closeImplInner(CloseReason.ERROR, null, false);

    expect(activity.commitUserTurn).not.toHaveBeenCalled();
  });

  it('forwards force option through session interrupt()', () => {
    const session = new AgentSession({});
    const interruptFuture = new Future<void>();
    const activity = {
      interrupt: vi.fn(() => interruptFuture),
    };

    (session as any).activity = activity;
    const returned = session.interrupt({ force: true });

    expect(returned).toBe(interruptFuture);
    expect(activity.interrupt).toHaveBeenCalledWith({ force: true });
  });

  it('honors waitOnEnter by awaiting onEnter task completion', async () => {
    const session = new AgentSession({});
    const agent = new Agent({ instructions: 'wait on enter agent' });
    const previousAgent = new Agent({ instructions: 'previous agent' });

    (session as any).activity = {
      agent: previousAgent,
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    const startSpy = vi.spyOn(AgentActivity.prototype, 'start').mockImplementation(async function (
      this: AgentActivity,
    ) {
      this._onEnterTask = Task.from(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    });

    const startedAt = Date.now();
    await (session as any)._updateActivity(agent, { waitOnEnter: true });
    const elapsed = Date.now() - startedAt;

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(15);

    startSpy.mockRestore();
  });
});
