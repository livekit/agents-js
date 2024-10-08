// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AsyncIterableQueue } from '../utils.js';

export interface SynthesizedAudio {
  /** Request ID (one segment could be made up of multiple requests) */
  requestId: string;
  /** Segment ID, each segment is separated by a flush */
  segmentId: string;
  /** Synthesized audio frame */
  frame: AudioFrame;
  /** Current segment of the synthesized audio */
  deltaText: string;
}

export interface TTSCapabilities {
  streaming: boolean;
}

export abstract class TTS {
  #capabilities: TTSCapabilities;
  #sampleRate: number;
  #numChannels: number;

  constructor(sampleRate: number, numChannels: number, capabilities: TTSCapabilities) {
    this.#capabilities = capabilities;
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;
  }

  get capabilities(): TTSCapabilities {
    return this.#capabilities;
  }

  get sampleRate(): number {
    return this.#sampleRate;
  }

  get numChannels(): number {
    return this.#numChannels;
  }

  /**
   * Returns a {@link SynthesizeStream} that can be used to push audio frames and receive syntheses.
   */
  abstract stream(): SynthesizeStream;
}

export abstract class SynthesizeStream implements AsyncIterableIterator<SynthesizedAudio> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<string | typeof SynthesizeStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<SynthesizedAudio>();
  protected closed = false;

  pushText(text: string) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(text);
  }

  flush() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(SynthesizeStream.FLUSH_SENTINEL);
  }

  endInput() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.close();
  }

  next(): Promise<IteratorResult<SynthesizedAudio>> {
    return this.queue.next();
  }

  close() {
    this.input.close();
    this.queue.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): SynthesizeStream {
    return this;
  }
}
