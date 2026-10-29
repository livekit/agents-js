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
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { Mistral } from '@mistralai/mistralai';
import {
  RealtimeSpeech,
  RealtimeSpeechException,
  RealtimeSpeechWSError,
  audioBytes,
} from '@mistralai/mistralai/extra/realtime';
import type { RealtimeSpeechConnection } from '@mistralai/mistralai/extra/realtime';
import type { IPAPhoneme, SpeechOutputFormat } from '@mistralai/mistralai/models/components';
import type { MistralTTSModels, MistralTTSVoices } from './models.js';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const DEFAULT_MODEL: MistralTTSModels = 'voxtral-mini-tts-3';
const DEFAULT_VOICE: MistralTTSVoices = 'en_paul_neutral';
const DEFAULT_RESPONSE_FORMAT: SpeechOutputFormat = 'pcm';
const SPLIT_AFTER_CHARS = 1500;
const MAX_REQUEST_CHARS = 2500;
const SENTENCE_ENDS = new Set(['.', '!', '?', '…', '\n']);

const VOXTRAL_3_VOICES = new Set<string>([
  'voice_479',
  'voice_3143',
  'voice_481',
  'voice_1788',
  'voice_591',
  'voice_590',
  'voice_3147',
  'voice_3149',
  'voice_1787',
  'voice_1786',
  'voice_3150',
  'voice_447',
  'voice_485',
  'voice_478',
  'voice_483',
  'voice_3141',
  'voice_589',
  'voice_3137',
  'voice_592',
  'voice_3139',
  'voice_3153',
  'voice_3146',
  'voice_482',
  'voice_3133',
  'voice_3135',
  'voice_3136',
  'voice_3145',
  'voice_3134',
  'voice_3154',
  'voice_480',
  'voice_3155',
  'voice_3132',
  'voice_3138',
  'voice_3140',
  'voice_3144',
  'voice_3142',
]);

export interface TTSOptions {
  model?: MistralTTSModels | string;
  voice?: MistralTTSVoices | string;
  refAudio?: string;
  /** How expressive speech is, from 1 to 5. Voxtral 3 only. */
  expressiveness?: number;
  /** Case-sensitive words mapped to ordered IPA phones. Voxtral 3 HTTP only. */
  phonemeHints?: Record<string, IPAPhoneme[]> | null;
  /** Stream text and speech over the realtime WebSocket API. Voxtral 3 only. */
  useRealtime?: boolean;
  apiKey?: string;
  client?: Mistral;
}

interface ResolvedTTSOptions {
  model: string;
  voice?: string;
  refAudio?: string;
  responseFormat: SpeechOutputFormat;
  expressiveness?: number;
  phonemeHints?: Record<string, IPAPhoneme[]>;
  useRealtime: boolean;
}

const realtimeConnectionAccess = new WeakMap<
  TTS,
  <T>(
    fn: (connection: RealtimeSpeechConnection) => Promise<T>,
    connOptions: APIConnectOptions,
    signal: AbortSignal,
  ) => Promise<T>
