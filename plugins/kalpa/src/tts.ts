// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  asError,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type { TTSModels } from './models.js';

const BASE_URL = 'https://api.kalpalabs.ai';
const DEFAULT_VOICE = '18c26f49-9f9c-400c-bec9-7467f28e1db5'; // Arjun
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const MAX_IDLE_MS = 240_000;
export const CANCEL_ACK_TIMEOUT = 1_000;
const CLOSE_TIMEOUT = 1_000;

const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  context_length_exceeded: 400,
  authentication_error: 401,
  allowance_exhausted: 402,
  account_suspended: 403,
  not_found: 404,
  rate_limit_exceeded: 429,
  internal_error: 500,
  inference_error: 502,
  overloaded: 503,
  service_unavailable: 503,
};

interface KalpaError {
  type?: string;
  message?: string;
  request_id?: string;
}

interface KalpaEvent {
  type: string;
  fatal?: boolean;
  error?: KalpaError;
  response_id?: string;
  pcm_b64?: string;
  status?: string;
}

/** Options for Kalpa text-to-speech. */
export interface TTSOptions {
  /** Voice ID from `GET /v1/voices`. Defaults to Arjun. */
  voice: string;
  /** Kalpa TTS model. */
  model: TTSModels | string;
  /** Kalpa API key. Defaults to `KALPA_API_KEY`. */
  apiKey?: string;
  /** Kalpa API base URL. */
  baseURL: string;
}

const defaultTTSOptions: TTSOptions = {
  voice: DEFAULT_VOICE,
  model: 'kalpa-tts-1',
  baseURL: BASE_URL,
};

class EventQueue {
  #events: KalpaEvent[] = [];
  #waiters: Array<{
    resolve: (event: KalpaEvent) => void;
    reject: (error: Error) => void;
  }> = [];
  #error?: Error;

  push(event: KalpaEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(event);
    else this.#events.push(event);
  }

  close(error = new APIConnectionError({ message: 'Kalpa connection closed' })): void {
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  receive(timeoutMs?: number, signal?: AbortSignal): Promise<KalpaEvent> {
    const event = this.#events.shift();
    if (event) return Promise.resolve(event);
    if (this.#error) return Promise.reject(this.#error);

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        resolve: (value: KalpaEvent) => finish(() => resolve(value)),
        reject: (error: Error) => finish(() => reject(error)),
      };
      const onAbort = () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        waiter.reject(error);
      };
      const finish = (settle: () => void) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        settle();
      };

      this.#waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => waiter.reject(new APITimeoutError({ message: 'Kalpa request timed out' })),
          timeoutMs,
        );
      }
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

interface KalpaConnection {
  ws: WebSocket;
  events: EventQueue;
}

interface TTSState {
  pool: ConnectionPool<KalpaConnection>;
  streams: Map<SynthesizeStream, { done: Promise<void>; resolve: () => void }>;
  tasks: Set<Promise<void>>;
  closing: boolean;
  closePromise?: Promise<void>;
}

const states = new WeakMap<TTS, TTSState>();

const stateFor = (instance: TTS): TTSState => states.get(instance)!;

const ensureOpen = (instance: TTS): TTSState => {
  const state = stateFor(instance);
  if (state.closing) throw new Error('Kalpa TTS is closed');
  return state;
};

const spawn = (instance: TTS, task: Promise<void>): void => {
  const tasks = stateFor(instance).tasks;
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
};

const send = (connection: KalpaConnection, event: object): Promise<void> =>
  new Promise((resolve, reject) => {
    if (connection.ws.readyState !== WebSocket.OPEN) {
      reject(new APIConnectionError({ message: 'Kalpa connection is not open' }));
      return;
    }
    connection.ws.send(JSON.stringify(event), (error) =>
      error
        ? reject(new APIConnectionError({ message: `Kalpa send failed: ${error.message}` }))
        : resolve(),
    );
  });

