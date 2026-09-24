// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { FunctionCall, ToolContext, tool } from '../llm/index.js';
import { Event } from '../utils.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import type { AgentState } from './events.js';
import { performAudioForwarding, performToolExecutions } from './generation.js';
import { AudioOutput } from './io.js';
import { RunContext } from './run_context.js';
import { SpeechHandle } from './speech_handle.js';

class PausableAudioOutput extends AudioOutput {
  pausedAt?: number;
  order?: string[];

  constructor() {
    super(undefined, undefined, { pause: true });
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    this.order?.push('frame');
    await super.captureFrame(frame);
  }

  override flush(): void {
    this.order?.push('flush');
    super.flush();
  }

  override pause(): void {
    this.pausedAt ??= Date.now();
  }

  override resume(): void {
    this.pausedAt = undefined;
  }

  clearBuffer(): void {
    // No buffered audio in this test output.
  }
}

type TestActivity = {
  pausedSpeech?: { handle: SpeechHandle; agentState: AgentState; timeout: number };
  falseInterruptionTimer?: NodeJS.Timeout;
  falseInterruptionPending: boolean;
  cancelSpeechPauseTask?: Promise<void>;
  userSilenceEvent: Event;
  audioRecognition?: undefined;
  agentSession: {
    agentState: AgentState;
    sessionOptions: {
      turnHandling: {
        interruption: { resumeFalseInterruption: boolean; falseInterruptionTimeout: number };
      };
    };
    output: { audioEnabled: boolean; audio: PausableAudioOutput };
  };
  updatePausedSpeech: (speechHandle: SpeechHandle, timeout: number) => void;
  reconcilePlayoutPause: (speechHandle: SpeechHandle) => void;
  cancelSpeechPause: (options?: { interrupt?: boolean }) => Promise<void>;
};

function testActivity(): [TestActivity, PausableAudioOutput] {
  const audioOutput = new PausableAudioOutput();
  const activity = Object.create(AgentActivity.prototype) as TestActivity;
  Object.assign(activity, {
    pausedSpeech: undefined,
    falseInterruptionTimer: undefined,
    falseInterruptionPending: false,
    cancelSpeechPauseTask: undefined,
    userSilenceEvent: new Event(),
    audioRecognition: undefined,
    agentSession: {
      agentState: 'thinking',
      sessionOptions: {
        turnHandling: {
          interruption: { resumeFalseInterruption: true, falseInterruptionTimeout: 2000 },
        },
      },
      output: { audioEnabled: true, audio: audioOutput },
    },
  });
  activity.userSilenceEvent.set();
  return [activity, audioOutput];
}

