// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { resolveFfmpegPath } from '../ffmpeg.js';
import { log } from '../log.js';
import { AsyncIterableQueue, isFfmpegTeardownError } from '../utils.js';

/**
 * Container short names understood by ffmpeg's `-f` flag, keyed by MIME type.
 *
 * Mirrors the table in the Python `utils/codecs/decoder.py`. A MIME type absent from this table
 * is passed to ffmpeg without `-f` so it can probe the stream itself.
 */
const MIME_TO_FORMAT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/opus': 'ogg',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
};

/**
 * Resolve a MIME type to the ffmpeg container short name, or `undefined` to let ffmpeg probe.
 *
 * Parameters and casing are normalized, so `Audio/MPEG; charset=utf-8` resolves to `mp3`.
 */
export function mimeToFormat(mimeType: string | undefined): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  const media = mimeType.split(';')[0]!.trim().toLowerCase();
  return MIME_TO_FORMAT[media];
}

/** Whether a MIME type names raw, header-less PCM that needs no decoding. */
export function isRawPcm(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  const media = mimeType.split(';')[0]!.trim().toLowerCase();
  return media.startsWith('audio/pcm') || media.startsWith('audio/raw');
}

export interface AudioStreamDecoderOptions {
  /** Sample rate of the decoded PCM output. */
  sampleRate: number;
  /** Channel count of the decoded PCM output. */
  numChannels: number;
  /**
   * MIME type of the pushed bytes (e.g. `audio/mpeg`). When omitted or unrecognized, ffmpeg
   * probes the stream to detect the container itself.
   */
  format?: string;
}

/**
 * Decode a stream of container or compressed audio bytes into raw PCM {@link AudioFrame}s.
 *
 * Bytes are pushed in with {@link push} as they arrive and decoded frames are consumed by
 * iterating the decoder. Call {@link endInput} once the last byte has been pushed; the iterator
 * then completes after the decoder drains.
 *
 * Decoding runs in an ffmpeg subprocess, resolved from `LIVEKIT_FFMPEG_PATH`, the bundled
 * `@livekit/av` binary, or `ffmpeg` on `PATH` — see `resolveFfmpegPath`.
 *
 * @example
 * ```ts
 * const decoder = new AudioStreamDecoder({ sampleRate: 24000, numChannels: 1, format: 'audio/mpeg' });
 * decoder.push(mp3Bytes);
 * decoder.endInput();
 * for await (const frame of decoder) {
 *   // raw PCM at 24kHz mono
 * }
 * await decoder.aclose();
 * ```
 */
export class AudioStreamDecoder implements AsyncIterable<AudioFrame> {
  #queue = new AsyncIterableQueue<AudioFrame>();
  #proc?: ChildProcessWithoutNullStreams;
  /** Resolves once the subprocess has exited and stdout has been fully drained. */
  #exited?: Promise<void>;
  #failure?: Error;
  #inputEnded = false;
  #closed = false;
  /** Trailing bytes of an incomplete sample, carried into the next stdout chunk. */
  #remainder = new Uint8Array(0);
  #bytesPerSample: number;
  #sampleRate: number;
  #numChannels: number;
  #format?: string;
  #logger = log();

  constructor(opts: AudioStreamDecoderOptions) {
    this.#sampleRate = opts.sampleRate;
    this.#numChannels = opts.numChannels;
    this.#format = mimeToFormat(opts.format);
    this.#bytesPerSample = opts.numChannels * 2;
  }

