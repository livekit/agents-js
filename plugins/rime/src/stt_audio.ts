// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, type AudioBuffer } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';

export function validateFrame(frame: AudioFrame): void {
  if (
    !(frame instanceof AudioFrame) ||
    !Number.isInteger(frame.sampleRate) ||
    frame.sampleRate <= 0 ||
    !Number.isInteger(frame.channels) ||
    frame.channels <= 0 ||
    !Number.isInteger(frame.samplesPerChannel) ||
    frame.samplesPerChannel < 0 ||
    !(frame.data instanceof Int16Array) ||
    frame.data.length !== frame.samplesPerChannel * frame.channels
  ) {
    throw new APIError('Invalid audio buffer for Rime STT', { retryable: false });
  }
}

export function pcmBytes(frame: AudioFrame): Buffer {
  const bytes = Buffer.alloc(frame.data.length * 2);
  for (let i = 0; i < frame.data.length; i++) bytes.writeInt16LE(frame.data[i]!, i * 2);
  return bytes;
}

/** Complete PCM16 mono 16 kHz WAV, including the resampler's buffered tail. */
export function toWav(audio: AudioBuffer): Buffer {
  let resampler: AudioResampler | undefined;
  try {
    const frames = Array.isArray(audio) ? audio : [audio];
    if (!frames.length) throw new Error();
    const first = frames[0]!;
    const chunks: Buffer[] = [];
    let samples = 0;
    for (const frame of frames) {
      validateFrame(frame);
      if (frame.sampleRate !== first.sampleRate || frame.channels !== first.channels)
        throw new Error();
      samples += frame.samplesPerChannel;
      const data = new Int16Array(frame.samplesPerChannel);
      for (let i = 0; i < data.length; i++) {
        let sum = 0;
        for (let c = 0; c < frame.channels; c++) sum += frame.data[i * frame.channels + c]!;
        data[i] = Math.trunc(sum / frame.channels);
      }
      const mono = new AudioFrame(data, frame.sampleRate, 1, data.length);
      if (frame.sampleRate === 16000) chunks.push(pcmBytes(mono));
      else {
        resampler ??= new AudioResampler(frame.sampleRate, 16000, 1);
        chunks.push(...resampler.push(mono).map(pcmBytes));
      }
    }
    if (!samples) throw new Error();
    if (resampler) chunks.push(...resampler.flush().map(pcmBytes));
    const pcm = Buffer.concat(chunks);
    if (!pcm.length || pcm.length + 44 > 16 * 1024 * 1024) throw new Error();
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  } catch {
    throw new APIError('Invalid audio buffer for Rime STT (maximum WAV size: 16 MiB)', {
      retryable: false,
    });
  } finally {
    resampler?.close();
  }
}