describe('playout launch pause', () => {
  function runContext(activity: TestActivity, speechHandle: SpeechHandle) {
    return new RunContext(
      activity.agentSession as unknown as AgentSession,
      speechHandle,
      FunctionCall.create({ name: 'transfer', callId: 'transfer-1', args: '{}' }),
      activity as unknown as AgentActivity,
    );
  }

  it('disallowInterruptions releases its paused speech without another audio frame', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    activity.userSilenceEvent.clear();
    activity.falseInterruptionTimer = setTimeout(() => {}, 2000);
    activity.falseInterruptionPending = true;

    runContext(activity, speechHandle).disallowInterruptions();

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
    expect(activity.falseInterruptionTimer).toBeUndefined();
    expect(activity.falseInterruptionPending).toBe(false);
  });

  it('disallowInterruptions preserves a different speech pause', () => {
    const [activity, audioOutput] = testActivity();
    const pausedSpeech = SpeechHandle.create();
    const toolSpeech = SpeechHandle.create();
    activity.updatePausedSpeech(pausedSpeech, 2000);
    audioOutput.pause();
    const resume = vi.spyOn(audioOutput, 'resume');

    runContext(activity, toolSpeech).disallowInterruptions();

    expect(toolSpeech.allowInterruptions).toBe(false);
    expect(pausedSpeech.allowInterruptions).toBe(true);
    expect(activity.pausedSpeech?.handle).toBe(pausedSpeech);
    expect(audioOutput.pausedAt).toBeDefined();
    expect(resume).not.toHaveBeenCalled();
  });

  function pausedSpeakingActivity() {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.agentSession.agentState = 'speaking';
    activity.updatePausedSpeech(speechHandle, 2000);
    activity.agentSession.agentState = 'listening';
    audioOutput.pause();
    const onStartOfAgentSpeech = vi.fn(async () => {});
    const disableVadInterruptionSoon = vi.fn();
    const stateLease = { activity, speechHandle };
    const session = Object.assign(activity.agentSession, {
      _activity: activity as object,
      _updateAgentState: vi.fn((state: AgentState) => {
        activity.agentSession.agentState = state;
      }),
    });
    const internals = Object.assign(activity, {
      _currentSpeech: speechHandle,
      activeAgentStateLease: stateLease,
      isInterruptionDetectionEnabled: true,
      disableVadInterruptionSoon,
    });
    Object.assign(activity, { audioRecognition: { onStartOfAgentSpeech } });
    return { activity, audioOutput, speechHandle, session, internals, onStartOfAgentSpeech };
  }

  it('restores speaking state before resuming a tool-owned pause', () => {
    const { activity, audioOutput, speechHandle, session, onStartOfAgentSpeech } =
      pausedSpeakingActivity();
    vi.spyOn(audioOutput, 'resume').mockImplementation(() => {
      expect(session.agentState).toBe('speaking');
      expect(onStartOfAgentSpeech).toHaveBeenCalledOnce();
    });

    runContext(activity, speechHandle).disallowInterruptions();

    expect(session._updateAgentState).toHaveBeenCalledWith('speaking', {
      otelContext: speechHandle._agentTurnContext,
    });
    expect(onStartOfAgentSpeech).toHaveBeenCalledWith(expect.any(Number));
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it.each(['activity', 'speech', 'lease', 'done', 'audio'] as const)(
    'does not restore paused state after losing %s ownership or availability',
    (reason) => {
      const { activity, speechHandle, session, internals, onStartOfAgentSpeech } =
        pausedSpeakingActivity();
      if (reason === 'activity') session._activity = {};
      if (reason === 'speech') internals._currentSpeech = SpeechHandle.create();
      if (reason === 'lease') {
        internals.activeAgentStateLease = { activity, speechHandle: SpeechHandle.create() };
      }
      if (reason === 'done') vi.spyOn(speechHandle, 'done').mockReturnValue(true);
      if (reason === 'audio') session.output.audioEnabled = false;

      runContext(activity, speechHandle).disallowInterruptions();

      expect(session.agentState).toBe('listening');
      expect(session._updateAgentState).not.toHaveBeenCalled();
      expect(onStartOfAgentSpeech).not.toHaveBeenCalled();
    },
  );

  it('tool execution releases the owning activity pause', async () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    const session = Object.assign(activity.agentSession, { _activity: activity });
    const transfer = tool({
      name: 'transfer',
      description: 'Transfer the caller.',
      execute: async (_, { ctx }) => {
        ctx.disallowInterruptions();
        return 'Transferred.';
      },
    });
    const toolCallStream = new ReadableStream<FunctionCall>({
      start(controller) {
        controller.enqueue(
          FunctionCall.create({ name: 'transfer', callId: 'transfer-1', args: '{}' }),
        );
        controller.close();
      },
    });

    const [task, output] = performToolExecutions({
      session: session as unknown as AgentSession,
      speechHandle,
      toolCtx: new ToolContext([transfer]),
      toolCallStream,
      controller: new AbortController(),
    });
    await task.result;

    expect(output.output[0]?.toolCallOutput?.isError).toBe(false);
    expect(speechHandle.allowInterruptions).toBe(false);
    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('disallowInterruptions rejects interrupted speech before changing its pause', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    speechHandle.interrupt();

    expect(() => runContext(activity, speechHandle).disallowInterruptions()).toThrow();

    expect(activity.pausedSpeech?.handle).toBe(speechHandle);
    expect(audioOutput.pausedAt).toBeDefined();
  });

  it('disallowInterruptions works for a standalone context', () => {
    const speechHandle = SpeechHandle.create();
    const context = new RunContext(
      new AgentSession({ vad: null }),
      speechHandle,
      FunctionCall.create({ name: 'transfer', callId: 'transfer-1', args: '{}' }),
    );

    context.disallowInterruptions();

    expect(speechHandle.allowInterruptions).toBe(false);
  });

  it('releases the silence gate when audio input is disabled', () => {
    const session = new AgentSession({ vad: null });
    const activity = new AgentActivity(new Agent({ instructions: 'test' }), session);
    const sessionInternals = session as unknown as {
      activity: AgentActivity;
      _userState: 'speaking' | 'listening';
    };
    const activityInternals = activity as unknown as { userSilenceEvent: Event };
    sessionInternals.activity = activity;
    sessionInternals._userState = 'speaking';
    activityInternals.userSilenceEvent.clear();

    session.input.setAudioEnabled(false);

    expect(activityInternals.userSilenceEvent.isSet).toBe(true);
    expect(session.userState).toBe('listening');
  });

  it('preserves an existing pause', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    const pausedAt = audioOutput.pausedAt;

    activity.reconcilePlayoutPause(speechHandle);

    expect(pausedAt).toBeDefined();
    expect(audioOutput.pausedAt).toBe(pausedAt);
    expect(activity.pausedSpeech?.handle).toBe(speechHandle);
    expect(activity.pausedSpeech?.timeout).toBe(2000);
  });

  it('pauses when start of speech precedes the current speech', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.userSilenceEvent.clear();

    activity.reconcilePlayoutPause(speechHandle);

    expect(audioOutput.pausedAt).toBeDefined();
    expect(activity.pausedSpeech?.handle).toBe(speechHandle);
    expect(activity.pausedSpeech?.timeout).toBe(0);
  });

  it('resumes when the user is silent', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    expect(activity.userSilenceEvent.isSet).toBe(true);

    activity.reconcilePlayoutPause(speechHandle);

    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('releases a pause when interruptions are disabled', async () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    const timer = setTimeout(() => {}, 2000);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    activity.falseInterruptionTimer = timer;
    activity.falseInterruptionPending = true;

    speechHandle.allowInterruptions = false;
    activity.reconcilePlayoutPause(speechHandle);

    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(activity.falseInterruptionTimer).toBeUndefined();
    expect(activity.falseInterruptionPending).toBe(false);

    speechHandle.allowInterruptions = true;
    activity.reconcilePlayoutPause(speechHandle);
    await activity.cancelSpeechPause();

    expect(audioOutput.pausedAt).toBeUndefined();
    expect(speechHandle.interrupted).toBe(false);
    clearTimeoutSpy.mockRestore();
  });

  it('releases a pause for interrupted speech', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();

    speechHandle.interrupt();
    activity.reconcilePlayoutPause(speechHandle);

    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('releases a pause when pausing is disabled', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    activity.agentSession.sessionOptions.turnHandling.interruption.resumeFalseInterruption = false;

    activity.reconcilePlayoutPause(speechHandle);

    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('releases a pause when audio output is disabled', () => {
    const [activity, audioOutput] = testActivity();
    const speechHandle = SpeechHandle.create();
    activity.updatePausedSpeech(speechHandle, 2000);
    audioOutput.pause();
    activity.agentSession.output.audioEnabled = false;

    activity.reconcilePlayoutPause(speechHandle);

    expect(audioOutput.pausedAt).toBeUndefined();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('reconciles the playout pause before the first frame', async () => {
    const order: string[] = [];
    const audioOutput = new PausableAudioOutput();
    audioOutput.order = order;
    const resumeSpy = vi.spyOn(audioOutput, 'resume');
    const frame = new AudioFrame(new Int16Array(480), 24000, 1, 480);
    const stream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(frame);
        controller.close();
      },
    });

    const [task, audioOut] = performAudioForwarding(
      stream,
      audioOutput,
      new AbortController(),
      () => order.push('reconcile'),
    );
    await task.result;
    audioOut.firstFrameFut.reject(new Error('playout finished before playback started'));

    expect(order).toEqual(['reconcile', 'frame', 'flush']);
    expect(resumeSpy).not.toHaveBeenCalled();
  });
});
