// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { adoptLocalAudioFrame } from './_frame_identity.js';

/**
 * Stands in for the `AudioFrame` of a second copy of `@livekit/rtc-node`: identical shape, same
 * constructor name, unrelated identity. That is exactly what the CJS build produces when the
 * Cloud backend pulls it in through `createRequire`.
 */
class ForeignAudioFrame {
  constructor(
    readonly data: Int16Array,
    readonly sampleRate: number,
    readonly channels: number,
    readonly samplesPerChannel: number,
    private readonly _userdata: Record<string, unknown> = {},
  ) {}

  get userdata(): Record<string, unknown> {
    return this._userdata;
  }
}

describe('adoptLocalAudioFrame', () => {
  it('adopts a frame built by another copy of rtc-node', () => {
    const samples = new Int16Array([1, -2, 3, -4]);
    const foreign = new ForeignAudioFrame(samples, 16000, 1, 4, { source: 'krisp' });

    // The premise of the bug: this lookalike fails the identity check every consumer relies on.
    expect(foreign instanceof AudioFrame).toBe(false);

    const adopted = adoptLocalAudioFrame(foreign as unknown as AudioFrame);

    expect(adopted instanceof AudioFrame).toBe(true);
    expect(adopted.sampleRate).toBe(16000);
    expect(adopted.channels).toBe(1);
    expect(adopted.samplesPerChannel).toBe(4);
    expect(adopted.userdata).toEqual({ source: 'krisp' });
    // Adopting must not copy the audio: this runs on every frame of every session.
    expect(adopted.data).toBe(samples);
  });

  it('returns a local frame untouched', () => {
    const local = new AudioFrame(new Int16Array([5, 6]), 48000, 1, 2);

    expect(adoptLocalAudioFrame(local)).toBe(local);
  });
});