const receiveEvent = async (
  connection: KalpaConnection,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<KalpaEvent> => {
  const event = await connection.events.receive(timeoutMs, signal);
  if (event.type === 'error' && (event.fatal ?? true)) {
    throw statusError(event.error ?? {});
  }
  return event;
};

/** Kalpa text-to-speech client. */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'kalpa.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved = {
      ...defaultTTSOptions,
      ...opts,
      apiKey: opts.apiKey || process.env.KALPA_API_KEY,
      baseURL: (opts.baseURL ?? BASE_URL).replace(/\/$/, ''),
    };
    if (!resolved.apiKey) {
      throw new Error('Kalpa API key required. Set KALPA_API_KEY or provide apiKey.');
    }
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = resolved;
    const pool = new ConnectionPool<KalpaConnection>({
      connectCb: (timeout, signal) => this.#connect(timeout, signal),
      closeCb: (connection) => this.#closeConnection(connection),
      maxSessionDuration: MAX_IDLE_MS,
      markRefreshedOnGet: true,
    });
    states.set(this, { pool, streams: new Map(), tasks: new Set(), closing: false });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Kalpa';
  }

  /** Update the voice or model used by replies that have not acquired a connection. */
  updateOptions(opts: Partial<Pick<TTSOptions, 'voice' | 'model'>>): void {
    const state = ensureOpen(this);
    if (opts.voice === undefined && opts.model === undefined) return;
    this.#opts = { ...this.#opts, ...opts };
    state.pool.invalidate();
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    ensureOpen(this);
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const state = ensureOpen(this);
    const stream = new SynthesizeStream(this, options?.connOptions);
    let resolve = () => {};
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve;
    });
    state.streams.set(stream, { done, resolve });
    return stream;
  }

  override prewarm(): void {
    ensureOpen(this).pool.prewarm();
  }

  override async releaseIdleConnections(): Promise<void> {
    await stateFor(this).pool.releaseIdle();
  }

  override async close(): Promise<void> {
    const state = stateFor(this);
    if (state.closePromise) return state.closePromise;
    state.closing = true;
    state.closePromise = this.#closeState(state);
    return state.closePromise;
  }

  async #closeState(state: TTSState): Promise<void> {
    const streams = [...state.streams.entries()];
    for (const [stream] of streams) stream.close();
    await Promise.all(streams.map(([, completion]) => completion.done));
    await Promise.allSettled([...state.tasks]);
    await state.pool.close();
    await super.close();
  }

  async #connect(timeoutMs: number, signal?: AbortSignal): Promise<KalpaConnection> {
    const url = new URL(`/v1/tts/${this.#opts.voice}/stream`, this.#opts.baseURL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    const events = new EventQueue();
    const connection = { ws, events };
    const remove = () => stateFor(this).pool.remove(connection);
    ws.on('message', (data: RawData) => {
      try {
        events.push(JSON.parse(data.toString()) as KalpaEvent);
      } catch (error) {
        events.close(new APIConnectionError({ message: asError(error).message }));
      }
    });
    ws.on('error', (error) => {
      events.close(new APIConnectionError({ message: error.message }));
      remove();
    });
    ws.on('close', (code) => {
      events.close(new APIConnectionError({ message: `Kalpa connection closed (code ${code})` }));
      remove();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new APITimeoutError({ message: 'Kalpa connection timed out' })),
          timeoutMs,
        );
        const onAbort = () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        ws.once('open', () => {
          cleanup();
          resolve();
        });
        ws.once('error', (error) => {
          cleanup();
          reject(new APIConnectionError({ message: error.message }));
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      await send(connection, {
        type: 'initializeConnection',
        api_key: this.#opts.apiKey,
        model: this.#opts.model,
        sample_rate: SAMPLE_RATE,
        generation_config: {},
      });
      const event = await receiveEvent(connection, timeoutMs, signal);
      if (event.type !== 'sessionCreated') {
        throw new APIError(`unexpected Kalpa message before sessionCreated: ${event.type}`);
      }
      return connection;
    } catch (error) {
      ws.terminate();
      throw error;
    }
  }

  async #closeConnection(connection: KalpaConnection): Promise<void> {
    if (connection.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        connection.ws.terminate();
        resolve();
      }, CLOSE_TIMEOUT);
      connection.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      connection.ws.close();
    });
  }
}

