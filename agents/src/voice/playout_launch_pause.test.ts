// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { Event } from '../utils.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { performAudioForwarding } from './generation.js';
import { AudioOutput } from './io.js';
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
  pausedSpeech?: { handle: SpeechHandle; agentState: 'thinking'; timeout: number };
  falseInterruptionTimer?: NodeJS.Timeout;
  falseInterruptionPending: boolean;
  cancelSpeechPauseTask?: Promise<void>;
  userSilenceEvent: Event;
  audioRecognition?: undefined;
  agentSession: {
    agentState: 'thinking';
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
