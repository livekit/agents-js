// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AudioByteStream } from './audio.js';

const SAMPLE_RATE = 16000;
/** 200ms at 16kHz. */
const TARGET_SAMPLES = 3200;

/** `count` samples of mono 16-bit PCM, as raw bytes. */
const pcm = (count: number): Uint8Array => new Uint8Array(count * 2);

describe('AudioByteStream', () => {
  describe('fixed mode', () => {
    it('emits frames of exactly samplesPerChannel', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES);
      const frames = stream.write(pcm(TARGET_SAMPLES * 3));
      expect(frames.map((f) => f.samplesPerChannel)).toEqual([
        TARGET_SAMPLES,
        TARGET_SAMPLES,
        TARGET_SAMPLES,
      ]);
    });

    it('buffers a partial frame until enough data arrives', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES);
      expect(stream.write(pcm(TARGET_SAMPLES - 1))).toHaveLength(0);
      expect(stream.write(pcm(1))).toHaveLength(1);
    });
  });

  describe('progressive mode', () => {
    it('doubles the frame size until it reaches the target', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES, true);
      const frames = stream.write(pcm(TARGET_SAMPLES * 4));
      // 20ms, then 40, 80, 160, then capped at the 200ms target
      expect(frames.map((f) => f.samplesPerChannel)).toEqual([320, 640, 1280, 2560, 3200, 3200]);
      // 12800 in, 11200 emitted; the rest waits for a full target-size frame
      expect(stream.bufferedDuration).toBe((1600 / SAMPLE_RATE) * 1000);
    });

    it('never exceeds the target when it is smaller than the 20ms floor', () => {
      // 10ms target at 16kHz is below MIN_PROGRESSIVE_MS, so every frame is the target size.
      const stream = new AudioByteStream(SAMPLE_RATE, 1, 160, true);
      const frames = stream.write(pcm(640));
      expect(frames.map((f) => f.samplesPerChannel)).toEqual([160, 160, 160, 160]);
    });

    it('resetProgressive restarts the ramp but keeps buffered audio', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES, true);
      // ramp through the first two frames, leaving the buffer empty
      expect(stream.write(pcm(960)).map((f) => f.samplesPerChannel)).toEqual([320, 640]);

      // not enough for the next 1280-sample frame, so this stays buffered
      expect(stream.write(pcm(100))).toHaveLength(0);
      stream.resetProgressive();

      // back at the 20ms floor, and the 100 buffered samples counted toward it
      const frames = stream.write(pcm(220));
      expect(frames.map((f) => f.samplesPerChannel)).toEqual([320]);
      expect(stream.bufferedDuration).toBe(0);
    });

    it('clear discards buffered audio and resets the ramp', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES, true);
      stream.write(pcm(960));
      stream.write(pcm(100));
      stream.clear();

      expect(stream.bufferedDuration).toBe(0);
      expect(stream.write(pcm(320))[0]!.samplesPerChannel).toBe(320);
    });
  });

  describe('flush', () => {
    it('emits the buffered remainder as one frame', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES);
      stream.write(pcm(500));
      const frames = stream.flush();
      expect(frames).toHaveLength(1);
      expect(frames[0]!.samplesPerChannel).toBe(500);
      expect(stream.bufferedDuration).toBe(0);
    });

    it('returns nothing when the buffer is empty', () => {
      expect(new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES).flush()).toHaveLength(0);
    });

    it('retains a trailing partial sample instead of dropping the buffer', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES);
      // 401 bytes: 200 whole samples plus one dangling byte
      stream.write(new Uint8Array(401));

      const frames = stream.flush();
      expect(frames).toHaveLength(1);
      expect(frames[0]!.samplesPerChannel).toBe(200);

      // the dangling byte is still buffered and realigns the next sample rather than
      // shifting every subsequent one
      stream.write(new Uint8Array(1));
      expect(stream.flush()[0]!.samplesPerChannel).toBe(1);
    });

    it('keeps a lone partial sample rather than emitting a frame', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 1, TARGET_SAMPLES);
      stream.write(new Uint8Array(1));
      expect(stream.flush()).toHaveLength(0);
      expect(stream.bufferedDuration).toBeGreaterThan(0);
    });

    it('aligns to whole samples across every channel when stereo', () => {
      const stream = new AudioByteStream(SAMPLE_RATE, 2, TARGET_SAMPLES);
      // 10 bytes = 2 complete stereo samples (4 bytes each) + 2 dangling bytes
      stream.write(new Uint8Array(10));
      const frames = stream.flush();
      expect(frames[0]!.samplesPerChannel).toBe(2);
      expect(frames[0]!.channels).toBe(2);
    });
  });

  it('preserves sample values through framing', () => {
    const stream = new AudioByteStream(SAMPLE_RATE, 1, 4);
    const samples = new Int16Array([1, -2, 3, -4, 5, -6, 7, -8]);
    const frames = stream.write(new Uint8Array(samples.buffer));
    expect(Array.from(frames[0]!.data)).toEqual([1, -2, 3, -4]);
    expect(Array.from(frames[1]!.data)).toEqual([5, -6, 7, -8]);
  });

  it('push is an alias for write', () => {
    const stream = new AudioByteStream(SAMPLE_RATE, 1, 100);
    expect(stream.push(pcm(200))).toHaveLength(2);
  });
});
