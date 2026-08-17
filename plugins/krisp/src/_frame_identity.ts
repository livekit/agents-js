// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';

/**
 * Return a frame that belongs to *this* copy of `@livekit/rtc-node`.
 *
 * The Cloud backend is reached through `createRequire`, which resolves the internal package's
 * `require` condition and so loads the CJS build of `@livekit/rtc-node` next to our ESM one.
 * Frames it hands back are instances of that copy's `AudioFrame`, so `instanceof AudioFrame`
 * fails everywhere downstream: audio recognition treats them as unrecognised sentinels and
 * drops them, and adaptive interruption — never fed any audio — rules every barge-in a
 * backchannel. `AudioFrame` is a plain data holder, so adopting one shares its samples rather
 * than copying them.
 */
export function adoptLocalAudioFrame(frame: AudioFrame): AudioFrame {
  if (frame instanceof AudioFrame) {
    return frame;
  }

  // Statically unreachable — the declared type *is* `AudioFrame`. It is reachable at runtime
  // precisely because that type came from a different copy of the module.
  const foreign = frame as unknown as {
    data: Int16Array;
    sampleRate: number;
    channels: number;
    samplesPerChannel: number;
    userdata?: Record<string, unknown>;
  };

  return new AudioFrame(
    foreign.data,
    foreign.sampleRate,
    foreign.channels,
    foreign.samplesPerChannel,
    foreign.userdata,
  );
}
