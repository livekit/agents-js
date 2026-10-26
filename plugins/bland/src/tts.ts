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
  Future,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { IncomingMessage } from 'node:http';
import { type RawData, WebSocket } from 'ws';

const DEFAULT_BASE_URL = 'https://api.bland.ai/v2';
const DEFAULT_VOICE_ID = '2f29fdbb-c55e-4add-9c7c-93437ebf379d';
const DEFAULT_SAMPLE_RATE = 48000;
const NUM_CHANNELS = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SESSION_DURATION_MS = 50_000;
const CANCEL_DRAIN_TIMEOUT_MS = 500;
const SAMPLE_RATES = [8000, 16000, 24000, 44100, 48000] as const;

const FATAL_ERROR_CODES = new Set([
  'AUTH_FAILED',
  'INSUFFICIENT_CREDITS',
  'ORG_DELETED',
  'ORG_STRIPE_OVERDUE',
  'ORG_SUSPENDED',
  'USER_BANNED',
  'already_initialized',
  'context_overflow',
  'init_required',
  'insufficient_credits',
  'invalid_message',
  'invalid_request',
  'unsupported_encoding',
  'unsupported_sample_rate',
  'unsupported_voice',
  'voice_not_found',
  'voice_not_live',
]);

/**
 * Configuration options for Bland TTS.
 *
 * @public
 */
export interface TTSOptions {
  /** Bland voice UUID. Names are not accepted. Defaults to a BTTS_V3 voice. */
  voiceId?: string;
  /** Output sample rate in Hz. Defaults to 48000, the native BTTS_V3 rate. */
  sampleRate?: number;
  /** Higher values produce more varied intonation. Range: 0.0-1.0. */
  expressiveness?: number;
  /** Higher values produce more consistency between renders. Range: 0.0-1.0. */
  stability?: number;
  /** Bland API key. Falls back to `$BLAND_API_KEY`. */
  apiKey?: string;
  /** Bland API base URL. */
  baseUrl?: string;
  /** Use Bland's realtime WebSocket endpoint. Defaults to true. */
  streaming?: boolean;
}

interface ResolvedTTSOptions {
  voiceId: string;
  sampleRate: number;
  expressiveness?: number;
  stability?: number;
  apiKey: string;
  baseUrl: string;
}

type WebSocketEvent =
  | { type: 'message'; data: RawData; isBinary: boolean }
  | { type: 'close'; code: number; reason: Buffer }
  | { type: 'error'; error: Error };

const resolvedOptions = new WeakMap<tts.TTS, ResolvedTTSOptions>();
const connectionPools = new WeakMap<TTS, ConnectionPool<WebSocket>>();
const streamCompletionCallbacks = new WeakMap<SynthesizeStream, () => void>();

