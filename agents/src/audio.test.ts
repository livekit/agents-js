// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { AudioByteStream } from './audio.js';
import { mergeFrames } from './utils.js';

const pcm = (length: number, start = 0) => Int16Array.from({ length }, (_, i) => start + i);

describe('AudioByteStream', () => {
  it('reassembles frames from writes that do not align with frame boundaries', () => {
    const samples = pcm(1000);
    const bytes = new Uint8Array(samples.buffer);
    const bstream = new AudioByteStream(16000, 1, 160);

    const frames: AudioFrame[] = [];
    let pos = 0;
    for (const size of [1, 77, 320, 3, 1000, 599]) {
      frames.push(...bstream.write(bytes.subarray(pos, pos + size)));
      pos += size;
    }

    // 2000 bytes = 1000 samples -> 6 full frames of 160 samples, 40 samples left over
    expect(pos).toBe(bytes.length);
    expect(frames).toHaveLength(6);
    for (const frame of frames) {
      expect(frame.samplesPerChannel).toBe(160);
    }
    const out = mergeFrames(frames).data;
    expect(Array.from(out)).toEqual(Array.from(samples.subarray(0, 960)));
    expect(Array.from(bstream.flush()[0]!.data)).toEqual(Array.from(samples.subarray(960)));
  });

  it('keeps the remainder for flush', () => {
    const bstream = new AudioByteStream(16000, 1, 160);
    expect(bstream.write(pcm(100).buffer)).toHaveLength(0);
    const flushed = bstream.flush();
    expect(flushed).toHaveLength(1);
    expect(Array.from(flushed[0]!.data)).toEqual(Array.from(pcm(100)));
  });
});

describe('mergeFrames', () => {
  it('concatenates frame data in order', () => {
    const a = new AudioFrame(pcm(4), 16000, 2, 2);
    const b = new AudioFrame(pcm(6, 4), 16000, 2, 3);
    const merged = mergeFrames([a, b]);
    expect(Array.from(merged.data)).toEqual(Array.from(pcm(10)));
    expect(merged.samplesPerChannel).toBe(5);
    expect(merged.channels).toBe(2);
    expect(merged.sampleRate).toBe(16000);
  });

  it('rejects mismatched frames', () => {
    const a = new AudioFrame(pcm(2), 16000, 1, 2);
    expect(() => mergeFrames([a, new AudioFrame(pcm(2), 24000, 1, 2)])).toThrow(
      'sample rate mismatch',
    );
    expect(() => mergeFrames([a, new AudioFrame(pcm(4), 16000, 2, 2)])).toThrow(
      'channel count mismatch',
    );
  });
});
