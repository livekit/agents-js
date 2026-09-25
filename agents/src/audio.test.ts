// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { AudioByteStream } from './audio.js';

const PCM = Uint8Array.from({ length: 256 * 64 }, (_, index) => index % 256);

function frameBytes(frames: AudioFrame[]): Uint8Array {
  const chunks = frames.map(
    (frame) => new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
  );
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

describe.each([1, 2])('AudioByteStream with %i channel(s)', (numChannels) => {
  describe.each([false, true])('progressive=%s', (progressive) => {
    it.each([1, 2, 3, 960, 961, 3001, 4095, 4096, 4097])(
      'preserves samples across a flush at byte %i',
      (split) => {
        const stream = new AudioByteStream(24_000, numChannels, 2400, progressive);
        const frames = stream.write(PCM.slice(0, split));
        frames.push(...stream.flush());

        const completeBytes = split - (split % (2 * numChannels));
        expect(frameBytes(frames)).toEqual(PCM.slice(0, completeBytes));
        expect(stream.flush()).toEqual([]);

        frames.push(...stream.write(PCM.slice(split)));
        frames.push(...stream.flush());
        expect(frameBytes(frames)).toEqual(PCM);
        expect(stream.bufferedDuration).toBe(0);
      },
    );
  });

  it('preserves samples across repeated flushes', () => {
    const stream = new AudioByteStream(24_000, numChannels, null, true);
    const frames: AudioFrame[] = [];
    for (let offset = 0; offset < PCM.length; offset += 103) {
      frames.push(...stream.write(PCM.slice(offset, offset + 103)));
      frames.push(...stream.flush());
    }
    expect(frameBytes(frames)).toEqual(PCM);
  });

  it.each(numChannels === 1 ? [1] : [1, 2, 3])(
    'resets progressive framing while preserving %i partial byte(s)',
    (partialBytes) => {
      const stream = new AudioByteStream(24_000, numChannels, null, true);
      const initialSamples = 480;
      const initialBytes = initialSamples * 2 * numChannels;
      const split = 3 * initialBytes + partialBytes;
      const frames = stream.write(PCM.slice(0, split));
      expect(frames.map((frame) => frame.samplesPerChannel)).toEqual([480, 960]);
      frames.push(...stream.flush());

      stream.resetProgressive();
      const nextFrames = stream.write(PCM.slice(split, 4 * initialBytes));
      expect(nextFrames.map((frame) => frame.samplesPerChannel)).toEqual([initialSamples]);
      frames.push(...nextFrames);
      frames.push(...stream.write(PCM.slice(4 * initialBytes)));
      frames.push(...stream.flush());
      expect(frameBytes(frames)).toEqual(PCM);
    },
  );

  it('clears a partial sample and resets progressive framing', () => {
    const stream = new AudioByteStream(24_000, numChannels, null, true);
    const initialBytes = 480 * 2 * numChannels;
    stream.write(new Uint8Array(3 * initialBytes + 1).fill(0x11));

    stream.clear();
    expect(stream.bufferedDuration).toBe(0);
    expect(stream.flush()).toEqual([]);

    const pcm = new Uint8Array(initialBytes).fill(0x44);
    const frames = stream.write(pcm);
    expect(frames.map((frame) => frame.samplesPerChannel)).toEqual([480]);
    expect(frameBytes(frames)).toEqual(pcm);
  });

  it('exposes an incomplete terminal PCM sample for the caller to discard', () => {
    const stream = new AudioByteStream(24_000, numChannels);
    const completeBytes = 256 - (256 % (2 * numChannels));
    const pcm = PCM.slice(0, completeBytes + 1);

    const frames = stream.write(pcm);
    frames.push(...stream.flush());

    expect(frameBytes(frames)).toEqual(pcm.slice(0, completeBytes));
    expect(stream.bufferedDuration).toBeGreaterThan(0);
    stream.clear();
    expect(stream.bufferedDuration).toBe(0);
  });
});
