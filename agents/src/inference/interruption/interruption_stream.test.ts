// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterruptionMetrics } from '../../metrics/base.js';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';
import { InterruptionStreamBase, InterruptionStreamSentinel } from './interruption_stream.js';

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

function audioFrame(samples: number[], sampleRate: number): AudioFrame {
  const data = new Int16Array(samples);
  return new AudioFrame(data, sampleRate, 1, data.length);
}

async function resampledAudioAfterReset(
  oldSamples: number[] | undefined,
  nextSamples: number[],
  nextSampleRate: number,
): Promise<{ audio: Int16Array; inputRate: number | undefined }> {
  const previousSocketCount = MockWebSocket.instances.length;
  const detector = new AdaptiveInterruptionDetector({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseUrl: 'http://localhost:9999',
    detectionIntervalInS: 0.01,
  });
  const stream = new InterruptionStreamBase(detector, {});
  const frames: AudioFrame[] = [];
  const pushAudio = async (samples: number[], sampleRate: number): Promise<void> => {
    const frame = audioFrame(samples, sampleRate);
    frames.push(frame);
    await stream.pushFrame(frame);
  };

  try {
    await vi.waitFor(() =>
      expect(MockWebSocket.instances.length).toBeGreaterThan(previousSocketCount),
    );
    const ws = MockWebSocket.instances[previousSocketCount]!;
    ws.simulateOpen();
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
    if (oldSamples) {
      await pushAudio(oldSamples, 8000);
      await stream.pushFrame(InterruptionStreamSentinel.agentSpeechEnded());
      await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
    }
    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(0, Date.now()));
    const nextPushes = nextSampleRate === 16000 ? 1 : 3;
    for (let i = 0; i < nextPushes; i++) {
      await pushAudio(nextSamples, nextSampleRate);
    }

    await vi.waitFor(() => expect(ws.sent.some((item) => item instanceof Uint8Array)).toBe(true));
    const request = ws.sent.findLast((item): item is Uint8Array => item instanceof Uint8Array)!;
    return {
      audio: new Int16Array(
        request.buffer.slice(request.byteOffset + 8, request.byteOffset + request.length),
      ),
      inputRate: (stream as unknown as { resampler?: AudioResampler }).resampler?.inputRate,
    };
  } finally {
    await stream.close();
  }
}

function expectPcmClose(actual: Int16Array, expected: Int16Array): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(2);
  }
}

async function expectNewResamplerAfterReset(oldSamples: number[]): Promise<void> {
  const previousSocketCount = MockWebSocket.instances.length;
  const detector = new AdaptiveInterruptionDetector({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseUrl: 'http://localhost:9999',
  });
  const stream = new InterruptionStreamBase(detector, {});
  const internal = stream as unknown as { resampler?: AudioResampler };
  const frames: AudioFrame[] = [];
  const frame = (samples: number[]): AudioFrame => {
    const value = audioFrame(samples, 8000);
    frames.push(value);
    return value;
  };
  const outputSamples = (output: AudioFrame[]): Int16Array => {
    const samples = output.flatMap((item) =>
      Array.from(
        new Int16Array(
          item.data.buffer,
          item.data.byteOffset,
          item.samplesPerChannel * item.channels,
        ),
      ),
    );
    return new Int16Array(samples);
  };

  try {
    await vi.waitFor(() =>
      expect(MockWebSocket.instances.length).toBeGreaterThan(previousSocketCount),
    );
    MockWebSocket.instances[previousSocketCount]!.simulateOpen();

    const oldPushes = oldSamples.length === 1 ? 1 : 2;
    for (let i = 0; i < oldPushes; i++) await stream.pushFrame(frame(oldSamples));
    const oldResampler = internal.resampler;
    expect(oldResampler).toBeDefined();

    await stream.pushFrame(InterruptionStreamSentinel.agentSpeechEnded());
    const silence = new Array<number>(400).fill(0);
    await stream.pushFrame(frame(silence));

    expect(internal.resampler).toBeDefined();
    expect(internal.resampler).not.toBe(oldResampler);

    const actual = outputSamples([
      ...internal.resampler!.push(frame(silence)),
      ...internal.resampler!.push(frame(silence)),
    ]);
    const fresh = new AudioResampler(8000, 16000);
    const expected = outputSamples([
      ...fresh.push(frame(silence)),
      ...fresh.push(frame(silence)),
      ...fresh.push(frame(silence)),
    ]);
    fresh.close();

    expectPcmClose(actual, expected);
  } finally {
    await stream.close();
  }
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

describe('InterruptionStreamBase metrics', () => {
  it('does not count agent-ended overlap as a backchannel', async () => {
    MockWebSocket.instances.length = 0;
    const detector = new AdaptiveInterruptionDetector({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseUrl: 'http://localhost:9999',
    });
    const stream = new InterruptionStreamBase(detector, {});
    const metrics: InterruptionMetrics[] = [];
    detector.on('metrics_collected', (event) => metrics.push(event));
    const reader = stream.stream().getReader();

    try {
      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      MockWebSocket.instances[0]!.simulateOpen();
      const event = reader.read();
      await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
      await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(0, Date.now()));
      await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechEnded(Date.now(), true));
      await event;

      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({ numInterruptions: 0, numBackchannels: 0 });
    } finally {
      await reader.cancel();
      await stream.close();
    }
  });
});

describe('InterruptionStreamBase resampler reset', () => {
  it.each([[30000], new Array<number>(400).fill(30000)])(
    'discards resampler history from %s',
    async (oldSamples) => {
      await expectNewResamplerAfterReset(oldSamples);
    },
  );

  it.each([16000, 24000])('allows a new %i Hz input sample rate', async (nextSampleRate) => {
    const nextSamples = new Array<number>(400).fill(2);

    const actual = await resampledAudioAfterReset(
      new Array<number>(400).fill(1),
      nextSamples,
      nextSampleRate,
    );
    const fresh = await resampledAudioAfterReset(undefined, nextSamples, nextSampleRate);

    expect(actual.inputRate).toBe(nextSampleRate === 16000 ? undefined : nextSampleRate);
    expect(actual.inputRate).toBe(fresh.inputRate);
    expectPcmClose(actual.audio, fresh.audio);
  });
});
