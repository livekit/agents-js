// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  type AudioBuffer,
  AudioByteStream,
  type ConversationItemAddedEvent,
  DEFAULT_API_CONNECT_OPTIONS,
  asLanguageCode,
  createTimedString,
  log,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { decode, encode } from '@msgpack/msgpack';
import type { IncomingMessage } from 'node:http';
import { type RawData, WebSocket } from 'ws';
import type { STTModels, TurnDetectionMode } from './models.js';

const DEFAULT_STT_MODEL: STTModels = 'transcribe-stream-1';
const DEFAULT_BASE_URL = 'https://api.fish.audio';
const SAMPLE_RATES = new Set([8000, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
const PROTOCOL_VERSION = 1;
const CHUNK_DURATION_MS = 20;
const KEEPALIVE_INTERVAL_MS = 10_000;
const USAGE_REPORT_INTERVAL_SECONDS = 5;
const MAX_TERMS = 100;
const MAX_TERM_CHARS = 32;
const MAX_HISTORY_ITEMS = 32;
const MAX_HISTORY_CHARS = 2000;
const SERVER_RESTARTING_CLOSE_CODE = 1012;
const MAX_DURATION_CLOSE_CODE = 4413;
const RECONNECT_CLOSE_CODES = new Set([SERVER_RESTARTING_CLOSE_CODE, MAX_DURATION_CLOSE_CODE]);
const RECONNECT_ERROR_TYPES = new Set(['server_restarting', 'max_duration_exceeded']);
const SILENCE_TIMEOUT_RANGES: Record<TurnDetectionMode, readonly [number, number]> = {
  auto: [3000, 60000],
  vad: [300, 60000],
  manual: [300, 60000],
};

type HistoryItem = { role: 'assistant' | 'user'; text: string };
type WireMessage = Record<string, unknown>;

interface STTState {
  opts: ResolvedSTTOptions;
  apiKey: string;
  agentHistory: HistoryItem[];
  streams: Set<SpeechStream>;
}

interface StreamControl {
  addContext(item: HistoryItem): void;
  updateOptions(opts: STTUpdateOptions): void;
}

const sttStates = new WeakMap<STT, STTState>();
const streamControls = new WeakMap<SpeechStream, StreamControl>();

interface ResolvedSTTOptions {
  model: STTModels | string;
  sampleRate: number;
  baseURL: string;
  turnDetectionMode: TurnDetectionMode;
  eagerEot: boolean;
  silenceTimeoutMs?: number;
  interimResults: boolean;
  tagAudioEvents: boolean;
  keyterms: string[];
}

interface Turn {
  index: number;
  startMs: number;
  userTurn: boolean;
  draft: string;
}

/** Options for Fish Audio realtime speech-to-text. @public */
export interface STTOptions {
  /** Fish Audio API key. Defaults to `FISH_API_KEY`. */
  apiKey?: string;
  /** Realtime ASR model. Defaults to `transcribe-stream-1`. */
  model?: STTModels | string;
  /** Audio sample rate in Hz. Defaults to 16000. */
  sampleRate?: number;
  /** How Fish Audio ends turns. Defaults to `auto`. */
  turnDetectionMode?: TurnDetectionMode;
  /** Emit preflight transcripts near end of turn in auto mode. Defaults to true. */
  eagerEot?: boolean;
  /** Silence duration in milliseconds that ends a turn or acts as a safety net. */
  silenceTimeoutMs?: number;
  /** Emit interim transcripts. Defaults to true. */
  interimResults?: boolean;
  /** Keep sound tags such as `[laughter]` in transcripts. Defaults to false. */
  tagAudioEvents?: boolean;
  /** Terms to bias recognition toward. Invalid and excess terms are dropped. */
  keyterms?: string[];
  /** Custom Fish Audio API base URL. */
  baseURL?: string;
}

/** Options that can be changed on active Fish Audio streams. @public */
export interface STTUpdateOptions {
  /** Emit preflight transcripts near end of turn in auto mode. */
  eagerEot?: boolean;
  /** Silence duration in milliseconds that ends a turn or acts as a safety net. */
  silenceTimeoutMs?: number;
  /** Keep sound tags such as `[laughter]` in transcripts. */
  tagAudioEvents?: boolean;
  /** Replace the user-provided recognition bias terms. */
  keyterms?: string[];
}

/** Fish Audio realtime speech-to-text. @public */
export class STT extends stt.STT {
  /** Provider label used in metrics and logs. */
  label = 'fishaudio.STT';
  readonly #apiKey: string;
  readonly #opts: ResolvedSTTOptions;
  readonly #streams = new Set<SpeechStream>();
  readonly #agentHistory: HistoryItem[] = [];
  #userKeyterms: string[];
  #sessionKeyterms: string[] = [];
  #closed = false;

  /** Create a Fish Audio realtime speech recognizer. */
  constructor(opts: STTOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.FISH_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Fish Audio API key is required, either as argument or set FISH_API_KEY environment variable',
      );
    }
    const sampleRate = opts.sampleRate ?? 16000;
    if (!SAMPLE_RATES.has(sampleRate)) {
      throw new Error(`sampleRate must be one of ${[...SAMPLE_RATES].join(', ')}`);
    }
    const turnDetectionMode = opts.turnDetectionMode ?? 'auto';
    if (opts.silenceTimeoutMs !== undefined) {
      validateSilenceTimeout(turnDetectionMode, opts.silenceTimeoutMs);
    }
    const interimResults = opts.interimResults ?? true;
    super({
      streaming: true,
      interimResults,
      manualFlush: true,
      alignedTranscript: 'word',
      keyterms: true,
      chatContext: true,
    });
    this.#apiKey = apiKey;
    this.#userKeyterms = [...(opts.keyterms ?? [])];
    this.#opts = {
      model: opts.model ?? DEFAULT_STT_MODEL,
      sampleRate,
      baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
      turnDetectionMode,
      eagerEot: opts.eagerEot ?? true,
      silenceTimeoutMs: opts.silenceTimeoutMs,
      interimResults,
      tagAudioEvents: opts.tagAudioEvents ?? false,
      keyterms: sanitizeTerms(this.#userKeyterms),
    };
    sttStates.set(this, {
      opts: this.#opts,
      apiKey: this.#apiKey,
      agentHistory: this.#agentHistory,
      streams: this.#streams,
    });
  }

  /** The configured Fish Audio model. */
  override get model(): string {
    return this.#opts.model;
  }

  /** The model provider name used in metrics. */
  override get provider(): string {
    return 'FishAudio';
  }

  /** @internal */
  protected override async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Fish Audio realtime STT does not support non-streaming recognize');
  }

  /** Create a realtime transcription stream. */
  override stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    if (this.#closed) throw new Error('Fish Audio STT is closed');
    const stream = new SpeechStream(this, options?.connOptions);
    this.#streams.add(stream);
    return stream;
  }

  /** Update options mid-session. Active streams apply changes without reconnecting. */
  updateOptions(opts: STTUpdateOptions): void {
    if (opts.silenceTimeoutMs !== undefined) {
      validateSilenceTimeout(this.#opts.turnDetectionMode, opts.silenceTimeoutMs);
      this.#opts.silenceTimeoutMs = opts.silenceTimeoutMs;
    }
    if (opts.eagerEot !== undefined) this.#opts.eagerEot = opts.eagerEot;
    if (opts.tagAudioEvents !== undefined) this.#opts.tagAudioEvents = opts.tagAudioEvents;
    let keyterms: string[] | undefined;
    if (opts.keyterms !== undefined) {
      this.#userKeyterms = [...opts.keyterms];
      keyterms = this.#mergeKeyterms();
    }
    for (const stream of this.#streams) {
      streamControls.get(stream)?.updateOptions({ ...opts, keyterms });
    }
  }

  /** @internal */
  override _updateSessionKeyterms(keyterms: string[]): void {
    if (arrayEquals(keyterms, this.#sessionKeyterms)) return;
    this.#sessionKeyterms = [...keyterms];
    const merged = this.#mergeKeyterms();
    for (const stream of this.#streams)
      streamControls.get(stream)?.updateOptions({ keyterms: merged });
  }

  /** @internal */
  override _pushConversationItem(ev: ConversationItemAddedEvent): void {
    const item = ev.item;
    if (item.type !== 'message' || item.role !== 'assistant' || !item.textContent) return;
    const contextItem: HistoryItem = {
      role: 'assistant',
      text: lastCharacters(item.textContent),
    };
    appendCapped(this.#agentHistory, contextItem);
    for (const stream of this.#streams) streamControls.get(stream)?.addContext(contextItem);
  }

  /** Close all active transcription streams. */
  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const streams = [...this.#streams];
    for (const stream of streams) stream.close();
    await Promise.all(streams.map((stream) => stream._waitClosed()));
    this.#streams.clear();
    await super.close();
  }

  #mergeKeyterms(): string[] {
    const merged = sanitizeTerms([...this.#userKeyterms, ...this.#sessionKeyterms]);
    this.#opts.keyterms = merged;
    return merged;
  }
}

/** A Fish Audio realtime transcription stream. @public */
export class SpeechStream extends stt.SpeechStream {
  /** Provider label used in metrics and logs. */
  label = 'fishaudio.SpeechStream';
  readonly #opts: ResolvedSTTOptions;
  readonly #apiKey: string;
  readonly #history: HistoryItem[];
  readonly #streams: Set<SpeechStream>;
  readonly #logger = log();
  readonly #controlQueue: WireMessage[] = [];
  #controlWaiter?: () => void;
  #ws: WebSocket | null = null;
  #sessionId?: string;
  #requestId = '';
  #language = 'en';
  #speaking = false;
  #turn: Turn | null = null;
  #madeProgress = false;
  #unreportedAudioDuration = 0;
  #inputStartedAt?: number;
  #connectionInputStartedAt?: number;
  #providerStartTimeOffset = 0;
  #sendChain = Promise.resolve();
  #connectTimeoutMs: number;
  #livenessTimeoutMs: number;
  #lastCloseCode = -1;

  constructor(sttInstance: STT, connOptions?: APIConnectOptions) {
    const state = sttStates.get(sttInstance);
    if (!state) throw new Error('Fish Audio STT is not initialized');
    super(sttInstance, state.opts.sampleRate, connOptions);
    this.#opts = state.opts;
    this.#apiKey = state.apiKey;
    this.#history = [...state.agentHistory];
    this.#streams = state.streams;
    this.#connectTimeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
    this.#livenessTimeoutMs =
      connOptions?.livenessTimeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.livenessTimeoutMs ?? 6000;
    streamControls.set(this, {
      addContext: (item) => this.#addContext(item),
      updateOptions: (opts) => this.#updateOptions(opts),
    });
    void this._waitClosed().then(() => {
      this.#streams.delete(this);
      streamControls.delete(this);
    });
  }

  /** @internal */
  protected override async run(): Promise<void> {
    while (!this.abortSignal.aborted) {
      const ws = await this.#connectWebSocket();
      this.#controlQueue.length = 0;
      this.#ws = ws;
      this.#madeProgress = false;
      this.#connectionInputStartedAt = undefined;
      this.#providerStartTimeOffset = this.startTimeOffset;
      try {
        try {
          await this.#send(ws, this.#config());
        } catch {
          throw new APIConnectionError({ message: 'fish audio stt connection lost' });
        }
        const reconnect = await this.#runWebSocket(ws);
        if (!reconnect) return;
      } catch (error) {
        this.#closeOpenTurn();
        throw error;
      } finally {
        this.#ws = null;
        this.#reportUsage();
        closeWebSocket(ws);
      }

      this.#closeOpenTurn();
      if (!this.#madeProgress && this.#lastCloseCode !== MAX_DURATION_CLOSE_CODE) {
        throw new APIConnectionError({ message: 'fish audio stt session ended by the server' });
      }
      this.#logger.debug(
        { sessionId: this.#sessionId, closeCode: this.#lastCloseCode },
        'fish audio stt session ended by the server, reconnecting',
      );
    }
  }

  #config(): WireMessage {
    const turnDetection: WireMessage = { mode: this.#opts.turnDetectionMode };
    if (this.#opts.turnDetectionMode === 'auto') turnDetection.eager = this.#opts.eagerEot;
    if (this.#opts.silenceTimeoutMs !== undefined) {
      turnDetection.silence_timeout_ms = this.#opts.silenceTimeoutMs;
    }
    const context: WireMessage = {};
    if (this.#history.length) context.history = [...this.#history];
    if (this.#opts.keyterms.length) context.terms = [...this.#opts.keyterms];
    return {
      type: 'config',
      protocol_version: PROTOCOL_VERSION,
      audio: { format: 'pcm_s16le', sample_rate: this.#opts.sampleRate, channels: 1 },
      turn_detection: turnDetection,
      results: {
        drafts: this.#opts.interimResults,
        ignore_timestamps: false,
        diarize: false,
        tag_audio_events: this.#opts.tagAudioEvents,
      },
      ...(Object.keys(context).length ? { context } : {}),
    };
  }

  #processMessage(msg: WireMessage): void {
    const type = stringValue(msg.type);
    if (type === 'session_started') {
      this.#sessionId = optionalString(msg.session_id);
      this.#requestId = optionalString(msg.request_id) ?? '';
      return;
    }
    if (type === 'configured') {
      if (!msg.ok) this.#logger.warn({ message: msg.message }, 'Fish Audio rejected an update');
      return;
    }
    if (type === 'error') {
      this.#onError(msg);
      return;
    }
    switch (type) {
      case 'speech_start':
        this.#onSpeechStart(msg);
        break;
      case 'user_turn_taken':
        this.#onUserTurnTaken(msg);
        break;
      case 'draft':
        this.#onDraft(msg);
        break;
      case 'eager_end_of_turn':
        this.#onEagerEndOfTurn(msg);
        break;
      case 'committed':
        this.#onCommitted(msg);
        break;
      default:
        return;
    }
    this.#madeProgress = true;
    this.markProviderProgress();
  }

  #addContext(item: HistoryItem): void {
    appendCapped(this.#history, item);
    this.#sendControl({ type: 'context_add', items: [item] });
  }

  #updateOptions(opts: STTUpdateOptions): void {
    const turnDetection: WireMessage = {};
    if (opts.eagerEot !== undefined && this.#opts.turnDetectionMode === 'auto') {
      turnDetection.eager = opts.eagerEot;
    }
    if (opts.silenceTimeoutMs !== undefined) {
      turnDetection.silence_timeout_ms = opts.silenceTimeoutMs;
    }
    const results: WireMessage = {};
    if (opts.tagAudioEvents !== undefined) results.tag_audio_events = opts.tagAudioEvents;
    const msg: WireMessage = { type: 'configure' };
    if (Object.keys(turnDetection).length) msg.turn_detection = turnDetection;
    if (Object.keys(results).length) msg.results = results;
    if (opts.keyterms !== undefined) msg.context = { terms: opts.keyterms };
    if (Object.keys(msg).length > 1) this.#sendControl(msg);
  }

  /** Close the stream and its active WebSocket. */
  override close(): void {
    if (this.closed) return;
    super.close();
    this.#controlWaiter?.();
    this.#controlWaiter = undefined;
    if (this.#ws) closeWebSocket(this.#ws);
  }

  async #runWebSocket(ws: WebSocket): Promise<boolean> {
    let closingWs = false;
    this.#turn = null;
    const taskAbort = new AbortController();
    const messages = new AsyncIterableQueue<
      | { type: 'message'; data: RawData; isBinary: boolean }
      | { type: 'close'; code: number; reason: Buffer }
      | { type: 'error'; error: Error }
    >();
    const onMessage = (data: RawData, isBinary: boolean) =>
      !messages.closed && messages.put({ type: 'message', data, isBinary });
    const onClose = (code: number, reason: Buffer) => {
      this.#lastCloseCode = code;
      if (!messages.closed) messages.put({ type: 'close', code, reason });
    };
    const onError = (error: Error) => !messages.closed && messages.put({ type: 'error', error });
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);

    let livenessTimer: NodeJS.Timeout | undefined;
    let pingTimer: NodeJS.Timeout | undefined;
    const clearLiveness = () => {
      if (livenessTimer) clearTimeout(livenessTimer);
      if (pingTimer) clearTimeout(pingTimer);
    };
    const failLiveness = () => {
      if (!messages.closed) {
        messages.put({
          type: 'error',
          error: new Error(
            `no Fish Audio WebSocket activity for ${this.#livenessTimeoutMs}ms after ping`,
          ),
        });
      }
      ws.terminate();
    };
    const armLiveness = () => {
      clearLiveness();
      pingTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.ping();
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        livenessTimer = setTimeout(failLiveness, (this.#livenessTimeoutMs * 2) / 3);
      }, this.#livenessTimeoutMs / 3);
    };
    const onActivity = () => armLiveness();
    ws.on('message', onActivity);
    ws.on('ping', onActivity);
    ws.on('pong', onActivity);
    armLiveness();

    const sendTask = async () => {
      const samplesPerChunk = Math.floor((this.#opts.sampleRate * CHUNK_DURATION_MS) / 1000);
      const audio = new AudioByteStream(this.#opts.sampleRate, 1, samplesPerChunk);
      while (!taskAbort.signal.aborted) {
        let result: IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>;
        try {
          result = await this.input.next({ signal: taskAbort.signal });
        } catch (error) {
          if (taskAbort.signal.aborted) return;
          throw error;
        }
        if (result.done) {
          closingWs = true;
          await this.#send(ws, { type: 'audio_done' });
          return;
        }
        const frames =
          result.value === SpeechStream.FLUSH_SENTINEL
            ? audio.flush()
            : audio.write(result.value.data);
        for (const frame of frames) {
          if (this.#connectionInputStartedAt === undefined) {
            const frameStartedAt = Date.now() - (frame.samplesPerChannel / frame.sampleRate) * 1000;
            this.#inputStartedAt ??= frameStartedAt - this.startTimeOffset * 1000;
            this.#connectionInputStartedAt = frameStartedAt;
            this.#providerStartTimeOffset = (frameStartedAt - this.#inputStartedAt) / 1000;
          }
          await this.#send(ws, { type: 'audio', data: frame.data });
          this.#addUsage(frame.samplesPerChannel / frame.sampleRate);
        }
        if (result.value === SpeechStream.FLUSH_SENTINEL) {
          await this.#send(ws, { type: 'finalize' });
        }
      }
    };

    const controlTask = async () => {
      while (!taskAbort.signal.aborted && !closingWs) {
        const msg = this.#controlQueue.shift();
        if (msg) {
          await this.#send(ws, msg);
          continue;
        }
        const timedOut = await this.#waitForControl(taskAbort.signal);
        if (timedOut && !closingWs && !taskAbort.signal.aborted) {
          await this.#send(ws, { type: 'keepalive' });
        }
      }
    };

    const receiveTask = async (): Promise<boolean> => {
      while (!taskAbort.signal.aborted) {
        let result: IteratorResult<
          | { type: 'message'; data: RawData; isBinary: boolean }
          | { type: 'close'; code: number; reason: Buffer }
          | { type: 'error'; error: Error }
        >;
        try {
          result = await messages.next({ signal: taskAbort.signal });
        } catch (error) {
          if (taskAbort.signal.aborted) return false;
          throw error;
        }
        if (result.done) return false;
        const event = result.value;
        if (event.type === 'close') {
          if (closingWs || this.abortSignal.aborted) return false;
          if (RECONNECT_CLOSE_CODES.has(event.code)) return true;
          // A transport that disappears before accepting the initial config is a connection
          // failure. Once the provider has made progress, preserve Fish's close status instead.
          if (!this.#madeProgress && event.code === 1006) {
            throw new APIConnectionError({ message: 'fish audio stt connection lost' });
          }
          throw new APIStatusError({
            message: 'fish audio stt connection closed unexpectedly',
            options: {
              statusCode: _closeCodeToStatus(event.code),
              requestId: this.#requestId,
              body: event.reason.toString(),
            },
          });
        }
        if (event.type === 'error') {
          if (closingWs || this.abortSignal.aborted) return false;
          throw new APIConnectionError({
            message: 'fish audio stt connection lost',
            options: { body: event.error.name },
          });
        }
        if (!event.isBinary) {
          this.#logger.warn('unexpected fish audio stt text message');
          continue;
        }
        try {
          this.#processMessage(decode(rawDataToUint8Array(event.data)) as WireMessage);
        } catch (error) {
          if (error instanceof APIError) throw error;
          this.#logger.error({ error }, 'failed to process fish audio stt message');
        }
      }
      return false;
    };

    const send = sendTask();
    const control = controlTask();
    const receive = receiveTask();
    try {
      const first = await Promise.race([
        send.then(() => 'send' as const),
        control.then(() => 'control' as const),
        receive.then(() => 'receive' as const),
      ]);
      if (first === 'send') return await receive;
      if (first === 'control') return await receive;
      return await receive;
    } finally {
      taskAbort.abort();
      this.#controlWaiter?.();
      clearLiveness();
      closeWebSocket(ws);
      await Promise.allSettled([send, control, receive]);
      ws.off('message', onMessage);
      ws.off('message', onActivity);
      ws.off('ping', onActivity);
      ws.off('pong', onActivity);
      ws.off('close', onClose);
      ws.off('error', onError);
      if (!messages.closed) messages.close();
    }
  }

  async #connectWebSocket(): Promise<WebSocket> {
    const url = `${this.#opts.baseURL.replace(/^http/, 'ws')}/v1/asr/realtime`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'User-Agent': `livekit-agents-plugin-fishaudio/${__PACKAGE_VERSION__}`,
          model: this.#opts.model,
        },
        handshakeTimeout: this.#connectTimeoutMs,
      });
      // Publish a connecting socket so close() can abort a blocked handshake.
      this.#ws = ws;
    } catch (error) {
      throw new APIConnectionError({
        message: `failed to connect to fish audio stt (${errorName(error)})`,
      });
    }
    const timeoutMs = this.#connectTimeoutMs;
    return await new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ws.off('open', onOpen);
        ws.off('unexpected-response', onUnexpectedResponse);
        ws.off('error', onError);
        ws.off('close', onClose);
        if (error) {
          if (this.#ws === ws) this.#ws = null;
          closeWebSocket(ws);
          reject(error);
        } else resolve(ws);
      };
      const onOpen = () => finish();
      const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) =>
        finish(
          new APIStatusError({
            message: response.statusMessage ?? 'Fish Audio WebSocket connection rejected',
            options: {
              statusCode: response.statusCode ?? -1,
              requestId: optionalHeader(response.headers['x-request-id']),
            },
          }),
        );
      const onError = (error: Error) =>
        finish(
          new APIConnectionError({
            message: `failed to connect to fish audio stt (${errorName(error)})`,
          }),
        );
      const onClose = () =>
        finish(new APIConnectionError({ message: 'failed to connect to fish audio stt' }));
      const timeout = setTimeout(
        () => finish(new APITimeoutError({ message: 'timed out connecting to fish audio stt' })),
        timeoutMs,
      );
      ws.once('open', onOpen);
      ws.once('unexpected-response', onUnexpectedResponse);
      ws.once('error', onError);
      ws.once('close', onClose);
    });
  }

  #send(ws: WebSocket, msg: WireMessage): Promise<void> {
    const payload = encode(msg);
    const sent = this.#sendChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket is not open'));
            return;
          }
          ws.send(payload, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.#sendChain = sent.catch(() => undefined);
    return sent.catch((error: unknown) => {
      throw new APIConnectionError({
        message: 'fish audio stt connection lost',
        options: { body: errorName(error) },
      });
    });
  }

  #sendControl(msg: WireMessage): void {
    if (!this.#ws) return;
    this.#controlQueue.push(msg);
    this.#controlWaiter?.();
    this.#controlWaiter = undefined;
  }

  async #waitForControl(signal: AbortSignal): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (this.#controlWaiter === onControl) this.#controlWaiter = undefined;
        resolve(timedOut);
      };
      const onControl = () => finish(false);
      const onAbort = () => finish(false);
      const timeout = setTimeout(() => finish(true), KEEPALIVE_INTERVAL_MS);
      this.#controlWaiter = onControl;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #currentTurn(msg: WireMessage): Turn | null {
    return this.#turn?.index === numberValue(msg.turn_index) ? this.#turn : null;
  }

  #onSpeechStart(msg: WireMessage): void {
    const turn = {
      index: numberValue(msg.turn_index),
      startMs: numberValue(msg.audio_ms),
      userTurn: false,
      draft: '',
    };
    this.#turn = turn;
    if (this.#opts.turnDetectionMode !== 'auto') this.#startUserTurn(turn);
  }

  #onUserTurnTaken(msg: WireMessage): void {
    let turn = this.#currentTurn(msg);
    if (!turn) {
      turn = {
        index: numberValue(msg.turn_index),
        startMs: numberValue(msg.audio_ms),
        userTurn: false,
        draft: '',
      };
      this.#turn = turn;
    }
    this.#startUserTurn(turn);
  }

  #startUserTurn(turn: Turn): void {
    turn.userTurn = true;
    this.#startSpeech(turn.startMs);
    if (turn.draft) this.#sendTranscript(stt.SpeechEventType.INTERIM_TRANSCRIPT, turn.draft);
  }

  #startSpeech(audioMs: number): void {
    if (this.#speaking) return;
    this.#speaking = true;
    this.#put({
      type: stt.SpeechEventType.START_OF_SPEECH,
      requestId: this.#requestId,
      createdAt: this.#wallTime(audioMs),
    });
  }

  #onDraft(msg: WireMessage): void {
    const turn = this.#currentTurn(msg);
    if (!turn) return;
    turn.draft = (optionalString(msg.text) ?? '').trim();
    if (turn.userTurn && turn.draft) {
      this.#sendTranscript(stt.SpeechEventType.INTERIM_TRANSCRIPT, turn.draft, msg);
    }
  }

  #onEagerEndOfTurn(msg: WireMessage): void {
    const turn = this.#currentTurn(msg);
    if (!turn?.userTurn) return;
    const text = (optionalString(msg.text) ?? '').trim();
    if (text) this.#sendTranscript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, text, msg);
  }

  #onCommitted(msg: WireMessage): void {
    if (this.#currentTurn(msg)) this.#turn = null;
    if (msg.user_turn === false) {
      this.#logger.debug(
        { turnKind: msg.turn_kind, sessionId: this.#sessionId },
        "ignoring a turn that isn't the user's",
      );
      this.#endSpeech([]);
      return;
    }
    this.#startSpeech(numberValue(msg.audio_start_ms));
    const text = (optionalString(msg.text) ?? '').trim();
    const speechData = this.#speechData(text, msg);
    this.#put({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: this.#requestId,
      alternatives: [speechData],
    });
    if (text) appendCapped(this.#history, { role: 'user', text: lastCharacters(text) });
    this.#endSpeech(speechData.words?.length && speechData.endTime > 0 ? [speechData] : []);
  }

  #endSpeech(alternatives: stt.SpeechData[]): void {
    if (!this.#speaking) return;
    this.#speaking = false;
    this.#put({
      type: stt.SpeechEventType.END_OF_SPEECH,
      requestId: this.#requestId,
      alternatives: alternatives.length ? (alternatives as [stt.SpeechData]) : undefined,
      speechEndTime:
        alternatives[0]?.endTime && this.#inputStartedAt !== undefined
          ? this.#inputStartedAt + alternatives[0].endTime * 1000
          : undefined,
    });
  }

  #closeOpenTurn(): void {
    const turn = this.#turn;
    this.#turn = null;
    if (!this.#speaking) return;
    if (turn?.userTurn && turn.draft) {
      this.#sendTranscript(stt.SpeechEventType.FINAL_TRANSCRIPT, turn.draft);
    }
    this.#endSpeech([]);
  }

  #onError(msg: WireMessage): void {
    const errorType = optionalString(msg.error_type);
    const message = optionalString(msg.message) ?? 'unknown error from fish audio stt';
    if (msg.recoverable || (errorType && RECONNECT_ERROR_TYPES.has(errorType))) {
      this.#logger.warn(
        { errorType, requestId: msg.request_id },
        `fish audio stt error: ${message}`,
      );
      return;
    }
    throw new APIStatusError({
      message,
      options: {
        statusCode: numberValue(msg.code, -1),
        requestId: optionalString(msg.request_id),
        body: errorType ?? null,
      },
    });
  }

  #sendTranscript(type: stt.SpeechEventType, text: string, msg?: WireMessage): void {
    this.#put({
      type,
      requestId: this.#requestId,
      alternatives: [this.#speechData(text, msg)],
    });
  }

  #speechData(text: string, msg: WireMessage = {}): stt.SpeechData {
    const language = optionalString(msg.language_code);
    if (language) this.#language = language;
    const rawWords = Array.isArray(msg.words) ? msg.words : [];
    const offset = this.#providerStartTimeOffset;
    const words = rawWords.map((entry) => {
      const word = isRecord(entry) ? entry : {};
      return createTimedString({
        text: optionalString(word.text) ?? '',
        startTime: numberValue(word.start_ms) / 1000 + offset,
        endTime: numberValue(word.end_ms) / 1000 + offset,
        startTimeOffset: offset,
      });
    });
    let startTime = 0;
    let endTime = 0;
    if (rawWords.length) {
      const first = isRecord(rawWords[0]) ? rawWords[0] : {};
      const last = isRecord(rawWords.at(-1)) ? rawWords.at(-1)! : {};
      startTime = numberValue(first.start_ms) / 1000 + offset;
      endTime = numberValue(last.end_ms) / 1000 + offset;
    } else if ('audio_end_ms' in msg) {
      startTime = numberValue(msg.audio_start_ms) / 1000 + offset;
      endTime = numberValue(msg.audio_end_ms) / 1000 + offset;
    }
    return {
      language: asLanguageCode(this.#language),
      text,
      startTime,
      endTime,
      confidence: 0,
      words: words.length ? words : undefined,
    };
  }

  #wallTime(audioMs: number): number | undefined {
    if (this.#inputStartedAt === undefined) return undefined;
    return this.#inputStartedAt + this.#providerStartTimeOffset * 1000 + audioMs;
  }

  #addUsage(durationSeconds: number): void {
    this.#unreportedAudioDuration += durationSeconds;
    if (this.#unreportedAudioDuration >= USAGE_REPORT_INTERVAL_SECONDS) this.#reportUsage();
  }

  #reportUsage(): void {
    if (this.#unreportedAudioDuration <= 0) return;
    this.#put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: { audioDuration: this.#unreportedAudioDuration },
    });
    this.#unreportedAudioDuration = 0;
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }
}

