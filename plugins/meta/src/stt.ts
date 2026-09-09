// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import { performance } from 'node:perf_hooks';
import type { ClientOptions, RawData } from 'ws';
import { WebSocket } from 'ws';
import { log } from './log.js';

export const DEFAULT_URL = 'wss://api.meta.ai/v1/asr/realtime';
export const DEFAULT_MODEL = 'muse-voice-transcribe-1.0';
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const SAMPLE_WIDTH_BYTES = 2;
const CHUNK_DURATION_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH_BYTES * CHUNK_DURATION_MS) / 1000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_COMPLETED_TURNS = 128;

const SUPPORTED_LANGUAGES = [
  'Arabic',
  'Bengali',
  'Dutch',
  'English',
  'French',
  'German',
  'Hebrew',
  'Hindi',
  'Indonesian',
  'Italian',
  'Japanese',
  'Kannada',
  'Korean',
  'Malay',
  'Mandarin Chinese',
  'Marathi',
  'Polish',
  'Portuguese',
  'Spanish',
  'Tagalog',
  'Tamil',
  'Telugu',
  'Thai',
  'Turkish',
  'Vietnamese',
] as const;

const LANGUAGE_NAMES = new Map(
  SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
);
const LANGUAGE_CODES: Record<string, (typeof SUPPORTED_LANGUAGES)[number]> = {
  ar: 'Arabic',
  bn: 'Bengali',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fil: 'Tagalog',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  iw: 'Hebrew',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  ms: 'Malay',
  mr: 'Marathi',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Tagalog',
  tr: 'Turkish',
  vi: 'Vietnamese',
  zh: 'Mandarin Chinese',
};
const RETRYABLE_CLOSE_CODES = new Set([1011, 1013]);
const NON_RETRYABLE_CLOSE_CODES = new Set([1008]);

/** Creates the WebSocket transport used by a Muse stream. */
export type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

/** Configuration for Meta Muse Voice Transcribe. */
export interface STTOptions {
  /** Meta Model API key. Defaults to `MODEL_API_KEY`, then `META_API_KEY`. */
  apiKey?: string;
  /** Muse Voice Transcribe model identifier. */
  model: string;
  /** Realtime Muse ASR WebSocket endpoint. Must be an absolute secure URL. */
  url: string;
  /** Static recognition keywords sent when each stream starts. */
  keywords: string[];
  /** Static supported language names sent when each stream starts. */
  languageBias: string[];
  /** Custom WebSocket constructor, primarily for managed transports and testing. */
  webSocketFactory: WebSocketFactory;
}

/** Per-stream options for Meta Muse Voice Transcribe. */
export interface SpeechStreamOptions {
  /** Language name, code, or locale to append to the stream's language bias. */
  language?: string;
  /** Framework connection and retry options. */
  connOptions?: APIConnectOptions;
}

interface ResolvedSTTOptions extends STTOptions {
  apiKey: string;
}

interface TurnState {
  providerStarted: boolean;
  emittedStart: boolean;
  latestInterim?: string;
  emittedInterim?: string;
  finalText?: string;
  finalEmitted: boolean;
  ended: boolean;
  usageSeconds: number;
  usageCaptured: boolean;
}

interface SpeechStreamTestState {
  audioConsumed: boolean;
  turns: Map<string, TurnState>;
  completedTurnIds: Set<string>;
  completedTurnOrder: string[];
}

const SPEECH_STREAM_TEST_STATES = new WeakMap<SpeechStream, () => SpeechStreamTestState>();
const SPEECH_STREAM_CLOSE_PROMISES = new WeakMap<SpeechStream, () => Promise<void>>();

export function speechStreamTestState(stream: SpeechStream): SpeechStreamTestState {
  const state = SPEECH_STREAM_TEST_STATES.get(stream);
  if (!state) throw new Error('unknown Meta speech stream');
  return state();
}

function sanitizedErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const name = error.constructor.name;
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : 'Error';
}

type IncomingEvent =
  | { kind: 'message'; data: RawData; isBinary: boolean }
  | { kind: 'close'; code: number }
  | { kind: 'error'; error: Error };

