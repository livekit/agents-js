// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  AudioByteStream,
  Future,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';

const WEBSOCKET_URL = 'wss://tts-rt.soniox.com/tts-websocket';
const NUM_CHANNELS = 1;
const DEFAULT_MODEL = 'tts-rt-v1-preview';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_VOICE = 'Maya';
const DEFAULT_AUDIO_FORMAT = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_SPEED = 1.0;
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.3;
const KEEPALIVE_INTERVAL = 10000;
const KEEPALIVE_MESSAGE = JSON.stringify({ keep_alive: true });

/** @public */
export interface TTSOptions {
  model: string;
  language: string;
  voice: string;
  /** Soniox output audio format. Only pcm_s16le is supported by this JS AudioFrame port. */
  audioFormat: string;
  sampleRate: number;
  bitrate?: number | null;
  /** Speaking rate. 1.0 is normal; valid range is [0.7, 1.3]. */
  speed: number;
  apiKey?: string;
  websocketUrl: string;
}

const defaultTTSOptions: TTSOptions = {
  model: DEFAULT_MODEL,
  language: DEFAULT_LANGUAGE,
  voice: DEFAULT_VOICE,
  audioFormat: DEFAULT_AUDIO_FORMAT,
  sampleRate: DEFAULT_SAMPLE_RATE,
  speed: DEFAULT_SPEED,
  apiKey: process.env.SONIOX_API_KEY,
  websocketUrl: WEBSOCKET_URL,
};

const validateSpeed = (speed: number) => {
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new Error(`speed must be between ${MIN_SPEED} and ${MAX_SPEED}, but got ${speed}`);
  }
};

const validateAudioFormat = (audioFormat: string) => {
  if (audioFormat !== DEFAULT_AUDIO_FORMAT) {
    throw new Error(`Soniox TTS audioFormat must be ${DEFAULT_AUDIO_FORMAT}, got ${audioFormat}`);
  }
};

const cloneOptions = (opts: TTSOptions): TTSOptions => ({ ...opts });

const toAPIStatusError = (message: string, statusCode?: number, body?: object | null) =>
  new APIStatusError({
    message,
    options: { statusCode, body: body ?? null },
  });

interface TTSState {
  currentConnection?: Connection;
  connectionPromise?: Promise<Connection>;
  streams: Set<SynthesizeStream>;
}

const ttsState = new WeakMap<TTS, TTSState>();

/** @public */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'soniox.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const merged = { ...defaultTTSOptions, ...opts };

    super(merged.sampleRate, NUM_CHANNELS, { streaming: true });

    if (!merged.apiKey) {
      throw new Error('Soniox API key is required. Set SONIOX_API_KEY or pass apiKey');
    }
    validateSpeed(merged.speed);
    validateAudioFormat(merged.audioFormat);

    this.#opts = merged;
    ttsState.set(this, { streams: new Set() });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Soniox';
  }

  updateOptions(opts: Partial<Pick<TTSOptions, 'model' | 'language' | 'voice' | 'speed'>>): void {
    if (opts.speed !== undefined) {
      validateSpeed(opts.speed);
    }
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, this.#opts, options?.connOptions);
    getTTSState(this).streams.add(stream);
    return stream;
  }

  prewarm(): void {
    void currentConnection(this, this.#opts.websocketUrl, 20000).catch((error: unknown) => {
      log().debug({ error }, 'Soniox TTS prewarm failed');
    });
  }

  override async close(): Promise<void> {
    const state = getTTSState(this);
    for (const stream of state.streams) {
      stream.close();
    }
    state.streams.clear();

    await state.currentConnection?.close();
    state.currentConnection = undefined;
    state.connectionPromise = undefined;
  }
}

const getTTSState = (tts: TTS): TTSState => {
  const state = ttsState.get(tts);
  if (state === undefined) {
    throw new Error('Soniox TTS state is missing');
  }
  return state;
};

