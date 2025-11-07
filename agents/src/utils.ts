// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  ParticipantKind,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  TrackKind,
} from '@livekit/rtc-node';
import { AudioFrame, AudioResampler, RoomEvent } from '@livekit/rtc-node';
import { EventEmitter, once } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { TransformStream, type TransformStreamDefaultController } from 'node:stream/web';
import { v4 as uuidv4 } from 'uuid';
import { log } from './log.js';

/**
 * Recursively expands all nested properties of a type,
 * resolving aliases so as to inspect the real shape in IDE.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type Expand<T> = T extends Function
  ? T
  : T extends object
    ? T extends Array<infer U>
      ? Array<Expand<U>>
      : T extends Map<infer K, infer V>
        ? Map<Expand<K>, Expand<V>>
        : T extends Set<infer M>
          ? Set<Expand<M>>
          : { [K in keyof T]: Expand<T[K]> }
    : T;

/** Union of a single and a list of {@link AudioFrame}s */
export type AudioBuffer = AudioFrame[] | AudioFrame;

export const noop = () => {};

export const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
  const sentinel = Symbol('sentinel');
  const result = await Promise.race([promise, Promise.resolve(sentinel)]);
  return result === sentinel;
};

/**
 * Merge one or more {@link AudioFrame}s into a single one.
 *
 * @param buffer - Either an {@link AudioFrame} or a list thereof
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
export class Future<T = void> {
  #await: Promise<T>;
  #resolvePromise!: (value: T) => void;
  #rejectPromise!: (error: Error) => void;
  #done: boolean = false;

  constructor() {
    this.#await = new Promise<T>((resolve, reject) => {
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

  resolve(value: T) {
    this.#done = true;
    this.#resolvePromise(value);
  }

  reject(error: Error) {
    this.#done = true;
    this.#rejectPromise(error);
  }
}

/** @internal */
export class Event {
  #isSet = false;
  #waiters: Array<() => void> = [];

