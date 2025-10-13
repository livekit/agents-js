// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { log } from './log.js';
import type { AudioBuffer } from './utils.js';

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

  write(data: ArrayBuffer): AudioFrame[] {
    this.#buf = new Int8Array([...this.#buf, ...new Int8Array(data)]);

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