const currentConnection = async (
  tts: TTS,
  websocketUrl: string,
  timeoutMs: number,
): Promise<Connection> => {
  const state = getTTSState(tts);
  const current = state.currentConnection;
  if (current !== undefined && current.isCurrent && !current.closed) {
    return current;
  }

  if (state.connectionPromise !== undefined) {
    return state.connectionPromise;
  }

  if (current !== undefined && !current.closed) {
    current.markNonCurrent();
  }

  state.connectionPromise = new Promise<Connection>((resolve, reject) => {
    const connection = new Connection(websocketUrl);
    const timeout = setTimeout(() => {
      void connection.close();
      reject(new APITimeoutError({ message: 'Timeout connecting to Soniox TTS API' }));
    }, timeoutMs);

    connection
      .connect()
      .then(() => {
        clearTimeout(timeout);
        state.currentConnection = connection;
        resolve(connection);
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      });
  }).finally(() => {
    state.connectionPromise = undefined;
  });

  return state.connectionPromise;
};

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  #tts: TTS;
  #opts: TTSOptions;
  #text: string;
  #connOptions: APIConnectOptions | undefined;
  #connection?: Connection;
  #streamId = '';
  label = 'soniox.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#tts = tts;
    this.#text = text;
    this.#opts = cloneOptions(opts);
    this.#connOptions = connOptions;
    this.abortSignal.addEventListener('abort', () => this.#cancelRequest(), { once: true });
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    this.#streamId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const waiter = new Future<void>();

    let lastFrame: AudioFrame | undefined;
    const emitFrame = (final: boolean) => {
      if (lastFrame !== undefined && !this.queue.closed) {
        this.queue.put({ requestId, segmentId: this.#streamId, frame: lastFrame, final });
      }
      lastFrame = undefined;
    };

    try {
      this.#connection = await currentConnection(
        this.#tts,
        this.#opts.websocketUrl,
        this.#connOptions?.timeoutMs ?? 10000,
      );
      this.#connection.registerStream(this.#streamId, {
        opts: this.#opts,
        waiter,
        pushAudio: (audio) => {
          for (const frame of bstream.write(audio)) {
            emitFrame(false);
            lastFrame = frame;
          }
        },
        endAudio: () => {
          for (const frame of bstream.flush()) {
            emitFrame(false);
            lastFrame = frame;
          }
          emitFrame(true);
        },
      });

      if (this.abortSignal.aborted) {
        this.#cancelRequest();
      } else {
        this.#connection.sendText(this.#streamId, this.#text, false);
        this.#connection.sendText(this.#streamId, '', true);
      }

      await waiter.await;
    } catch (error) {
      if (this.abortSignal.aborted) {
        return;
      }
      if (error instanceof APITimeoutError || error instanceof APIStatusError) {
        throw error;
      }
      throw new APIConnectionError({ message: `Soniox TTS connection error: ${error}` });
    } finally {
      this.#connection?.unregisterStream(this.#streamId);
    }
  }

  #cancelRequest(): void {
    if (this.#connection !== undefined && this.#streamId) {
      this.#connection.cancelStream(this.#streamId);
    }
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  #tts: TTS;
  #opts: TTSOptions;
  #connection?: Connection;
  #streamId = '';
  #cancelled = false;
  #inputCache: Array<string | typeof SynthesizeStream.FLUSH_SENTINEL> = [];
  #inputConsumed = false;
  label = 'soniox.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#opts = cloneOptions(opts);
  }

  override close(): void {
    if (!this.#cancelled) {
      this.#cancelled = true;
      if (this.#connection !== undefined && this.#streamId) {
        this.#connection.cancelStream(this.#streamId);
      }
    }
    super.close();
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    this.#streamId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const waiter = new Future<void>();
    let inputTask: Promise<void> | undefined;
    const attemptState = { cancelled: false };

    let lastFrame: AudioFrame | undefined;
    const emitFrame = (final: boolean) => {
      if (lastFrame !== undefined && !this.queue.closed) {
        this.queue.put({ requestId, segmentId: this.#streamId, frame: lastFrame, final });
      }
      lastFrame = undefined;
    };

    try {
      this.#connection = await currentConnection(
        this.#tts,
        this.#opts.websocketUrl,
        this.connOptions.timeoutMs,
      );
      this.#connection.registerStream(this.#streamId, {
        opts: this.#opts,
        waiter,
        pushAudio: (audio) => {
          for (const frame of bstream.write(audio)) {
            emitFrame(false);
            lastFrame = frame;
          }
        },
        endAudio: () => {
          for (const frame of bstream.flush()) {
            emitFrame(false);
            lastFrame = frame;
          }
          emitFrame(true);
        },
      });

      if (this.#cancelled || this.abortSignal.aborted) {
        this.#connection.cancelStream(this.#streamId);
      } else {
        inputTask = this.#sendInput(attemptState);
      }
      await waiter.await;
    } catch (error) {
      if (this.abortSignal.aborted) {
        return;
      }
      if (error instanceof APITimeoutError || error instanceof APIStatusError) {
        throw error;
      }
      throw new APIConnectionError({ message: `Soniox TTS connection error: ${error}` });
    } finally {
      attemptState.cancelled = true;
      if (!this.input.closed) {
        this.input.close();
      }
      await inputTask;
      if (this.#connection !== undefined && this.#streamId) {
        this.#connection.unregisterStream(this.#streamId);
      }
      getTTSState(this.#tts).streams.delete(this);
    }
  }

  async #sendInput(attemptState: { cancelled: boolean }): Promise<void> {
    if (this.#inputConsumed) {
      for (const data of this.#inputCache) {
        if (this.#cancelled || attemptState.cancelled || this.#connection === undefined) {
          break;
        }
        this.#sendInputItem(data);
      }
      if (!this.#cancelled && !attemptState.cancelled && this.#connection !== undefined) {
        this.#connection.sendText(this.#streamId, '', true);
      }
      return;
    }

    for await (const data of this.input) {
      this.#inputCache.push(data);
      if (this.#cancelled || attemptState.cancelled || this.#connection === undefined) {
        break;
      }
      this.#sendInputItem(data);
    }
    this.#inputConsumed = true;

    if (!this.#cancelled && !attemptState.cancelled && this.#connection !== undefined) {
      this.#connection.sendText(this.#streamId, '', true);
    }
  }

  #sendInputItem(data: string | typeof SynthesizeStream.FLUSH_SENTINEL): void {
    if (data === SynthesizeStream.FLUSH_SENTINEL || this.#connection === undefined) {
      return;
    }
    this.markStarted();
    this.#connection.sendText(this.#streamId, data, false);
  }
}