  #fail(error: Error): void {
    if (isFfmpegTeardownError(error)) {
      // Expected when we kill the process during teardown — not a decode failure.
      this.#logger.debug('audio decoder ended during shutdown');
      return;
    }
    this.#failure ??= error;
  }

  #start(): void {
    const binary = resolveFfmpegPath() ?? 'ffmpeg';
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (this.#format) {
      // The container is known, so ffmpeg needs only enough bytes to find the first packet.
      args.push('-probesize', '32', '-analyzeduration', '0', '-f', this.#format);
    }
    args.push(
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ac',
      String(this.#numChannels),
      '-ar',
      String(this.#sampleRate),
      'pipe:1',
    );

    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#proc = proc;

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail; a failing ffmpeg can be chatty and we just want the reason.
      stderr = (stderr + chunk.toString()).slice(-2048);
    });

    proc.stdout.on('data', (chunk: Buffer) => this.#onDecoded(chunk));
    // EPIPE on stdin is normal when ffmpeg exits first (bad input); the exit code reports it.
    proc.stdin.on('error', (err: Error) => this.#fail(err));
    proc.stdout.on('error', (err: Error) => this.#fail(err));
    proc.on('error', (err: Error) => this.#fail(err));

    this.#exited = new Promise<void>((resolve) => {
      let stdoutEnded = false;
      let exitCode: number | null = null;
      const settle = () => {
        if (!stdoutEnded || exitCode === null) {
          return;
        }
        if (exitCode !== 0 && !this.#closed) {
          this.#fail(
            new Error(
              `audio decoding failed: ffmpeg exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`,
            ),
          );
        }
        if (!this.#queue.closed) {
          this.#queue.close();
        }
        resolve();
      };
      proc.stdout.on('end', () => {
        stdoutEnded = true;
        settle();
      });
      proc.once('close', (code) => {
        exitCode = code ?? 0;
        settle();
      });
    });
  }

  /** Frame each stdout chunk immediately, carrying any partial trailing sample forward. */
  #onDecoded(chunk: Buffer): void {
    if (this.#queue.closed) {
      return;
    }

    let bytes: Uint8Array;
    if (this.#remainder.length === 0) {
      bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      bytes = new Uint8Array(this.#remainder.length + chunk.byteLength);
      bytes.set(this.#remainder, 0);
      bytes.set(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        this.#remainder.length,
      );
    }

    const complete = bytes.length - (bytes.length % this.#bytesPerSample);
    if (complete === 0) {
      this.#remainder = bytes.slice();
      return;
    }

    // slice() copies, so the frame owns its memory and the Buffer can be recycled by node.
    const frameBytes = bytes.slice(0, complete);
    this.#remainder = bytes.slice(complete);
    this.#queue.put(
      new AudioFrame(
        new Int16Array(frameBytes.buffer, frameBytes.byteOffset, complete / 2),
        this.#sampleRate,
        this.#numChannels,
        complete / this.#bytesPerSample,
      ),
    );
  }

  /** Push encoded bytes into the decoder. Spawns the subprocess on first call. */
  push(data: Uint8Array): void {
    if (this.#closed || this.#inputEnded || data.length === 0) {
      return;
    }
    if (!this.#proc) {
      this.#start();
    }
    this.#proc!.stdin.write(data, (err) => {
      if (err) {
        this.#fail(err);
      }
    });
  }

  /** Signal that no more bytes will be pushed, letting the decoder drain and complete. */
  endInput(): void {
    if (this.#inputEnded) {
      return;
    }
    this.#inputEnded = true;
    if (this.#proc) {
      this.#proc.stdin.end();
    } else if (!this.#queue.closed) {
      // Nothing was ever pushed, so there is no subprocess to drain.
      this.#queue.close();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<AudioFrame> {
    for await (const frame of this.#queue) {
      yield frame;
    }
    await this.#exited;
    if (this.#failure) {
      throw this.#failure;
    }
  }

  /** Stop the decoder and release the subprocess. Safe to call more than once. */
  async aclose(): Promise<void> {
    if (this.#closed) {
      await this.#exited;
      return;
    }
    this.#closed = true;

    if (!this.#proc) {
      if (!this.#queue.closed) {
        this.#queue.close();
      }
      return;
    }

    if (!this.#inputEnded) {
      this.#inputEnded = true;
      this.#proc.stdin.end();
    }
    // The consumer may have stopped iterating, so don't wait on a drain that will never happen.
    this.#proc.kill('SIGKILL');
    await this.#exited;
    if (!this.#queue.closed) {
      this.#queue.close();
    }
  }
}
