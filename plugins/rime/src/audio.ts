// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, AudioByteStream } from '@livekit/agents';
import { getFfmpegPath } from '@livekit/av';
import type { AudioFrame } from '@livekit/rtc-node';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { RimeAudioFormat } from './options.js';

export function decodeMuLaw(data: Uint8Array): Buffer {
  const pcm = Buffer.alloc(data.length * 2);
  data.forEach((value, i) => {
    const encoded = ~value & 255;
    const sample = ((((encoded & 15) << 3) + 132) << ((encoded >> 4) & 7)) - 132;
    pcm.writeInt16LE(encoded & 128 ? -sample : sample, i * 2);
  });
  return pcm;
}

/** Decode each context as a continuous audio stream, including split container headers. */
export class RimeAudio {
  private bytes: AudioByteStream;
  private decoder?: ChildProcessWithoutNullStreams;
  private complete?: Promise<void>;
  private failure?: APIError;
  private byteCount = 0;
  constructor(
    private format: RimeAudioFormat,
    private sampleRate: number,
    private emit: (frame: AudioFrame) => void,
  ) {
    this.bytes = new AudioByteStream(sampleRate, 1, Math.max(1, Math.floor(sampleRate / 50)));
  }
  private pcm(data: Uint8Array) {
    this.byteCount += data.length;
    this.bytes.write(data).forEach(this.emit);
  }
  private startDecoder() {
    const formats: Partial<Record<RimeAudioFormat, string>> = {
      'audio/wav': 'wav',
      'audio/mpeg': 'mp3',
      'audio/ogg;codecs=opus': 'ogg',
      'audio/webm;codecs=opus': 'webm',
    };
    const process = spawn(
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
        formats[this.format]!,
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        String(this.sampleRate),
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.decoder = process;
    const fail = () => {
      this.failure = new APIError('Rime audio decoding failed', { retryable: false });
    };
    process.stdout.on('data', (data: Buffer) => this.pcm(data));
    process.stderr.resume();
    process.stdin.on('error', fail);
    process.stdout.on('error', fail);
    this.complete = new Promise<void>((resolve) => {
      process.once('error', () => {
        fail();
        resolve();
      });
      process.once('close', (code) => {
        if (code !== 0) fail();
        resolve();
      });
    });
  }
  async push(data: Uint8Array) {
    if (!data.length) return;
    if (this.format === 'audio/pcm' || this.format === 'audio/pcmu') {
      this.pcm(this.format === 'audio/pcmu' ? decodeMuLaw(data) : data);
    } else {
      if (!this.decoder) this.startDecoder();
      await new Promise<void>((resolve) => this.decoder!.stdin.write(data, () => resolve()));
    }
    if (this.failure) throw this.failure;
  }
  async end() {
    if (this.decoder) {
      this.decoder.stdin.end();
      await this.complete;
    }
    if (this.failure) throw this.failure;
    if (this.byteCount % 2)
      throw new APIError('Rime returned incomplete PCM audio', { retryable: false });
    this.bytes.flush().forEach(this.emit);
  }
  close() {
    this.decoder?.kill('SIGKILL');
  }
}