type OutboundMessage =
  | { type: 'start'; streamId: string; opts: TTSOptions }
  | { type: 'text'; streamId: string; text: string; textEnd: boolean }
  | { type: 'cancel'; streamId: string };

interface StreamData {
  opts: TTSOptions;
  waiter: Future<void>;
  pushAudio(audio: Buffer): void;
  endAudio(): void;
  audioEnded?: boolean;
  cancelSent?: boolean;
  configSent?: boolean;
}

class Connection {
  #websocketUrl: string;
  #ws?: WebSocket;
  #streams = new Map<string, StreamData>();
  #outbound = new AsyncIterableQueue<OutboundMessage>();
  #sendTask?: Promise<void>;
  #keepalive?: NodeJS.Timeout;
  #isCurrent = true;
  #closed = false;
  #logger = log();

  constructor(websocketUrl: string) {
    this.#websocketUrl = websocketUrl;
  }

  get isCurrent(): boolean {
    return this.#isCurrent;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async connect(): Promise<void> {
    if (this.#ws !== undefined || this.#closed) {
      return;
    }

    this.#ws = new WebSocket(this.#websocketUrl);
    await new Promise<void>((resolve, reject) => {
      this.#ws!.once('open', () => resolve());
      this.#ws!.once('error', (error) => reject(error));
      this.#ws!.once('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
    });

    this.#ws.on('message', (data) => this.#handleMessage(data.toString()));
    this.#ws.on('error', (error) => {
      this.#logger.warn({ error }, 'Soniox TTS WebSocket error');
      this.#failAll(new APIConnectionError({ message: `Soniox TTS WebSocket error: ${error}` }));
    });
    this.#ws.on('close', (code) => {
      if (!this.#closed) {
        this.#failAll(
          toAPIStatusError('Soniox TTS WebSocket connection closed unexpectedly', code),
        );
      }
    });

    this.#sendTask = this.#sendLoop();
    this.#keepalive = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(KEEPALIVE_MESSAGE);
      }
    }, KEEPALIVE_INTERVAL);
  }

  markNonCurrent(): void {
    this.#isCurrent = false;
    if (this.#streams.size === 0 && !this.#closed) {
      void this.close();
    }
  }

  registerStream(streamId: string, stream: StreamData): void {
    if (this.#closed) {
      stream.waiter.reject(new APIConnectionError({ message: 'Soniox TTS connection is closed' }));
      return;
    }
    if (this.#streams.has(streamId)) {
      throw new Error(`streamId ${streamId} already registered`);
    }
    this.#streams.set(streamId, stream);
  }

  unregisterStream(streamId: string): void {
    this.#streams.delete(streamId);
    if (!this.#isCurrent && this.#streams.size === 0 && !this.#closed) {
      void this.close();
    }
  }

  sendText(streamId: string, text: string, textEnd: boolean): void {
    if (this.#closed) {
      return;
    }

    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      return;
    }

    if (!text) {
      if (!textEnd) {
        return;
      }
      if (!stream.configSent) {
        if (!stream.waiter.done) stream.waiter.resolve();
        this.#streams.delete(streamId);
        return;
      }
    }

    if (!stream.configSent) {
      stream.configSent = true;
      this.#outbound.put({ type: 'start', streamId, opts: stream.opts });
    }
    this.#outbound.put({ type: 'text', streamId, text, textEnd });
  }

  cancelStream(streamId: string): void {
    if (this.#closed) {
      return;
    }
    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      return;
    }
    if (!stream.configSent) {
      if (!stream.waiter.done) stream.waiter.resolve();
      this.unregisterStream(streamId);
      return;
    }
    stream.cancelSent = true;
    this.#outbound.put({ type: 'cancel', streamId });
    if (!stream.waiter.done) stream.waiter.resolve();
    this.unregisterStream(streamId);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#isCurrent = false;

    for (const stream of this.#streams.values()) {
      if (!stream.waiter.done) {
        stream.waiter.reject(new APIConnectionError({ message: 'Soniox TTS connection closed' }));
      }
    }
    this.#streams.clear();

    if (!this.#outbound.closed) {
      this.#outbound.close();
    }
    if (this.#keepalive !== undefined) {
      clearInterval(this.#keepalive);
      this.#keepalive = undefined;
    }
    if (this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.close();
    }
    await this.#sendTask?.catch(() => undefined);
  }

  async #sendLoop(): Promise<void> {
    try {
      for await (const msg of this.#outbound) {
        if (this.#ws === undefined || this.#ws.readyState !== WebSocket.OPEN) {
          break;
        }

        if (msg.type === 'start') {
          const config: Record<string, unknown> = {
            api_key: msg.opts.apiKey,
            model: msg.opts.model,
            language: msg.opts.language,
            voice: msg.opts.voice,
            audio_format: msg.opts.audioFormat,
            sample_rate: msg.opts.sampleRate,
            speed: msg.opts.speed,
            stream_id: msg.streamId,
          };
          if (msg.opts.bitrate !== undefined && msg.opts.bitrate !== null) {
            config.bitrate = msg.opts.bitrate;
          }
          this.#ws.send(JSON.stringify(config));
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
      this.#failAll(new APIConnectionError({ message: `Soniox TTS send loop error: ${error}` }));
    }
  }

  #handleMessage(raw: string): void {
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      this.#logger.warn({ error, raw }, 'Failed to parse Soniox TTS response');
      return;
    }

    const streamId = response.stream_id;
    if (typeof streamId !== 'string') {
      if (response.error_code !== undefined) {
        this.#logger.error(
          { response },
          `Soniox TTS connection-level error: ${response.error_code} - ${response.error_message}`,
        );
      }
      return;
    }

    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      this.#logger.debug(`Ignoring message for unknown Soniox TTS stream ${streamId}`);
      return;
    }

    if (response.error_code !== undefined) {
      const statusCode = parseStatusCode(response.error_code);
      if (!stream.waiter.done) {
        stream.waiter.reject(
          toAPIStatusError(
            String(response.error_message ?? 'Unknown Soniox TTS error'),
            statusCode,
            response,
          ),
        );
      }
      return;
    }

    if (typeof response.audio === 'string' && response.audio) {
      stream.pushAudio(Buffer.from(response.audio, 'base64'));
    }

    if (response.audio_end === true) {
      stream.audioEnded = true;
      stream.endAudio();
    }

    if (response.terminated === true) {
      if (!stream.waiter.done) {
        const serverError = !stream.audioEnded && !stream.cancelSent;
        if (serverError) {
          stream.waiter.reject(
            new APIStatusError({
              message: 'Soniox TTS stream terminated without producing audio',
              options: { body: { stream_id: streamId }, retryable: true },
            }),
          );
        } else {
          stream.waiter.resolve();
        }
      }
      this.#streams.delete(streamId);
    }
  }

  #failAll(error: Error): void {
    for (const stream of this.#streams.values()) {
      if (!stream.waiter.done) {
        stream.waiter.reject(error);
      }
    }
    this.#streams.clear();
    this.#isCurrent = false;
  }
}

const parseStatusCode = (errorCode: unknown): number => {
  if (typeof errorCode === 'number' && Number.isInteger(errorCode)) return errorCode;
  if (typeof errorCode === 'string' && /^\d+$/.test(errorCode)) return Number(errorCode);
  return -1;
};
