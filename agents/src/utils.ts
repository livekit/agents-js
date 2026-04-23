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
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
import { AsyncLocalStorage } from 'node:async_hooks';
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

export const isPending = async (promise: Promise<unknown>): Promise<Throws<boolean, Error>> => {
  const sentinel = Symbol('sentinel');
  const result = await Promise.race([
    ThrowsPromise.fromPromise<unknown, Error>(promise),
    ThrowsPromise.resolve(sentinel),
  ]);
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
      if (typeof item === 'undefined') {
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
export class Future<T = void, E extends Error = Error> {
  #await: ThrowsPromise<T, E>;
  #resolvePromise!: (value: T) => void;
  #rejectPromise!: (error: E) => void;
  #done: boolean = false;
  #rejected: boolean = false;
  #result: T | undefined = undefined;
  #error: Error | undefined = undefined;

  constructor() {
    this.#await = new ThrowsPromise<T, E>((resolve, reject) => {
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

  get result(): T {
    if (!this.#done) {
      throw new Error('Future is not done');
    }

    if (this.#rejected) {
      throw this.#error;
    }

    return this.#result!;
  }

  /** Whether the future was rejected (cancelled) */
  get rejected() {
    return this.#rejected;
  }

  resolve(value: T) {
    this.#done = true;
    this.#result = value;
    this.#resolvePromise(value);
  }

  reject(error: E) {
    this.#done = true;
    this.#rejected = true;
    this.#error = error;
    this.#rejectPromise(error);
    // Python calls Future.exception() right after set_exception() to silence
    // "exception was never retrieved" warnings. In JS, consume the rejection
    // immediately so Node does not emit unhandled-rejection noise before a
    // later await/catch observes it.
    void this.#await.catch(() => undefined);
  }
}

/** @internal */
export class Event {
  #isSet = false;
  #waiters: Array<() => void> = [];

  async wait() {
    if (this.#isSet) return true;

    let resolve: () => void = noop;
    const waiter = new ThrowsPromise<void, never>((r) => {
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
export class CancellablePromise<T, E extends Error = Error> {
  #promise: ThrowsPromise<T, E>;
  #cancelFn: () => void;
  #isCancelled: boolean = false;
  #error: E | null = null;

  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason: E) => void,
      onCancel: (cancelFn: () => void) => void,
    ) => void,
  ) {
    let cancel: () => void;

    this.#promise = new ThrowsPromise<T, E>((resolve, reject) => {
      executor(
        resolve,
        (reason) => {
          this.#error = reason;
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
    onrejected?: ((reason: E) => TResult2 | Promise<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: E) => TResult | Promise<TResult>) | null,
  ): Promise<Throws<T | TResult | undefined, E>> {
    return this.#promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Throws<T, E>> {
    return this.#promise.finally(onfinally);
  }

  cancel(): void {
    this.#cancelFn();
  }

  static from<T, E extends Error = Error>(promise: Promise<Throws<T, E>>): CancellablePromise<T, E>;
  static from<T>(promise: Promise<T>): CancellablePromise<T>;
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
  private _alpha: number;
  private _maxVal: number | undefined;
  private _minVal: number | undefined;
  private _filtered: number | undefined;

  constructor(alpha: number, opts?: number | { max?: number; min?: number; initial?: number }) {
    if (!(alpha > 0 && alpha <= 1)) {
      throw new Error('alpha must be in (0, 1].');
    }

    this._alpha = alpha;
    this._maxVal = typeof opts === 'number' ? opts : opts?.max;
    this._minVal = typeof opts === 'number' ? undefined : opts?.min;
    this._filtered = typeof opts === 'number' ? undefined : opts?.initial;
  }

  reset(opts?: number | { alpha?: number; initial?: number; min?: number; max?: number }) {
    if (typeof opts === 'number') {
      if (!(opts > 0 && opts <= 1)) {
        throw new Error('alpha must be in (0, 1].');
      }
      this._alpha = opts;
      this._filtered = undefined;
      return;
    }

    if (opts?.alpha !== undefined) {
      if (!(opts.alpha > 0 && opts.alpha <= 1)) {
        throw new Error('alpha must be in (0, 1].');
      }
      this._alpha = opts.alpha;
    }
    if (opts && Object.hasOwn(opts, 'initial')) {
      this._filtered = opts.initial;
    }
    if (opts && Object.hasOwn(opts, 'min')) {
      this._minVal = opts.min;
    }
    if (opts && Object.hasOwn(opts, 'max')) {
      this._maxVal = opts.max;
    }
  }

  apply(exp: number, sample?: number): number {
    const resolvedSample = sample ?? this._filtered;

    if (resolvedSample === undefined) {
      throw new Error('sample or initial value must be given.');
    }

    if (this._filtered === undefined) {
      this._filtered = resolvedSample;
    } else {
      const a = this._alpha ** exp;
      this._filtered = a * this._filtered + (1 - a) * resolvedSample;
    }

    if (this._maxVal !== undefined && this._filtered > this._maxVal) {
      this._filtered = this._maxVal;
    }
    if (this._minVal !== undefined && this._filtered < this._minVal) {
      this._filtered = this._minVal;
    }

    return this._filtered;
  }

  get filtered(): number | undefined {
    return this._filtered;
  }

  get value(): number | undefined {
    return this._filtered;
  }

  set alpha(alpha: number) {
    if (!(alpha > 0 && alpha <= 1)) {
      throw new Error('alpha must be in (0, 1].');
    }
    this._alpha = alpha;
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
  private static readonly currentTaskStorage = new AsyncLocalStorage<Task<unknown>>();
  private resultFuture: Future<T>;
  private doneCallbacks: Set<() => void> = new Set();

  #logger = log();

  constructor(
    private readonly fn: (controller: AbortController) => Promise<T>,
    private readonly controller: AbortController,
    readonly name?: string,
  ) {
    this.resultFuture = new Future();
    void this.resultFuture.await
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        for (const callback of this.doneCallbacks) {
          try {
            callback();
          } catch (error) {
            this.#logger.error({ error }, 'Task done callback failed');
          }
        }
        this.doneCallbacks.clear();
      });
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

  /**
   * Returns the currently running task in this async context, if available.
   */
  static current(): Task<unknown> | undefined {
    return Task.currentTaskStorage.getStore();
  }

  private async runTask() {
    const run = async () => {
      if (this.name) {
        this.#logger.debug(`Task.runTask: task ${this.name} started`);
      }
      return await this.fn(this.controller);
    };

    return Task.currentTaskStorage
      .run(this as Task<unknown>, run)
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

    const result = await ThrowsPromise.race(promises);

    // Check what happened
    if (result === TaskResult.Timeout) {
      throw new Error('Task cancellation timed out');
    }

    return result;
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
    if (this.done) {
      queueMicrotask(callback);
      return;
    }
    this.doneCallbacks.add(callback);
  }

  removeDoneCallback(callback: () => void) {
    this.doneCallbacks.delete(callback);
  }
}

export async function waitFor(tasks: Task<void>[]): Promise<void> {
  await ThrowsPromise.allSettled(tasks.map((task) => task.result));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cancelAndWait(tasks: Task<any>[], timeout?: number): Promise<void> {
  await ThrowsPromise.allSettled(tasks.map((task) => task.cancelAndWait(timeout)));
}

export function withResolvers<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;

  const promise = new ThrowsPromise<T, Error>((res, rej) => {
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
      if (chunk.samplesPerChannel === 0) {
        controller.enqueue(chunk);
        return;
      }
      if (!resampler) {
        resampler = new AudioResampler(chunk.sampleRate, outputRate);
      }
      for (const frame of resampler.push(chunk)) {
        controller.enqueue(frame);
      }
    },
    flush(controller) {
      if (resampler) {
        for (const frame of resampler.flush()) {
          controller.enqueue(frame);
        }
        resampler.close();
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
 * Check if an error is a stream closed error that can be safely ignored during cleanup.
 * This happens during handover/cleanup when close() is called while operations are still running.
 *
 * @param error - The error to check.
 * @returns True if the error is a stream closed error.
 */
export function isStreamClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'Stream is closed' || error.message === 'Input is closed')
  );
}

/** FFmpeg error messages expected during normal teardown/shutdown. */
const FFMPEG_TEARDOWN_ERRORS = ['Output stream closed', 'received signal 2', 'SIGKILL', 'SIGINT'];

/**
 * Check if an error is an expected FFmpeg teardown error that can be safely ignored during cleanup.
 *
 * @param error - The error to check.
 * @returns True if the error is an expected FFmpeg shutdown error.
 */
export function isFfmpegTeardownError(error: unknown): boolean {
  return (
    error instanceof Error && FFMPEG_TEARDOWN_ERRORS.some((msg) => error.message?.includes(msg))
  );
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
  if (signal?.aborted) return ThrowsPromise.reject(signal.reason ?? new Error('delay aborted'));
  return new ThrowsPromise<void, Error>((resolve, reject) => {
    const abort = () => {
      clearTimeout(i);
      reject(signal?.reason ?? new Error('delay aborted'));
    };
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const i = setTimeout(done, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class IdleTimeoutError extends Error {
  constructor(message = 'idle timeout') {
    super(message);
    this.name = 'IdleTimeoutError';
  }
}

/**
 * Race a promise against an idle timeout. If the promise does not settle within
 * `timeoutMs` milliseconds, the returned promise rejects with {@link IdleTimeoutError}
 * (or the error returned by `throwError` when provided).
 * The timer is properly cleaned up on settlement to avoid leaking handles.
 */
export function waitUntilTimeout<T, E extends Error = IdleTimeoutError>(
  promise: Promise<T>,
  timeoutMs: number,
  throwError?: () => E,
): Promise<Throws<T, E | IdleTimeoutError>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ThrowsPromise.race([
    promise,
    new ThrowsPromise<never, E | IdleTimeoutError>((_, reject) => {
      timer = setTimeout(() => reject(throwError?.() ?? new IdleTimeoutError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<Throws<T, E>>;
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

  const onDisconnected = () => {
    fut.reject(new Error('Got disconnected from room while waiting for participant'));
  };

  room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  room.on(RoomEvent.Disconnected, onDisconnected);

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
    room.off(RoomEvent.Disconnected, onDisconnected);
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

/**
 * Yields values from a ReadableStream until the stream ends or the signal is aborted.
 * Handles reader cleanup and stream-release errors internally.
 */
export async function* readStream<T>(
  stream: ReadableStream<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  if (signal?.aborted) return;
  const reader = stream.getReader();
  try {
    if (signal) {
      const abortPromise = waitForAbort(signal);
      while (true) {
        const result = await ThrowsPromise.race([reader.read(), abortPromise]);
        if (!result) break;
        const { done, value } = result;
        if (done) break;
        yield value;
      }
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // stream cleanup errors are expected (releasing reader, controller closed, etc.)
    }
  }
}

export async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return;
  }

  const abortFuture = new Future<void>();
  const handler = () => {
    abortFuture.resolve();
    signal.removeEventListener('abort', handler);
  };
  if (signal.aborted) {
    return;
  }
  signal.addEventListener('abort', handler, { once: true });
  return await abortFuture.await;
}

export async function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  const abortFuture = new Future<never>();
  signal.addEventListener('abort', () => abortFuture.reject(signal.reason), { once: true });
  return abortFuture.await;
}

/**
 * Combines two abort signals into a single abort signal.
 * @param a - The first abort signal.
 * @param b - The second abort signal.
 * @returns A new abort signal that is aborted when either of the input signals is aborted.
 */
export const combineSignals = (a: AbortSignal, b: AbortSignal): AbortSignal => {
  const c = new AbortController();
  const abortFrom = (s: AbortSignal) => {
    if (c.signal.aborted) return;
    c.abort((s as any).reason);
  };
  if (a.aborted) {
    abortFrom(a);
  } else {
    a.addEventListener('abort', () => abortFrom(a), { once: true });
  }
  if (b.aborted) {
    abortFrom(b);
  } else {
    b.addEventListener('abort', () => abortFrom(b), { once: true });
  }
  return c.signal;
};

export const isCloud = (url: URL) => {
  const hostname = url.hostname;
  return hostname.endsWith('.livekit.cloud') || hostname.endsWith('.livekit.run');
};

/**
 * Whether the agent is running in development mode (launched via `dev` or `connect`).
 */
export const isDevMode = (): boolean => {
  return process.env.LIVEKIT_DEV_MODE === '1';
};

/**
 * Whether the agent is hosted on LiveKit Cloud.
 */
export const isHosted = (): boolean => {
  return process.env.LIVEKIT_REMOTE_EOT_URL !== undefined;
};

export function asError(maybeError: unknown): Error {
  if (maybeError instanceof Error) {
    return maybeError;
  }
  return new Error(String(maybeError));
}

/**
 * Tagged template literal that strips common leading indentation from every line,
 * trims the first empty line and any trailing whitespace.
 *
 * Useful for writing multi-line strings inside indented code without the indentation
 * leaking into the runtime value.
 *
 * @example
 * ```ts
 * const msg = dedent`
 *   Hello,
 *     world!
 * `;
 * // "Hello,\n  world!"
 * ```
 */
export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
  // Build the raw string with interpolations
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += String(values[i]);
    }
  }

  // Strip the leading newline (first line is usually empty after the backtick)
  if (result.startsWith('\n')) {
    result = result.slice(1);
  }

  const lines = result.split('\n');

  // Find the minimum indentation across non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let spaces = 0;
    for (const ch of line) {
      if (ch === ' ' || ch === '\t') {
        spaces++;
      } else {
        break;
      }
    }
    minIndent = Math.min(minIndent, spaces);
  }

  if (minIndent === Infinity) {
    minIndent = 0;
  }

  // Remove common indentation and join
  return lines
    .map((line) => line.slice(minIndent))
    .join('\n')
    .trimEnd();
}
