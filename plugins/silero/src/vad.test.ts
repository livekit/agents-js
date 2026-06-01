// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, type VADEvent, VADEventType, mergeFrames } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VAD, type VADStream } from './vad.js';

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 10;

/**
 * Build a short, deterministic clip: ~1.5s of real speech (from the shared test
 * wav) followed by ~1.2s of silence so the VAD reliably emits a full
 * START_OF_SPEECH then END_OF_SPEECH cycle, chunked into 10ms frames at 16kHz.
 */
function makeSpeechThenSilenceFrames(): AudioFrame[] {
  const sample = readFileSync(join(import.meta.dirname, '../../test/src/long.wav'));
  const channels = sample.readUInt16LE(22);
  const fileSampleRate = sample.readUInt32LE(24);
  const dataSamples = sample.readUInt32LE(40) / 2;
  const pcm = new Int16Array(sample.buffer, sample.byteOffset, Math.trunc(sample.byteLength / 2));

  // 44-byte WAVE header => 22 samples
  const dataStart = 22;
  const speechSampleCount = Math.min(Math.trunc(fileSampleRate * 1.5), dataSamples);
  const speech = pcm.slice(dataStart, dataStart + speechSampleCount);
  let speechFrame = new AudioFrame(
    speech,
    fileSampleRate,
    channels,
    Math.trunc(speechSampleCount / channels),
  );

  if (fileSampleRate !== TARGET_SAMPLE_RATE) {
    const resampler = new AudioResampler(fileSampleRate, TARGET_SAMPLE_RATE, channels);
    const out = [...resampler.push(speechFrame), ...resampler.flush()];
    resampler.close();
    speechFrame = mergeFrames(out);
  }

  const silenceSamples = Math.trunc(TARGET_SAMPLE_RATE * 1.2);
  const silenceFrame = new AudioFrame(
    new Int16Array(silenceSamples),
    TARGET_SAMPLE_RATE,
    channels,
    silenceSamples,
  );

  const merged = mergeFrames([speechFrame, silenceFrame]);
  const chunkSize = (TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000;
  const bstream = new AudioByteStream(TARGET_SAMPLE_RATE, channels, chunkSize);
  const arrayBuffer = merged.data.buffer.slice(
    merged.data.byteOffset,
    merged.data.byteOffset + merged.data.byteLength,
  ) as ArrayBuffer;
  const frames = bstream.write(arrayBuffer);
  frames.push(...bstream.flush());
  return frames;
}

/**
 * Push every frame (synchronous + ordered relative to `flush()`), then consume
 * events until a complete speech segment has been observed.
 */
async function drainSpeechSegment(
  stream: VADStream,
  frames: AudioFrame[],
): Promise<[VADEvent, VADEvent]> {
  for (const frame of frames) {
    stream.pushFrame(frame);
  }

  let sos: VADEvent | undefined;
  while (true) {
    const { done, value } = await stream.next();
    if (done) {
      throw new Error('stream ended before END_OF_SPEECH');
    }
    if (value.type === VADEventType.START_OF_SPEECH && sos === undefined) {
      sos = value;
    } else if (value.type === VADEventType.END_OF_SPEECH && sos !== undefined) {
      return [sos, value];
    }
  }
}

describe('Silero VADStream flush reset', () => {
  it(
    'recovers a full speech segment after flush() resets the stream',
    { timeout: 30000 },
    async () => {
      const frames = makeSpeechThenSilenceFrames();
      expect(frames.length).toBeGreaterThan(1);

      const vad = await VAD.load();
      const stream = vad.stream();
      try {
        const [firstSos, firstEos] = await drainSpeechSegment(stream, frames);
        expect(firstSos.type).toBe(VADEventType.START_OF_SPEECH);
        expect(firstEos.type).toBe(VADEventType.END_OF_SPEECH);

        // hard segment boundary: drop accumulated speech/silence state
        stream.flush();

        const [secondSos, secondEos] = await drainSpeechSegment(stream, frames);
        expect(secondSos.type).toBe(VADEventType.START_OF_SPEECH);
        expect(secondEos.type).toBe(VADEventType.END_OF_SPEECH);
      } finally {
        stream.close();
      }
    },
  );
});
