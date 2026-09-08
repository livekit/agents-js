// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for #2435.
 *
 * AgentActivity.createSpeechTask() registers an abort listener that interrupts the owned
 * SpeechHandle. SpeechHandle is a thenable, and Node's EventTarget calls `.then()` on any
 * thenable a listener returns. When the abort fires from inside the function tool that owns
 * the handle (for example `session.interrupt({ force: true })` in a tool), that `.then()` calls
 * `waitForPlayout()`, hits the circular-wait guard, and Node rethrows the rejection as an
 * uncaught exception. The listener must not return the handle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FunctionCall } from '../llm/chat_context.js';
import { Future, type Task } from '../utils.js';
import { functionCallStorage } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { SpeechHandle } from './speech_handle.js';

type SpeechTaskFactory = (options: {
  taskFn: (controller: AbortController) => Promise<void>;
  ownedSpeechHandle?: SpeechHandle;
  name?: string;
}) => Task<void>;

function makeActivity(): AgentActivity {
  const activity = Object.create(AgentActivity.prototype) as AgentActivity;
  Object.assign(activity, {
    speechTasks: new Set(),
    q_updated: new Future<void>(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
  return activity;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentActivity.createSpeechTask - abort listener', () => {
  it('does not hand the owned SpeechHandle to EventTarget when cancelled from its own tool', async () => {
    const activity = makeActivity();
    const speechHandle = SpeechHandle.create();
    const functionCall = FunctionCall.create({
      callId: 'call_test',
      name: 'example_tool',
      args: '{}',
    });

    // If the listener returns the handle, EventTarget calls `.then()` on it. Stub it so a
    // regression fails this assertion instead of crashing the whole vitest worker.
    const then = vi.spyOn(speechHandle, 'then').mockImplementation(() => Promise.resolve());

    const started = new Future<void>();
    const createSpeechTask = (
      activity as unknown as { createSpeechTask: SpeechTaskFactory }
    ).createSpeechTask.bind(activity);
    const task = createSpeechTask({
      taskFn: async (controller) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      ownedSpeechHandle: speechHandle,
      name: 'test_speech_task',
    });
    await started.await;

    // Same context as a tool calling `session.interrupt({ force: true })`.
    functionCallStorage.run({ functionCall, speechHandle }, () => task.cancel());
    await task.result;

    expect(speechHandle.interrupted).toBe(true);
    expect(then).not.toHaveBeenCalled();
  });
});
