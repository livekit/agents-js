// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { AudioFrame } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'node:stream';
import { AudioByteStream } from '../audio.js';
import { createStreamChannel } from '../stream/stream_channel.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface AudioStreamDecoderOptions {
  sampleRate?: number;
  numChannels?: number;
  /**
   * Audio format hint (e.g., 'mp3', 'ogg', 'wav', 'opus')
   * If not provided, FFmpeg will auto-detect
   */
  format?: string;
}

/**
 * Decode an audio file into AudioFrame instances
 *
 * @param filePath - Path to the audio file
 * @param options - Decoding options
 * @returns AsyncGenerator that yields AudioFrame objects
 *
 * @example
 * ```typescript
 * for await (const frame of audioFramesFromFile('audio.ogg', { sampleRate: 48000 })) {
 *   console.log('Frame:', frame.samplesPerChannel, 'samples');
 * }
 * ```
 */
export async function* audioFramesFromFile(
  filePath: string,
  options: AudioStreamDecoderOptions = {},
): AsyncGenerator<AudioFrame, void, unknown> {
  const sampleRate = options.sampleRate ?? 48000;
  const numChannels = options.numChannels ?? 1;

  const audioStream = new AudioByteStream(sampleRate, numChannels);
  const channel = createStreamChannel<AudioFrame>();

  let ffmpegError: Error | null = null;

  const command = ffmpeg(filePath)
    .inputOptions([
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      '-fflags',
      '+nobuffer+flush_packets',
      '-flags',
      'low_delay',
    ])
    .format('s16le') // signed 16-bit little-endian PCM to be consistent cross-platform
    .audioChannels(numChannels)
    .audioFrequency(sampleRate);

  const outputStream = command.pipe() as Readable;

  outputStream.on('data', (chunk: Buffer) => {
    const arrayBuffer = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;

    const frames = audioStream.write(arrayBuffer);
    for (const frame of frames) {
      channel.write(frame);
    }
  });

  outputStream.on('end', () => {
    const frames = audioStream.flush();
    for (const frame of frames) {
      channel.write(frame);
    }
    channel.close();
  });

  outputStream.on('error', (err: Error) => {
    ffmpegError = err;
    channel.close();
  });

  try {
    for await (const frame of channel.stream()) {
      if (ffmpegError) throw ffmpegError;
      yield frame;
    }
  } finally {
    channel.close();
  }
}

/**
 * Loop audio frames from a file indefinitely
 *
 * @param filePath - Path to the audio file
 * @param options - Decoding options
 * @returns AsyncGenerator that yields AudioFrame objects in an infinite loop
 */
export async function* loopAudioFramesFromFile(
  filePath: string,
  options: AudioStreamDecoderOptions = {},
): AsyncGenerator<AudioFrame, void, unknown> {
  const frames: AudioFrame[] = [];
  for await (const frame of audioFramesFromFile(filePath, options)) {
    frames.push(frame);
    yield frame;
  }

  while (true) {
    for (const frame of frames) {
      yield frame;
    }
  }
}
