// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AudioStreamDecoder, audioFramesFromFile } from './audio.js';
import { FFMPEG_PATH_ENV, resolveFfmpegPath } from './ffmpeg.js';
import { initializeLogger, loggerOptions } from './log.js';

if (!loggerOptions()) {
  initializeLogger({ pretty: true, level: 'info' });
}

// These tests exercise the real ffmpeg decode/encode pipeline shared by audio.ts and
// recorder_io.ts. Resolve a usable ffmpeg WITHOUT triggering a network download: prefer the
// env/bundled binary, else fall back to one on PATH. If none works, skip rather than fail —
// keeping the suite hermetic on machines/CI without ffmpeg.
const resolveTestFfmpeg = (): string | undefined => {
  for (const candidate of [resolveFfmpegPath(), 'ffmpeg']) {
    if (candidate && spawnSync(candidate, ['-version']).status === 0) {
      return candidate;
    }
  }
  return undefined;
};

const TEST_FFMPEG = resolveTestFfmpeg();
// Pin the resolved binary so audioFramesFromFile()'s internal configureFfmpeg() uses it and
// never attempts a download during tests.
if (TEST_FFMPEG) {
  process.env.LIVEKIT_FFMPEG_PATH = TEST_FFMPEG;
}

const SAMPLE_RATE = 48000;

const makeWav = ({
  sampleRate = SAMPLE_RATE,
  numChannels = 1,
  durationMs = 1000,
  freq = 440,
} = {}): {
  buf: Buffer;
  numSamples: number;
} => {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const blockAlign = numChannels * 2;
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000);
    for (let c = 0; c < numChannels; c++) {
      buf.writeInt16LE(sample, off);
      off += 2;
    }
  }
  return { buf, numSamples };
};

const writeWav = (file: string, opts = {}): number => {
  const { buf, numSamples } = makeWav(opts);
  fs.writeFileSync(file, buf);
  return numSamples;
};

const collectDecoder = async (
  decoder: AudioStreamDecoder,
): Promise<{ frames: number; samples: number; sampleRate?: number; numChannels?: number }> => {
  let frames = 0;
  let samples = 0;
  let sampleRate: number | undefined;
  let numChannels: number | undefined;
  for await (const frame of decoder as AsyncIterable<AudioFrame>) {
    frames++;
    samples += frame.samplesPerChannel;
    sampleRate = frame.sampleRate;
    numChannels = frame.channels;
  }
  return { frames, samples, sampleRate, numChannels };
};

const feedInChunks = (decoder: AudioStreamDecoder, buf: Buffer, chunkSize: number): void => {
  for (let i = 0; i < buf.length; i += chunkSize) {
    decoder.pushChunk(buf.subarray(i, i + chunkSize));
  }
  decoder.endInput();
};

const encode = (input: string, output: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(args)
      .output(output)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });

const drain = async (
  stream: ReturnType<typeof audioFramesFromFile>,
): Promise<{ frames: number; samples: number; sampleRate?: number; numChannels?: number }> => {
  let frames = 0;
  let samples = 0;
  let sampleRate: number | undefined;
  let numChannels: number | undefined;
  for await (const frame of stream) {
    frames++;
    samples += frame.samplesPerChannel;
    sampleRate = frame.sampleRate;
    numChannels = frame.channels;
  }
  return { frames, samples, sampleRate, numChannels };
};

describe.skipIf(!TEST_FFMPEG)('audioFramesFromFile (ffmpeg decode pipeline)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-audio-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decodes a mono WAV into PCM frames at the requested rate', async () => {
    const wav = path.join(tmpDir, 'mono.wav');
    const expected = writeWav(wav, { numChannels: 1, durationMs: 1000 });

    const { frames, samples, sampleRate, numChannels } = await drain(
      audioFramesFromFile(wav, { sampleRate: SAMPLE_RATE, numChannels: 1 }),
    );

    expect(frames).toBeGreaterThan(0);
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(numChannels).toBe(1);
    // Decoders can drop/add a fractional frame at the boundary; allow a small tolerance.
    expect(samples).toBeGreaterThan(expected * 0.9);
    expect(samples).toBeLessThanOrEqual(expected + SAMPLE_RATE / 10);
  });

  it('resamples to the requested sample rate', async () => {
    const wav = path.join(tmpDir, 'resample.wav');
    writeWav(wav, { numChannels: 1, durationMs: 1000 });

    const { samples, sampleRate } = await drain(
      audioFramesFromFile(wav, { sampleRate: 24000, numChannels: 1 }),
    );

    expect(sampleRate).toBe(24000);
    expect(samples).toBeGreaterThan(24000 * 0.9);
    expect(samples).toBeLessThanOrEqual(24000 * 1.1);
  });

  it('round-trips through ogg/opus (the codec recorder_io encodes with)', async () => {
    const wav = path.join(tmpDir, 'src.wav');
    writeWav(wav, { numChannels: 1, durationMs: 1000 });
    const ogg = path.join(tmpDir, 'out.ogg');

    // Encode with the same libopus → ogg settings recorder_io uses.
    await new Promise<void>((resolve, reject) => {
      ffmpeg(wav)
        .audioCodec('libopus')
        .audioChannels(1)
        .audioFrequency(SAMPLE_RATE)
        .format('ogg')
        .output(ogg)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });
    expect(fs.statSync(ogg).size).toBeGreaterThan(0);

    const { frames, samples } = await drain(
      audioFramesFromFile(ogg, { sampleRate: SAMPLE_RATE, numChannels: 1 }),
    );
    expect(frames).toBeGreaterThan(0);
    expect(samples).toBeGreaterThan(SAMPLE_RATE * 0.8);
  });

  it('stops promptly when the abort signal fires', async () => {
    const wav = path.join(tmpDir, 'abort.wav');
    writeWav(wav, { numChannels: 1, durationMs: 5000 });

    const ac = new AbortController();
    ac.abort();
    const { frames } = await drain(
      audioFramesFromFile(wav, { sampleRate: SAMPLE_RATE, numChannels: 1, abortSignal: ac.signal }),
    );
    // Pre-aborted: the stream must terminate rather than decode all 5 seconds.
    expect(frames).toBeLessThan(50);
  });
});

