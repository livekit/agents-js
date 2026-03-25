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
});