>();

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #client: Mistral;
  #realtime: RealtimeSpeech;
  #pool: ConnectionPool<RealtimeSpeechConnection>;
  #connectionGenerations = new WeakMap<RealtimeSpeechConnection, number>();
  #optionsGeneration = 0;
  #pendingConnectionCleanup = new Set<Promise<void>>();
  #streams = new Set<WeakRef<SynthesizeStream>>();
  label = 'mistral.TTS';

  constructor(opts: TTSOptions = {}) {
    if (opts.voice && opts.refAudio) {
      throw new Error("Only one of 'voice' or 'refAudio' may be provided, not both");
    }

    const model = opts.model ?? DEFAULT_MODEL;
    const phonemeHints = opts.phonemeHints || undefined;
    checkOptions(model, opts.voice, opts.expressiveness, opts.useRealtime ?? false, phonemeHints);

    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: opts.useRealtime ?? false });

    const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
    if (!apiKey && !opts.client) {
      throw new Error(
        'Mistral API key is required, either as an argument or via MISTRAL_API_KEY env var',
      );
    }

    this.#opts = {
      model,
      voice: opts.refAudio ? undefined : opts.voice ?? DEFAULT_VOICE,
      refAudio: opts.refAudio,
      responseFormat: DEFAULT_RESPONSE_FORMAT,
      expressiveness: opts.expressiveness,
      phonemeHints,
      useRealtime: opts.useRealtime ?? false,
    };
    this.#client = opts.client ?? new Mistral({ apiKey });
    this.#realtime = new RealtimeSpeech(this.#client._options);
    this.#pool = new ConnectionPool<RealtimeSpeechConnection>({
      connectCb: (timeout, signal) => this.#connectRealtime(timeout, signal),
      closeCb: (connection) => connection.close(),
      connectTimeout: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    });
    realtimeConnectionAccess.set(this, (fn, connOptions, signal) =>
      this.#withRealtimeConnection(fn, connOptions, signal),
    );
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'api.mistral.ai';
  }

  updateOptions(opts: Omit<Partial<TTSOptions>, 'apiKey' | 'client'>): void {
    if (opts.voice && opts.refAudio) {
      throw new Error("Only one of 'voice' or 'refAudio' may be provided, not both");
    }

    const model = opts.model ?? this.#opts.model;
    const voice = opts.voice ?? (opts.refAudio !== undefined ? undefined : this.#opts.voice);
    const expressiveness = opts.expressiveness ?? this.#opts.expressiveness;
    const phonemeHints =
      opts.phonemeHints === undefined ? this.#opts.phonemeHints : opts.phonemeHints || undefined;
    const useRealtime = opts.useRealtime ?? this.#opts.useRealtime;
    checkOptions(model, voice, expressiveness, useRealtime, phonemeHints);

    const previousSession = JSON.stringify([this.#opts.model, this.#realtimeSessionOptions()]);
    if (opts.model !== undefined) this.#opts.model = opts.model;
    if (opts.voice !== undefined) {
      this.#opts.voice = opts.voice;
      this.#opts.refAudio = undefined;
    }
    if (opts.refAudio !== undefined) {
      this.#opts.refAudio = opts.refAudio;
      this.#opts.voice = undefined;
    }
    this.#opts.expressiveness = expressiveness;
    this.#opts.phonemeHints = phonemeHints;
    this.#opts.useRealtime = useRealtime;
    this.capabilities.streaming = useRealtime;

    if (previousSession !== JSON.stringify([this.#opts.model, this.#realtimeSessionOptions()])) {
      this.#optionsGeneration += 1;
      this.#pool.invalidate();
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, this.#client, this.#opts, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    if (!this.capabilities.streaming) {
      throw new Error('Streaming requires useRealtime to be enabled on Mistral TTS');
    }
    const stream = new SynthesizeStream(this, options?.connOptions);
    const ref = new WeakRef(stream);
    this.#streams.add(ref);
    void stream.done.then(() => this.#streams.delete(ref));
    return stream;
  }

  prewarm(): void {
    if (this.capabilities.streaming) this.#pool.prewarm();
  }

  override async releaseIdleConnections(): Promise<void> {
    await this.#pool.releaseIdle();
  }

  override async close(): Promise<void> {
    const streams = [...this.#streams].flatMap((ref) => {
      const stream = ref.deref();
      return stream ? [stream] : [];
    });
    for (const stream of streams) stream.close();
    await Promise.all(streams.map((stream) => stream.done));
    this.#streams.clear();
    await this.#pool.close();
    await Promise.allSettled(this.#pendingConnectionCleanup);
    realtimeConnectionAccess.delete(this);
    await super.close();
  }

  async #withRealtimeConnection<T>(
    fn: (connection: RealtimeSpeechConnection) => Promise<T>,
    connOptions: APIConnectOptions,
    signal: AbortSignal,
  ): Promise<T> {
    while (true) {
      const connection = await this.#pool.get(connOptions.timeoutMs, signal);
      if (
        connection.isClosed ||
        this.#connectionGenerations.get(connection) !== this.#optionsGeneration
      ) {
        this.#pool.remove(connection);
        continue;
      }
      try {
        const result = await fn(connection);
        this.#pool.put(connection);
        return result;
      } catch (error) {
        this.#pool.remove(connection);
        throw error;
      }
    }
  }

  async #connectRealtime(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RealtimeSpeechConnection> {
    const generation = this.#optionsGeneration;
    const pending = this.#realtime.connect(this.#opts.model, {
      ...this.#realtimeSessionOptions(),
      timeoutMs,
    });
    const connection = signal ? await connectionOrAbort(pending, signal) : await pending;
    if (!connection) {
      const cleanup = pending.then((opened) => opened.close()).catch(() => {});
      this.#pendingConnectionCleanup.add(cleanup);
      void cleanup.finally(() => this.#pendingConnectionCleanup.delete(cleanup));
      throw signal?.reason ?? new Error('aborted');
    }
    this.#connectionGenerations.set(connection, generation);
    return connection;
  }

  #realtimeSessionOptions() {
    return {
      voiceId: this.#opts.voice,
      refAudio: this.#opts.refAudio,
      responseFormat: 'pcm' as const,
      streamingMode: 'responsive' as const,
      expressiveness: this.#opts.expressiveness,
    };
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'mistral.ChunkedStream';
  #client: Mistral;
  #opts: ResolvedTTSOptions;
  #connOptions: APIConnectOptions;

  constructor(
    ttsInstance: TTS,
    client: Mistral,
    opts: {
      model: string;
      voice?: string;
      refAudio?: string;
      responseFormat: SpeechOutputFormat;
      expressiveness?: number;
      phonemeHints?: Record<string, IPAPhoneme[]>;
      useRealtime: boolean;
    },
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions ?? DEFAULT_API_CONNECT_OPTIONS, abortSignal);
    this.#client = client;
    this.#opts = { ...opts };
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run(): Promise<void> {
    try {
      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
      const speechRequest = {
        model: this.#opts.model,
        input: this.inputText,
        responseFormat: this.#opts.responseFormat,
        stream: true as const,
        voiceId: this.#opts.refAudio ? undefined : this.#opts.voice ?? DEFAULT_VOICE,
        refAudio: this.#opts.refAudio,
        expressiveness: this.#opts.expressiveness,
        phonemeHints: this.#opts.phonemeHints,
      };

      const stream = await this.#client.audio.speech.complete(speechRequest, {
        signal: this.abortController.signal,
        timeoutMs: this.#connOptions.timeoutMs,
      });

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (final: boolean) => {
        if (!lastFrame) return;
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
        lastFrame = undefined;
      };

      // The SDK's stream wrapper currently exposes a broader event type than its iterator yields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const ev of stream as any) {
        if (this.abortController.signal.aborted) break;
        if (ev.type === 'speech.audio.delta') {
          for (const frame of audioByteStream.write(f32leToS16le(audioBytes(ev)))) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        } else if (ev.type === 'speech.audio.done') {
          this.setTokenUsage({
            inputTokens: ev.usage.promptTokens ?? 0,
            outputTokens: ev.usage.completionTokens ?? 0,
          });
        }
      }

      for (const frame of audioByteStream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } catch (error: unknown) {
      if (this.abortController.signal.aborted) return;
      throw mistralError(error, 'HTTP speech request');
    }
  }
}