function normalizeHints(values: string[] | undefined, name: string): string[] {
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const hint = value.trim();
    if (!hint) throw new Error(`${name} entries must be non-empty`);
    if (!normalized.includes(hint)) normalized.push(hint);
  }
  return normalized;
}

export function normalizeAccessToken(apiKey: string): string {
  const match = apiKey.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (match?.[1]?.toLowerCase() === 'bearer') {
    const token = match[2]?.trim();
    if (!token) throw new Error('Meta Model API key must include a token after Bearer');
    return `Bearer ${token}`;
  }
  return `Bearer ${apiKey}`;
}

function normalizeLanguageBias(values: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const documentedName = LANGUAGE_NAMES.get(value.trim().toLowerCase());
    if (!documentedName) {
      throw new Error(
        `unsupported languageBias entry ${JSON.stringify(value)}; supported: ${SUPPORTED_LANGUAGES.join(', ')}`,
      );
    }
    if (!normalized.includes(documentedName)) normalized.push(documentedName);
  }
  return normalized;
}

export function normalizeLanguageHint(language: string): string {
  const value = language.trim();
  if (!value) throw new Error('language must be non-empty');

  const documentedName = LANGUAGE_NAMES.get(value.toLowerCase());
  if (documentedName) return documentedName;

  const primary = value.replaceAll('_', '-').split('-', 1)[0]!.toLowerCase();
  const mappedName = LANGUAGE_CODES[primary];
  if (!mappedName) {
    throw new Error(
      `unsupported Muse Voice language ${JSON.stringify(language)}; supported: ${SUPPORTED_LANGUAGES.join(', ')}`,
    );
  }
  return mappedName;
}

function protocolError(detail: string): APIConnectionError {
  return new APIConnectionError({
    message: `Meta Muse realtime ASR protocol error: ${detail}`,
    options: { retryable: false },
  });
}

function serverError(phase: string): APIStatusError {
  return new APIStatusError({
    message: `Meta Muse realtime ASR ${phase} error`,
    options: { statusCode: 400, requestId: null, body: null, retryable: false },
  });
}

export function closeError(
  closeCode: number | undefined,
  phase: string,
  retryableOnNormalClose = false,
): APIStatusError {
  const code = closeCode || -1;
  let retryable: boolean;
  if (code === 1000) retryable = retryableOnNormalClose;
  else if (NON_RETRYABLE_CLOSE_CODES.has(code)) retryable = false;
  else if (RETRYABLE_CLOSE_CODES.has(code)) retryable = true;
  else retryable = true;
  return new APIStatusError({
    message: `Meta Muse realtime ASR closed during ${phase}`,
    options: { statusCode: code, body: null, retryable },
  });
}

function parseMessage(event: IncomingEvent, phase: string, retryableOnNormalClose = false) {
  if (event.kind === 'close') {
    throw closeError(event.code, phase, retryableOnNormalClose);
  }
  if (event.kind === 'error') {
    throw new APIConnectionError({
      message: `Meta Muse realtime ASR ${phase} failed (${event.error.name})`,
    });
  }
  if (event.isBinary) throw protocolError(`unexpected message type during ${phase}`);
  try {
    const message: unknown = JSON.parse(event.data.toString());
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw protocolError(`non-object message during ${phase}`);
    }
    return message as Record<string, unknown>;
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw protocolError(`invalid JSON during ${phase}`);
  }
}

function normalizeTurnId(value: unknown, event: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || typeof value === 'boolean') {
    throw protocolError(`${event} event has an invalid turnId`);
  }
  const turnId = String(value).trim();
  if (!turnId) throw protocolError(`${event} event has an invalid turnId`);
  return turnId;
}

function emptyTurn(): TurnState {
  return {
    providerStarted: false,
    emittedStart: false,
    finalEmitted: false,
    ended: false,
    usageSeconds: 0,
    usageCaptured: false,
  };
}

