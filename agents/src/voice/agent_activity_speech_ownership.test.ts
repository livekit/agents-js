// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future, type Task } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput, type PlaybackFinishedEvent } from './io.js';

const PLAYBACK_FINISHED: PlaybackFinishedEvent = {
  playbackPosition: 0.02,
  interrupted: false,
};

function frame(): AudioFrame {
  const samples = 480;
  return new AudioFrame(new Int16Array(samples), 24000, 1, samples);
}

function controlledAudio(): {
  stream: ReadableStream<AudioFrame>;
  pushAndClose: () => void;
} {
  let controller!: ReadableStreamDefaultController<AudioFrame>;
  const stream = new ReadableStream<AudioFrame>({
    start(streamController) {
      controller = streamController;
    },
  });

  return {
    stream,
    pushAndClose: () => {
      controller.enqueue(frame());
      controller.close();
    },
  };
}

class DeferredPlayoutOutput extends AudioOutput {
  readonly firstCapture = new Future<void>();
  readonly secondCapture = new Future<void>();
  readonly initialWaitEntered = new Future<void>();
  readonly delayedCleanupWaitEntered = new Future<void>();
  readonly currentWaitEntered = new Future<void>();

  private captureCount = 0;
  private waitCount = 0;
  private initialPlayout = new Future<PlaybackFinishedEvent>();
  private delayedCleanup = new Future<PlaybackFinishedEvent>();
  private currentPlayout = new Future<PlaybackFinishedEvent>();
  private trailingPlayout = new Future<PlaybackFinishedEvent>();

  constructor() {
    super(24000);
  }

  override async captureFrame(audioFrame: AudioFrame): Promise<void> {
    await super.captureFrame(audioFrame);
    this.onPlaybackStarted(Date.now());

    if (this.captureCount++ === 0) {
      this.firstCapture.resolve();
    } else {
      this.secondCapture.resolve();
    }
  }

  override async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    this.waitCount += 1;
    if (this.waitCount === 1) {
      this.initialWaitEntered.resolve();
      return this.initialPlayout.await;
    }
    if (this.waitCount === 2) {
      this.delayedCleanupWaitEntered.resolve();
      return this.delayedCleanup.await;
    }
    if (this.waitCount === 3) {
      this.currentWaitEntered.resolve();
      return this.currentPlayout.await;
    }
    return this.trailingPlayout.await;
  }

  clearBuffer(): void {}

  releaseDelayedCleanup(): void {
    if (!this.delayedCleanup.done) {
      this.delayedCleanup.resolve({ ...PLAYBACK_FINISHED, interrupted: true });
    }
  }

  finishCurrentPlayout(): void {
    if (!this.currentPlayout.done) {
      this.currentPlayout.resolve(PLAYBACK_FINISHED);
    }
  }

  releaseAll(): void {
    if (!this.initialPlayout.done) {
      this.initialPlayout.resolve({ ...PLAYBACK_FINISHED, interrupted: true });
    }
    this.releaseDelayedCleanup();
    this.finishCurrentPlayout();
    if (!this.trailingPlayout.done) {
      this.trailingPlayout.resolve({ ...PLAYBACK_FINISHED, interrupted: true });
    }
  }
}

async function startSession(output: DeferredPlayoutOutput): Promise<AgentSession> {
  const session = new AgentSession({
    vad: null,
    aecWarmupDuration: 0,
    userAwayTimeout: 15,
  });
  session.output.audio = output;
  await session.start({ agent: new Agent({ instructions: 'test' }) });
  return session;
}

async function startInterruptedSpeech(session: AgentSession, output: DeferredPlayoutOutput) {
  const audio = controlledAudio();
  const speech = session.say('stale speech', { audio: audio.stream, addToChatCtx: false });
  const task = speech._tasks[0]!;
  audio.pushAndClose();

  await output.firstCapture.await;
  await output.initialWaitEntered.await;
  expect(session.agentState).toBe('speaking');

  session.interrupt();
  await output.delayedCleanupWaitEntered.await;
  return task;
}

async function startCurrentSpeech(session: AgentSession, output: DeferredPlayoutOutput) {
  const audio = controlledAudio();
  const speech = session.say('current speech', { audio: audio.stream, addToChatCtx: false });
  audio.pushAndClose();

  await output.secondCapture.await;
  await output.currentWaitEntered.await;
  expect(session.agentState).toBe('speaking');
  return { speech };
}

describe('agent speech state ownership', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores delayed cleanup after the interruption watchdog starts newer speech', async () => {
    const output = new DeferredPlayoutOutput();
    const session = await startSession(output);

    try {
      const staleTask = await startInterruptedSpeech(session, output);
      const currentSpeechPromise = startCurrentSpeech(session, output);

      await vi.advanceTimersByTimeAsync(5000);
      const { speech: currentSpeech } = await currentSpeechPromise;

      output.releaseDelayedCleanup();
      await staleTask.result.catch(() => undefined);

      expect(session.agentState).toBe('speaking');
      await vi.advanceTimersByTimeAsync(15_001);
      expect(session.userState).toBe('listening');

      output.finishCurrentPlayout();
      await currentSpeech.waitForPlayout();
    } finally {
      output.releaseAll();
      const closeTask = session.close();
      await vi.runAllTimersAsync();
      await closeTask;
    }
  });

  it('ignores delayed cleanup from an inactive activity', async () => {
    const output = new DeferredPlayoutOutput();
    const session = await startSession(output);

    try {
      const staleTask = await startInterruptedSpeech(session, output);
      session.updateAgent(new Agent({ instructions: 'replacement' }));
      const transitionTask = (session as unknown as { updateActivityTask?: Task<void> })
        .updateActivityTask;
      expect(transitionTask).toBeDefined();

      await vi.advanceTimersByTimeAsync(5000);
      await transitionTask!.result;
      const { speech: currentSpeech } = await startCurrentSpeech(session, output);

      output.releaseDelayedCleanup();
      await staleTask.result.catch(() => undefined);

      expect(session.agentState).toBe('speaking');
      await vi.advanceTimersByTimeAsync(15_001);
      expect(session.userState).toBe('listening');

      output.finishCurrentPlayout();
      await currentSpeech.waitForPlayout();
    } finally {
      output.releaseAll();
      const closeTask = session.close();
      await vi.runAllTimersAsync();
      await closeTask;
    }
  });
});
