// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cancelling a speech task from inside its owning function tool, as a tool calling
 * `session.interrupt` with force does, must not crash the process with SpeechHandleCircularWaitError.
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

    // Stub `.then()` so a regression fails the assertion instead of crashing the vitest worker.
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

    // Same async context as a tool calling `session.interrupt({ force: true })`.
    functionCallStorage.run({ functionCall, speechHandle }, () => task.cancel());
    await task.result;

    expect(speechHandle.interrupted).toBe(true);
    expect(then).not.toHaveBeenCalled();
  });
});
