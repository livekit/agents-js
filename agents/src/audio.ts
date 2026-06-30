// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { configureFfmpeg } from './ffmpeg.js';
import { log } from './log.js';
import { type StreamChannel, createStreamChannel } from './stream/stream_channel.js';
import { type AudioBuffer, isFfmpegTeardownError } from './utils.js';

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
): ReadableStream<AudioFrame> {
  const sampleRate = options.sampleRate ?? 48000;
  const numChannels = options.numChannels ?? 1;

  const audioStream = new AudioByteStream(sampleRate, numChannels);
  const channel = createStreamChannel<AudioFrame>();
  const logger = log();

  let command: ffmpeg.FfmpegCommand | undefined;
  let commandRunning = true;
  let aborted = false;

  const onClose = () => {
    logger.debug('Audio file playback aborted');

    channel.close();
    if (commandRunning) {
      commandRunning = false;
      command?.kill('SIGKILL');
    }
  };

  const onAbort = () => {
    aborted = true;
    onClose();
  };
  // An already-aborted signal never fires 'abort', so handle that case up front.
  if (options.abortSignal?.aborted) {
    onAbort();
  } else {
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
  }

  // Resolve (and if necessary download) the ffmpeg binary lazily, then start decoding. The
  // stream is returned synchronously; frames begin flowing once ffmpeg is configured.
  void (async () => {
    await configureFfmpeg();
    if (aborted) return;

    // TODO (Brian): decode WAV using a custom decoder instead of FFmpeg
    command = ffmpeg(filePath)
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
  })().catch((err: unknown) => {
    logger.error({ err }, 'failed to start ffmpeg audio decoding');
    commandRunning = false;
    channel.close();
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

/** Maps common audio MIME types to the ffmpeg input format / demuxer name. */
const MIME_TO_FORMAT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/opus': 'ogg',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

export interface AudioStreamDecoderOptions {
  /** Output sample rate in Hz. Defaults to 48000. */
  sampleRate?: number;
  /** Output channel count. Defaults to 1. */
  numChannels?: number;
  /** ffmpeg input format/demuxer hint (e.g. `'mp3'`, `'ogg'`, `'flac'`, `'wav'`). */
  format?: string;
  /** Audio MIME type, mapped to an input format. Ignored if `format` is set. */
  mimeType?: string;
}

/**
 * Streaming audio decoder: push compressed (or WAV) bytes in, async-iterate decoded PCM
 * `AudioFrame`s out. Unlike {@link audioFramesFromFile}, the input is a byte stream — decode
 * a TTS/network audio segment incrementally without writing it to disk first.
 *
 * 16-bit PCM WAV is decoded in pure JS (no subprocess). Every other format is decoded by
 * piping the bytes through the bundled ffmpeg binary. Only royalty-free codecs the bundled
 * binary ships are supported (mp3, flac, vorbis, opus/ogg, wav, alac); AAC is not.
 *
 * @example
 * ```typescript
 * const decoder = new AudioStreamDecoder({ mimeType: 'audio/mpeg', sampleRate: 24000 });
 * for await (const chunk of ttsByteStream) decoder.pushChunk(chunk);
 * decoder.endInput();
 * for await (const frame of decoder) playout(frame);
 * ```
 */
export class AudioStreamDecoder {
  #sampleRate: number;
  #numChannels: number;
  #format?: string;
  #channel: StreamChannel<AudioFrame> = createStreamChannel<AudioFrame>();
  #logger = log();

  // Routing is decided once, from the format hint or by sniffing the first bytes.
  #route?: 'wav' | 'ffmpeg';
  #sniffBuf: Buffer = Buffer.alloc(0);
  #ended = false;
  #closed = false;

  // ffmpeg path
  #ffInput?: PassThrough;

  // WAV inline path
  #wav?: WavInlineDecoder;

  constructor(opts: AudioStreamDecoderOptions = {}) {
    this.#sampleRate = opts.sampleRate ?? 48000;
    this.#numChannels = opts.numChannels ?? 1;
    this.#format =
      opts.format ?? (opts.mimeType ? MIME_TO_FORMAT[opts.mimeType.toLowerCase()] : undefined);
  }

  /** Feed the next chunk of encoded (or WAV) bytes. */
  pushChunk(chunk: Uint8Array): void {
    if (this.#closed || this.#ended) return;
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (this.#route === undefined) {
      this.#decideRoute(buf);
      return;
    }
    if (this.#route === 'wav') {
      this.#wav!.push(buf);
    } else {
      this.#ffInput!.write(buf);
    }
  }

  /** Signal end of input. The frame stream completes once decoding drains. */
  endInput(): void {
    if (this.#closed || this.#ended) return;
    this.#ended = true;
    if (this.#route === undefined) {
      // Never got enough bytes to sniff; treat what we have as an ffmpeg input.
      this.#startFfmpeg(this.#format, this.#sniffBuf);
    }
    if (this.#route === 'wav') {
      this.#wav!.end();
    } else {
      this.#ffInput!.end();
    }
  }

  /** Decoded PCM frames at the requested sample rate / channel count. */
  stream(): ReadableStream<AudioFrame> {
    return this.#channel.stream();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AudioFrame> {
    return this.stream()[Symbol.asyncIterator]();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#ffInput?.destroy();
    await this.#channel.close().catch(() => {});
  }

  #decideRoute(buf: Buffer): void {
    // Explicit non-wav format → straight to ffmpeg, no sniffing needed.
    if (this.#format && this.#format !== 'wav') {
      this.#startFfmpeg(this.#format, buf);
      return;
    }

    this.#sniffBuf = Buffer.concat([this.#sniffBuf, buf]);
    const isWav =
      this.#format === 'wav' ||
      (this.#sniffBuf.length >= 12 &&
        this.#sniffBuf.toString('ascii', 0, 4) === 'RIFF' &&
        this.#sniffBuf.toString('ascii', 8, 12) === 'WAVE');

    if (isWav) {
      // WAV needs ≥12 bytes to confirm and parse; wait for more if a hint forced wav.
      if (this.#sniffBuf.length < 12) return;
      this.#startWav(this.#sniffBuf);
    } else if (this.#sniffBuf.length >= 12) {
      // Enough bytes to know it isn't WAV → let ffmpeg probe the container.
      this.#startFfmpeg(this.#format, this.#sniffBuf);
    }
    // else: not enough bytes yet, keep buffering.
  }

  #startWav(initial: Buffer): void {
    this.#route = 'wav';
    this.#wav = new WavInlineDecoder({
      sampleRate: this.#sampleRate,
      numChannels: this.#numChannels,
      emit: (frame) => void this.#channel.write(frame).catch(() => {}),
      done: () => void this.#channel.close().catch(() => {}),
      error: (err) => void this.#channel.abort(err).catch(() => {}),
      // A WAV shape the inline decoder can't handle (non-PCM, >2ch) falls back to ffmpeg.
      fallback: (pending) => {
        this.#wav = undefined;
        this.#startFfmpeg('wav', pending);
        if (this.#ended) this.#ffInput!.end();
      },
    });
    this.#wav.push(initial);
  }

  #startFfmpeg(inputFormat: string | undefined, initial: Buffer): void {
    this.#route = 'ffmpeg';
    const input = new PassThrough();
    this.#ffInput = input;
    if (initial.length > 0) input.write(initial);

    const audioStream = new AudioByteStream(this.#sampleRate, this.#numChannels);

    // configureFfmpeg() resolves/downloads the binary lazily; the PassThrough buffers input
    // until ffmpeg attaches as a consumer.
    void configureFfmpeg()
      .then(() => {
        if (this.#closed) return;
        let command = ffmpeg(input);
        if (inputFormat) command = command.inputFormat(inputFormat);
        command = command
          .inputOptions(['-fflags', '+nobuffer+flush_packets', '-flags', 'low_delay'])
          .format('s16le')
          .audioChannels(this.#numChannels)
          .audioFrequency(this.#sampleRate);

        command.on('error', (err: Error) => {
          if (isFfmpegTeardownError(err)) {
            this.#logger.debug('FFmpeg decode ended during shutdown');
            void this.#channel.close().catch(() => {});
          } else {
            void this.#channel.abort(err).catch(() => {});
          }
        });

        const output = command.pipe();
        output.on('data', (chunk: Buffer) => {
          const ab = chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength,
          ) as ArrayBuffer;
          for (const frame of audioStream.write(ab)) {
            void this.#channel.write(frame).catch(() => {});
          }
        });
        output.on('end', () => {
          for (const frame of audioStream.flush()) {
            void this.#channel.write(frame).catch(() => {});
          }
          void this.#channel.close().catch(() => {});
        });
        output.on('error', (err: Error) => void this.#channel.abort(err).catch(() => {}));
      })
      .catch((err: unknown) => {
        this.#logger.error({ err }, 'failed to start ffmpeg decoder');
        void this.#channel
          .abort(err instanceof Error ? err : new Error(String(err)))
          .catch(() => {});
      });
  }
}

type WavInlineOptions = {
  sampleRate: number;
  numChannels: number;
  emit: (frame: AudioFrame) => void;
  done: () => void;
  error: (err: Error) => void;
  fallback: (pending: Buffer) => void;
};

/**
 * Incremental decoder for 16-bit PCM WAV — no subprocess. Parses the RIFF/`fmt `/`data`
 * headers as bytes arrive, then streams PCM through {@link AudioByteStream}, converting
 * channels (mono↔stereo) and sample rate as needed. Anything it can't handle (non-PCM,
 * non-16-bit, more than 2 channels) is handed back via `fallback` for ffmpeg to decode.
 */
class WavInlineDecoder {
  #opts: WavInlineOptions;
  #buf: Buffer = Buffer.alloc(0);
  #state: 'header' | 'streaming' | 'done' = 'header';
  #byteStream?: AudioByteStream;
  #resampler?: AudioResampler;
  #inChannels = 1;

  constructor(opts: WavInlineOptions) {
    this.#opts = opts;
  }

  push(chunk: Buffer): void {
    if (this.#state === 'done') return;
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    if (this.#state === 'header') this.#parseHeader();
    if (this.#state === 'streaming') this.#consumePcm();
  }

  end(): void {
    if (this.#state !== 'streaming') {
      // Ended before the data chunk began — nothing decodable; just complete.
      this.#opts.done();
      this.#state = 'done';
      return;
    }
    this.#consumePcm();
    if (this.#byteStream) {
      for (const frame of this.#byteStream.flush()) this.#emit(frame);
    }
    if (this.#resampler) {
      for (const frame of this.#resampler.flush()) this.#opts.emit(frame);
    }
    this.#opts.done();
    this.#state = 'done';
  }

  // Walks RIFF chunks until `data`, parsing `fmt `. Buffers until each needed field is present.
  #parseHeader(): void {
    if (this.#buf.length < 12) return;
    let off = 12; // past 'RIFF', size, 'WAVE'
    let fmtParsed = false;
    let inRate = 0;

    while (off + 8 <= this.#buf.length) {
      const id = this.#buf.toString('ascii', off, off + 4);
      const size = this.#buf.readUInt32LE(off + 4);
      const body = off + 8;

      if (id === 'fmt ') {
        if (body + Math.min(size, 16) > this.#buf.length) return; // need the whole fmt chunk
        const audioFormat = this.#buf.readUInt16LE(body);
        const channels = this.#buf.readUInt16LE(body + 2);
        inRate = this.#buf.readUInt32LE(body + 4);
        const bits = this.#buf.readUInt16LE(body + 14);
        if (audioFormat !== 1 || bits !== 16 || channels < 1 || channels > 2) {
          // Not plain 16-bit mono/stereo PCM — let ffmpeg handle it. Hand back all bytes.
          this.#state = 'done';
          this.#opts.fallback(this.#buf);
          return;
        }
        this.#inChannels = channels;
        fmtParsed = true;
        off = body + size + (size & 1); // chunks are word-aligned
      } else if (id === 'data') {
        if (!fmtParsed) return; // wait for fmt (it precedes data in well-formed WAVs)
        this.#startStreaming(inRate);
        this.#buf = this.#buf.subarray(body); // remaining bytes are PCM
        return;
      } else {
        const next = body + size + (size & 1);
        if (next > this.#buf.length) return; // need the whole chunk before skipping it
        off = next;
      }
    }
  }

  #startStreaming(inRate: number): void {
    this.#byteStream = new AudioByteStream(inRate, this.#inChannels);
    if (inRate !== this.#opts.sampleRate) {
      this.#resampler = new AudioResampler(inRate, this.#opts.sampleRate, this.#opts.numChannels);
    }
    this.#state = 'streaming';
  }

  #consumePcm(): void {
    if (!this.#byteStream || this.#buf.length === 0) return;
    const ab = this.#buf.buffer.slice(
      this.#buf.byteOffset,
      this.#buf.byteOffset + this.#buf.byteLength,
    ) as ArrayBuffer;
    this.#buf = Buffer.alloc(0);
    for (const frame of this.#byteStream.write(ab)) this.#emit(frame);
  }

  // Convert channels (mono↔stereo) then sample rate, and emit.
  #emit(frame: AudioFrame): void {
    const converted =
      frame.channels === this.#opts.numChannels
        ? frame
        : downOrUpMix(frame, this.#opts.numChannels);
    if (this.#resampler) {
      for (const out of this.#resampler.push(converted)) this.#opts.emit(out);
    } else {
      this.#opts.emit(converted);
    }
  }
}

/** Convert a 16-bit PCM frame between mono and stereo (only 1↔2 channels). */
const downOrUpMix = (frame: AudioFrame, targetChannels: number): AudioFrame => {
  const src = frame.data;
  // Derive per-channel sample count from the interleaved data rather than trusting
  // frame.samplesPerChannel (AudioByteStream reports total samples there for multi-channel).
  const spc = Math.floor(src.length / frame.channels);
  if (frame.channels === 2 && targetChannels === 1) {
    const out = new Int16Array(spc);
    for (let i = 0; i < spc; i++) {
      out[i] = (src[i * 2]! + src[i * 2 + 1]!) >> 1;
    }
    return new AudioFrame(out, frame.sampleRate, 1, spc);
  }
  if (frame.channels === 1 && targetChannels === 2) {
    const out = new Int16Array(spc * 2);
    for (let i = 0; i < spc; i++) {
      out[i * 2] = src[i]!;
      out[i * 2 + 1] = src[i]!;
    }
    return new AudioFrame(out, frame.sampleRate, 2, spc);
  }
  return frame;
};
