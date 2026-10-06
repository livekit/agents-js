// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { AudioStreamDecoder, isRawPcm, mimeToFormat } from './decoder.js';

const SAMPLE_RATE = 24000;

/** A 16-bit mono sine, as raw PCM samples. */
const sine = (samples: number, freq = 440): Int16Array => {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 16000);
  }
  return out;
};

/** Wrap raw PCM samples in a minimal 44-byte WAV container. */
const toWav = (samples: Int16Array, sampleRate = SAMPLE_RATE, channels = 1): Uint8Array => {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataLen).copy(buf, 44);
  return new Uint8Array(buf);
};

const collect = async (decoder: AudioStreamDecoder): Promise<AudioFrame[]> => {
  const frames: AudioFrame[] = [];
  for await (const frame of decoder) {
    frames.push(frame);
  }
  return frames;
};

const totalSamples = (frames: AudioFrame[]): number =>
  frames.reduce((sum, f) => sum + f.samplesPerChannel, 0);

describe('mimeToFormat', () => {
  it('maps known container types to ffmpeg format names', () => {
    expect(mimeToFormat('audio/mpeg')).toBe('mp3');
    expect(mimeToFormat('audio/wav')).toBe('wav');
    expect(mimeToFormat('audio/ogg')).toBe('ogg');
    expect(mimeToFormat('application/ogg')).toBe('ogg');
    expect(mimeToFormat('audio/webm')).toBe('webm');
  });

  it('normalizes casing and strips parameters', () => {
    expect(mimeToFormat('Audio/MPEG')).toBe('mp3');
    expect(mimeToFormat('audio/wav; charset=binary')).toBe('wav');
    expect(mimeToFormat('  audio/flac  ')).toBe('flac');
  });

  it('returns undefined for unknown or missing types, letting ffmpeg probe', () => {
    expect(mimeToFormat(undefined)).toBeUndefined();
    expect(mimeToFormat('')).toBeUndefined();
    expect(mimeToFormat('application/octet-stream')).toBeUndefined();
  });
});

describe('isRawPcm', () => {
  it('recognizes raw, header-less types', () => {
    expect(isRawPcm('audio/pcm')).toBe(true);
    expect(isRawPcm('audio/pcm;rate=24000')).toBe(true);
    expect(isRawPcm('audio/raw')).toBe(true);
    expect(isRawPcm('AUDIO/PCM')).toBe(true);
  });

  it('rejects container and compressed types', () => {
    expect(isRawPcm('audio/wav')).toBe(false);
    expect(isRawPcm('audio/mpeg')).toBe(false);
    expect(isRawPcm(undefined)).toBe(false);
  });
});

describe('AudioStreamDecoder', () => {
  it('decodes a WAV container to raw PCM of the same length', async () => {
    const samples = sine(SAMPLE_RATE); // 1 second
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    decoder.push(toWav(samples));
    decoder.endInput();

    const frames = await collect(decoder);
    await decoder.aclose();

    expect(frames.length).toBeGreaterThan(0);
    expect(totalSamples(frames)).toBe(samples.length);
    expect(frames.every((f) => f.sampleRate === SAMPLE_RATE && f.channels === 1)).toBe(true);
  });

  it('round-trips sample values through the decoder', async () => {
    const samples = sine(2048);
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    decoder.push(toWav(samples));
    decoder.endInput();

    const frames = await collect(decoder);
    await decoder.aclose();

    const decoded = new Int16Array(totalSamples(frames));
    let offset = 0;
    for (const frame of frames) {
      decoded.set(frame.data, offset);
      offset += frame.samplesPerChannel;
    }
    // WAV is lossless, so the decoded PCM is bit-identical to the input
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  it('accepts bytes pushed across many small chunks', async () => {
    const samples = sine(SAMPLE_RATE / 2);
    const wav = toWav(samples);
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    for (let i = 0; i < wav.length; i += 997) {
      decoder.push(wav.slice(i, i + 997));
    }
    decoder.endInput();

    const frames = await collect(decoder);
    await decoder.aclose();
    expect(totalSamples(frames)).toBe(samples.length);
  });

  it('resamples and downmixes to the requested output format', async () => {
    // 48kHz stereo in, 24kHz mono out
    const stereo = new Int16Array(48000 * 2);
    for (let i = 0; i < 48000; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 16000);
      stereo[i * 2] = v;
      stereo[i * 2 + 1] = v;
    }
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    decoder.push(toWav(stereo, 48000, 2));
    decoder.endInput();

    const frames = await collect(decoder);
    await decoder.aclose();

    // one second of 48kHz stereo becomes one second of 24kHz mono
    expect(totalSamples(frames)).toBeCloseTo(SAMPLE_RATE, -2);
    expect(frames.every((f) => f.channels === 1 && f.sampleRate === SAMPLE_RATE)).toBe(true);
  });

  it('probes the container when no format is given', async () => {
    const samples = sine(4096);
    const decoder = new AudioStreamDecoder({ sampleRate: SAMPLE_RATE, numChannels: 1 });
    decoder.push(toWav(samples));
    decoder.endInput();

    const frames = await collect(decoder);
    await decoder.aclose();
    expect(totalSamples(frames)).toBe(samples.length);
  });

  it('throws when the bytes are not decodable', async () => {
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    decoder.push(new Uint8Array(4096).fill(0x41)); // 'AAAA...', not a WAV
    decoder.endInput();

    await expect(collect(decoder)).rejects.toThrow(/audio decoding failed/);
    await decoder.aclose();
  });

  it('completes without frames when no bytes were ever pushed', async () => {
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    decoder.endInput();
    expect(await collect(decoder)).toHaveLength(0);
    await decoder.aclose();
  });

  it('aclose stops an abandoned decoder without reporting a failure', async () => {
    const decoder = new AudioStreamDecoder({
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      format: 'audio/wav',
    });
    decoder.push(toWav(sine(SAMPLE_RATE * 5)));
    // abandon mid-stream, without endInput or draining
    await decoder.aclose();
    // a second close is a no-op rather than an error
    await decoder.aclose();
  });
});
