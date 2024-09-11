// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter, once } from 'events';

export type AudioBuffer = AudioFrame[] | AudioFrame;

/**
 * Merge one or more {@link AudioFrame}s into a single one.
 *
 * @param buffer Either an {@link AudioFrame} or a list thereof
 */
export const mergeFrames = (buffer: AudioBuffer): AudioFrame => {
  if (Array.isArray(buffer)) {
    buffer = buffer as AudioFrame[];
    if (buffer.length == 0) {
      throw new TypeError('buffer is empty');
    }

    const sampleRate = buffer[0].sampleRate;
    const channels = buffer[0].channels;
    let samplesPerChannel = 0;
    let data = new Int16Array();

    for (const frame of buffer) {
      if (frame.sampleRate !== sampleRate) {
        throw new TypeError('sample rate mismatch');
      }

      if (frame.channels !== channels) {
        throw new TypeError('channel count mismatch');
      }

      data = new Int16Array([...data, ...frame.data]);
      samplesPerChannel += frame.samplesPerChannel;
    }

    return new AudioFrame(data, sampleRate, channels, samplesPerChannel);
  }

  return buffer;
};

/** @internal */
export class Mutex {
  #locking: Promise<void>;
  #locks: number;

  constructor() {
    this.#locking = Promise.resolve();
    this.#locks = 0;
  }

  isLocked(): boolean {
    return this.#locks > 0;
  }

  async lock(): Promise<() => void> {
    this.#locks += 1;

    let unlockNext: () => void;

    const willLock = new Promise<void>(
      (resolve) =>
        (unlockNext = () => {
          this.#locks -= 1;
          resolve();
        }),
    );

    const willUnlock = this.#locking.then(() => unlockNext);
    this.#locking = this.#locking.then(() => willLock);
    return willUnlock;
  }
}

/** @internal */
export class Queue<T> {
  #items: T[] = [];
  #limit?: number;

  // XXX(nbsp): ugly, but *simple*. will work on making this lighter later
  #events = new EventEmitter()

  constructor(limit?: number) {
    this.#limit = limit
  }

  async get(): Promise<T> {
    if (this.#items.length === 0) {
      await once(this.#events, 'put')
    }
    const item = this.#items.shift()!;
    this.#events.emit('get');
    return item;
  }

  async put(item: T) {
    if (this.#limit && this.#items.length >= this.#limit) {
      await once(this.#events, 'get')
    }
    this.#items.push(item);
    this.#events.emit('put');
  }
}