/** Streams generated text and synthesized audio over a pooled Voxtral 3 connection. */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'mistral.SynthesizeStream';
  readonly done: Promise<void>;
  #resolveDone!: () => void;
  #withRealtimeConnection: NonNullable<ReturnType<typeof realtimeConnectionAccess.get>>;

  constructor(instance: TTS, connOptions?: APIConnectOptions) {
    super(instance, connOptions);
    this.#withRealtimeConnection = realtimeConnectionAccess.get(instance)!;
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  protected async run(): Promise<void> {
    try {
      await this.#withRealtimeConnection(
        (connection) => this.#synthesize(connection),
        this.connOptions,
        this.abortSignal,
      );
      if (!this.queue.closed) this.queue.put(SynthesizeStream.END_OF_STREAM);
    } catch (error: unknown) {
      if (this.abortSignal.aborted) return;
      throw mistralError(error, 'realtime speech request');
    }
  }

  protected override onStreamDone(): void {
    this.#resolveDone();
  }

  async #synthesize(connection: RealtimeSpeechConnection): Promise<void> {
    let text = await this.#nextText(false, this.abortSignal);
    while (text !== null) {
      await this.#synthesizeSegment(connection, text);
      text = await this.#nextText(false, this.abortSignal);
    }
  }

  async #synthesizeSegment(
    connection: RealtimeSpeechConnection,
    initialText: string,
  ): Promise<void> {
    let text: string | null = initialText;
    const requestId = shortuuid();
    const segmentId = shortuuid();
    const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    let lastFrame: AudioFrame | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame) return;
      this.queue.put({ requestId, segmentId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    while (text !== null) {
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort(this.abortSignal.reason);
      this.abortSignal.addEventListener('abort', abortRequest, { once: true });
      let markFlushed!: () => void;
      const flushState = {
        flushed: false,
        promise: new Promise<void>((resolve) => {
          markFlushed = resolve;
        }),
      };
      const receive = this.#receiveAudio(
        connection,
        audioByteStream,
        flushState,
        requestController.signal,
        (frame) => {
          sendLastFrame(false);
          lastFrame = frame;
        },
      );
      const send = this.#sendText(
        connection,
        text,
        flushState,
        markFlushed,
        requestController.signal,
      );
      let sent: { split: boolean; rest: string };
      let usage: { inputTokens: number; outputTokens: number };
      try {
        [sent, usage] = await Promise.all([send, receive]);
      } catch (error) {
        requestController.abort(error);
        await connection.close().catch(() => {});
        await Promise.allSettled([send, receive]);
        throw error;
      } finally {
        this.abortSignal.removeEventListener('abort', abortRequest);
      }
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      text = sent.rest || (sent.split ? await this.#nextText(true, this.abortSignal) : null);
    }

    for (const frame of audioByteStream.flush()) {
      sendLastFrame(false);
      lastFrame = frame;
    }
    sendLastFrame(true);
    this.setTokenUsage({ inputTokens, outputTokens });
  }

  async #sendText(
    connection: RealtimeSpeechConnection,
    text: string,
    flushState: { flushed: boolean },
    markFlushed: () => void,
    signal: AbortSignal,
  ): Promise<{ split: boolean; rest: string }> {
    this.markStarted();
    // Input already sent to the provider cannot be replayed safely by the base retry loop.
    this.connOptions.maxRetry = 0;
    let [head, rest] = cut(text, MAX_REQUEST_CHARS, true);
    await connection.sendText(head);
    let sent = head.length;
    let split = Boolean(rest);

    while (!split) {
      const item = await this.input.next({ signal });
      if (item.done || typeof item.value !== 'string') break;
      [head, rest] = cut(item.value, MAX_REQUEST_CHARS - sent, false);
      if (head) {
        await connection.sendText(head);
        sent += head.length;
      }
      if (
        rest ||
        sent >= MAX_REQUEST_CHARS ||
        (sent >= SPLIT_AFTER_CHARS && SENTENCE_ENDS.has(head.trimEnd().at(-1) ?? ''))
      ) {
        split = true;
      }
    }

    await connection.flush();
    flushState.flushed = true;
    markFlushed();
    return { split, rest };
  }

  async #nextText(untilFlush: boolean, signal: AbortSignal): Promise<string | null> {
    while (true) {
      const item = await this.input.next({ signal });
      if (item.done) return null;
      if (typeof item.value !== 'string') {
        if (untilFlush) return null;
      } else if (item.value.trim()) {
        return item.value;
      }
    }
  }

  async #receiveAudio(
    connection: RealtimeSpeechConnection,
    audioByteStream: AudioByteStream,
    flushState: { flushed: boolean; promise: Promise<void> },
    signal: AbortSignal,
    emitFrame: (frame: AudioFrame) => void,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    const converter = new Float32ToInt16();
    const events = connection[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextRealtimeEvent(
          events,
          flushState,
          this.connOptions.timeoutMs,
          signal,
        );
        if (next.done) break;
        const event = next.value;
        if ('raw' in event) {
          if (event.error) throw event.error;
          continue;
        }
        if (event.type === 'speech.audio.delta') {
          for (const frame of audioByteStream.write(converter.convert(audioBytes(event)))) {
            emitFrame(frame);
          }
        } else if (event.type === 'speech.audio.done') {
          return {
            inputTokens: event.usage.promptTokens ?? 0,
            outputTokens: event.usage.completionTokens ?? 0,
          };
        } else if (event.type === 'error') {
          throw new APIStatusError({
            message:
              typeof event.error.message === 'string'
                ? event.error.message
                : JSON.stringify(event.error.message),
            options: { statusCode: event.error.code, body: event, retryable: false },
          });
        }
      }
    } finally {
      await events.return?.();
    }
    throw new APIConnectionError({ message: 'Mistral realtime speech connection closed' });
  }
}

