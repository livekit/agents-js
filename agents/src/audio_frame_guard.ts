// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { log } from './log.js';

/**
 * The structural half of an {@link AudioFrame}: every field the framework reads off a frame, and
 * every argument the constructor needs to rebuild one.
 */
interface AudioFrameShape {
  data: ArrayBufferView;
  sampleRate: number;
  samplesPerChannel: number;
  channels: number;
}

/**
 * True for anything carrying an audio frame's payload, whichever copy of `@livekit/rtc-node`
 * built it.
 *
 * `value instanceof AudioFrame` answers a narrower question — "did *this* copy of the module
 * build it" — and routing audio on that answer is what makes a duplicated dependency look like
 * silence rather than an error.
 */
export function isAudioFrameShaped(value: unknown): value is AudioFrameShape {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AudioFrameShape>;
  return (
    typeof candidate.sampleRate === 'number' &&
    typeof candidate.samplesPerChannel === 'number' &&
    typeof candidate.channels === 'number' &&
    ArrayBuffer.isView(candidate.data) &&
    !(candidate.data instanceof DataView)
  );
}

let duplicateRtcNodeReported = false;

/**
 * Announce, once per process, that a frame arrived from a second copy of `@livekit/rtc-node`.
 *
 * There is no way to notice the duplicate before a frame crosses the boundary: the other copy is
 * loaded by the application, not by us, so nothing at import time can see it. The first frame of
 * the first session is therefore the earliest possible signal — and it is early, arriving within
 * milliseconds of the session starting and long before any interruption verdict.
 */
function reportDuplicateRtcNode(frame: AudioFrameShape): void {
  if (duplicateRtcNodeReported) return;
  duplicateRtcNodeReported = true;
  log().error(
    {
      frameConstructor: (frame as object).constructor?.name ?? null,
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      samplesPerChannel: frame.samplesPerChannel,
    },
    '@livekit/rtc-node is loaded twice in this process. An audio frame arrived with the exact ' +
      'shape of an AudioFrame but was built by a different copy of the module, so ' +
      '`frame instanceof AudioFrame` is false inside @livekit/agents. Unhandled, that silently ' +
      'discards every audio frame: adaptive interruption stops receiving audio and reports every ' +
      'overlap as a backchannel, so the agent never yields to the user. The frame has been ' +
      'converted and accepted so audio keeps flowing, but the duplicate must be removed — run ' +
      '`npm ls @livekit/rtc-node` (or `pnpm why @livekit/rtc-node`) to find both copies and ' +
      'collapse them onto one install with `pnpm dedupe`, an npm `overrides` / pnpm `resolutions` ' +
      'entry, or, if you have linked a local @livekit/agents checkout, by linking its ' +
      '@livekit/rtc-node as well. Reported once per process.',
  );
}

function asInt16Array(data: ArrayBufferView): Int16Array {
  if (data instanceof Int16Array) return data;
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
}

/**
 * Return `value` as an {@link AudioFrame} this module's `@livekit/rtc-node` owns, or `undefined`
 * if it is not audio at all.
 *
 * A frame from a second copy of the module is rebuilt rather than passed through. That is not
 * cosmetic: `AudioResampler.push()` calls `frame.protoInfo()`, which resolves pointers through
 * the frame's own `FfiClient` singleton, so handing a foreign frame to a local resampler mixes
 * two FFI runtimes. Rebuilding is a plain object allocation over the same sample buffer — no
 * copy — and leaves every downstream consumer holding a frame whose native side matches ours.
 */
export function asAudioFrame(value: unknown): AudioFrame | undefined {
  if (value instanceof AudioFrame) return value;
  if (!isAudioFrameShaped(value)) return undefined;

  reportDuplicateRtcNode(value);

  const userdata = (value as { userdata?: unknown }).userdata;
  return new AudioFrame(
    asInt16Array(value.data),
    value.sampleRate,
    value.channels,
    value.samplesPerChannel,
    typeof userdata === 'object' && userdata !== null
      ? (userdata as Record<string, unknown>)
      : undefined,
  );
}

/** Log-safe description of a value that reached a branch nothing knows how to handle. */
export function describeUnknownChunk(chunk: unknown): {
  chunkType: string;
  chunkConstructor: string | null;
  chunkTag: string | null;
} {
  if (typeof chunk !== 'object' || chunk === null) {
    return { chunkType: typeof chunk, chunkConstructor: null, chunkTag: null };
  }
  const tag = (chunk as { type?: unknown }).type;
  return {
    chunkType: 'object',
    chunkConstructor: chunk.constructor?.name ?? null,
    chunkTag: typeof tag === 'string' ? tag : null,
  };
}
