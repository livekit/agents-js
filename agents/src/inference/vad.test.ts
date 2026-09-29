// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { VAD, type VADOptions } from './vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** White-box view of an `InferenceVADStream`'s internal buffer state. */
type StreamInternals = {
  _opts: VADOptions;
  _speechBuffer: Int16Array | null;
  _speechBufferIndex: number;
  _prefixPaddingSamples: number;
  _inputSampleRate: number;
  _windowSamples: number;
  _nativeVad: {
    predict(samples: Int16Array): Promise<number>;
    reset(): void;
  };
};

const internals = (stream: VADStream): StreamInternals => stream as unknown as StreamInternals;

const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 512;

async function pushWindow(stream: VADStream, value: number): Promise<VADEvent[]> {
  stream.pushFrame(
    new AudioFrame(new Int16Array(WINDOW_SAMPLES).fill(value), SAMPLE_RATE, 1, WINDOW_SAMPLES),
  );
  const events: VADEvent[] = [];
  while (true) {
    const { done, value: event } = await stream.next();
    if (done) throw new Error('stream ended before INFERENCE_DONE');
    events.push(event);
    if (event.type === VADEventType.INFERENCE_DONE) return events;
  }
}

const resizeCases = [
  ['maxBufferedSpeech', 'shrink'],
  ['maxBufferedSpeech', 'grow'],
  ['maxBufferedSpeech', 'shrinkThenGrow'],
  ['prefixPaddingDuration', 'shrink'],
  ['prefixPaddingDuration', 'grow'],
  ['prefixPaddingDuration', 'shrinkThenGrow'],
] as const;

describe('inference.VAD updateOptions propagation', () => {
  it('fans out option changes to live streams', () => {
    const vad = new VAD({ minSilenceDuration: 250 });
    const stream = vad.stream();
    try {
      expect(internals(stream)._opts.minSilenceDuration).toBe(250);

      vad.updateOptions({ minSilenceDuration: 800 });

      // The already-created stream observes the new value, not a stale snapshot.
      expect(internals(stream)._opts.minSilenceDuration).toBe(800);
    } finally {
      stream.close();
    }
  });

  it('resizes a live stream speech buffer once the sample rate is known', () => {
    const sampleRate = 16000;
    const vad = new VAD({ maxBufferedSpeech: 10_000, prefixPaddingDuration: 500 });
    const stream = vad.stream();
    try {
      // Simulate a stream that has already seen its first frame.
      const s = internals(stream);
      s._inputSampleRate = sampleRate;
      s._prefixPaddingSamples = Math.trunc((500 * sampleRate) / 1000);
      s._speechBuffer = new Int16Array(
        Math.trunc((10_000 * sampleRate) / 1000) + s._prefixPaddingSamples,
      );

      vad.updateOptions({ maxBufferedSpeech: 20_000, prefixPaddingDuration: 1000 });

      const expectedPrefix = Math.trunc((1000 * sampleRate) / 1000);
      expect(s._prefixPaddingSamples).toBe(expectedPrefix);
      expect(s._speechBuffer?.length).toBe(
        Math.trunc((20_000 * sampleRate) / 1000) + expectedPrefix,
      );
    } finally {
      stream.close();
    }
  });

  it.each(resizeCases)('handles %s %s during speech', async (option, resize) => {
    const vad = new VAD({
      minSpeechDuration: 32,
      minSilenceDuration: 32,
      prefixPaddingDuration: 64,
      maxBufferedSpeech: 256,
      activationThreshold: 0.5,
      deactivationThreshold: 0.4,
    });
    const stream = vad.stream();
    const s = internals(stream);
    s._windowSamples = WINDOW_SAMPLES;
    s._nativeVad = {
      predict: async (samples) => (samples.some((sample) => sample !== 0) ? 1 : 0),
      reset: () => {},
    };

    try {
      for (let value = 1; value < 10; value++) {
        await pushWindow(stream, value);
      }

      let samples = Int16Array.from(
        { length: 9 * WINDOW_SAMPLES },
        (_, index) => Math.trunc(index / WINDOW_SAMPLES) + 1,
      );
      if (resize !== 'grow') {
        vad.updateOptions({ [option]: 16 });
        const retained = ((option === 'maxBufferedSpeech' ? 80 : 272) * SAMPLE_RATE) / 1000;
        samples = samples.slice(0, retained);
      }
      if (resize !== 'shrink') {
        vad.updateOptions({ [option]: 512 });
        const grown = new Int16Array(samples.length + WINDOW_SAMPLES);
        grown.set(samples);
        samples = grown;
      }

      await pushWindow(stream, 0);
      let result = await stream.next();
      expect(result.done).toBe(false);
      expect(result.value?.type).toBe(VADEventType.END_OF_SPEECH);
      expect(result.value?.frames[0]?.samplesPerChannel).toBe(samples.length);
      expect(result.value?.frames[0]?.data).toEqual(samples);

      for (const reset of [false, true]) {
        if (reset) stream.flush();
        await pushWindow(stream, 10);
        const events = await pushWindow(stream, 0);
        expect(events.some((event) => event.type === VADEventType.START_OF_SPEECH)).toBe(true);
        result = await stream.next();
        expect(result.value?.type).toBe(VADEventType.END_OF_SPEECH);
        expect(result.value?.frames[0]?.samplesPerChannel).toBe(
          result.value?.frames[0]?.data.length,
        );
        expect(result.value?.frames[0]?.data).toContain(10);
      }
    } finally {
      stream.close();
    }
  });
});

describe('VADStream endInput', () => {
  it('ends the input without throwing and rejects later pushes', async () => {
    const vad = new VAD();
    const stream = vad.stream();
    try {
      expect(() => stream.endInput()).not.toThrow();
      expect(() => stream.endInput()).toThrow('Input is closed');
      expect(() => stream.flush()).toThrow('Input is closed');

      // The input reader observes the end of the stream.
      const reader = internalsReader(stream);
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      stream.close();
    }
  });
});

const internalsReader = (stream: VADStream) =>
  (stream as unknown as { inputReader: ReadableStreamDefaultReader<unknown> }).inputReader;
