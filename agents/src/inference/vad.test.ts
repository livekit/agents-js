// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { VADEventType, type VADStream } from '../vad.js';
import { VAD, type VADOptions } from './vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** White-box view of an `InferenceVADStream`'s internal buffer state. */
type StreamInternals = {
  _opts: VADOptions;
  _speechBuffer: Int16Array | null;
  _prefixPaddingSamples: number;
  _inputSampleRate: number;
};

const internals = (stream: VADStream): StreamInternals => stream as unknown as StreamInternals;

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
});

describe('inference.VAD speech buffer ownership', () => {
  it('does not mutate an emitted END_OF_SPEECH frame when sliding the next pre-roll', async () => {
    const sampleRate = 16000; // matches the model rate, so no resampler in the path
    const windowSamples = 512; // one inference window (32ms) per pushed frame

    const vad = new VAD({
      minSpeechDuration: 32, // 1 window of speech triggers START_OF_SPEECH
      minSilenceDuration: 64, // 2 windows of silence trigger END_OF_SPEECH
      prefixPaddingDuration: 64, // 1024-sample pre-roll — smaller than the segment
      maxBufferedSpeech: 2000,
    });
    const stream = vad.stream();

    // Deterministic stand-in for the native silero model: scripted
    // probabilities, one per inference window. 2 silence windows (pre-roll),
    // 10 speech windows, then 2 silence windows to end the segment.
    const probs = [0, 0, ...Array(10).fill(1), 0, 0];
    let call = 0;
    Object.assign(stream as unknown as Record<string, unknown>, {
      _nativeVad: {
        predict: async () => probs[call++] ?? 0,
        reset: () => {},
      },
      _windowSamples: windowSamples,
    });

    try {
      // Push a monotonically increasing ramp so any later mutation of the
      // emitted frame's underlying buffer is detectable.
      for (let w = 0; w < probs.length; w++) {
        const data = new Int16Array(windowSamples);
        for (let i = 0; i < windowSamples; i++) data[i] = w * windowSamples + i;
        stream.pushFrame(new AudioFrame(data, sampleRate, 1, windowSamples));
      }

      let endFrame: AudioFrame | undefined;
      for await (const ev of stream) {
        if (ev.type === VADEventType.END_OF_SPEECH) {
          endFrame = ev.frames[0];
          break;
        }
      }

      // By the time the consumer observes the event, the pump has already run
      // resetWriteCursor(), sliding the last pre-roll window to the head of
      // the speech buffer. If the emitted frame aliases that buffer, its
      // first samples now hold the segment's tail — the audio corruption
      // behind duplicated STT transcripts ("Hello? Hello?").
      expect(endFrame).toBeDefined();
      const samples = endFrame!.data;
      expect(samples.length).toBe(probs.length * windowSamples);
      expect(Array.from(samples.slice(0, 4))).toEqual([0, 1, 2, 3]);
      expect(samples.every((v, i) => v === i)).toBe(true);
    } finally {
      stream.close();
    }
  });
});
