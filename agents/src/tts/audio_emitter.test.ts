// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { AudioEmitter, type AudioEmitterDestination } from './audio_emitter.js';
import type { SynthesizedAudio } from './tts.js';

const SAMPLE_RATE = 24000;

/** Collects everything an emitter produces, standing in for the stream's output queue. */
class Recorder implements AudioEmitterDestination {
  items: SynthesizedAudio[] = [];
  closed = false;

  put(audio: SynthesizedAudio): void {
    this.items.push(audio);
  }

  get frameSizes(): number[] {
    return this.items.map((a) => a.frame.samplesPerChannel);
  }

  get totalSamples(): number {
    return this.items.reduce((sum, a) => sum + a.frame.samplesPerChannel, 0);
  }

  get finals(): SynthesizedAudio[] {
    return this.items.filter((a) => a.final);
  }

  /** Every emitted sample, concatenated back into one buffer. */
  get samples(): Int16Array {
    const out = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const item of this.items) {
      out.set(item.frame.data, offset);
      offset += item.frame.samplesPerChannel;
    }
    return out;
  }
}

/** `count` samples of mono 16-bit PCM whose values count up, so reordering is detectable. */
const ramp = (count: number, start = 1): Uint8Array => {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = ((start + i) % 30000) + 1;
  }
  return new Uint8Array(samples.buffer);
};

const toWav = (samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array => {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataLen).copy(buf, 44);
  return new Uint8Array(buf);
};

const newEmitter = (
  dest: Recorder,
  opts: Partial<Parameters<AudioEmitter['initialize']>[0]> = {},
) => {
  const emitter = new AudioEmitter({ label: 'test.TTS', destination: dest });
  emitter.initialize({
    requestId: 'req-1',
    sampleRate: SAMPLE_RATE,
    numChannels: 1,
    mimeType: 'audio/pcm',
    ...opts,
  });
  return emitter;
};

