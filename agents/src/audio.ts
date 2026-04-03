// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { AudioFrame } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import { log } from './log.js';
import { Chan, ChanClosed } from './stream/chan.js';
import { type AudioBuffer, isFfmpegTeardownError } from './utils.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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
  #sampleRate: number;
  #numChannels: number;
  #bytesPerFrame: number;
  #buf: Int8Array;
  #logger = log();

  constructor(sampleRate: number, numChannels: number, samplesPerChannel: number | null = null) {
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;

    if (samplesPerChannel === null) {
      samplesPerChannel = Math.floor(sampleRate / 10); // 100ms by default
    }

    this.#bytesPerFrame = numChannels * samplesPerChannel * 2; // 2 bytes per sample (Int16)
    this.#buf = new Int8Array();
  }

  write(data: ArrayBufferLike | ArrayBufferView): AudioFrame[] {
    const bytes = ArrayBuffer.isView(data)
      ? new Int8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Int8Array(data);
    this.#buf = new Int8Array([...this.#buf, ...bytes]);

    const frames: AudioFrame[] = [];
    while (this.#buf.length >= this.#bytesPerFrame) {
      const frameData = this.#buf.slice(0, this.#bytesPerFrame);
      this.#buf = this.#buf.slice(this.#bytesPerFrame);

      frames.push(
        new AudioFrame(
          new Int16Array(frameData.buffer),
          this.#sampleRate,
          this.#numChannels,
          frameData.length / 2,
        ),
      );
    }

    return frames;
  }

  flush(): AudioFrame[] {
    if (this.#buf.length % (2 * this.#numChannels) !== 0) {
      this.#logger.warn('AudioByteStream: incomplete frame during flush, dropping');
      return [];
    }

    const frames = [
      new AudioFrame(
        new Int16Array(this.#buf.buffer),
        this.#sampleRate,
        this.#numChannels,
        this.#buf.length / 2,
      ),
    ];

    this.#buf = new Int8Array(); // Clear buffer after flushing
    return frames;
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
): AsyncIterable<AudioFrame> {
  const sampleRate = options.sampleRate ?? 48000;
  const numChannels = options.numChannels ?? 1;

  const audioStream = new AudioByteStream(sampleRate, numChannels);
  const chan = new Chan<AudioFrame>();
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

    chan.close();
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
      try {
        chan.sendNowait(frame);
      } catch (e) {
        if (e instanceof ChanClosed) return;
        throw e;
      }
    }
  });

  outputStream.on('end', () => {
    const frames = audioStream.flush();
    for (const frame of frames) {
      try {
        chan.sendNowait(frame);
      } catch (e) {
        if (e instanceof ChanClosed) return;
        throw e;
      }
    }
    commandRunning = false;
    chan.close();
  });

  outputStream.on('error', (err: Error) => {
    logger.error(err);
    commandRunning = false;
    onClose();
  });

  return chan;
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