  async wait() {
    if (this.#isSet) return true;

    let resolve: () => void = noop;
    const waiter = new Promise<void>((r) => {
      resolve = r;
      this.#waiters.push(resolve);
    });

    try {
      await waiter;
      return true;
    } finally {
      const index = this.#waiters.indexOf(resolve);
      if (index !== -1) {
        this.#waiters.splice(index, 1);
      }
    }
  }

  get isSet(): boolean {
    return this.#isSet;
  }

  set(): void {
    if (this.#isSet) return;

    this.#isSet = true;
    this.#waiters.forEach((resolve) => resolve());
    this.#waiters = [];
  }

  clear(): void {
    this.#isSet = false;
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
      reject: (reason?: unknown) => void,
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
    onrejected?: ((reason: unknown) => TResult2 | Promise<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | Promise<TResult>) | null,
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

export const TASK_TIMEOUT_ERROR = new Error('Task cancellation timed out');

export enum TaskResult {
  Timeout = 'timeout',
  Completed = 'completed',
  Aborted = 'aborted',
}

/** @internal */
/**
 * A task that can be cancelled.
 *
 * We recommend using the `Task.from` method to create a task. When creating subtasks, pass the same controller to all subtasks.
 *
 * @example
 * ```ts
 * const parent = Task.from((controller) => {
 *   const child1 = Task.from(() => { ... }, controller);
 *   const child2 = Task.from(() => { ... }, controller);
 * });
 * parent.cancel();
 * ```
 *
 * This will cancel all subtasks when the parent is cancelled.
 *
 * @param T - The type of the task result
 */
export class Task<T> {
  private resultFuture: Future<T>;

  #logger = log();

  constructor(
    private readonly fn: (controller: AbortController) => Promise<T>,
    private readonly controller: AbortController,
    readonly name?: string,
  ) {
    this.resultFuture = new Future();
    this.runTask();
  }

  /**
   * Creates a new task from a function.
   *
   * @param fn - The function to run
   * @param controller - The abort controller to use
   * @returns A new task
   */
  static from<T>(
    fn: (controller: AbortController) => Promise<T>,
    controller?: AbortController,
    name?: string,
  ) {
    const abortController = controller ?? new AbortController();
    return new Task(fn, abortController, name);
  }

  private async runTask() {
    const run = async () => {
      if (this.name) {
        this.#logger.debug(`Task.runTask: task ${this.name} started`);
      }
      return await this.fn(this.controller);
    };

    return run()
      .then((value) => {
        this.resultFuture.resolve(value);
        return value;
      })
      .catch((error) => {
        this.resultFuture.reject(error);
      })
      .finally(() => {
        if (this.name) {
          this.#logger.debug(`Task.runTask: task ${this.name} done`);
        }
      });
  }

  /**
   * Cancels the task.
   */
  cancel() {
    this.controller.abort();
  }

  /**
   * Cancels the task and waits for it to complete.
   *
   * @param timeout - The timeout in milliseconds
   * @returns The result status of the task (timeout, completed, aborted)
   */
  async cancelAndWait(timeout?: number) {
    this.cancel();

    try {
      // Race between task completion and timeout
      const promises = [
        this.result
          .then(() => TaskResult.Completed)
          .catch((error) => {
            if (error.name === 'AbortError') {
              return TaskResult.Aborted;
            }
            throw error;
          }),
      ];

      if (timeout) {
        promises.push(delay(timeout).then(() => TaskResult.Timeout));
      }

      const result = await Promise.race(promises);

      // Check what happened
      if (result === TaskResult.Timeout) {
        throw TASK_TIMEOUT_ERROR;
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * The result of the task.
   */
  get result(): Promise<T> {
    return this.resultFuture.await;
  }

  /**
   * Whether the task has completed.
   */
  get done(): boolean {
    return this.resultFuture.done;
  }

  addDoneCallback(callback: () => void) {
    this.resultFuture.await.finally(callback);
  }
}

export async function waitFor(tasks: Task<void>[]): Promise<void> {
  await Promise.allSettled(tasks.map((task) => task.result));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cancelAndWait(tasks: Task<any>[], timeout?: number): Promise<void> {
  await Promise.allSettled(tasks.map((task) => task.cancelAndWait(timeout)));
}

export function withResolvers<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Generates a short UUID with a prefix. Mirrors the python agents implementation.
 *
 * @param prefix - The prefix to add to the UUID.
 * @returns A short UUID with the prefix.
 */
export function shortuuid(prefix: string = ''): string {
  return `${prefix}${uuidv4().slice(0, 12)}`;
}

const READONLY_SYMBOL = Symbol('Readonly');

const MUTATION_METHODS = [
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
] as const;

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
/**
 * Creates a read-only proxy for an array.
 * @param array - The array to make read-only.
 * @param additionalErrorMessage - An additional error message to include in the error thrown when a mutation method is called.
 * @returns A read-only proxy for the array.
 */
export function createImmutableArray<T>(array: T[], additionalErrorMessage: string = ''): T[] {
  return new Proxy(array, {
    get(target, key) {
      if (key === READONLY_SYMBOL) {
        return true;
      }

      // Intercept mutation methods
      if (
        typeof key === 'string' &&
        MUTATION_METHODS.includes(key as (typeof MUTATION_METHODS)[number])
      ) {
        return function () {
          throw new TypeError(
            `Cannot call ${key}() on a read-only array. ${additionalErrorMessage}`.trim(),
          );
        };
      }

      return Reflect.get(target, key);
    },
    set(_, prop) {
      throw new TypeError(
        `Cannot assign to read-only array index "${String(prop)}". ${additionalErrorMessage}`.trim(),
      );
    },
    deleteProperty(_, prop) {
      throw new TypeError(
        `Cannot delete read-only array index "${String(prop)}". ${additionalErrorMessage}`.trim(),
      );
    },
    defineProperty(_, prop) {
      throw new TypeError(
        `Cannot define property "${String(prop)}" on a read-only array. ${additionalErrorMessage}`.trim(),
      );
    },
    setPrototypeOf() {
      throw new TypeError(
        `Cannot change prototype of a read-only array. ${additionalErrorMessage}`.trim(),
      );
    },
  });
}

export function isImmutableArray(array: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof array === 'object' && !!(array as any)[READONLY_SYMBOL];
}

/**
 * Resamples an audio stream to a target sample rate.
 *
 * WARINING: The input stream will be locked until the resampled stream is closed.
 *
 * @param stream - The input stream to resample.
 * @param outputRate - The target sample rate.
 * @returns A new stream with the resampled audio.
 */
export function resampleStream({
  stream,
  outputRate,
}: {
  stream: ReadableStream<AudioFrame>;
  outputRate: number;
}): ReadableStream<AudioFrame> {
  let resampler: AudioResampler | null = null;
  const transformStream = new TransformStream<AudioFrame, AudioFrame>({
    transform(chunk: AudioFrame, controller: TransformStreamDefaultController<AudioFrame>) {
      if (!resampler) {
        resampler = new AudioResampler(chunk.sampleRate, outputRate);
      }
      for (const frame of resampler.push(chunk)) {
        controller.enqueue(frame);
      }
      for (const frame of resampler.flush()) {
        controller.enqueue(frame);
      }
    },
  });
  return stream.pipeThrough(transformStream);
}

export class InvalidErrorType extends Error {
  readonly error: unknown;

  constructor(error: unknown) {
    super(`Expected error, got ${error} (${typeof error})`);
    this.error = error;
    Error.captureStackTrace(this, InvalidErrorType);
  }
}

/**
 * In JS an error can be any arbitrary value.
 * This function converts an unknown error to an Error and stores the original value in the error object.
 *
 * @param error - The error to convert.
 * @returns An Error.
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  throw new InvalidErrorType(error);
}

/**
 * This is a hack to immitate asyncio.create_task so that
 * func will be run after the current event loop iteration.
 *
 * @param func - The function to run.
 */
export function startSoon(func: () => void) {
  setTimeout(func, 0);
}

export type DelayOptions = {
  signal?: AbortSignal;
};

/**
 * Delay for a given number of milliseconds.
 *
 * @param ms - The number of milliseconds to delay.
 * @param options - The options for the delay.
 * @returns A promise that resolves after the delay.
 */
export function delay(ms: number, options: DelayOptions = {}): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(i);
      reject(signal?.reason);
    };
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const i = setTimeout(done, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Returns a participant that matches the given identity. If identity is None, the first
 * participant that joins the room will be returned.
 * If the participant has already joined, the function will return immediately.
 * @param room - The room to wait for a participant in.
 * @param identity - The identity of the participant to wait for.
 * @param kind - The kind of the participant to wait for.
 * @returns A promise that resolves to the participant.
 */
export async function waitForParticipant({
  room,
  identity,
  kind,
}: {
  room: Room;
  identity?: string;
  kind?: ParticipantKind | ParticipantKind[];
}): Promise<RemoteParticipant> {
  if (!room.isConnected) {
    throw new Error('Room is not connected');
  }

  const fut = new Future<RemoteParticipant>();

  const kindMatch = (participant: RemoteParticipant) => {
    if (kind === undefined) return true;

    if (Array.isArray(kind)) {
      return kind.includes(participant.kind);
    }

    return participant.kind === kind;
  };

  const onParticipantConnected = (p: RemoteParticipant) => {
    if ((identity === undefined || p.identity === identity) && kindMatch(p)) {
      if (!fut.done) {
        fut.resolve(p);
      }
    }
  };

  room.on(RoomEvent.ParticipantConnected, onParticipantConnected);

  try {
    for (const p of room.remoteParticipants.values()) {
      onParticipantConnected(p);
      if (fut.done) {
        break;
      }
    }

    return await fut.await;
  } finally {
    room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
  }
}

export async function waitForTrackPublication({
  room,
  identity,
  kind,
}: {
  room: Room;
  identity: string;
  kind: TrackKind;
}): Promise<RemoteTrackPublication> {
  if (!room.isConnected) {
    throw new Error('Room is not connected');
  }

  const fut = new Future<RemoteTrackPublication>();

  const kindMatch = (k: TrackKind | undefined) => {
    if (kind === undefined || kind === null) {
      return true;
    }
    return k === kind;
  };

  const onTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (fut.done) return;
    if (
      (identity === undefined || participant.identity === identity) &&
      kindMatch(publication.kind)
    ) {
      fut.resolve(publication);
    }
  };

  room.on(RoomEvent.TrackPublished, onTrackPublished);

  try {
    for (const p of room.remoteParticipants.values()) {
      for (const publication of p.trackPublications.values()) {
        onTrackPublished(publication, p);
        if (fut.done) break;
      }
    }

    return await fut.await;
  } finally {
    room.off(RoomEvent.TrackPublished, onTrackPublished);
  }
}

export async function waitForAbort(signal: AbortSignal) {
  const abortFuture = new Future<void>();
  const handler = () => {
    abortFuture.resolve();
    signal.removeEventListener('abort', handler);
  };

  signal.addEventListener('abort', handler, { once: true });
  return await abortFuture.await;
}