function resolveOptions(opts: TTSOptions): ResolvedTTSOptions {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`sampleRate must be one of ${SAMPLE_RATES.join(', ')}, got ${sampleRate}`);
  }

  const apiKey = opts.apiKey ?? process.env.BLAND_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Bland API key is required, either as `apiKey` argument or `BLAND_API_KEY` environment variable',
    );
  }

  return {
    voiceId: opts.voiceId ?? DEFAULT_VOICE_ID,
    sampleRate,
    expressiveness: opts.expressiveness,
    stability: opts.stability,
    apiKey,
    baseUrl: (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

/**
 * Bland text-to-speech client.
 *
 * @public
 */
export class TTS extends tts.TTS {
  label = 'bland.TTS';
  #opts: ResolvedTTSOptions;
  #pool?: ConnectionPool<WebSocket>;
  #streams = new Map<SynthesizeStream, Promise<void>>();
  #closed = false;

  constructor(opts: TTSOptions = {}) {
    const resolved = resolveOptions(opts);
    const streaming = opts.streaming ?? true;
    super(resolved.sampleRate, NUM_CHANNELS, { streaming });
    this.#opts = resolved;
    resolvedOptions.set(this, resolved);

    if (streaming) {
      this.#pool = new ConnectionPool<WebSocket>({
        connectCb: (timeoutMs) => this.#connectWebSocket(timeoutMs),
        closeCb: (ws) => closeBlandWebSocket(ws),
        maxSessionDuration: MAX_SESSION_DURATION_MS,
        markRefreshedOnGet: true,
        connectTimeout: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
      });
      connectionPools.set(this, this.#pool);
    }
  }

  get provider(): string {
    return 'Bland';
  }

  /** Update voice and synthesis controls for subsequent requests. */
  updateOptions(
    opts: Partial<Pick<TTSOptions, 'voiceId' | 'expressiveness' | 'stability'>> = {},
  ): void {
    const supplied = ['voiceId', 'expressiveness', 'stability'].some((key) =>
      Object.prototype.hasOwnProperty.call(opts, key),
    );
    if (opts.voiceId !== undefined) this.#opts.voiceId = opts.voiceId;
    if (opts.expressiveness !== undefined) this.#opts.expressiveness = opts.expressiveness;
    if (opts.stability !== undefined) this.#opts.stability = opts.stability;
    if (supplied) this.#pool?.invalidate();
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    if (!this.#pool) {
      throw new Error(
        'Streaming is disabled on this Bland TTS instance; construct it with `streaming: true`, or wrap it in a `tts.StreamAdapter`',
      );
    }
    const stream = new SynthesizeStream(this, options?.connOptions);
    let markDone!: () => void;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    streamCompletionCallbacks.set(stream, () => {
      this.#streams.delete(stream);
      markDone();
    });
    this.#streams.set(stream, done);
    return stream;
  }

  prewarm(): void {
    this.#pool?.prewarm();
  }

  override async close(): Promise<void> {
    this.#closed = true;
    const streams = [...this.#streams.entries()];
    for (const [stream] of streams) stream.close();
    await Promise.all(streams.map(([, done]) => done));
    this.#streams.clear();
    await this.#pool?.close();
    await super.close();
  }

  async #connectWebSocket(timeoutMs: number): Promise<WebSocket> {
    const opts = { ...this.#opts };
    const ws = await openWebSocket(wsUrl(opts.baseUrl), opts.apiKey, timeoutMs);
    try {
      const inbox = new WebSocketInbox(ws);
      const event = await (async () => {
        try {
          await sendWebSocket(
            ws,
            JSON.stringify({
              type: 'init',
              voice: opts.voiceId,
              audio: { encoding: 'pcm_s16le', sample_rate: opts.sampleRate },
              ...(Object.keys(controls(opts)).length > 0 ? { controls: controls(opts) } : {}),
            }),
          );
          return await inbox.next({ timeoutMs });
        } catch (error) {
          if (isTimeoutError(error)) throw new APITimeoutError({});
          throw error;
        } finally {
          inbox.close();
        }
      })();
      if (event.type !== 'message' || event.isBinary) {
        throw new APIError(`Bland did not acknowledge init: ${event.type}`);
      }
      const data = parseMessage(event.data);
      if (data.type !== 'ready') throw apiError(data);
      if (data.encoding !== 'pcm_s16le' || data.sample_rate !== opts.sampleRate) {
        throw new APIError('Bland acknowledged an unexpected audio format', {
          body: data,
          retryable: false,
        });
      }
      log().debug({ sessionId: data.session_id }, 'Bland TTS session ready');
    } catch (error) {
      terminateWebSocket(ws);
      throw error;
    }

    if (this.#closed) {
      terminateWebSocket(ws);
      throw new APIConnectionError({ message: 'Bland TTS is closed' });
    }
    if (
      opts.apiKey !== this.#opts.apiKey ||
      opts.voiceId !== this.#opts.voiceId ||
      opts.sampleRate !== this.#opts.sampleRate ||
      opts.expressiveness !== this.#opts.expressiveness ||
      opts.stability !== this.#opts.stability ||
      opts.baseUrl !== this.#opts.baseUrl
    ) {
      terminateWebSocket(ws);
      return this.#connectWebSocket(timeoutMs);
    }

    ws.on('error', () => {});
    ws.on('close', () => this.#pool?.remove(ws));
    return ws;
  }
}

/**
 * Audio stream returned by a Bland HTTP synthesis request.
 *
 * @public
 */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'bland.ChunkedStream';
  #opts: ResolvedTTSOptions;
  #text: string;
  #timeoutMs: number;

  constructor(
    ttsInstance: TTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#text = text;
    this.#opts = { ...resolvedOptions.get(ttsInstance)! };
    this.#timeoutMs = Math.min(
      connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
      REQUEST_TIMEOUT_MS,
    );
  }

  protected async run(): Promise<void> {
    const payload: Record<string, unknown> = {
      text: this.#text,
      voice: this.#opts.voiceId,
      audio: { encoding: 'pcm_s16le', sample_rate: this.#opts.sampleRate },
    };
    const requestControls = controls(this.#opts);
    if (Object.keys(requestControls).length > 0) payload.controls = requestControls;

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([this.abortSignal, timeoutSignal]);

    try {
      const response = await fetch(`${this.#opts.baseUrl}/tts`, {
        method: 'POST',
        headers: {
          authorization: this.#opts.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        throw new APIStatusError({
          message: await errorMessage(response),
          options: {
            statusCode: response.status,
            requestId: response.headers.get('x-request-id'),
          },
        });
      }

      const reader = response.body?.getReader();
      if (!reader) throw new APIConnectionError({ message: 'Bland TTS response has no body' });

      const requestId = response.headers.get('x-request-id') ?? shortuuid();
      const audioStream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (final: boolean) => {
        if (!lastFrame) return;
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
        lastFrame = undefined;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of audioStream.write(value)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        }
        for (const frame of audioStream.flush()) {
          sendLastFrame(false);
          lastFrame = frame;
        }
        sendLastFrame(true);
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      if (timeoutSignal.aborted) throw new APITimeoutError({});
      throw new APIConnectionError({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Realtime Bland synthesis stream. One stream represents one Bland turn and segment.
 *
 * @public
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'bland.SynthesizeStream';
  #opts: ResolvedTTSOptions;
  #pool: ConnectionPool<WebSocket>;
  #logger = log();
  #textDeltas: string[] = [];
  #inputDone = false;
  #inputPump?: Promise<void>;
  #inputWaiters = new Set<() => void>();

  constructor(ttsInstance: TTS, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    const pool = connectionPools.get(ttsInstance);
    if (!pool) throw new Error('Bland connection pool is not initialized');
    this.#pool = pool;
    this.#opts = { ...resolvedOptions.get(ttsInstance)! };
  }

  protected override onStreamDone(): void {
    streamCompletionCallbacks.get(this)?.();
    streamCompletionCallbacks.delete(this);
  }

  protected async run(): Promise<void> {
    this.#startInputPump();
    const contextId = shortuuid();
    const requestId = contextId;
    const audioStream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    let lastFrame: AudioFrame | undefined;
    let textAttempted = false;
    let textSent = false;
    let writesInFlight = 0;
    let reusable = false;
    const firstInput = new Future<boolean>();
    const attemptController = new AbortController();
    const connection = this.#pool.get(this.connOptions.timeoutMs);
    void connection.catch(() => {});
    const abortedBeforeAcquire = new Promise<'aborted'>((resolve) => {
      if (this.abortSignal.aborted) resolve('aborted');
      else this.abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    let ws: WebSocket;
    try {
      const acquired = await Promise.race([connection, abortedBeforeAcquire]);
      if (acquired === 'aborted') {
        void connection.then((lateSocket) => this.#pool.remove(lateSocket)).catch(() => {});
        return;
      }
      ws = acquired;
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (isTimeoutError(error)) throw new APITimeoutError({});
      throw new APIConnectionError({
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const inbox = new WebSocketInbox(ws);

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame || this.queue.closed) return;
      this.queue.put({ requestId, segmentId: contextId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    const send = async (message: Record<string, unknown>) => {
      writesInFlight++;
      try {
        await sendWebSocket(ws, JSON.stringify(message));
      } finally {
        writesInFlight--;
      }
    };

    const sendTask = async () => {
      let index = 0;
      while (true) {
        while (index < this.#textDeltas.length) {
          if (this.abortSignal.aborted || attemptController.signal.aborted) break;
          const data = this.#textDeltas[index++]!;
          textAttempted = true;
          this.markStarted();
          await send({ type: 'speak', context_id: contextId, text: data });
          textSent = true;
          if (!firstInput.done) firstInput.resolve(true);
        }
        if (this.#inputDone || this.abortSignal.aborted || attemptController.signal.aborted) {
          break;
        }
        await this.#waitForInput(index, attemptController.signal);
      }
      if (attemptController.signal.aborted) return;
      if (this.abortSignal.aborted) {
        if (!firstInput.done) firstInput.resolve(textSent);
        return;
      }
      if (!textSent) {
        if (!firstInput.done) firstInput.resolve(false);
        return;
      }
      await send({ type: 'end_of_turn', context_id: contextId });
    };

    const recvTask = async () => {
      if (!(await firstInput.await)) return;
      const receiveSignal = AbortSignal.any([this.abortSignal, attemptController.signal]);
      while (true) {
        const event = await inbox.next({
          timeoutMs: this.connOptions.timeoutMs,
          signal: receiveSignal,
        });
        if (event.type === 'error') throw event.error;
        if (event.type === 'close') throw closedError('unexpectedly', event);
        if (event.isBinary) {
          for (const frame of audioStream.write(rawDataBytes(event.data))) {
            sendLastFrame(false);
            lastFrame = frame;
          }
          continue;
        }

        const data = parseMessage(event.data);
        if (data.type === 'utterance_start') continue;
        if (data.type === 'utterance_end') {
          if (data.context_id !== contextId) continue;
          if (data.reason !== 'complete') {
            throw new APIError(`Bland turn ended as ${String(data.reason)}`, { body: data });
          }
          for (const frame of audioStream.flush()) {
            sendLastFrame(false);
            lastFrame = frame;
          }
          sendLastFrame(true);
          return;
        }
        if (data.type === 'error') throw apiError(data);
        this.#logger.warn({ data }, 'Unexpected Bland message');
      }
    };

    const tasks = Promise.all([sendTask(), recvTask()]);
    void tasks.catch(() => {});
    const aborted = new Promise<'aborted'>((resolve) => {
      if (this.abortSignal.aborted) resolve('aborted');
      else this.abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    try {
      const result = await Promise.race([tasks.then(() => 'complete' as const), aborted]);
      if (result === 'complete') {
        reusable = true;
        if (!this.queue.closed) this.queue.put(SynthesizeStream.END_OF_STREAM);
        return;
      }

      const turnWasSent = textSent;
      const writeWasInFlight = writesInFlight > 0;
      await Promise.allSettled([tasks]);
      if (!textAttempted) {
        reusable = true;
        return;
      }
      if (!turnWasSent || writeWasInFlight) return;

      try {
        await send({ type: 'cancel', context_id: contextId });
        const drainSignal = AbortSignal.timeout(CANCEL_DRAIN_TIMEOUT_MS);
        while (true) {
          const event = await inbox.next({ signal: drainSignal });
          if (event.type === 'error') throw event.error;
          if (event.type === 'close') throw closedError('while cancelling a turn', event);
          if (event.isBinary) continue;
          const data = parseMessage(event.data);
          if (data.context_id !== contextId) continue;
          if (data.type === 'error') throw apiError(data);
          if (data.type !== 'utterance_end') continue;
          if (data.reason !== 'cancelled' && data.reason !== 'complete') {
            throw new APIError('Bland did not cancel the turn cleanly', { body: data });
          }
          reusable = true;
          return;
        }
      } catch (error) {
        this.#logger.debug({ error }, 'Bland cancel handshake failed');
        return;
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      if (isTimeoutError(error)) throw new APITimeoutError({});
      throw new APIConnectionError({
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      attemptController.abort();
      if (!firstInput.done) firstInput.resolve(false);
      inbox.close();
      if (reusable) this.#pool.put(ws);
      else this.#pool.remove(ws);
    }
  }

  #startInputPump(): void {
    if (this.#inputPump) return;
    this.#inputPump = (async () => {
      try {
        for await (const data of this.input) {
          if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
          this.#textDeltas.push(data);
          this.#wakeInputWaiters();
        }
      } finally {
        this.#inputDone = true;
        this.#wakeInputWaiters();
      }
    })();
    void this.#inputPump.catch(() => {});
  }

  async #waitForInput(index: number, signal: AbortSignal): Promise<void> {
    if (index < this.#textDeltas.length || this.#inputDone) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.#inputWaiters.delete(onInput);
        signal.removeEventListener('abort', onAbort);
      };
      const onInput = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      this.#inputWaiters.add(onInput);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #wakeInputWaiters(): void {
    for (const waiter of this.#inputWaiters) waiter();
    this.#inputWaiters.clear();
  }
}

class WebSocketInbox {
  #ws: WebSocket;
  #events: WebSocketEvent[] = [];
  #waiters = new Set<(event: WebSocketEvent) => void>();
  #onMessage = (data: RawData, isBinary: boolean) =>
    this.#push({ type: 'message', data, isBinary });
  #onClose = (code: number, reason: Buffer) => this.#push({ type: 'close', code, reason });
  #onError = (error: Error) => this.#push({ type: 'error', error });

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', this.#onMessage);
    ws.on('close', this.#onClose);
    ws.on('error', this.#onError);
  }

  #push(event: WebSocketEvent): void {
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter(event);
    } else {
      this.#events.push(event);
    }
  }

  async next({
    timeoutMs,
    signal,
  }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WebSocketEvent> {
    const queued = this.#events.shift();
    if (queued) return queued;
    if (signal?.aborted) throw signal.reason;

    return await new Promise<WebSocketEvent>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        this.#waiters.delete(onEvent);
        signal?.removeEventListener('abort', onAbort);
        if (timeout) clearTimeout(timeout);
      };
      const onEvent = (event: WebSocketEvent) => {
        cleanup();
        resolve(event);
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason);
      };
      this.#waiters.add(onEvent);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        }, timeoutMs);
      }
    });
  }

  close(): void {
    this.#ws.off('message', this.#onMessage);
    this.#ws.off('close', this.#onClose);
    this.#ws.off('error', this.#onError);
    this.#waiters.clear();
  }
}

function wsUrl(baseUrl: string): string {
  return `${baseUrl
    .replace(/\/+$/, '')
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')}/tts/ws`;
}

function controls(opts: ResolvedTTSOptions): Record<string, number> {
  const result: Record<string, number> = {};
  if (opts.expressiveness !== undefined) result.expressiveness = opts.expressiveness;
  if (opts.stability !== undefined) result.stability = opts.stability;
  return result;
}

function apiError(data: Record<string, unknown>): APIError {
  const code = typeof data.code === 'string' ? data.code : undefined;
  const message = typeof data.message === 'string' ? data.message : 'Bland returned an error';
  return new APIError(code ? `${code}: ${message}` : message, {
    body: data,
    retryable: !code || !FATAL_ERROR_CODES.has(code),
  });
}

function parseMessage(data: RawData): Record<string, unknown> {
  return JSON.parse(data.toString()) as Record<string, unknown>;
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

function closedError(
  where: string,
  event: Extract<WebSocketEvent, { type: 'close' }>,
): APIStatusError {
  return new APIStatusError({
    message: `Bland connection closed ${where}`,
    options: {
      statusCode: event.code || -1,
      body: { reason: event.reason.toString() },
    },
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

async function openWebSocket(url: string, apiKey: string, timeoutMs: number): Promise<WebSocket> {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: timeoutMs,
  });

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new APITimeoutError({})), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
      ws.off('unexpected-response', onUnexpectedResponse);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        terminateWebSocket(ws);
        reject(error);
      } else {
        resolve(ws);
      }
    };
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number, reason: Buffer) =>
      finish(new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`));
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      response.resume();
      const requestId = response.headers['x-request-id'];
      finish(
        new APIStatusError({
          message: response.statusMessage || 'WebSocket upgrade failed',
          options: {
            statusCode: response.statusCode ?? -1,
            requestId: Array.isArray(requestId) ? requestId[0] : requestId ?? null,
          },
        }),
      );
    };

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.on('unexpected-response', onUnexpectedResponse);
  });
}

async function nextWebSocketEvent(
  ws: WebSocket,
  { timeoutMs }: { timeoutMs: number },
): Promise<WebSocketEvent> {
  const inbox = new WebSocketInbox(ws);
  try {
    return await inbox.next({ timeoutMs });
  } catch (error) {
    if (isTimeoutError(error)) throw new APITimeoutError({});
    throw error;
  } finally {
    inbox.close();
  }
}

async function sendWebSocket(ws: WebSocket, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      ws.send(data, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function closeBlandWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  ws.on('error', () => {});
  try {
    const response = nextWebSocketEvent(ws, { timeoutMs: 1000 });
    await sendWebSocket(ws, JSON.stringify({ type: 'close' }));
    await response;
  } catch (error) {
    log().debug({ error }, 'Bland TTS close handshake skipped');
  } finally {
    try {
      ws.close();
    } catch {
      ws.terminate();
    }
  }
}

function terminateWebSocket(ws: WebSocket): void {
  ws.on('error', () => {});
  try {
    ws.terminate();
  } catch {
    // The socket may not have been assigned yet.
  }
}

async function errorMessage(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return response.statusText || 'request failed';
  }

  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = payload.error;
    if (error && typeof error === 'object') {
      const code = 'code' in error ? error.code : undefined;
      const message = 'message' in error ? error.message : undefined;
      if (code && message) return `${String(code)}: ${String(message)}`;
      if (message) return String(message);
    }
  }
  return JSON.stringify(payload);
}
