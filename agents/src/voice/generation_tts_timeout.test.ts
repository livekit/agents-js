// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { performAudioForwarding, performTTSInference } from './generation.js';
import { AudioOutput } from './io.js';

function createSilentFrame(sampleRate = 24000, channels = 1, durationMs = 20): AudioFrame {
  const samplesPerChannel = Math.floor((sampleRate * durationMs) / 1000);
  const data = new Int16Array(samplesPerChannel * channels);
  return new AudioFrame(data, sampleRate, channels, samplesPerChannel);
}

class MockAudioOutput extends AudioOutput {
  capturedFrames: AudioFrame[] = [];

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.capturedFrames.push(frame);
    this.onPlaybackStarted(Date.now());
  }

  clearBuffer(): void {
    // no-op for mock
  }
}

describe('TTS stream idle timeout', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('forwardAudio completes when TTS stream stalls after producing frames', async () => {
    const stalledStream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(createSilentFrame());
        controller.enqueue(createSilentFrame());
      },
    });

    const audioOutput = new MockAudioOutput();
    const controller = new AbortController();

    const [task, audioOut] = performAudioForwarding(stalledStream, audioOutput, controller);

    vi.useFakeTimers();

    const taskPromise = task.result;
    await vi.advanceTimersByTimeAsync(11_000);
    await taskPromise;

    vi.useRealTimers();

    expect(audioOutput.capturedFrames.length).toBe(2);
    expect(audioOut.firstFrameFut.done).toBe(true);
  }, 10_000);

  it('forwardAudio honours a custom idle timeout', async () => {
    const stalledStream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(createSilentFrame());
      },
    });

    const audioOutput = new MockAudioOutput();
    const controller = new AbortController();

    const [task, audioOut] = performAudioForwarding(stalledStream, audioOutput, controller, 500);

    vi.useFakeTimers();

    const taskPromise = task.result;
    await vi.advanceTimersByTimeAsync(600);
    await taskPromise;

    vi.useRealTimers();

    expect(audioOutput.capturedFrames.length).toBe(1);
    expect(audioOut.firstFrameFut.done).toBe(true);
  });

  it('forwardAudio completes normally when TTS stream closes properly', async () => {
    const normalStream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(createSilentFrame());
        controller.enqueue(createSilentFrame());
        controller.enqueue(createSilentFrame());
        controller.close();
      },
    });

    const audioOutput = new MockAudioOutput();
    const controller = new AbortController();

    const [task, audioOut] = performAudioForwarding(normalStream, audioOutput, controller);

    await task.result;

    expect(audioOutput.capturedFrames.length).toBe(3);
    expect(audioOut.firstFrameFut.done).toBe(true);
  });

  it('ignores PLAYBACK_STARTED from another segment before its own first frame', async () => {
    // Stalled stream so the forwarder is still waiting on its first read when a
    // stray event (from an interrupted overlapping segment) arrives; the idle
    // timeout then ends the loop without this segment ever capturing a frame.
    const stalledStream = new ReadableStream<AudioFrame>({ start() {} });

    const audioOutput = new MockAudioOutput();
    const controller = new AbortController();
    const [task, audioOut] = performAudioForwarding(stalledStream, audioOutput, controller, 500);

    audioOut.firstFrameFut.await.catch(() => {});

    vi.useFakeTimers();

    // Stray PLAYBACK_STARTED before this segment captures anything must be ignored.
    audioOutput.onPlaybackStarted(Date.now());
    expect(audioOut.firstFrameFut.done).toBe(false);

    const taskPromise = task.result;
    await vi.advanceTimersByTimeAsync(600);
    await taskPromise;

    vi.useRealTimers();

    expect(audioOutput.capturedFrames.length).toBe(0);
    // Forwarding ended without capturing a frame. The future stays pending —
    // playback-started may legitimately arrive after forwarding completes
    // (deferred avatar notification), so the caller settles it when the
    // segment's playout window ends. Stray events must still be ignored.
    audioOutput.onPlaybackStarted(Date.now());
    expect(audioOut.firstFrameFut.done).toBe(false);
  });

  it('resamples a rate-mismatched frame even after a stray PLAYBACK_STARTED', async () => {
    // Output is 24kHz; frames are 16kHz and must be resampled regardless of any
    // stray PLAYBACK_STARTED resolving firstFrameFut early.
    const stream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(createSilentFrame(16000));
        controller.enqueue(createSilentFrame(16000));
        controller.close();
      },
    });

    const audioOutput = new MockAudioOutput();
    const controller = new AbortController();
    const [task, audioOut] = performAudioForwarding(stream, audioOutput, controller);

    // Stray event before the loop captures anything must not skip resampling.
    audioOutput.onPlaybackStarted(Date.now());

    await task.result;

    expect(audioOut.firstFrameFut.done).toBe(true);
    // Every captured frame must match the output sample rate (i.e. was resampled).
    expect(audioOutput.capturedFrames.length).toBeGreaterThan(0);
    for (const f of audioOutput.capturedFrames) {
      expect(f.sampleRate).toBe(24000);
    }
  });

  it('performTTSInference completes when TTS node returns stalled stream', async () => {
    const stalledTtsStream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(createSilentFrame());
      },
    });

    const ttsNode = async () => stalledTtsStream;
    const textInput = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Hello world');
        controller.close();
      },
    });

    const controller = new AbortController();
    const [task, genData] = performTTSInference(ttsNode, textInput, {}, controller);

    vi.useFakeTimers();

    const taskPromise = task.result;
    await vi.advanceTimersByTimeAsync(11_000);
    await taskPromise;

    vi.useRealTimers();

    expect(genData.ttfb).toBeDefined();
  }, 10_000);

  it('performTTSInference honours a custom read idle timeout', async () => {
    const stalledTtsStream = new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(createSilentFrame());
      },
    });

    const ttsNode = async () => stalledTtsStream;
    const textInput = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Hello world');
        controller.close();
      },
    });

    const controller = new AbortController();
    const [task, genData] = performTTSInference(
      ttsNode,
      textInput,
      {},
      controller,
      undefined,
      undefined,
      500,
    );

    vi.useFakeTimers();

    const taskPromise = task.result;
    await vi.advanceTimersByTimeAsync(600);
    await taskPromise;

    vi.useRealTimers();

    expect(genData.ttfb).toBeDefined();
  }, 10_000);
});