class WebSocketInbox {
  readonly #events: IncomingEvent[] = [];
  readonly #waiters: Array<(event: IncomingEvent) => void> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data, isBinary) => this.#push({ kind: 'message', data, isBinary }));
    ws.on('close', (code) => this.#push({ kind: 'close', code }));
    ws.on('error', (error) => this.#push({ kind: 'error', error }));
  }

  #push(event: IncomingEvent) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(event);
    else this.#events.push(event);
  }

  async next(signal?: AbortSignal): Promise<IncomingEvent> {
    const event = this.#events.shift();
    if (event) return event;
    if (signal?.aborted) throw signal.reason;
    return new Promise<IncomingEvent>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(onEvent);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason);
      };
      const onEvent = (nextEvent: IncomingEvent) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(nextEvent);
      };
      this.#waiters.push(onEvent);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

function send(ws: WebSocket, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      ws.send(data, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

/** Streaming speech recognition with Meta Muse Voice Transcribe. */
export class STT extends stt.STT {
  readonly #opts: ResolvedSTTOptions;
  readonly #streams = new Set<WeakRef<SpeechStream>>();
  readonly #streamRegistry = new FinalizationRegistry<WeakRef<SpeechStream>>((ref) => {
    this.#streams.delete(ref);
  });
  #closed = false;
  label = 'meta.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: true,
      diarization: false,
      alignedTranscript: false,
      keyterms: false,
    });

    const resolvedKey =
      opts.apiKey !== undefined
        ? opts.apiKey.trim()
        : process.env.MODEL_API_KEY?.trim() || process.env.META_API_KEY?.trim() || '';
    if (!resolvedKey) {
      throw new Error(
        'Meta Model API key is required. Pass apiKey or set MODEL_API_KEY or META_API_KEY',
      );
    }

    const model = (opts.model ?? DEFAULT_MODEL).trim();
    if (!model) throw new Error('model must be non-empty');
    const url = opts.url ?? DEFAULT_URL;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('url must be an absolute wss:// URL without credentials or a fragment');
    }
    if (
      parsedUrl.protocol !== 'wss:' ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.hash
    ) {
      throw new Error('url must be an absolute wss:// URL without credentials or a fragment');
    }

    this.#opts = {
      apiKey: normalizeAccessToken(resolvedKey),
      model,
      url,
      keywords: normalizeHints(opts.keywords, 'keywords'),
      languageBias: normalizeLanguageBias(opts.languageBias),
      webSocketFactory:
        opts.webSocketFactory ?? ((socketUrl, options) => new WebSocket(socketUrl, options)),
    };
  }

  override get model(): string {
    return this.#opts.model;
  }

  override get provider(): string {
    return 'Meta';
  }

  protected override async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new APIError('Meta Muse Voice Transcribe supports streaming recognition only', {
      retryable: false,
    });
  }

  override stream(options: SpeechStreamOptions = {}): SpeechStream {
    if (this.#closed) throw new Error('Meta STT is closed');
    const languageBias = [...this.#opts.languageBias];
    if (options.language !== undefined) {
      const language = normalizeLanguageHint(options.language);
      if (!languageBias.includes(language)) languageBias.push(language);
    }
    const stream = new SpeechStream(
      this,
      { ...this.#opts, keywords: [...this.#opts.keywords], languageBias },
      options.connOptions,
    );
    const ref = new WeakRef(stream);
    this.#streams.add(ref);
    this.#streamRegistry.register(stream, ref);
    return stream;
  }

  override async close(): Promise<void> {
    this.#closed = true;
    const closing: Promise<void>[] = [];
    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (!stream) {
        this.#streams.delete(ref);
        continue;
      }
      stream.close();
      closing.push(SPEECH_STREAM_CLOSE_PROMISES.get(stream)?.() ?? Promise.resolve());
    }
    await Promise.all(closing);
  }
}

/** A Meta Muse Voice Transcribe streaming session. */
export class SpeechStream extends stt.SpeechStream {
  readonly #opts: ResolvedSTTOptions;
  readonly #timeoutMs: number;
  readonly #logger = log();
  readonly #turns = new Map<string, TurnState>();
  readonly #completedTurnIds = new Set<string>();
  readonly #completedTurnOrder: string[] = [];
  #providerActiveTurnId?: string;
  #sessionId = '';
  #audioConsumed = false;
  #endStreamSent = false;
  #lastAudioProcessedMs = 0;
  #pendingUsageSeconds = 0;
  #ws?: WebSocket;
  #attemptDone = Promise.resolve();
  #resolveAttemptDone?: () => void;
  label = 'meta.SpeechStream';

  constructor(sttInstance: STT, opts: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, SAMPLE_RATE, connOptions);
    this.#opts = opts;
    this.#timeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
    SPEECH_STREAM_TEST_STATES.set(this, () => ({
      audioConsumed: this.#audioConsumed,
      turns: this.#turns,
      completedTurnIds: this.#completedTurnIds,
      completedTurnOrder: this.#completedTurnOrder,
    }));
    SPEECH_STREAM_CLOSE_PROMISES.set(this, () => this.#attemptDone);
  }

  protected override async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    this.#attemptDone = new Promise((resolve) => (this.#resolveAttemptDone = resolve));
    this.#endStreamSent = false;
    this.#lastAudioProcessedMs = 0;
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(this.abortSignal.reason);
    this.abortSignal.addEventListener('abort', abortAttempt, { once: true });
    let sender: Promise<void> | undefined;
    let receiver: Promise<void> | undefined;
    try {
      const { ws, inbox } = await this.#connect(attemptController.signal);
      this.#ws = ws;
      sender = this.#sendAudio(ws, attemptController.signal);
      receiver = this.#receiveEvents(inbox, attemptController.signal);
      await this.#driveTasks(sender, receiver);
      this.#validateCleanClose();
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) {
        if (this.#audioConsumed && error.retryable) {
          throw new APIConnectionError({
            message: 'Meta Muse realtime ASR failed after audio was consumed',
            options: { retryable: false },
          });
        }
        throw error;
      }
      const phase = this.#audioConsumed ? 'audio streaming' : 'connection';
      const errorName = sanitizedErrorName(error);
      throw new APIConnectionError({
        message: `Meta Muse realtime ASR ${phase} failed (${errorName})`,
        options: { retryable: !this.#audioConsumed },
      });
    } finally {
      this.abortSignal.removeEventListener('abort', abortAttempt);
      attemptController.abort();
      this.#closeSocket();
      await Promise.allSettled([sender, receiver].filter((task): task is Promise<void> => !!task));
      try {
        if (!this.closed) this.#flushUsage();
      } finally {
        this.#resolveAttemptDone?.();
        this.#resolveAttemptDone = undefined;
      }
    }
  }

  async #connect(signal: AbortSignal): Promise<{ ws: WebSocket; inbox: WebSocketInbox }> {
    const startedAt = performance.now();
    let ws: WebSocket;
    try {
      ws = this.#opts.webSocketFactory(this.#opts.url, {
        handshakeTimeout: this.#timeoutMs,
        maxPayload: MAX_MESSAGE_BYTES,
      });
    } catch (error) {
      const errorName = sanitizedErrorName(error);
      throw new APIConnectionError({
        message: `Meta Muse realtime ASR connection failed (${errorName})`,
      });
    }
    const inbox = new WebSocketInbox(ws);

    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            ws.off('open', onOpen);
            ws.off('unexpected-response', onUnexpectedResponse);
            ws.off('error', onError);
            ws.off('close', onClose);
            signal.removeEventListener('abort', onAbort);
          };
          const onOpen = () => {
            cleanup();
            resolve();
          };
          const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
            cleanup();
            reject(
              new APIStatusError({
                message: 'Meta Muse realtime ASR connection was rejected',
                options: { statusCode: response.statusCode ?? -1, body: null },
              }),
            );
          };
          const onError = (error: Error) => {
            cleanup();
            reject(
              new APIConnectionError({
                message: `Meta Muse realtime ASR connection failed (${sanitizedErrorName(error)})`,
              }),
            );
          };
          const onClose = (code: number) => {
            cleanup();
            reject(closeError(code, 'connection', true));
          };
          const onAbort = () => {
            cleanup();
            reject(signal.reason);
          };
          ws.once('open', onOpen);
          ws.once('unexpected-response', onUnexpectedResponse);
          ws.once('error', onError);
          ws.once('close', onClose);
          signal.addEventListener('abort', onAbort, { once: true });
          if (ws.readyState === WebSocket.OPEN) onOpen();
        }),
        this.#timeoutMs,
        () => new APITimeoutError({ message: 'Meta Muse realtime ASR connection timed out' }),
      );
      await send(ws, JSON.stringify(this.#handshake()));
      const event = await withTimeout(
        inbox.next(signal),
        this.#timeoutMs,
        () => new APITimeoutError({ message: 'Meta Muse realtime ASR handshake timed out' }),
      );
      this.#acceptHandshake(parseMessage(event, 'handshake', true));
    } catch (error) {
      this.#closeSocket(ws);
      throw error;
    }
    this.#logger.debug(
      { durationMs: performance.now() - startedAt },
      'Muse STT connection acquired',
    );
    return { ws, inbox };
  }

  #handshake(): Record<string, unknown> {
    const handshake: Record<string, unknown> = {
      mode: 'ENDPOINTING',
      authorization: { accessToken: this.#opts.apiKey },
      audioEncoding: 'PCM_24KHZ',
      model: this.#opts.model,
      partialMode: 'CUMULATIVE',
      emitAudioProgress: true,
    };
    if (this.#opts.keywords.length) handshake.keywords = this.#opts.keywords;
    if (this.#opts.languageBias.length) handshake.languageBias = this.#opts.languageBias;
    return handshake;
  }

  #acceptHandshake(message: Record<string, unknown>) {
    if (message.type === 'error') throw serverError('handshake');
    if (typeof message.sessionId !== 'string' || !message.sessionId) {
      throw new APIConnectionError({
        message: 'Meta Muse realtime ASR sent an invalid handshake response',
        options: { retryable: false },
      });
    }
    this.#sessionId = message.sessionId;
  }

  async #driveTasks(sender: Promise<void>, receiver: Promise<void>) {
    const first = await Promise.race([
      sender.then(
        () => ({ task: 'sender' as const }),
        (error: unknown) => ({ task: 'sender' as const, error }),
      ),
      receiver.then(
        () => ({ task: 'receiver' as const }),
        (error: unknown) => ({ task: 'receiver' as const, error }),
      ),
    ]);
    if ('error' in first) throw first.error;
    if (first.task === 'receiver') {
      if (!this.#endStreamSent) {
        throw new APIConnectionError({
          message: 'Meta Muse realtime ASR closed before input ended',
          options: { retryable: !this.#audioConsumed },
        });
      }
      await sender;
      return;
    }
    await withTimeout(
      receiver,
      this.#timeoutMs,
      () =>
        new APITimeoutError({
          message: 'Meta Muse realtime ASR timed out while draining final events',
          options: { retryable: !this.#audioConsumed },
        }),
    );
  }

  async #sendAudio(ws: WebSocket, signal: AbortSignal) {
    let pending = Buffer.alloc(0);
    let pacingOrigin: number | undefined;
    let sentDurationMs = 0;
    const abortPromise = waitForAbort(signal);
    const iterator = this.input[Symbol.asyncIterator]();

    const sendPacket = async (packet: Buffer) => {
      if (!packet.length) return;
      pacingOrigin ??= performance.now();
      const delayMs = pacingOrigin + sentDurationMs - performance.now();
      if (delayMs > 0) {
        const result = await Promise.race([
          new Promise<'elapsed'>((resolve) => setTimeout(() => resolve('elapsed'), delayMs)),
          abortPromise,
        ]);
        if (result !== 'elapsed') return;
      }
      try {
        await send(ws, packet);
      } catch (error) {
        const errorName = sanitizedErrorName(error);
        throw new APIConnectionError({
          message: `Meta Muse realtime ASR audio send failed (${errorName})`,
          options: { retryable: false },
        });
      }
      sentDurationMs += (packet.length / (SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH_BYTES)) * 1000;
    };

    while (true) {
      const result = await Promise.race([iterator.next(), abortPromise]);
      if (result === undefined) return;
      if (result.done) break;
      const item = result.value;
      if (item === SpeechStream.FLUSH_SENTINEL) {
        await sendPacket(pending);
        pending = Buffer.alloc(0);
        continue;
      }

      this.#audioConsumed = true;
      if (item.channels !== CHANNELS) {
        throw new APIError('Meta Muse realtime ASR requires mono audio', { retryable: false });
      }
      pending = Buffer.concat([
        pending,
        Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength),
      ]);
      while (pending.length >= CHUNK_BYTES) {
        await sendPacket(pending.subarray(0, CHUNK_BYTES));
        pending = pending.subarray(CHUNK_BYTES);
      }
    }

    await sendPacket(pending);
    if (!this.#endStreamSent) {
      try {
        await send(ws, '{"type":"endStream"}');
      } catch (error) {
        const errorName = sanitizedErrorName(error);
        throw new APIConnectionError({
          message: `Meta Muse realtime ASR end-of-input send failed (${errorName})`,
          options: { retryable: false },
        });
      }
      this.#endStreamSent = true;
    }
  }

  async #receiveEvents(inbox: WebSocketInbox, signal: AbortSignal) {
    while (true) {
      const event = await inbox.next(signal);
      if (event.kind === 'close') {
        if (this.#endStreamSent && event.code === 1000) return;
        throw closeError(event.code, 'stream', !this.#audioConsumed);
      }
      if (event.kind === 'error') {
        throw new APIConnectionError({
          message: 'Meta Muse realtime ASR WebSocket failed',
          options: { retryable: !this.#audioConsumed },
        });
      }

      const message = parseMessage(event, 'stream');
      const eventType = message.type;
      if (eventType === 'error') throw serverError('stream');
      if (eventType === 'speechStart') this.#speechStart(message);
      else if (eventType === 'transcript') this.#transcript(message);
      else if (eventType === 'speechEnd') this.#speechEnd(message);
      else if (eventType === 'speechComplete') this.#speechComplete(message);
      else if (eventType === 'audioProgress') this.#audioProgress(message);
    }
  }

  #audioProgress(message: Record<string, unknown>) {
    const processedMs = message.audioProcessedMs;
    if (typeof processedMs !== 'number' || !Number.isFinite(processedMs) || processedMs < 0) {
      throw protocolError('audioProgress event has invalid audioProcessedMs');
    }
    if (processedMs <= this.#lastAudioProcessedMs) return;
    this.#pendingUsageSeconds += (processedMs - this.#lastAudioProcessedMs) / 1000;
    this.#lastAudioProcessedMs = processedMs;
  }

  #speechStart(message: Record<string, unknown>) {
    const turnId = this.#requiredTurnId(message, 'speechStart');
    if (this.#completedTurnIds.has(turnId)) return;
    const turn = this.#getTurn(turnId);
    turn.providerStarted = true;
    this.#providerActiveTurnId = turnId;
    this.#drainTurns();
  }

  #transcript(message: Record<string, unknown>) {
    const text = message.transcript;
    if (typeof text !== 'string') throw protocolError('transcript event has invalid text');
    if (!text && message.turnId === undefined && this.#providerActiveTurnId === undefined) return;
    const turnId = this.#transcriptTurnId(message);
    if (this.#completedTurnIds.has(turnId)) return;
    const turn = this.#getTurn(turnId);
    if (turn.finalText !== undefined || turn.latestInterim === text) return;
    turn.latestInterim = text;
    this.#drainTurns();
  }

  #speechEnd(message: Record<string, unknown>) {
    const turnId = this.#requiredTurnId(message, 'speechEnd');
    if (this.#completedTurnIds.has(turnId)) return;
    const turn = this.#getTurn(turnId);
    turn.ended = true;
    if (this.#providerActiveTurnId === turnId) this.#providerActiveTurnId = undefined;
    this.#captureTurnUsage(turn);
    this.#drainTurns();
  }

  #speechComplete(message: Record<string, unknown>) {
    const turnId = this.#requiredTurnId(message, 'speechComplete');
    if (this.#completedTurnIds.has(turnId)) return;
    const text = message.transcript;
    if (typeof text !== 'string')
      throw protocolError('speechComplete event has invalid transcript');
    const turn = this.#getTurn(turnId);
    turn.finalText ??= text;
    this.#captureTurnUsage(turn);
    this.#drainTurns();
  }

  #getTurn(turnId: string): TurnState {
    let turn = this.#turns.get(turnId);
    if (!turn) {
      turn = emptyTurn();
      this.#turns.set(turnId, turn);
    }
    return turn;
  }

  #captureTurnUsage(turn: TurnState) {
    if (turn.usageCaptured || !turn.ended) return;
    turn.usageSeconds = this.#pendingUsageSeconds;
    turn.usageCaptured = true;
    this.#pendingUsageSeconds = 0;
  }

  #drainTurns() {
    while (this.#turns.size) {
      const [turnId, turn] = this.#turns.entries().next().value!;
      const hasContent = turn.latestInterim !== undefined || turn.finalText !== undefined;
      if (!turn.emittedStart && (turn.providerStarted || hasContent)) {
        turn.emittedStart = true;
        this.#emit(stt.SpeechEventType.START_OF_SPEECH, turnId);
      }
      if (
        turn.emittedStart &&
        !turn.finalEmitted &&
        turn.latestInterim !== undefined &&
        turn.latestInterim !== turn.emittedInterim
      ) {
        turn.emittedInterim = turn.latestInterim;
        this.#emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, turnId, turn.latestInterim);
      }
      if (turn.emittedStart && !turn.finalEmitted && turn.finalText !== undefined) {
        turn.finalEmitted = true;
        this.#emit(stt.SpeechEventType.FINAL_TRANSCRIPT, turnId, turn.finalText);
      }
      if (!(turn.finalEmitted && turn.ended)) return;
      this.#emit(stt.SpeechEventType.END_OF_SPEECH, turnId);
      this.#emitUsage(turn.usageSeconds);
      this.#turns.delete(turnId);
      this.#rememberCompletedTurn(turnId);
    }
  }

  #rememberCompletedTurn(turnId: string) {
    if (this.#completedTurnIds.has(turnId)) return;
    if (this.#completedTurnOrder.length >= MAX_COMPLETED_TURNS) {
      this.#completedTurnIds.delete(this.#completedTurnOrder.shift()!);
    }
    this.#completedTurnOrder.push(turnId);
    this.#completedTurnIds.add(turnId);
  }

  #emit(type: stt.SpeechEventType, requestId: string, text?: string) {
    this.queue.put({
      type,
      requestId,
      ...(text === undefined
        ? {}
        : {
            alternatives: [
              {
                language: normalizeLanguage(''),
                text,
                startTime: 0,
                endTime: 0,
                confidence: 0,
              },
            ],
          }),
    });
  }

  #emitUsage(duration: number) {
    if (duration <= 0) return;
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#sessionId,
      recognitionUsage: { audioDuration: duration },
    });
  }

  #flushUsage() {
    let duration = this.#pendingUsageSeconds;
    this.#pendingUsageSeconds = 0;
    for (const turn of this.#turns.values()) {
      duration += turn.usageSeconds;
      turn.usageSeconds = 0;
    }
    this.#emitUsage(duration);
  }

  #transcriptTurnId(message: Record<string, unknown>): string {
    if (message.turnId !== undefined) return normalizeTurnId(message.turnId, 'transcript');
    if (this.#providerActiveTurnId !== undefined) return this.#providerActiveTurnId;
    throw protocolError('transcript event is missing turnId outside an active turn');
  }

  #requiredTurnId(message: Record<string, unknown>, event: string): string {
    if (message.turnId === undefined) throw protocolError(`${event} event is missing turnId`);
    return normalizeTurnId(message.turnId, event);
  }

  #validateCleanClose() {
    if (this.#turns.size) {
      throw new APIConnectionError({
        message: 'Meta Muse realtime ASR closed with incomplete speech turns',
        options: { retryable: false },
      });
    }
  }

  #closeSocket(ws = this.#ws) {
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {
      // The transport may already be closed.
    }
  }

  override close() {
    this.#closeSocket();
    super.close();
  }
}
