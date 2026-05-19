// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';
import { WebSocket } from 'ws';
import type { TTSAudioFormat, TTSModels } from './models.js';

const WEBSOCKET_URL = 'wss://tts-rt.soniox.com/tts-websocket';
const NUM_CHANNELS = 1;
const DEFAULT_MODEL = 'tts-rt-v1-preview';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_VOICE = 'Maya';
const DEFAULT_AUDIO_FORMAT = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 24000;
const KEEPALIVE_INTERVAL_MS = 10000;
const KEEPALIVE_MESSAGE = JSON.stringify({ keep_alive: true });

const audioFormatToMimeType = (audioFormat: string): string => {
  if (audioFormat.startsWith('pcm')) return 'audio/pcm';
  if (audioFormat === 'mp3') return 'audio/mpeg';
  return `audio/${audioFormat}`;
};

/** @public */
export interface TTSOptions {
  apiKey?: string;
  websocketUrl: string;
  model: TTSModels;
  language: string;
  voice: string;
  audioFormat: TTSAudioFormat;
  sampleRate: number;
  bitrate?: number | null;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.SONIOX_API_KEY,
  websocketUrl: WEBSOCKET_URL,
  model: DEFAULT_MODEL,
  language: DEFAULT_LANGUAGE,
  voice: DEFAULT_VOICE,
  audioFormat: DEFAULT_AUDIO_FORMAT,
  sampleRate: DEFAULT_SAMPLE_RATE,
  bitrate: null,
};

