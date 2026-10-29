// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, AudioByteStream } from '@livekit/agents';
import { getFfmpegPath } from '@livekit/av';
import type { AudioFrame } from '@livekit/rtc-node';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

/** Decode one continuous MP3 response into LiveKit PCM frames. */
export class Mp3AudioDecoder {
  #bytes: AudioByteStream;
  #process?: ChildProcessWithoutNullStreams;
  #complete?: Promise<void>;
  #failure?: APIError;
  #byteCount = 0;

  constructor(
    sampleRate: number,
    private emit: (frame: AudioFrame) => void,
  ) {
    this.#bytes = new AudioByteStream(sampleRate, 1, Math.max(1, Math.floor(sampleRate / 50)));
    this.#process = spawn(
      globalThis.process.env.LIVEKIT_FFMPEG_PATH || getFfmpegPath() || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        'mp3',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const fail = () => {
      this.#failure = new APIError('AddisAI MP3 decoding failed', { retryable: false });
    };
    this.#process.stdout.on('data', (data: Buffer) => {
      this.#byteCount += data.length;
      this.#bytes.write(data).forEach(this.emit);
    });
    this.#process.stderr.resume();
    this.#process.stdin.on('error', fail);
    this.#process.stdout.on('error', fail);
    this.#complete = new Promise((resolve) => {
      this.#process!.once('error', () => {
        fail();
        resolve();
      });
      this.#process!.once('close', (code) => {
        if (code !== 0) fail();
        resolve();
      });
    });
  }

  async push(data: Uint8Array): Promise<void> {
    if (!data.length) return;
    await new Promise<void>((resolve) => this.#process!.stdin.write(data, () => resolve()));
    if (this.#failure) throw this.#failure;
  }

  async end(): Promise<void> {
    this.#process?.stdin.end();
    await this.#complete;
    if (this.#failure) throw this.#failure;
    if (this.#byteCount % 2) {
      throw new APIError('AddisAI returned incomplete decoded audio', { retryable: false });
    }
    this.#bytes.flush().forEach(this.emit);
  }

  close(): void {
    this.#process?.kill('SIGKILL');
  }
}
