// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioBuffer } from '@livekit/agents';
import { AudioFrame, combineAudioFrames } from '@livekit/rtc-node';

const WAV_HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Encode a LiveKit `AudioBuffer` (single frame or array) into a standard
 * PCM16 WAV byte stream suitable for uploading to the Speko `/v1/transcribe`
 * endpoint (which defaults to `audio/wav`).
 *
 * v1 constraint: mono only. Multi-channel frames throw so that a confusing
 * downstream routing failure turns into a clear error at the plugin boundary.
 *
 * @public
 */
export function framesToWav(buffer: AudioBuffer): Uint8Array {
  const merged = combineAudioFrames(buffer);
  if (merged.channels !== 1) {
    throw new Error(
      `speko.STT: expected mono audio (1 channel), got ${merged.channels}. ` +
        `Configure your LiveKit AgentSession to pass mono audio or pre-mix ` +
        `upstream of the STT.`,
    );
  }

  const pcm = merged.data;
  const dataByteLength = pcm.byteLength;
  const totalByteLength = WAV_HEADER_BYTES + dataByteLength;
  const out = new Uint8Array(totalByteLength);
  const view = new DataView(out.buffer);
  const byteRate = (merged.sampleRate * merged.channels * BITS_PER_SAMPLE) / 8;
  const blockAlign = (merged.channels * BITS_PER_SAMPLE) / 8;

  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, totalByteLength - 8, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, merged.channels, true);
  view.setUint32(24, merged.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  out.set(pcmBytes, WAV_HEADER_BYTES);

  return out;
}

/**
 * Parse a PCM16 WAV byte stream, returning `{ pcm, sampleRate, channels }`.
 * Used by the TTS path to unwrap a WAV-formatted proxy response into raw
 * samples that can be fed into `AudioByteStream`.
 *
 * Only the minimal subset of the WAV spec we need: PCM format, 16-bit samples,
 * a `fmt ` chunk and a `data` chunk in that order. Non-conforming inputs throw.
 *
 * @public
 */
export function parseWav(bytes: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
} {
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    throw new Error(`speko.TTS: WAV response too small (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('speko.TTS: not a RIFF/WAVE stream');
  }
  if (readAscii(bytes, 12, 4) !== 'fmt ') {
    throw new Error('speko.TTS: missing `fmt ` chunk');
  }
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== PCM_FORMAT) {
    throw new Error(`speko.TTS: unsupported WAV format ${audioFormat}, expected PCM (1)`);
  }
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== BITS_PER_SAMPLE) {
    throw new Error(`speko.TTS: unsupported WAV bit depth ${bitsPerSample}, expected 16`);
  }

  const fmtChunkSize = view.getUint32(16, true);
  let cursor = 20 + fmtChunkSize;
  while (cursor + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const chunkStart = cursor + 8;
    if (chunkId === 'data') {
      const pcm = bytes.subarray(chunkStart, chunkStart + chunkSize);
      return { pcm, sampleRate, channels };
    }
    cursor = chunkStart + chunkSize;
  }
  throw new Error('speko.TTS: WAV stream missing `data` chunk');
}

/**
 * Parse the `rate` parameter from a `audio/pcm;rate=NNNN` content type, which
 * is what Cartesia returns via the Speko proxy. Falls back to the supplied
 * default when the rate is missing or unparseable.
 *
 * @public
 */
export function pcmSampleRateFromContentType(contentType: string, fallback: number): number {
  const match = contentType.match(/rate=(\d+)/i);
  if (!match || match[1] === undefined) return fallback;
  const rate = parseInt(match[1], 10);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    buf[offset + i] = text.charCodeAt(i);
  }
}

function readAscii(buf: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(buf[offset + i] ?? 0);
  }
  return out;
}

/**
 * Build a canned `AudioFrame` for tests. Exported for use from spec files -
 * the plugin's runtime code never calls this directly.
 */
export function createTestFrame(options: {
  samples: Int16Array;
  sampleRate: number;
  channels?: number;
}): AudioFrame {
  const channels = options.channels ?? 1;
  return new AudioFrame(
    options.samples,
    options.sampleRate,
    channels,
    options.samples.length / channels,
  );
}