// The WAV fast path is pure JS and must never shell out to ffmpeg — these run unconditionally
// and pin LIVEKIT_FFMPEG_PATH to a bogus value to prove no subprocess is involved.
describe('AudioStreamDecoder — WAV fast path (no subprocess)', () => {
  const savedEnv = process.env[FFMPEG_PATH_ENV];
  beforeAll(() => {
    process.env[FFMPEG_PATH_ENV] = '/nonexistent/ffmpeg-should-not-be-used';
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env[FFMPEG_PATH_ENV];
    else process.env[FFMPEG_PATH_ENV] = savedEnv;
  });

  it('decodes a mono WAV byte stream into PCM frames', async () => {
    const { buf, numSamples } = makeWav({ numChannels: 1, durationMs: 1000 });
    const decoder = new AudioStreamDecoder({
      format: 'wav',
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
    decoder.pushChunk(buf);
    decoder.endInput();

    const { frames, samples, sampleRate, numChannels } = await collectDecoder(decoder);
    expect(frames).toBeGreaterThan(0);
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(numChannels).toBe(1);
    expect(samples).toBe(numSamples);
  });

  it('handles input split across tiny chunks (header straddles boundaries)', async () => {
    const { buf, numSamples } = makeWav({ numChannels: 1, durationMs: 500 });
    const decoder = new AudioStreamDecoder({ sampleRate: SAMPLE_RATE, numChannels: 1 });
    feedInChunks(decoder, buf, 7); // 7 bytes splits the 44-byte header repeatedly

    const { samples, sampleRate } = await collectDecoder(decoder);
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(samples).toBe(numSamples);
  });

  it('auto-detects WAV by RIFF magic without a format hint', async () => {
    const { buf, numSamples } = makeWav({ numChannels: 1, durationMs: 500 });
    const decoder = new AudioStreamDecoder({ sampleRate: SAMPLE_RATE, numChannels: 1 });
    decoder.pushChunk(buf);
    decoder.endInput();

    const { samples } = await collectDecoder(decoder);
    expect(samples).toBe(numSamples);
  });

  it('resamples to a different output rate', async () => {
    const { buf } = makeWav({ sampleRate: SAMPLE_RATE, numChannels: 1, durationMs: 1000 });
    const decoder = new AudioStreamDecoder({ format: 'wav', sampleRate: 24000, numChannels: 1 });
    decoder.pushChunk(buf);
    decoder.endInput();

    const { samples, sampleRate } = await collectDecoder(decoder);
    expect(sampleRate).toBe(24000);
    expect(samples).toBeGreaterThan(24000 * 0.9);
    expect(samples).toBeLessThanOrEqual(24000 * 1.1);
  });

  it('downmixes stereo WAV to mono', async () => {
    const { buf, numSamples } = makeWav({ numChannels: 2, durationMs: 500 });
    const decoder = new AudioStreamDecoder({
      format: 'wav',
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
    decoder.pushChunk(buf);
    decoder.endInput();

    const { samples, numChannels } = await collectDecoder(decoder);
    expect(numChannels).toBe(1);
    expect(samples).toBe(numSamples);
  });
});

describe.skipIf(!TEST_FFMPEG)('AudioStreamDecoder — ffmpeg path', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-decoder-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  afterEach(() => {
    // Restore the env the suite-level setup pinned for ffmpeg resolution.
    if (TEST_FFMPEG) process.env[FFMPEG_PATH_ENV] = TEST_FFMPEG;
  });

  const makeOpus = async (durationMs: number): Promise<Buffer> => {
    const wav = path.join(tmpDir, `src-${durationMs}.wav`);
    const ogg = path.join(tmpDir, `src-${durationMs}.ogg`);
    writeWav(wav, { numChannels: 1, durationMs });
    await encode(wav, ogg, ['-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-f', 'ogg']);
    return fs.readFileSync(ogg);
  };

  it('decodes an ogg/opus byte stream', async () => {
    const opus = await makeOpus(1000);
    const decoder = new AudioStreamDecoder({
      format: 'ogg',
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
    decoder.pushChunk(opus);
    decoder.endInput();

    const { frames, samples, sampleRate } = await collectDecoder(decoder);
    expect(frames).toBeGreaterThan(0);
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(samples).toBeGreaterThan(SAMPLE_RATE * 0.8);
  });

  it('maps a MIME type to the input format', async () => {
    const opus = await makeOpus(500);
    const decoder = new AudioStreamDecoder({ mimeType: 'audio/ogg', sampleRate: SAMPLE_RATE });
    decoder.pushChunk(opus);
    decoder.endInput();

    const { frames } = await collectDecoder(decoder);
    expect(frames).toBeGreaterThan(0);
  });

  it('decodes opus fed in small chunks', async () => {
    const opus = await makeOpus(1000);
    const decoder = new AudioStreamDecoder({
      format: 'ogg',
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
    feedInChunks(decoder, opus, 256);

    const { samples } = await collectDecoder(decoder);
    expect(samples).toBeGreaterThan(SAMPLE_RATE * 0.8);
  });
});
