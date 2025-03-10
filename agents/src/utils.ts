// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  LocalParticipant,
  RemoteParticipant,
  Room,
  TrackPublication,
} from '@livekit/rtc-node';
import { AudioFrame, TrackSource } from '@livekit/rtc-node';
import { EventEmitter, once } from 'node:events';

/** Union of a single and a list of {@link AudioFrame}s */
export type AudioBuffer = AudioFrame[] | AudioFrame;

/**
 * Merge one or more {@link AudioFrame}s into a single one.
 *
 * @param buffer Either an {@link AudioFrame} or a list thereof
 * @throws
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypeError
 * | TypeError} if sample rate or channel count are mismatched
 */
export const mergeFrames = (buffer: AudioBuffer): AudioFrame => {
  if (Array.isArray(buffer)) {
    buffer = buffer as AudioFrame[];
    if (buffer.length == 0) {
      throw new TypeError('buffer is empty');
    }

    const sampleRate = buffer[0]!.sampleRate;
    const channels = buffer[0]!.channels;
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

export const findMicroTrackId = (room: Room, identity: string): string => {
  let p: RemoteParticipant | LocalParticipant | undefined = room.remoteParticipants.get(identity);

  if (identity === room.localParticipant?.identity) {
    p = room.localParticipant;
  }

  if (!p) {
    throw new Error(`participant ${identity} not found`);
  }

  // find first micro track
  let trackId: string | undefined;
  p.trackPublications.forEach((track: TrackPublication) => {
    if (track.source === TrackSource.SOURCE_MICROPHONE) {
      trackId = track.sid;
      return;
    }
  });

  if (!trackId) {
    throw new Error(`participant ${identity} does not have a microphone track`);
  }

  return trackId;
};

/** @internal */
export class Queue<T> {
  /** @internal */
  items: T[] = [];
  #limit?: number;
  #events = new EventEmitter();

  constructor(limit?: number) {
    this.#limit = limit;
  }

  async get(): Promise<T> {
    const _get = async (): Promise<T> => {
      if (this.items.length === 0) {
        await once(this.#events, 'put');
      }
      let item = this.items.shift();
      if (!item) {
        item = await _get();
      }
      return item;
    };

    const item = _get();
    this.#events.emit('get');
    return item;
  }

  async put(item: T) {
    if (this.#limit && this.items.length >= this.#limit) {
      await once(this.#events, 'get');
    }
    this.items.push(item);
    this.#events.emit('put');
  }
}

/** @internal */
export class Future {
  #await: Promise<void>;
  #resolvePromise!: () => void;
  #rejectPromise!: (error: Error) => void;
  #done: boolean = false;

  constructor() {
    this.#await = new Promise<void>((resolve, reject) => {
      this.#resolvePromise = resolve;
      this.#rejectPromise = reject;
    });
  }

  get await() {
    return this.#await;
  }

  get done() {
    return this.#done;
  }

  resolve() {
    this.#done = true;
    this.#resolvePromise();
  }

  reject(error: Error) {
    this.#done = true;
    this.#rejectPromise(error);
  }
}

/** @internal */
export class CancellablePromise<T> {
  #promise: Promise<T>;
  #cancelFn: () => void;
  #isCancelled: boolean = false;
  #error: Error | null = null;

  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: any) => void,
      onCancel: (cancelFn: () => void) => void,
    ) => void,
  ) {
    let cancel: () => void;

    this.#promise = new Promise<T>((resolve, reject) => {
      executor(
        resolve,
        (reason) => {
          this.#error = reason instanceof Error ? reason : new Error(String(reason));
          reject(reason);
        },
        (cancelFn) => {
          cancel = () => {
            this.#isCancelled = true;
            cancelFn();
          };
        },
      );
    });

    this.#cancelFn = cancel!;
  }

  get isCancelled(): boolean {
    return this.#isCancelled;
  }

  get error(): Error | null {
    return this.#error;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | Promise<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | Promise<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | Promise<TResult>) | null,
  ): Promise<T | TResult> {
    return this.#promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#promise.finally(onfinally);
  }

  cancel(): void {
    this.#cancelFn();
  }

  static from<T>(promise: Promise<T>): CancellablePromise<T> {
    return new CancellablePromise<T>((resolve, reject) => {
      promise.then(resolve).catch(reject);
    });
  }
}

/** @internal */
export async function gracefullyCancel<T>(promise: CancellablePromise<T>): Promise<void> {
  if (!promise.isCancelled) {
    promise.cancel();
  }
  try {
    await promise;
  } catch (error) {
    // Ignore the error, as it's expected due to cancellation
  }
}

/** @internal */
export class AsyncIterableQueue<T> implements AsyncIterableIterator<T> {
  private static readonly CLOSE_SENTINEL = Symbol('CLOSE_SENTINEL');
  #queue = new Queue<T | typeof AsyncIterableQueue.CLOSE_SENTINEL>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  put(item: T): void {
    if (this.#closed) {
      throw new Error('Queue is closed');
    }
    this.#queue.put(item);
  }

  close(): void {
    this.#closed = true;
    this.#queue.put(AsyncIterableQueue.CLOSE_SENTINEL);
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#closed && this.#queue.items.length === 0) {
      return { value: undefined, done: true };
    }
    const item = await this.#queue.get();
    if (item === AsyncIterableQueue.CLOSE_SENTINEL && this.#closed) {
      return { value: undefined, done: true };
    }
    return { value: item as T, done: false };
  }

  [Symbol.asyncIterator](): AsyncIterableQueue<T> {
    return this;
  }
}

/** @internal */
export class ExpFilter {
  #alpha: number;
  #max?: number;
  #filtered?: number = undefined;

  constructor(alpha: number, max?: number) {
    this.#alpha = alpha;
    this.#max = max;
  }

  reset(alpha?: number) {
    if (alpha) {
      this.#alpha = alpha;
    }
    this.#filtered = undefined;
  }

  apply(exp: number, sample: number): number {
    if (this.#filtered) {
      const a = this.#alpha ** exp;
      this.#filtered = a * this.#filtered + (1 - a) * sample;
    } else {
      this.#filtered = sample;
    }

    if (this.#max && this.#filtered > this.#max) {
      this.#filtered = this.#max;
    }

    return this.#filtered;
  }

  get filtered(): number | undefined {
    return this.#filtered;
  }

  set alpha(alpha: number) {
    this.#alpha = alpha;
  }
}

/** @internal */
export class AudioEnergyFilter {
  #cooldownSeconds: number;
  #cooldown: number;

  constructor(cooldownSeconds = 1) {
    this.#cooldownSeconds = cooldownSeconds;
    this.#cooldown = cooldownSeconds;
  }

  pushFrame(frame: AudioFrame): boolean {
    const arr = Float32Array.from(frame.data, (x) => x / 32768);
    const rms = (arr.map((x) => x ** 2).reduce((acc, x) => acc + x) / arr.length) ** 0.5;
    if (rms > 0.004) {
      this.#cooldown = this.#cooldownSeconds;
      return true;
    }

    const durationSeconds = frame.samplesPerChannel / frame.sampleRate;
    this.#cooldown -= durationSeconds;
    if (this.#cooldown > 0) {
      return true;
    }

    return false;
  }
}