function validateSilenceTimeout(mode: TurnDetectionMode, timeoutMs: number): void {
  const [low, high] = SILENCE_TIMEOUT_RANGES[mode];
  if (timeoutMs < low || timeoutMs > high) {
    throw new Error(
      `silenceTimeoutMs must be between ${low} and ${high} in '${mode}' turn detection mode`,
    );
  }
}

function sanitizeTerms(terms: readonly string[]): string[] {
  const sanitized: string[] = [];
  const seen = new Set<string>();
  let tooLong = 0;
  for (const raw of terms) {
    const term = raw.trim();
    if (!term || seen.has(term)) continue;
    if ([...term].length > MAX_TERM_CHARS) {
      tooLong++;
      continue;
    }
    seen.add(term);
    sanitized.push(term);
  }
  if (tooLong) log().warn(`dropped ${tooLong} keyterm(s) longer than ${MAX_TERM_CHARS} characters`);
  if (sanitized.length > MAX_TERMS) {
    log().warn(`keeping the first ${MAX_TERMS} of ${sanitized.length} keyterms`);
    return sanitized.slice(0, MAX_TERMS);
  }
  return sanitized;
}

/** @internal */
export function _closeCodeToStatus(code: number): number {
  return code >= 4000 && code < 5000 ? code - 4000 : -1;
}

function appendCapped<T>(items: T[], item: T): void {
  items.push(item);
  if (items.length > MAX_HISTORY_ITEMS) items.splice(0, items.length - MAX_HISTORY_ITEMS);
}

function lastCharacters(value: string): string {
  return [...value].slice(-MAX_HISTORY_CHARS).join('');
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isRecord(value: unknown): value is WireMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringValue(value: unknown): string {
  return optionalString(value) ?? '';
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function optionalHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data as ArrayBuffer);
}

function closeWebSocket(ws: WebSocket): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING)
      ws.terminate();
  } catch {
    // Ignore teardown races.
  }
}
