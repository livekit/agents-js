// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { AudioFrame } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import type { ReadableStream } from 'node:stream/web';
import { AudioByteStream } from '../audio.js';
import { log } from '../log.js';
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
  abortSignal?: AbortSignal;
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
export function audioFramesFromFile(
  filePath: string,
  options: AudioStreamDecoderOptions = {},
  abortSignal?: AbortSignal,
): ReadableStream<AudioFrame> {
  const sampleRate = options.sampleRate ?? 48000;
  const numChannels = options.numChannels ?? 1;

  const audioStream = new AudioByteStream(sampleRate, numChannels);
  const channel = createStreamChannel<AudioFrame>();
  const logger = log();
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

  let commandRunning = true;

  const onClose = () => {
    logger.debug('Audio file playback aborted');

    channel.close();
    if (commandRunning) {
      commandRunning = false;
      command.kill('SIGKILL');
    }
  };

  const outputStream = command.pipe();
  options.abortSignal?.addEventListener('abort', onClose, { once: true });

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
    commandRunning = false;
    channel.close();
  });

  outputStream.on('error', (err: Error) => {
    logger.error(err);
    commandRunning = false;
    onClose();
  });

  return channel.stream();
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
  const logger = log();

  for await (const frame of audioFramesFromFile(filePath, options)) {
    frames.push(frame);
    yield frame;
  }

  while (!options.abortSignal?.aborted) {
    for (const frame of frames) {
      yield frame;
    }
  }

  logger.debug('Audio file playback loop finished');
}