/** @public */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #currentConnection: Connection | null = null;
  #connectionPromise: Promise<Connection> | null = null;
  label = 'soniox.TTS';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Soniox';
  }

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved = { ...defaultTTSOptions, ...opts };
    if (!resolved.apiKey) {
      throw new Error('Soniox API key is required, whether as an argument or as $SONIOX_API_KEY');
    }
    super(resolved.sampleRate, NUM_CHANNELS, { streaming: true });
    this.#opts = resolved;
  }

  updateOptions(opts: Partial<Pick<TTSOptions, 'model' | 'language' | 'voice'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
  }

  async currentConnection(timeoutMs: number, abortSignal: AbortSignal): Promise<Connection> {
    const current = this.#currentConnection;
    if (current?.isCurrent && !current.closed) return current;
    if (this.#connectionPromise) return this.#connectionPromise;

    this.#connectionPromise = (async () => {
      if (this.#currentConnection && !this.#currentConnection.closed) {
        this.#currentConnection.markNonCurrent();
      }
      const connection = new Connection(this.#opts);
      await connection.connect(timeoutMs, abortSignal);
      this.#currentConnection = connection;
      return connection;
    })();

    try {
      return await this.#connectionPromise;
    } finally {
      this.#connectionPromise = null;
    }
  }

  async close(): Promise<void> {
    await this.#currentConnection?.close();
    this.#currentConnection = null;
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #tts: TTS;
  #streamId = '';
  #connection: Connection | null = null;
  #audioStream: AudioByteStream;
  #requestId = '';
  #segmentId = '';
  label = 'soniox.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#opts = opts;
    this.#audioStream = new AudioByteStream(opts.sampleRate, NUM_CHANNELS);
  }

  protected async run(): Promise<void> {
    this.#requestId = shortuuid();
    this.#segmentId = shortuuid();
    this.#streamId = shortuuid();
    const connection = await this.#tts.currentConnection(
      this.connOptions.timeoutMs,
      this.abortSignal,
    );
    this.#connection = connection;
    const waiter = makeDeferred<void>();
    connection.registerStream(this.#streamId, this, waiter, { ...this.#opts });

    const inputTask = this.#inputLoop(connection);
    try {
      await waiter.promise;
    } finally {
      await inputTask.catch(() => {});
      connection.unregisterStream(this.#streamId);
    }
  }

  close() {
    if (this.#connection && this.#streamId) {
      this.#connection.cancelStream(this.#streamId);
    }
    super.close();
  }

  async #inputLoop(connection: Connection): Promise<void> {
    for await (const data of this.input) {
      if (this.abortSignal.aborted) break;
      if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
      connection.sendText(this.#streamId, data, false);
    }
    if (!this.abortSignal.aborted) {
      connection.sendText(this.#streamId, '', true);
    }
  }

  pushAudio(audio: Buffer) {
    for (const frame of this.#audioStream.write(
      audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    )) {
      this.queue.put({
        requestId: this.#requestId,
        segmentId: this.#segmentId,
        frame,
        final: false,
      });
    }
  }

  finishAudio() {
    for (const frame of this.#audioStream.flush()) {
      this.queue.put({
        requestId: this.#requestId,
        segmentId: this.#segmentId,
        frame,
        final: false,
      });
    }
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  #opts: TTSOptions;
  #connOptions: APIConnectOptions;
  label = 'soniox.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#opts = opts;
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run(): Promise<void> {
    if (!this.inputText) return;

    const requestId = shortuuid();
    const segmentId = shortuuid();
    const streamId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const ws = new WebSocket(this.#opts.websocketUrl);
    let audioEnded = false;

    try {
      await waitForWsOpen(ws, this.#connOptions.timeoutMs, this.abortSignal, 'Soniox TTS');
      ws.send(JSON.stringify(startConfig(streamId, this.#opts)));
      ws.send(JSON.stringify({ stream_id: streamId, text: this.inputText }));
      ws.send(JSON.stringify({ stream_id: streamId, text_end: true }));

      for await (const raw of websocketMessages(ws, this.abortSignal)) {
        const resp = JSON.parse(raw) as SonioxTTSResponse;
        if (resp.stream_id !== streamId) continue;
        if (resp.error_code) throw apiStatusErrorFromResponse(streamId, resp, raw);
        if (resp.audio) {
          const audio = Buffer.from(resp.audio, 'base64');
          for (const frame of bstream.write(
            audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
          )) {
            this.queue.put({ requestId, segmentId, frame, final: false });
          }
        }
        if (resp.audio_end) audioEnded = true;
        if (resp.terminated) {
          if (!audioEnded) throw terminatedWithoutAudioError(streamId);
          for (const frame of bstream.flush()) {
            this.queue.put({ requestId, segmentId, frame, final: false });
          }
          return;
        }
      }
      throw new APIConnectionError({ message: 'Soniox TTS WebSocket closed unexpectedly' });
    } catch (error) {
      if (this.abortSignal.aborted) return;
      throw error;
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }
}

interface SonioxTTSResponse {
  stream_id?: string;
  audio?: string;
  audio_end?: boolean;
  terminated?: boolean;
  error_code?: number;
  error_message?: string;
}

interface StreamData {
  stream: SynthesizeStream;
  waiter: Deferred<void>;
  opts: TTSOptions;
  audioEnded: boolean;
  cancelSent: boolean;
  configSent: boolean;
}

type OutboundMessage =
  | { type: 'start'; streamId: string; opts: TTSOptions }
  | { type: 'text'; streamId: string; text: string; textEnd: boolean }
  | { type: 'cancel'; streamId: string };

class Connection {
  #opts: TTSOptions;
  #ws: WebSocket | null = null;
  #streams = new Map<string, StreamData>();
  #queue: OutboundMessage[] = [];
  #notifySend: (() => void) | null = null;
  #isCurrent = true;
  #closed = false;
  #logger = log();

  constructor(opts: TTSOptions) {
    this.#opts = opts;
  }

  get isCurrent(): boolean {
    return this.#isCurrent;
  }

  get closed(): boolean {
    return this.#closed;
  }

  markNonCurrent() {
    this.#isCurrent = false;
    if (this.#streams.size === 0) void this.close();
  }

  async connect(timeoutMs: number, abortSignal: AbortSignal): Promise<void> {
    this.#ws = new WebSocket(this.#opts.websocketUrl);
    await waitForWsOpen(this.#ws, timeoutMs, abortSignal, 'Soniox TTS');
    void this.#sendLoop();
    void this.#recvLoop();
    void this.#keepaliveLoop();
  }

  registerStream(
    streamId: string,
    stream: SynthesizeStream,
    waiter: Deferred<void>,
    opts: TTSOptions,
  ) {
    if (this.#closed) {
      waiter.reject(new APIConnectionError({ message: 'Soniox TTS connection is closed' }));
      return;
    }
    if (this.#streams.has(streamId)) throw new Error(`stream_id ${streamId} already registered`);
    this.#streams.set(streamId, {
      stream,
      waiter,
      opts,
      audioEnded: false,
      cancelSent: false,
      configSent: false,
    });
  }

  unregisterStream(streamId: string) {
    this.#streams.delete(streamId);
    if (!this.#isCurrent && this.#streams.size === 0) void this.close();
  }

  sendText(streamId: string, text: string, textEnd: boolean) {
    if (this.#closed) return;
    const stream = this.#streams.get(streamId);
    if (!stream) return;

    if (!text) {
      if (!textEnd) return;
      if (!stream.configSent) {
        stream.waiter.resolve();
        this.#streams.delete(streamId);
        return;
      }
    }

    if (!stream.configSent) {
      stream.configSent = true;
      this.#enqueue({ type: 'start', streamId, opts: stream.opts });
    }
    this.#enqueue({ type: 'text', streamId, text, textEnd });
  }

  cancelStream(streamId: string) {
    if (this.#closed) return;
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    if (!stream.configSent) {
      stream.waiter.resolve();
      this.#streams.delete(streamId);
      return;
    }
    stream.cancelSent = true;
    this.#enqueue({ type: 'cancel', streamId });
  }

  #enqueue(message: OutboundMessage) {
    this.#queue.push(message);
    this.#notifySend?.();
  }

  async #sendLoop(): Promise<void> {
    try {
      while (!this.#closed && this.#ws?.readyState === WebSocket.OPEN) {
        if (this.#queue.length === 0) {
          await new Promise<void>((resolve) => {
            this.#notifySend = resolve;
          });
          this.#notifySend = null;
        }
        const msg = this.#queue.shift();
        if (!msg || this.#closed || this.#ws?.readyState !== WebSocket.OPEN) continue;
        if (msg.type === 'start') {
          this.#ws.send(JSON.stringify(startConfig(msg.streamId, msg.opts)));
        } else if (msg.type === 'text') {
          const payload: Record<string, unknown> = { stream_id: msg.streamId };
          if (msg.text) payload.text = msg.text;
          if (msg.textEnd) payload.text_end = true;
          this.#ws.send(JSON.stringify(payload));
        } else {
          this.#ws.send(JSON.stringify({ stream_id: msg.streamId, cancel: true }));
        }
      }
    } catch (error) {
      this.#logger.warn({ error }, 'Soniox TTS send loop error');
      this.#failAll(new APIConnectionError({ message: 'Soniox TTS send loop error' }));
    } finally {
      if (!this.#closed) void this.close();
    }
  }

  async #recvLoop(): Promise<void> {
    if (!this.#ws) return;
    try {
      for await (const raw of websocketMessages(this.#ws)) {
        const resp = JSON.parse(raw) as SonioxTTSResponse;
        const streamId = resp.stream_id;
        if (!streamId) {
          if (resp.error_code) {
            this.#logger.error(
              `Soniox TTS connection-level error: ${resp.error_code} - ${resp.error_message}`,
            );
          }
          continue;
        }
        const stream = this.#streams.get(streamId);
        if (!stream) continue;

        if (resp.error_code) {
          stream.waiter.reject(apiStatusErrorFromResponse(streamId, resp, raw));
          continue;
        }
        if (resp.audio) {
          stream.stream.pushAudio(Buffer.from(resp.audio, 'base64'));
        }
        if (resp.audio_end) stream.audioEnded = true;
        if (resp.terminated) {
          if (!stream.waiter.settled) {
            if (!stream.audioEnded && !stream.cancelSent) {
              stream.waiter.reject(terminatedWithoutAudioError(streamId));
            } else {
              stream.stream.finishAudio();
              stream.waiter.resolve();
            }
          }
          this.#streams.delete(streamId);
        }
      }
      if (!this.#closed && this.#streams.size > 0) {
        this.#failAll(new APIConnectionError({ message: 'Soniox TTS connection closed' }));
      }
    } catch (error) {
      this.#logger.warn({ error }, 'Soniox TTS recv loop error');
      this.#failAll(new APIConnectionError({ message: 'Soniox TTS recv loop error' }));
    } finally {
      if (!this.#closed) void this.close();
    }
  }

  async #keepaliveLoop(): Promise<void> {
    try {
      while (!this.#closed && this.#ws?.readyState === WebSocket.OPEN) {
        await delay(KEEPALIVE_INTERVAL_MS);
        if (!this.#closed && this.#ws?.readyState === WebSocket.OPEN) {
          this.#ws.send(KEEPALIVE_MESSAGE);
        }
      }
    } catch (error) {
      this.#logger.warn({ error }, 'Soniox TTS keepalive error');
    }
  }

  #failAll(error: Error) {
    for (const stream of this.#streams.values()) {
      stream.waiter.reject(error);
    }
    this.#streams.clear();
    this.#isCurrent = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#isCurrent = false;
    this.#notifySend?.();
    this.#failAll(new APIConnectionError({ message: 'Soniox TTS connection closed' }));
    if (this.#ws && this.#ws.readyState !== WebSocket.CLOSED) {
      this.#ws.close();
    }
  }
}

const startConfig = (streamId: string, opts: TTSOptions): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    api_key: opts.apiKey,
    model: opts.model,
    language: opts.language,
    voice: opts.voice,
    audio_format: opts.audioFormat,
    sample_rate: opts.sampleRate,
    stream_id: streamId,
  };
  if (opts.bitrate != null) config.bitrate = opts.bitrate;
  return config;
};

const apiStatusErrorFromResponse = (
  streamId: string,
  resp: SonioxTTSResponse,
  raw: string,
): APIStatusError => {
  const code = resp.error_code ?? 500;
  return new APIStatusError({
    message: resp.error_message ?? 'Unknown Soniox TTS error',
    options: {
      statusCode: code,
      body: { streamId, raw },
      retryable: code === 408 || code === 429 || code >= 500,
    },
  });
};

const terminatedWithoutAudioError = (streamId: string): APIStatusError => {
  return new APIStatusError({
    message: 'Soniox TTS stream terminated without producing audio',
    options: { body: { streamId }, retryable: true },
  });
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

const makeDeferred = <T>(): Deferred<T> => {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    }),
    resolve: (value: T) => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolveFn(value);
    },
    reject: (error: Error) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectFn(error);
    },
    settled: false,
  };
  return deferred;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForWsOpen = async (
  ws: WebSocket,
  timeoutMs: number,
  abortSignal: AbortSignal,
  label: string,
) => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new APITimeoutError({})), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('open', onOpen);
      ws.off('error', onError);
      abortSignal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new APIConnectionError({ message: `${label} WebSocket error: ${error.message}` }));
    };
    const onAbort = () => {
      cleanup();
      reject(new APIConnectionError({ message: `${label} connection aborted` }));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
};

async function* websocketMessages(
  ws: WebSocket,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const messages: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;

  const onMessage = (data: WebSocket.RawData) => {
    messages.push(data.toString());
    notify?.();
  };
  const onClose = () => {
    done = true;
    notify?.();
  };
  const onError = (err: Error) => {
    error = err;
    done = true;
    notify?.();
  };
  const onAbort = () => {
    done = true;
    notify?.();
  };
  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (!done || messages.length > 0) {
      if (messages.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      while (messages.length > 0) yield messages.shift()!;
    }
    if (error) throw error;
  } finally {
    ws.off('message', onMessage);
    ws.off('close', onClose);
    ws.off('error', onError);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

export { audioFormatToMimeType };