describe('AudioEmitter', () => {
  describe('raw PCM', () => {
    it('emits every pushed sample, in order, ending with a final frame', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);
      const input = ramp(SAMPLE_RATE);

      emitter.push(input);
      emitter.endInput();
      await emitter.join();

      expect(dest.totalSamples).toBe(SAMPLE_RATE);
      expect(Array.from(dest.samples)).toEqual(Array.from(new Int16Array(input.buffer)));
      expect(dest.items.at(-1)!.final).toBe(true);
      // only the very last packet of the segment is final
      expect(dest.finals).toHaveLength(1);
    });

    it('stamps requestId and segmentId on every packet', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { requestId: 'req-xyz' });
      emitter.push(ramp(SAMPLE_RATE / 2));
      emitter.endInput();
      await emitter.join();

      expect(dest.items.every((a) => a.requestId === 'req-xyz')).toBe(true);
      expect(dest.items.every((a) => a.segmentId === '')).toBe(true);
    });

    it('ramps frame sizes progressively toward frameSizeMs', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { frameSizeMs: 200 });
      emitter.push(ramp(SAMPLE_RATE));
      emitter.endInput();
      await emitter.join();

      // The byte stream ramps 20ms/40/80/160 up to the 200ms target. A 10ms tail is held
      // back so the segment's last frame can be tagged `final`, so the first packet is the
      // 20ms frame minus that tail; from then on the tail is merged back into the next one.
      expect(dest.frameSizes.slice(0, 4)).toEqual([240, 960, 1920, 3840]);
      expect(dest.frameSizes.at(-1)).toBeLessThanOrEqual(4800);
    });

    it('honours a custom frameSizeMs', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { frameSizeMs: 40 });
      emitter.push(ramp(SAMPLE_RATE));
      emitter.endInput();
      await emitter.join();

      // 40ms at 24kHz is 960 samples; the ramp reaches it after the first 20ms frame
      expect(Math.max(...dest.frameSizes)).toBe(960);
    });

    it('tracks pushed duration and segment count', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);
      emitter.push(ramp(SAMPLE_RATE)); // exactly one second
      emitter.endInput();
      await emitter.join();

      expect(emitter.numSegments).toBe(1);
      expect(emitter.pushedDuration()).toBeCloseTo(1000, 5);
    });

    it('accepts bytes split across chunks that end mid-sample', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);
      const input = ramp(4000);
      // 333 is odd, so most chunks end halfway through a 16-bit sample
      for (let i = 0; i < input.length; i += 333) {
        emitter.push(input.slice(i, i + 333));
      }
      emitter.endInput();
      await emitter.join();

      expect(dest.totalSamples).toBe(4000);
      expect(Array.from(dest.samples)).toEqual(Array.from(new Int16Array(input.buffer)));
    });

    it('forwards pre-framed audio as-is through pushFrame', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);
      const frame = new AudioFrame(new Int16Array(1200).fill(7), SAMPLE_RATE, 1, 1200);

      emitter.pushFrame(frame);
      emitter.endInput();
      await emitter.join();

      expect(dest.totalSamples).toBe(1200);
      expect(dest.samples.every((v) => v === 7)).toBe(true);
    });

    it('emits nothing for a segment that received no audio', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);
      emitter.endInput();
      await emitter.join();

      expect(dest.items).toHaveLength(0);
      expect(emitter.pushedDuration()).toBe(0);
    });
  });

  describe('flush', () => {
    it('releases the held-back tail without ending the segment', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);

      emitter.push(ramp(SAMPLE_RATE / 2));
      emitter.flush();
      // let the flush drain before checking
      await new Promise((resolve) => setTimeout(resolve, 20));

      const afterFlush = dest.totalSamples;
      expect(afterFlush).toBe(SAMPLE_RATE / 2);
      expect(dest.finals).toHaveLength(0); // a flush is not the end of the segment

      emitter.push(ramp(SAMPLE_RATE / 2, 20000));
      emitter.endInput();
      await emitter.join();

      expect(dest.totalSamples).toBe(SAMPLE_RATE);
      expect(dest.finals).toHaveLength(1);
    });

    it('restarts the progressive ramp after a flush', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);

      emitter.push(ramp(SAMPLE_RATE));
      emitter.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const countBefore = dest.items.length;

      emitter.push(ramp(SAMPLE_RATE, 10000));
      emitter.endInput();
      await emitter.join();

      // back to the 20ms floor, less the 10ms tail held back for `final`
      expect(dest.frameSizes[countBefore]).toBe(240);
    });

    it('flushes on its own when audio arrives slower than realtime', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);

      // 400ms of audio at once: past the 150ms threshold, so the emitter arms its
      // slow-generation timer and releases the tail rather than holding it indefinitely
      emitter.push(ramp(SAMPLE_RATE * 0.4));
      const held = SAMPLE_RATE * 0.4 - dest.totalSamples;
      expect(held).toBeGreaterThan(0);

      const deadline = Date.now() + 2000;
      while (dest.totalSamples < SAMPLE_RATE * 0.4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(dest.totalSamples).toBe(SAMPLE_RATE * 0.4);
      expect(dest.finals).toHaveLength(0);

      await emitter.aclose();
    });
  });

  describe('streaming segments', () => {
    it('marks each segment final and keeps their ids', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { stream: true });

      emitter.startSegment({ segmentId: 'seg-a' });
      emitter.push(ramp(SAMPLE_RATE / 2));
      emitter.endSegment();

      emitter.startSegment({ segmentId: 'seg-b' });
      emitter.push(ramp(SAMPLE_RATE / 4, 5000));
      emitter.endSegment();

      emitter.endInput();
      await emitter.join();

      expect(emitter.numSegments).toBe(2);
      expect(dest.finals).toHaveLength(2);
      expect(dest.finals.map((a) => a.segmentId)).toEqual(['seg-a', 'seg-b']);
      expect(dest.totalSamples).toBe(SAMPLE_RATE / 2 + SAMPLE_RATE / 4);
    });

    it('reports per-segment durations', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { stream: true });

      emitter.startSegment({ segmentId: 'a' });
      emitter.push(ramp(SAMPLE_RATE)); // 1000ms
      emitter.endSegment();
      emitter.startSegment({ segmentId: 'b' });
      emitter.push(ramp(SAMPLE_RATE / 2)); // 500ms
      emitter.endSegment();
      emitter.endInput();
      await emitter.join();

      expect(emitter.pushedDuration(0)).toBeCloseTo(1000, 5);
      expect(emitter.pushedDuration(1)).toBeCloseTo(500, 5);
      expect(emitter.pushedDuration()).toBeCloseTo(500, 5); // defaults to the latest
    });

    it('ignores a segment that opened and closed with no audio', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { stream: true });

      emitter.startSegment({ segmentId: 'empty' });
      emitter.endSegment();
      emitter.startSegment({ segmentId: 'real' });
      emitter.push(ramp(1000));
      emitter.endSegment();
      emitter.endInput();
      await emitter.join();

      expect(dest.items.every((a) => a.segmentId === 'real')).toBe(true);
      expect(dest.finals).toHaveLength(1);
    });

    it('rejects segment calls on a non-streaming emitter', () => {
      const emitter = newEmitter(new Recorder());
      expect(() => emitter.startSegment({ segmentId: 'x' })).toThrow(/stream: true/);
      expect(() => emitter.endSegment()).toThrow(/stream: true/);
    });
  });

  describe('encoded audio', () => {
    it('decodes a WAV body pushed as bytes', async () => {
      const dest = new Recorder();
      const samples = new Int16Array(SAMPLE_RATE / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 16000);
      }

      const emitter = newEmitter(dest, { mimeType: 'audio/wav' });
      emitter.push(toWav(samples));
      emitter.endInput();
      await emitter.join();

      expect(dest.totalSamples).toBe(samples.length);
      expect(Array.from(dest.samples)).toEqual(Array.from(samples));
      expect(dest.items.at(-1)!.final).toBe(true);
    });

    it('frames decoded audio progressively, like raw PCM', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { mimeType: 'audio/wav', frameSizeMs: 200 });
      emitter.push(toWav(new Int16Array(SAMPLE_RATE)));
      emitter.endInput();
      await emitter.join();

      expect(dest.frameSizes.slice(0, 3)).toEqual([240, 960, 1920]);
    });

    it('surfaces a decoding failure from join()', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { mimeType: 'audio/wav' });
      emitter.push(new Uint8Array(4096).fill(0x41)); // not a WAV
      emitter.endInput();

      await expect(emitter.join()).rejects.toThrow(/audio decoding failed/);
    });
  });

  describe('timed transcripts', () => {
    it('attaches pending transcripts to the next emitted packet', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);
      const word = Object.assign('hello', { startTime: 0, endTime: 0.5 });

      emitter.pushTimedTranscript(word as never);
      emitter.push(ramp(SAMPLE_RATE / 2));
      emitter.endInput();
      await emitter.join();

      expect(dest.items[0]!.timedTranscripts).toEqual([word]);
      // attached once, not repeated on later packets
      expect(dest.items.slice(1).every((a) => a.timedTranscripts === undefined)).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('throws when used before initialize', () => {
      const emitter = new AudioEmitter({ label: 'test.TTS', destination: new Recorder() });
      expect(emitter.started).toBe(false);
      expect(() => emitter.push(ramp(10))).toThrow(/isn't started/);
    });

    it('throws when initialized twice', () => {
      const emitter = newEmitter(new Recorder());
      expect(() =>
        emitter.initialize({
          requestId: 'r',
          sampleRate: SAMPLE_RATE,
          numChannels: 1,
          mimeType: 'audio/pcm',
        }),
      ).toThrow(/already started/);
    });

    it('aclose on an uninitialized emitter is a no-op', async () => {
      const emitter = new AudioEmitter({ label: 'test.TTS', destination: new Recorder() });
      await emitter.aclose();
    });

    it('aclose abandons buffered audio and is idempotent', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest, { mimeType: 'audio/wav' });
      emitter.push(toWav(new Int16Array(SAMPLE_RATE * 5)));

      await emitter.aclose();
      await emitter.aclose();
    });

    it('stops writing once the destination is closed', async () => {
      const dest = new Recorder();
      const emitter = newEmitter(dest);

      emitter.push(ramp(SAMPLE_RATE / 4));
      dest.closed = true;
      emitter.push(ramp(SAMPLE_RATE / 4));
      emitter.endInput();
      await emitter.join();

      // whatever landed before the close is kept; nothing is written after it
      expect(dest.totalSamples).toBeLessThan(SAMPLE_RATE / 2);
    });
  });
});

describe('AudioEmitter unhandled rejections', () => {
  it('does not raise an unhandled rejection when a failing emitter is never joined', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      const emitter = new AudioEmitter({ label: 'test.TTS', destination: new Recorder() });
      emitter.initialize({
        requestId: 'req-1',
        sampleRate: SAMPLE_RATE,
        numChannels: 1,
        mimeType: 'audio/wav',
      });
      emitter.push(new Uint8Array(4096).fill(0x41)); // not a WAV, so decoding fails
      emitter.endInput();
      // deliberately never join()

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
