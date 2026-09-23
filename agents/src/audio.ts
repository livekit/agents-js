// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import type { ReadableStream } from 'node:stream/web';
import { configureFfmpeg } from './ffmpeg.js';
import { log } from './log.js';
import { createStreamChannel } from './stream/stream_channel.js';
import { type AudioBuffer, isFfmpegTeardownError } from './utils.js';

configureFfmpeg();

export interface AudioDecodeOptions {
  sampleRate?: number;
  numChannels?: number;
  /**
   * Audio format hint (e.g., 'mp3', 'ogg', 'wav', 'opus')
   * If not provided, FFmpeg will auto-detect
   */
  format?: string;
  abortSignal?: AbortSignal;
}

export function calculateAudioDurationSeconds(frame: AudioBuffer) {
  // TODO(AJS-102): use frame.durationMs once available in rtc-node
  return Array.isArray(frame)
    ? frame.reduce((sum, a) => sum + a.samplesPerChannel / a.sampleRate, 0)
    : frame.samplesPerChannel / frame.sampleRate;
}

/** AudioByteStream translates between LiveKit AudioFrame packets and raw byte data. */
export class AudioByteStream {
  static readonly #MIN_PROGRESSIVE_MS = 20;

  #sampleRate: number;
  #numChannels: number;
  #bytesPerSample: number;
  #targetBytesPerFrame: number;
  #initialBytesPerFrame: number;
  #currentBytesPerFrame: number;
  #buf: Int8Array;

  constructor(
    sampleRate: number,
    numChannels: number,
    samplesPerChannel: number | null = null,
    progressive = false,
  ) {
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;

    if (samplesPerChannel === null) {
      samplesPerChannel = Math.floor(sampleRate / 10); // 100ms by default
    }

    this.#bytesPerSample = numChannels * 2; // 2 bytes per sample (Int16)
    this.#targetBytesPerFrame = samplesPerChannel * this.#bytesPerSample;
    this.#initialBytesPerFrame = progressive
      ? Math.min(
          Math.floor((sampleRate * AudioByteStream.#MIN_PROGRESSIVE_MS) / 1000) *
            this.#bytesPerSample,
          this.#targetBytesPerFrame,
        )
      : this.#targetBytesPerFrame;
    this.#currentBytesPerFrame = this.#initialBytesPerFrame;
    this.#buf = new Int8Array();
  }

  write(data: ArrayBufferLike | ArrayBufferView): AudioFrame[] {
    const bytes = ArrayBuffer.isView(data)
      ? new Int8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Int8Array(data);
    this.#buf = new Int8Array([...this.#buf, ...bytes]);

    const frames: AudioFrame[] = [];
    while (this.#buf.length >= this.#currentBytesPerFrame) {
      const frameData = this.#buf.slice(0, this.#currentBytesPerFrame);
      this.#buf = this.#buf.slice(this.#currentBytesPerFrame);

      frames.push(
        new AudioFrame(
          new Int16Array(frameData.buffer),
          this.#sampleRate,
          this.#numChannels,
          frameData.length / this.#bytesPerSample,
        ),
      );

      if (this.#currentBytesPerFrame < this.#targetBytesPerFrame) {
        this.#currentBytesPerFrame = Math.min(
          this.#currentBytesPerFrame * 2,
          this.#targetBytesPerFrame,
        );
      }
    }

    return frames;
  }

  /** Seconds of audio waiting for the next frame. */
  get bufferedDuration(): number {
    return this.#buf.length / this.#bytesPerSample / this.#sampleRate;
  }

  /** Emit complete samples while retaining any trailing partial sample. */
  flush(): AudioFrame[] {
    if (this.#buf.length === 0) {
      return [];
    }

    const remainder = this.#buf.length % this.#bytesPerSample;
    const completeBytes = this.#buf.length - remainder;
    if (completeBytes === 0) {
      return [];
    }

    const frameData = this.#buf.slice(0, completeBytes);
    const frames = [
      new AudioFrame(
        new Int16Array(frameData.buffer),
        this.#sampleRate,
        this.#numChannels,
        completeBytes / this.#bytesPerSample,
      ),
    ];

    this.#buf = this.#buf.slice(completeBytes);
    return frames;
  }

  /** Reset progressive frame sizing without discarding buffered audio. */
  resetProgressive(): void {
    this.#currentBytesPerFrame = this.#initialBytesPerFrame;
  }

  /** Discard buffered audio and reset progressive frame sizing. */
  clear(): void {
    this.#buf = new Int8Array();
    this.resetProgressive();
  }
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
  options: AudioDecodeOptions = {},
): ReadableStream<AudioFrame> {
  const sampleRate = options.sampleRate ?? 48000;
  const numChannels = options.numChannels ?? 1;

  const audioStream = new AudioByteStream(sampleRate, numChannels);
  const channel = createStreamChannel<AudioFrame>();
  const logger = log();

  // TODO (Brian): decode WAV using a custom decoder instead of FFmpeg
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

  command.on('error', (err: Error) => {
    if (isFfmpegTeardownError(err)) {
      // Expected during teardown — not an error
      logger.debug('FFmpeg command ended during shutdown');
    } else {
      logger.error(err, 'FFmpeg command error');
    }
    commandRunning = false;
    onClose();
  });

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
  options: AudioDecodeOptions = {},
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
