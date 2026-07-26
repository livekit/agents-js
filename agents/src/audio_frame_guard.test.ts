// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asAudioFrame, describeUnknownChunk, isAudioFrameShaped } from './audio_frame_guard.js';
import { initializeLogger, log } from './log.js';

initializeLogger({ pretty: false, level: 'silent' });

/** An audio frame built by a second copy of `@livekit/rtc-node`: same shape, other constructor. */
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

/**
 * A fresh copy of the module, so the once-per-process report can be observed from its initial
 * state. `log()` reads a `globalThis` singleton, so the logger survives the module reset and the
 * spy below still sees the call.
 */
async function freshGuard() {
  vi.resetModules();
  return import('./audio_frame_guard.js');
}

describe('audio frame guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a genuine AudioFrame through untouched', () => {
    const frame = new AudioFrame(new Int16Array(160), 16000, 1, 160);
    expect(asAudioFrame(frame)).toBe(frame);
  });

  it('rebuilds a frame from another copy of the module as one of ours', () => {
    const data = new Int16Array([1, -2, 3, -4]);
    const foreign = new ForeignAudioFrame(data, 16000, 1, 4, { tag: 'kept' });

    const frame = asAudioFrame(foreign as unknown as AudioFrame);

    expect(frame).toBeInstanceOf(AudioFrame);
    expect(frame!.sampleRate).toBe(16000);
    expect(frame!.channels).toBe(1);
    expect(frame!.samplesPerChannel).toBe(4);
    // The same samples, not a copy of them — rebuilding must not cost an allocation per frame.
    expect(frame!.data).toBe(data);
    expect(frame!.userdata).toEqual({ tag: 'kept' });
  });

  it('reports the duplicate module loudly, once per process', async () => {
    const { asAudioFrame: freshAsAudioFrame } = await freshGuard();
    const errorSpy = vi.spyOn(log(), 'error').mockImplementation(() => undefined as never);

    const foreign = () =>
      new ForeignAudioFrame(new Int16Array(160), 16000, 1, 160) as unknown as AudioFrame;
    freshAsAudioFrame(foreign());
    freshAsAudioFrame(foreign());
    freshAsAudioFrame(foreign());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]![1]);
    expect(message).toContain('@livekit/rtc-node is loaded twice');
    expect(message).toContain('instanceof AudioFrame');
    expect(message).toContain('backchannel');
  });

  it('does not mistake sentinels or other values for audio', () => {
    expect(asAudioFrame({ type: 'flush' })).toBeUndefined();
    expect(asAudioFrame(null)).toBeUndefined();
    expect(asAudioFrame('frame')).toBeUndefined();
    // Shaped like a frame but carrying no buffer.
    expect(asAudioFrame({ sampleRate: 16000, samplesPerChannel: 1, channels: 1 })).toBeUndefined();
    expect(
      isAudioFrameShaped({
        sampleRate: 16000,
        samplesPerChannel: 1,
        channels: 1,
        data: new DataView(new ArrayBuffer(2)),
      }),
    ).toBe(false);
  });

  it('describes an unrecognised chunk without throwing on it', () => {
    expect(describeUnknownChunk({ type: 'mystery' })).toEqual({
      chunkType: 'object',
      chunkConstructor: 'Object',
      chunkTag: 'mystery',
    });
    expect(describeUnknownChunk(undefined)).toEqual({
      chunkType: 'undefined',
      chunkConstructor: null,
      chunkTag: null,
    });
    expect(describeUnknownChunk(Object.create(null))).toEqual({
      chunkType: 'object',
      chunkConstructor: null,
      chunkTag: null,
    });
  });
});