async function nextRealtimeEvent<T>(
  events: AsyncIterator<T>,
  flushState: { flushed: boolean; promise: Promise<void> },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const next = events.next();
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    if (!flushState.flushed) {
      const beforeFlush = await Promise.race([
        next.then((result) => ({ result })),
        flushState.promise.then(() => ({ result: undefined })),
        aborted,
      ]);
      if (beforeFlush.result) return beforeFlush.result;
    }
    return await Promise.race([
      next,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new APITimeoutError({ message: 'Mistral realtime speech timed out' })),
          timeoutMs,
        );
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function connectionOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let abort!: () => void;
  const aborted = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

class Float32ToInt16 {
  #remainder = new Uint8Array();

  convert(chunk: Uint8Array): Uint8Array {
    const data = new Uint8Array(this.#remainder.byteLength + chunk.byteLength);
    data.set(this.#remainder);
    data.set(chunk, this.#remainder.byteLength);
    const usable = data.byteLength - (data.byteLength % 4);
    this.#remainder = data.slice(usable);
    return f32leToS16le(data.subarray(0, usable));
  }
}

function f32leToS16le(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new DataView(new ArrayBuffer(Math.floor(data.byteLength / 4) * 2));
  for (let i = 0; i < data.byteLength / 4; i++) {
    const sample = view.getFloat32(i * 4, true);
    out.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.trunc(sample * 32767))), true);
  }
  return new Uint8Array(out.buffer);
}

function isVoxtral3(model: string): boolean {
  return /-tts-3(?:-|$)/u.test(model);
}

function checkOptions(
  model: string,
  voice: string | undefined,
  expressiveness: number | undefined,
  useRealtime: boolean,
  phonemeHints: Record<string, IPAPhoneme[]> | undefined,
): void {
  if (voice && VOXTRAL_3_VOICES.has(voice) && !isVoxtral3(model)) {
    throw new Error(`voice ${JSON.stringify(voice)} is only supported by the latest speech model`);
  }
  if (expressiveness !== undefined && !isVoxtral3(model)) {
    throw new Error('expressiveness is only supported by the latest speech model');
  }
  if ((useRealtime || phonemeHints) && !isVoxtral3(model)) {
    throw new Error('useRealtime and phonemeHints are only supported by the latest speech model');
  }
  if (useRealtime && phonemeHints) {
    throw new Error('phonemeHints is not supported with useRealtime');
  }
}

function cut(text: string, room: number, force: boolean): [string, string] {
  if (text.length <= room) return [text, ''];
  const window = text.slice(0, Math.max(room, 0));
  for (let i = window.length - 1; i >= 0; i--) {
    if (SENTENCE_ENDS.has(window[i]!)) return [text.slice(0, i + 1), text.slice(i + 1)];
  }
  const space = window.lastIndexOf(' ');
  if (space > 0) return [text.slice(0, space), text.slice(space)];
  return force ? [window, text.slice(window.length)] : ['', text];
}

function mistralError(error: unknown, operation: string): APIError {
  if (error instanceof APIError) return error;
  if (error instanceof RealtimeSpeechWSError) {
    return new APIStatusError({
      message: error.message,
      options: {
        statusCode: error.code ?? error.payload?.error.code ?? -1,
        body: error.rawPayload ?? error.payload ?? null,
        retryable: false,
      },
    });
  }
  if (error instanceof RealtimeSpeechException) {
    if (error.code === 1008) {
      return new APIStatusError({
        message: error.message || 'the realtime speech connection was rejected',
        options: { statusCode: error.code, body: error.message, retryable: false },
      });
    }
    if (/timeout/i.test(error.message)) {
      return new APITimeoutError({ message: error.message });
    }
    return new APIConnectionError({ message: error.message });
  }

  const err = error as {
    statusCode?: number;
    status?: number;
    code?: number;
    message?: string;
    name?: string;
  };
  const statusCode = err.statusCode ?? err.status ?? err.code;
  if (statusCode !== undefined) {
    return new APIStatusError({
      message: `Mistral ${operation} failed: ${err.message ?? 'unknown error'}`,
      options: { statusCode, retryable: statusCode !== 429 },
    });
  }
  if (err.name === 'TimeoutError' || err.name === 'RequestTimeoutError') {
    return new APITimeoutError({ message: `Mistral ${operation} timed out` });
  }
  return new APIConnectionError({
    message: `Mistral ${operation} failed: ${err.message ?? 'unknown error'}`,
  });
}