const finishStream = (instance: TTS, stream: SynthesizeStream): void => {
  const completion = stateFor(instance).streams.get(stream);
  if (!completion) return;
  stateFor(instance).streams.delete(stream);
  completion.resolve();
};

const recycle = (instance: TTS, connection: KalpaConnection): void => {
  const state = stateFor(instance);
  const task = (async () => {
    try {
      await send(connection, { type: 'cancelResponse' });
      const deadline = Date.now() + CANCEL_ACK_TIMEOUT;
      while (
        (await receiveEvent(connection, Math.max(1, deadline - Date.now()))).type !== 'cancelled'
      ) {
        // Drain events from the interrupted response until cancellation is acknowledged.
      }
      state.pool.put(connection);
    } catch {
      state.pool.remove(connection);
      if (!state.closing) state.pool.prewarm();
    }
  })();
  spawn(instance, task);
};

/** Synthesizes complete text with Kalpa's streaming HTTP endpoint. */
export class ChunkedStream extends tts.ChunkedStream {
  #opts: TTSOptions;
  #connOptions: APIConnectOptions;
  label = 'kalpa.ChunkedStream';

  constructor(
    instance: TTS,
    text: string,
    opts: TTSOptions,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ) {
    super(text, instance, connOptions, abortSignal);
    this.#opts = opts;
    this.#connOptions = connOptions;
    if (abortSignal?.aborted) this.close();
  }

  protected async run(): Promise<void> {
    if (!this.inputText.trim() || this.abortSignal.aborted) return;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.#connOptions.timeoutMs);
    };
    const abort = () => controller.abort();
    this.abortSignal.addEventListener('abort', abort, { once: true });
    resetTimeout();
    let response: Response;
    try {
      response = await fetch(`${this.#opts.baseURL}/v1/tts/${this.#opts.voice}/stream`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: this.inputText,
          model: this.#opts.model,
          sample_rate: SAMPLE_RATE,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      this.abortSignal.removeEventListener('abort', abort);
      if (this.abortSignal.aborted) return;
      if (timedOut) throw new APITimeoutError({});
      throw new APIConnectionError({ message: asError(error).message });
    }
    if (!response.ok) {
      let body: { error?: KalpaError } = {};
      try {
        body = (await response.json()) as { error?: KalpaError };
      } catch (error) {
        if (this.abortSignal.aborted) return;
        if (timedOut) throw new APITimeoutError({});
      } finally {
        if (timer) clearTimeout(timer);
        this.abortSignal.removeEventListener('abort', abort);
      }
      throw statusError(body.error ?? {}, response.status);
    }
    if (!response.body) {
      if (timer) clearTimeout(timer);
      this.abortSignal.removeEventListener('abort', abort);
      throw new APIConnectionError({ message: 'Kalpa returned no audio body' });
    }

    const requestId = response.headers.get('X-Request-ID') || shortuuid();
    const output = new SegmentWriter(requestId, (audio) => this.queue.put(audio));
    const reader = response.body.getReader();
    try {
      while (true) {
        resetTimeout();
        const result = await reader.read();
        if (result.done) break;
        output.write(Buffer.from(result.value));
      }
      output.end();
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (timedOut) throw new APITimeoutError({});
      throw new APIConnectionError({ message: asError(error).message });
    } finally {
      if (timer) clearTimeout(timer);
      this.abortSignal.removeEventListener('abort', abort);
    }
  }
}

/** Streams text and synthesized audio over a pooled Kalpa WebSocket. */
export class SynthesizeStream extends tts.SynthesizeStream {
  #tts: TTS;
  #replayInput: Array<string | symbol> = [];
  #attempt = 0;
  label = 'kalpa.SynthesizeStream';

  constructor(instance: TTS, connOptions?: APIConnectOptions) {
    super(instance, connOptions);
    this.#tts = instance;
  }

