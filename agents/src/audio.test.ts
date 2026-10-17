// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AudioByteStream } from './audio.js';

const SAMPLE_RATE = 16000;
const SAMPLES_PER_FRAME = 160;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;

function pcm(samples: number): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) => i);
}

describe('AudioByteStream.write', () => {
  it('splits one write into whole frames and keeps the remainder', () => {
    const stream = new AudioByteStream(SAMPLE_RATE, 1, SAMPLES_PER_FRAME);
    const input = pcm(SAMPLES_PER_FRAME * 2 + 10);

    const frames = stream.write(input);

    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0]!.data)).toEqual(Array.from(input.subarray(0, SAMPLES_PER_FRAME)));
    expect(Array.from(frames[1]!.data)).toEqual(
      Array.from(input.subarray(SAMPLES_PER_FRAME, 2 * SAMPLES_PER_FRAME)),
    );
    expect(Array.from(stream.flush()[0]!.data)).toEqual(
      Array.from(input.subarray(2 * SAMPLES_PER_FRAME)),
    );
  });

  it('joins bytes split across writes in order', () => {
    const stream = new AudioByteStream(SAMPLE_RATE, 1, SAMPLES_PER_FRAME);
    const input = pcm(SAMPLES_PER_FRAME * 3);
    const bytes = new Uint8Array(input.buffer);

    const frames = [];
    for (let offset = 0; offset < bytes.length; offset += 37) {
      frames.push(...stream.write(bytes.subarray(offset, offset + 37)));
    }

    expect(frames).toHaveLength(3);
    expect(frames.flatMap((frame) => Array.from(frame.data))).toEqual(Array.from(input));
    expect(stream.flush()).toEqual([]);
  });

  it('reads only the viewed range of a larger buffer', () => {
    const stream = new AudioByteStream(SAMPLE_RATE, 1, SAMPLES_PER_FRAME);
    const backing = pcm(SAMPLES_PER_FRAME * 2);
    const view = new Uint8Array(backing.buffer, BYTES_PER_FRAME / 2, BYTES_PER_FRAME);

    const [frame] = stream.write(view);

    expect(Array.from(frame!.data)).toEqual(
      Array.from(backing.subarray(SAMPLES_PER_FRAME / 2, (3 * SAMPLES_PER_FRAME) / 2)),
    );
  });
});
