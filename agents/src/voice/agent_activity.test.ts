// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { Future, Task } from '../utils.js';
import { Agent, _setActivityTaskInfo } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { ToolExecutionOutput } from './generation.js';
import { SpeechHandle } from './speech_handle.js';

initializeLogger({ pretty: false, level: 'error' });

function createActivityForTests(): AgentActivity {
  const agent = new Agent({ instructions: 'test agent' });
  const sessionMock = {
    options: {
      allowInterruptions: true,
      discardAudioIfUninterruptible: true,
      minInterruptionDuration: 500,
      minInterruptionWords: 0,
      minEndpointingDelay: 500,
      maxEndpointingDelay: 6000,
      maxToolSteps: 3,
      preemptiveGeneration: false,
      userAwayTimeout: 15,
      useTtsAlignedTranscript: true,
    },
    turnDetection: undefined,
    vad: undefined,
    stt: undefined,
    llm: undefined,
    tts: undefined,
    output: {
      audio: null,
      audioEnabled: false,
    },
    rootSpanContext: undefined,
    useTtsAlignedTranscript: true,
    agentState: 'listening',
    emit: vi.fn(),
    _updateAgentState: vi.fn(),
    _conversationItemAdded: vi.fn(),
    _toolItemsAdded: vi.fn(),
    updateAgent: vi.fn(),
  };

  return new AgentActivity(agent, sessionMock as any);
}

describe('AgentActivity parity behaviors', () => {
  it('summarizes tool outputs with symmetric function call metadata', () => {
    const activity = createActivityForTests();
    const speechHandle = SpeechHandle.create();

    const toolCall = FunctionCall.create({
      callId: 'call_1',
      name: 'lookup',
      args: JSON.stringify({ city: 'SF' }),
    });
    const toolCallOutput = FunctionCallOutput.create({
      callId: 'call_1',
      name: 'lookup',
      output: 'sunny',
      isError: false,
    });

    const toolOutput = {
      output: [
        ToolExecutionOutput.create({
          toolCall,
          toolCallOutput,
          rawOutput: 'sunny',
          replyRequired: true,
        }),
      ],
      firstToolStartedFuture: new Future<void>(),
    };

    const summary = (activity as any).summarizeToolExecutionOutput(toolOutput, speechHandle);
    expect(summary.functionToolsExecutedEvent.functionCalls).toHaveLength(1);
    expect(summary.functionToolsExecutedEvent.functionCallOutputs).toHaveLength(1);
    expect(summary.shouldGenerateToolReply).toBe(true);
    expect(summary.newAgentTask).toBeNull();
    expect(summary.ignoreTaskSwitch).toBe(false);
  });

  it('blocks scheduleSpeech while scheduling is paused unless force=true', () => {
    const activity = createActivityForTests();
    const handle = SpeechHandle.create();

    (activity as any)._schedulingPaused = true;

    expect(() =>
      (activity as any).scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL),
    ).toThrow('cannot schedule new speech, the speech scheduling is draining/pausing');

    expect(() =>
      (activity as any).scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL, true),
    ).not.toThrow();
  });

  it('filters drain pending tasks by blocked speech handles', async () => {
    const activity = createActivityForTests();
    const gate = new Future<void>();

    const blockedSpeechHandle = SpeechHandle.create();
    const siblingSpeechHandle = blockedSpeechHandle;

    const blockedTask = Task.from(async () => {
      await gate.await;
    });
    const siblingTask = Task.from(async () => {
      await gate.await;
    });

    _setActivityTaskInfo(blockedTask, { speechHandle: blockedSpeechHandle });
    _setActivityTaskInfo(siblingTask, { speechHandle: siblingSpeechHandle });

    (activity as any).speechTasks = new Set([blockedTask, siblingTask]);
    (activity as any)._drainBlockedTasks = [blockedTask];
    (activity as any)._schedulingPaused = true;

    const toWait = (activity as any).getDrainPendingSpeechTasks() as Task<void>[];
    expect(toWait).toEqual([]);

    gate.resolve();
    await Promise.allSettled([blockedTask.result, siblingTask.result]);
  });

  it('interrupt cancels preemptive generation first', () => {
    const activity = createActivityForTests();
    const preemptiveSpeech = SpeechHandle.create();

    (activity as any)._preemptiveGeneration = { speechHandle: preemptiveSpeech } as any;

    const fut = activity.interrupt();

    expect(preemptiveSpeech.interrupted).toBe(true);
    expect((activity as any)._preemptiveGeneration).toBeUndefined();
    expect(fut.done).toBe(true);
  });
});