  protected async run(): Promise<void> {
    const pool = stateFor(this.#tts).pool;
    let connection: KalpaConnection;
    try {
      connection = await pool.get(this.connOptions.timeoutMs, this.abortSignal);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      throw error;
    }
    const output = new SegmentWriter(shortuuid(), (audio) => this.queue.put(audio));
    const attempt = new AbortController();
    const signal = AbortSignal.any([this.abortSignal, attempt.signal]);
    let sent = false;
    let done = false;
    let rejected = false;
    let deadline: number | undefined;

    const sendTask = async () => {
      const input = this.#inputForAttempt(signal);
      for await (const data of input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          if (sent) break;
          continue;
        }
        const text = data as string;
        if (text.trim()) this.markStarted();
        sent = true;
        await send(connection, { type: 'sendText', text });
      }
      signal.throwIfAborted();
      sent = true;
      await send(connection, { type: 'sendText', flush: true });
      deadline = Date.now() + this.connOptions.timeoutMs;
    };

    const receiveTask = async () => {
      let error: KalpaError | undefined;
      while (true) {
        let event: KalpaEvent;
        try {
          event = await receiveEvent(
            connection,
            deadline === undefined
              ? this.connOptions.timeoutMs
              : Math.max(1, deadline - Date.now()),
            signal,
          );
        } catch (value) {
          if (
            value instanceof APITimeoutError &&
            (deadline === undefined || Date.now() < deadline)
          ) {
            continue;
          }
          throw value;
        }
        if (deadline !== undefined) deadline = Date.now() + this.connOptions.timeoutMs;
        if (event.type === 'error') {
          if (!event.response_id) {
            rejected = true;
            throw statusError(event.error ?? {});
          }
          error = event.error;
        } else if (event.type === 'responseCreated') {
          this.noteProviderRequestId(event.response_id ?? '');
        } else if (event.type === 'responseAudio') {
          output.write(Buffer.from(event.pcm_b64 ?? '', 'base64'));
        } else if (event.type === 'responseDone') {
          done = true;
          if (event.status !== 'completed') {
            if (error) throw statusError(error);
            throw new APIError(`Kalpa response ended with status ${event.status}`);
          }
          return;
        }
      }
    };

    try {
      const tasks = [sendTask(), receiveTask()] as const;
      try {
        await Promise.all(tasks);
      } finally {
        attempt.abort();
        await Promise.allSettled(tasks);
      }
      output.end();
      this.queue.put(SynthesizeStream.END_OF_STREAM);
      pool.put(connection);
    } catch (error) {
      if (this.abortSignal.aborted || done || rejected) {
        if (sent && !done) recycle(this.#tts, connection);
        else pool.put(connection);
      } else {
        pool.remove(connection);
      }
      if (!this.abortSignal.aborted) throw error;
    } finally {
      this.#attempt++;
    }
  }

  protected override onStreamDone(): void {
    finishStream(this.#tts, this);
  }

  async *#inputForAttempt(signal: AbortSignal): AsyncGenerator<string | symbol> {
    if (this.#attempt > 0) {
      yield* this.#replayInput;
    }
    while (true) {
      const item = await this.input.next({ signal });
      if (item.done) return;
      const data = item.value;
      this.#replayInput.push(data);
      yield data;
    }
  }
}

class SegmentWriter {
  #audio = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
  #lastFrame?: AudioFrame;
  #requestId: string;
  #put: (audio: tts.SynthesizedAudio) => void;

  constructor(requestId: string, put: (audio: tts.SynthesizedAudio) => void) {
    this.#requestId = requestId;
    this.#put = put;
  }

  write(data: Buffer): void {
    this.#push(this.#audio.write(data));
  }

  end(): void {
    this.#push(this.#audio.flush());
    this.#send(true);
  }

  #push(frames: AudioFrame[]): void {
    for (const frame of frames) {
      this.#send(false);
      this.#lastFrame = frame;
    }
  }

  #send(final: boolean): void {
    if (!this.#lastFrame) return;
    this.#put({
      requestId: this.#requestId,
      segmentId: this.#requestId,
      frame: this.#lastFrame,
      final,
    });
    this.#lastFrame = undefined;
  }
}

function statusError(error: KalpaError, status?: number): APIStatusError {
  const errorType = error.type;
  return new APIStatusError({
    message: error.message || 'Kalpa API error',
    options: {
      statusCode: status ?? ERROR_STATUS[errorType ?? ''] ?? 500,
      requestId: error.request_id,
      body: errorType,
    },
  });
}
