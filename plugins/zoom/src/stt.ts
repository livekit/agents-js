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
  calculateAudioDurationSeconds,
  createTimedString,
  delay,
  getBaseLanguage,
  intervalForRetry,
  log,
  mergeFrames,
  normalizeLanguage,
  stt,
  waitForAbort,
  waitForWebSocketOpen,
} from '@livekit/agents';
import type { LanguageCode } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const BASE_URL = 'https://api.zoom.us/v2/aiservices/scribe';
const SAMPLE_RATE = 16000;
const KEEPALIVE_INTERVAL_MS = 10000;
const INPUT_GAP_MS = 1000;
const RECONNECT_HOLD_MS = 10000;
const DEFAULT_SILENCE_DURATION_MS = 350;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const LANGUAGE_MAP: Record<string, string> = {
  ar: 'ar-SA',
  'ar-AE': 'ar-AE',
  'ar-SA': 'ar-SA',
  de: 'de-DE',
  'de-DE': 'de-DE',
  en: 'en-US',
  'en-US': 'en-US',
  es: 'es-ES',
  'es-ES': 'es-ES',
  fr: 'fr-FR',
  'fr-FR': 'fr-FR',
  it: 'it-IT',
  'it-IT': 'it-IT',
  ja: 'ja-JP',
  'ja-JP': 'ja-JP',
  ko: 'ko-KR',
  'ko-KR': 'ko-KR',
  pt: 'pt-BR',
  'pt-BR': 'pt-BR',
  'pt-PT': 'pt-PT',
  zh: 'zh-CN',
  'zh-CN': 'zh-CN',
  bn: 'bn-IN',
  'bn-IN': 'bn-IN',
  ca: 'ca-ES',
  'ca-ES': 'ca-ES',
  cs: 'cs-CZ',
  'cs-CZ': 'cs-CZ',
  da: 'da-DK',
  'da-DK': 'da-DK',
  el: 'el-GR',
  'el-GR': 'el-GR',
  et: 'et-EE',
  'et-EE': 'et-EE',
  fa: 'fa-IR',
  'fa-IR': 'fa-IR',
  fi: 'fi-FI',
  'fi-FI': 'fi-FI',
  fil: 'tl-PH',
  'fil-PH': 'tl-PH',
  he: 'he-IL',
  'he-IL': 'he-IL',
  hi: 'hi-IN',
  'hi-IN': 'hi-IN',
  hu: 'hu-HU',
  'hu-HU': 'hu-HU',
  id: 'id-ID',
  'id-ID': 'id-ID',
  ms: 'ms-MY',
  'ms-MY': 'ms-MY',
  nl: 'nl-NL',
  'nl-NL': 'nl-NL',
  pl: 'pl-PL',
  'pl-PL': 'pl-PL',
  ro: 'ro-RO',
  'ro-RO': 'ro-RO',
  ru: 'ru-RU',
  'ru-RU': 'ru-RU',
  sv: 'sv-SE',
  'sv-SE': 'sv-SE',
  ta: 'ta-IN',
  'ta-IN': 'ta-IN',
  te: 'te-IN',
  'te-IN': 'te-IN',
  th: 'th-TH',
  'th-TH': 'th-TH',
  tl: 'tl-PH',
  'tl-PH': 'tl-PH',
  tr: 'tr-TR',
  'tr-TR': 'tr-TR',
  uk: 'uk-UA',
  'uk-UA': 'uk-UA',
  vi: 'vi-VN',
  'vi-VN': 'vi-VN',
  yue: 'zh-HK',
  'zh-HK': 'zh-HK',
};

const SPEAKER_TAG = /\[(?:speaker[ _]?\d+[LR]?|spk_\d+|channel\d+)]\s*/gi;

/** Zoom Scribe operating mode. */
export type STTMode = 'live' | 'fast';

/** Injectable HTTP and WebSocket transport used by Zoom Scribe. */
export interface STTHTTPSession {
  fetch?: typeof fetch;
  wsConnect?: (
    url: string,
    protocols: string[],
    options: {
      headers: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ) => WebSocket | Promise<WebSocket>;
}

/** Options for a single Scribe Fast recognition request. */
export interface STTRecognizeOptions {
  language?: string;
  connOptions?: APIConnectOptions;
  abortSignal?: AbortSignal;
}

/** Options for Zoom Scribe speech recognition. */
export interface STTOptions {
  mode: STTMode;
  apiKey?: string;
  language: string;
  model?: string;
  languageDetection?: string;
  silenceDurationMs: number | null;
  diarization: boolean;
  wordTimeOffsets: boolean;
  channelSeparation: boolean;
  vocabulary?: string[];
  textPolishing: boolean;
  extraKwargs: Record<string, unknown>;
  baseUrl: string;
  liveUrl?: string;
  fastUrl?: string;
  httpSession?: STTHTTPSession;
}

type ResolvedOptions = STTOptions & { apiKey: string; liveUrl: string; fastUrl: string };
// Provider payloads are dynamic JSON objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

interface RequestView {
  diarization: boolean;
  wordTimeOffsets: boolean;
  channelSeparation: boolean;
  textPolishing: boolean;
  languageDetection: boolean;
  silenceDurationMs: number | null;
}

const defaults: Omit<STTOptions, 'apiKey'> = {
  mode: 'live',
  language: 'en-US',
  silenceDurationMs: DEFAULT_SILENCE_DURATION_MS,
  diarization: false,
  wordTimeOffsets: false,
  channelSeparation: false,
  textPolishing: false,
  extraKwargs: {},
  baseUrl: BASE_URL,
};

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null && typeof value === 'object' && 'aborted' in value && 'addEventListener' in value
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/** Remove speaker and channel tags inserted by Scribe. @internal */
export function _cleanTranscript(text: unknown): string {
  return (typeof text === 'string' ? text : '').replace(SPEAKER_TAG, '').trim();
}

function trackingId(): string {
  return `zoom_ai_community_livekit_${randomUUID()}`;
}

function checkUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, got ${JSON.stringify(value)}`);
  }
  if (['http:', 'ws:'].includes(url.protocol) && !LOOPBACK_HOSTS.has(url.hostname)) {
    log().warn(
      `${name} is not encrypted (${url.protocol.slice(0, -1)}://); the API key and audio are sent in plaintext`,
    );
  }
  return value;
}

function toLocale(language: string): string {
  const normalized = normalizeLanguage(language);
  const locale = LANGUAGE_MAP[normalized] ?? LANGUAGE_MAP[getBaseLanguage(normalized)];
  if (locale) return locale;
  log().warn(
    `language ${JSON.stringify(language)} isn't in the Zoom AI plugin's list; using ${JSON.stringify(normalized)}`,
  );
  return normalized;
}

function deepMerge(base: JsonObject, extra: JsonObject): JsonObject {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) {
    if (isObject(value) && isObject(merged[key])) merged[key] = deepMerge(merged[key], value);
    else merged[key] = structuredClone(value);
  }
  return merged;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recognitionConfig(opts: ResolvedOptions): JsonObject {
  const config: JsonObject = {};
  if (opts.model) config.model = opts.model;
  if (opts.languageDetection) config.language_detection = { mode: opts.languageDetection };
  if (opts.diarization) config.diarization = true;
  if (opts.vocabulary?.length) config.vocabulary = { phrases: [...opts.vocabulary] };
  return config;
}

function requestView(request: JsonObject): RequestView {
  const config = isObject(request.config) ? request.config : {};
  const outputs = isObject(request.outputs) ? request.outputs : {};
  const polishing = isObject(outputs.text_polishing) ? outputs.text_polishing : {};
  const turnDetection = isObject(request.turn_detection) ? request.turn_detection : {};
  return {
    diarization: Boolean(config.diarization),
    wordTimeOffsets: Boolean(config.word_time_offsets),
    channelSeparation: Boolean(config.channel_separation),
    textPolishing: Boolean(polishing.enabled),
    languageDetection: Boolean(config.language_detection),
    silenceDurationMs: Number.isInteger(turnDetection.silence_duration_ms)
      ? turnDetection.silence_duration_ms
      : null,
  };
}

function polishedText(payload: JsonObject): string | undefined {
  const outputs = isObject(payload.outputs) ? payload.outputs : {};
  const polishing = isObject(outputs.text_polishing) ? outputs.text_polishing : {};
  const text = polishing.text;
  if (typeof text !== 'string' || text.trimStart().startsWith('[polishing_failed')) return;
  return _cleanTranscript(text);
}

function reportedLanguage(value: unknown, detecting: boolean, configured: string): LanguageCode {
  return normalizeLanguage(
    typeof value === 'string' && value ? value : detecting ? '' : configured,
  );
}

function zoomReason(body: string): string | undefined {
  try {
    const value = (JSON.parse(body) as JsonObject).message;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return;
  }
}

function wav(frame: AudioFrame): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = frame.sampleRate * frame.channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frame.data.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(frame.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(frame.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);
  return Buffer.concat([
    header,
    Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
  ]);
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function startWebSocketHeartbeat(ws: WebSocket): () => void {
  let pongTimeout: NodeJS.Timeout | undefined;
  const onPong = () => {
    if (pongTimeout) clearTimeout(pongTimeout);
    pongTimeout = undefined;
  };
  ws.on('pong', onPong);
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || pongTimeout) return;
    try {
      ws.ping();
      pongTimeout = setTimeout(() => {
        pongTimeout = undefined;
        ws.terminate();
      }, 10000);
    } catch {
      // The close/error event drives retry.
    }
  }, 30000);
  return () => {
    clearInterval(interval);
    if (pongTimeout) clearTimeout(pongTimeout);
    ws.off('pong', onPong);
  };
}

/** Zoom Scribe speech-to-text, using streaming Live mode or per-utterance Fast mode. */
export class STT extends stt.STT {
  #opts: ResolvedOptions;
  #streams = new Set<SpeechStream>();
  #logger = log();
  #session: STTHTTPSession;
  label = 'zoom.STT';

  constructor(options: Partial<STTOptions> = {}) {
    if (options.mode !== undefined && options.mode !== 'live' && options.mode !== 'fast') {
      throw new Error(`mode must be "live" or "fast", got ${JSON.stringify(options.mode)}`);
    }
    if (options.extraKwargs !== undefined && !isObject(options.extraKwargs)) {
      throw new Error('extraKwargs must be an object');
    }
    const mode = options.mode ?? defaults.mode;
    const extraKwargs = structuredClone(options.extraKwargs ?? defaults.extraKwargs);
    const configuredDiarization = Boolean(
      isObject(extraKwargs.config) && extraKwargs.config.diarization,
    );
    const configuredWordOffsets = Boolean(
      isObject(extraKwargs.config) && extraKwargs.config.word_time_offsets,
    );
    super({
      streaming: mode === 'live',
      interimResults: false,
      alignedTranscript:
        mode === 'fast' && (options.wordTimeOffsets === true || configuredWordOffsets)
          ? 'word'
          : false,
      diarization: options.diarization === true || configuredDiarization,
    });

    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const apiKey = options.apiKey ?? process.env.ZOOM_AI_API_KEY;
    if (!apiKey) {
      throw new Error('Zoom AI API key is required: pass apiKey or set ZOOM_AI_API_KEY');
    }
    const baseUrl = (options.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '');
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new Error(`baseUrl must be an http(s) URL, got ${JSON.stringify(options.baseUrl)}`);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error(`baseUrl must be an http(s) URL, got ${JSON.stringify(options.baseUrl)}`);
    }
    checkUrl(baseUrl, 'baseUrl');
    const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const derivedLive = new URL(`${baseUrl}/live`);
    derivedLive.protocol = wsProtocol;
    const liveUrl = checkUrl(options.liveUrl ?? derivedLive.toString(), 'liveUrl');
    const fastUrl = checkUrl(options.fastUrl ?? `${baseUrl}/transcribe`, 'fastUrl');
    this.#opts = {
      ...defaults,
      ...options,
      mode,
      apiKey,
      language: toLocale(options.language ?? defaults.language),
      baseUrl,
      liveUrl,
      fastUrl,
      extraKwargs,
    };
    this.#session = options.httpSession ?? {};
  }

  get model(): string {
    return this.#opts.model ?? `scribe-${this.#opts.mode}`;
  }

  get provider(): string {
    return 'Zoom';
  }

  async recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent>;
  async recognize(buffer: AudioBuffer, options?: STTRecognizeOptions): Promise<stt.SpeechEvent>;
  async recognize(
    buffer: AudioBuffer,
    optionsOrAbortSignal?: AbortSignal | STTRecognizeOptions,
  ): Promise<stt.SpeechEvent> {
    const options = isAbortSignal(optionsOrAbortSignal)
      ? { abortSignal: optionsOrAbortSignal }
      : optionsOrAbortSignal ?? {};
    const connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;

    for (let attempt = 0; attempt < connOptions.maxRetry + 1; attempt++) {
      try {
        const startTime = process.hrtime.bigint();
        const event = await this.#recognizeImpl(
          buffer,
          options.language,
          options.abortSignal,
          connOptions.timeoutMs,
        );
        event.createdAt ??= Date.now();
        const durationMs = Number((process.hrtime.bigint() - startTime) / BigInt(1000000));
        this.emit('metrics_collected', {
          type: 'stt_metrics',
          requestId: event.requestId ?? '',
          timestamp: Date.now(),
          durationMs,
          label: this.label,
          audioDurationMs: Math.round(calculateAudioDurationSeconds(buffer) * 1000),
          streamed: false,
          metadata: { modelProvider: this.provider, modelName: this.model },
        });
        return event;
      } catch (error) {
        if (options.abortSignal?.aborted) throw abortReason(options.abortSignal);
        if (!(error instanceof APIError)) throw error;
        const retryInterval = intervalForRetry(connOptions, attempt);
        if (connOptions.maxRetry === 0 || !error.retryable) {
          this.#emitError(error);
          throw error;
        }
        if (attempt === connOptions.maxRetry) {
          this.#emitError(error);
          throw new APIConnectionError({
            message: `failed to recognize speech after ${connOptions.maxRetry + 1} attempts`,
            options: { retryable: false },
          });
        }
        this.#logger.warn(
          { stt: this.label, attempt: attempt + 1, error },
          `failed to recognize speech, retrying in ${retryInterval}ms`,
        );
        if (retryInterval > 0) {
          await Promise.race([
            delay(retryInterval),
            ...(options.abortSignal
              ? [
                  waitForAbort(options.abortSignal).then(() => {
                    throw abortReason(options.abortSignal!);
                  }),
                ]
              : []),
          ]);
        }
      }
    }
    throw new APIConnectionError({ message: 'failed to recognize speech' });
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    return this.#recognizeImpl(
      buffer,
      undefined,
      abortSignal,
      DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    );
  }

  async #recognizeImpl(
    buffer: AudioBuffer,
    language?: string,
    abortSignal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const locale = language !== undefined ? toLocale(language) : this.#opts.language;
    const request = this.#fastRequest(locale);
    const view = requestView(request);
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array(wav(frame))], 'utterance.wav', { type: 'audio/wav' }),
    );
    for (const [field, value] of Object.entries(request)) form.append(field, JSON.stringify(value));
    const requestId = trackingId();
    const timeout = AbortSignal.timeout(Math.min(30000, timeoutMs));
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    let response: Response;
    let body: string;
    try {
      const fetchFn = this.#session.fetch ?? fetch;
      response = await fetchFn(this.#opts.fastUrl, {
        method: 'POST',
        headers: this._headers(requestId),
        body: form,
        signal,
      });
      body = await response.text();
    } catch (error) {
      if (abortSignal?.aborted) throw abortReason(abortSignal);
      if (signal.aborted) {
        throw new APITimeoutError({ message: 'Zoom Scribe Fast request timed out' });
      }
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({ message: 'failed to connect to Zoom Scribe Fast' });
    }
    if (!response.ok) {
      const reason = zoomReason(body);
      throw new APIStatusError({
        message: `Zoom Scribe Fast error (HTTP ${response.status})${reason ? `: ${reason}` : ''}`,
        options: { statusCode: response.status, requestId, body },
      });
    }
    let payload: JsonObject;
    try {
      payload = JSON.parse(body) as JsonObject;
    } catch {
      throw new APIStatusError({
        message: 'Zoom Scribe Fast returned a non-JSON response',
        options: { statusCode: response.status, requestId, retryable: false },
      });
    }
    return this.#fastEvent(payload, view, locale);
  }

  stream(options: { connOptions?: APIConnectOptions; language?: string } = {}): SpeechStream {
    if (this.#opts.mode !== 'live') {
      throw new Error('mode="fast" is not streaming; AgentSession wraps it with a VAD');
    }
    const streamOptions = {
      ...this.#opts,
      language: options.language !== undefined ? toLocale(options.language) : this.#opts.language,
      extraKwargs: structuredClone(this.#opts.extraKwargs),
    };
    const stream = new SpeechStream(this, streamOptions, options.connOptions, () =>
      this.#streams.delete(stream),
    );
    this.#streams.add(stream);
    return stream;
  }

  updateOptions(options: { language?: string; silenceDurationMs?: number | null } = {}): void {
    if (options.language === undefined && options.silenceDurationMs === undefined) return;
    if (options.language !== undefined) this.#opts.language = toLocale(options.language);
    if (options.silenceDurationMs !== undefined) {
      this.#opts.silenceDurationMs = options.silenceDurationMs;
    }
    for (const stream of this.#streams) stream.updateOptions(options);
  }

  override async close(): Promise<void> {
    const streams = [...this.#streams];
    this.#streams.clear();
    for (const stream of streams) stream.close();
    await Promise.allSettled(streams.map((stream) => stream._waitClosed()));
  }

  #emitError(error: Error): void {
    if (this.listenerCount('error') === 0) return;
    this.emit('error', {
      type: 'stt_error',
      timestamp: Date.now(),
      label: this.label,
      error,
      recoverable: false,
    });
  }

  /** @internal */
  _headers(requestId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#opts.apiKey}`,
      'User-Agent': `livekit-plugins-zoom-ai/${__PACKAGE_VERSION__}`,
      'x-zm-trackingid': requestId,
    };
  }

  /** @internal */
  _wsConnect(
    url: string,
    protocols: string[],
    options: { headers: Record<string, string>; signal?: AbortSignal; timeoutMs?: number },
  ): WebSocket | Promise<WebSocket> {
    if (this.#session.wsConnect) return this.#session.wsConnect(url, protocols, options);
    return new WebSocket(url, protocols, {
      headers: options.headers,
      handshakeTimeout: options.timeoutMs,
    });
  }

  #fastRequest(locale: string): JsonObject {
    const config: JsonObject = { language: locale, ...recognitionConfig(this.#opts) };
    if (this.#opts.wordTimeOffsets) config.word_time_offsets = true;
    if (this.#opts.channelSeparation) config.channel_separation = true;
    let request: JsonObject = { config };
    if (this.#opts.textPolishing) request.outputs = { text_polishing: { enabled: true } };
    request = deepMerge(request, this.#opts.extraKwargs);
    delete request.file;
    return request;
  }

  #fastEvent(payload: JsonObject, view: RequestView, locale: string): stt.SpeechEvent {
    const result = isObject(payload.result) ? payload.result : {};
    const segments = Array.isArray(result.segments) ? (result.segments as JsonObject[]) : [];
    let text = _cleanTranscript(result.text_display);
    const detected = result.language ?? segments.find((segment) => segment.language)?.language;
    let speakerId: string | null = null;
    let metadata: Record<string, unknown> | undefined;
    const polished = view.textPolishing ? polishedText(payload) : undefined;
    if (polished !== undefined) {
      metadata = { transcript: text };
      text = polished;
    }
    if (view.diarization) {
      const speakers = new Set(
        segments.map((segment) => segment.speaker).filter((speaker) => Boolean(speaker)),
      );
      if (speakers.size === 1) speakerId = String([...speakers][0]);
      else if (speakers.size > 1) {
        metadata = {
          ...metadata,
          speaker_segments: segments.map(({ speaker, text, start, end }) => ({
            speaker,
            text,
            start,
            end,
          })),
        };
      }
    }
    if (view.channelSeparation) {
      metadata = {
        ...metadata,
        channel_segments: segments.map(({ channel, text, start, end }) => ({
          channel,
          text,
          start,
          end,
        })),
      };
    }
    const words =
      view.wordTimeOffsets && polished === undefined
        ? segments.flatMap((segment) =>
            (Array.isArray(segment.words) ? segment.words : [])
              .filter((word: JsonObject) => 'start' in word && 'end' in word)
              .map((word: JsonObject) =>
                createTimedString({
                  text: String(word.word ?? ''),
                  startTime: Number(word.start),
                  endTime: Number(word.end),
                }),
              ),
          )
        : undefined;
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: typeof payload.request_id === 'string' ? payload.request_id : '',
      alternatives: [
        {
          language: reportedLanguage(detected, view.languageDetection, locale),
          text,
          startTime: Number(segments[0]?.start ?? 0),
          endTime: Number(segments.at(-1)?.end ?? 0),
          confidence: 0,
          speakerId,
          ...(words?.length ? { words } : {}),
          ...(metadata ? { metadata } : {}),
        },
      ],
    };
  }
}

/** A Zoom Scribe Live streaming session. */
export class SpeechStream extends stt.SpeechStream {
  #zoom: STT;
  #opts: ResolvedOptions;
  #connOptions: APIConnectOptions;
  #logger = log();
  #onClose: () => void;
  #released = false;
  #finished = deferred();
  #reconnect?: ReturnType<typeof deferred>;
  #audioDuration = 0;
  #speechStarted = false;
  #trackingId?: string;
  #sessionUpdated = false;
  #sessionOffset = 0;
  #sessionStartTime = Date.now();
  #view: RequestView;
  label = 'zoom.SpeechStream';

  constructor(
    zoom: STT,
    options: ResolvedOptions,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    onClose: () => void = () => {},
  ) {
    super(zoom, SAMPLE_RATE, connOptions);
    this.#zoom = zoom;
    this.#opts = options;
    this.#connOptions = connOptions;
    this.#onClose = onClose;
    this.#view = requestView(this.#sessionUpdate());
  }

  /** Whether Scribe currently has an open speech turn. @internal */
  get _speechStarted(): boolean {
    return this.#speechStarted;
  }

  /** Offset accumulated across option-driven reconnects, in seconds. @internal */
  get _sessionOffset(): number {
    return this.#sessionOffset;
  }

  /** Wait until the stream's connection tasks have finished. @internal */
  _waitClosed(): Promise<void> {
    return this.#finished.promise;
  }

  updateOptions(options: { language?: string; silenceDurationMs?: number | null } = {}): void {
    if (options.language === undefined && options.silenceDurationMs === undefined) return;
    if (options.language !== undefined) this.#opts.language = toLocale(options.language);
    if (options.silenceDurationMs !== undefined) {
      this.#opts.silenceDurationMs = options.silenceDurationMs;
    }
    this.#reconnect?.resolve();
  }

  override close(): void {
    super.close();
    this.#release();
  }

  protected async run(): Promise<void> {
    try {
      this.#sessionOffset = 0;
      while (!this.abortSignal.aborted) {
        this.#endOpenUtterance();
        this.#reconnect = deferred();
        const connectedAt = Date.now();
        const ws = await this.#connect();
        const outcome = await this.#runSession(ws, this.#reconnect.promise);
        if (outcome !== 'reconnect') {
          this.#endOpenUtterance();
          return;
        }
        this.#sessionOffset += (Date.now() - connectedAt) / 1000;
      }
    } finally {
      this.#release();
      this.#finished.resolve();
    }
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#onClose();
  }

  async #connect(): Promise<WebSocket> {
    const requestId = trackingId();
    this.#trackingId = requestId;
    this.#sessionUpdated = false;
    const connectController = new AbortController();
    const signal = AbortSignal.any([connectController.signal, this.abortSignal]);
    const timeout = setTimeout(() => connectController.abort(), this.#connOptions.timeoutMs);
    let ws: WebSocket | undefined;
    let statusCode: number | undefined;
    try {
      ws = await Promise.race([
        Promise.resolve(
          this.#zoom._wsConnect(this.#opts.liveUrl, ['live-asr'], {
            headers: this.#zoom._headers(requestId),
            signal,
            timeoutMs: this.#connOptions.timeoutMs,
          }),
        ),
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new APITimeoutError({ message: 'Zoom Scribe Live connection timed out' })),
            { once: true },
          );
        }),
      ]);
      ws.once('unexpected-response', (_request, response) => {
        statusCode = response.statusCode;
      });
      if (ws.readyState !== WebSocket.OPEN) await waitForWebSocketOpen(ws, 'Zoom Scribe Live');
    } catch (error) {
      ws?.terminate();
      if (statusCode !== undefined) {
        throw new APIStatusError({
          message: `Zoom refused the connection (HTTP ${statusCode})`,
          options: { statusCode, requestId },
        });
      }
      if (error instanceof APITimeoutError) throw error;
      if (connectController.signal.aborted && !this.abortSignal.aborted) {
        throw new APITimeoutError({ message: 'Zoom Scribe Live connection timed out' });
      }
      throw new APIConnectionError({ message: 'failed to connect to Zoom Scribe Live' });
    } finally {
      clearTimeout(timeout);
    }
    if (!ws) throw new APIConnectionError({ message: 'failed to connect to Zoom Scribe Live' });
    const update = this.#sessionUpdate();
    this.#view = requestView(update);
    try {
      ws.send(JSON.stringify(update));
    } catch {
      ws.close();
      throw new APIConnectionError({
        message: 'failed to configure the Zoom Scribe Live session',
      });
    }
    this.#sessionStartTime = Date.now();
    return ws;
  }

  #sessionUpdate(): JsonObject {
    let update: JsonObject = {
      type: 'session.update',
      language: this.#opts.language,
      audio: { format: 'pcm16' },
    };
    const config = recognitionConfig(this.#opts);
    if (Object.keys(config).length) update.config = config;
    if (this.#opts.silenceDurationMs !== null) {
      update.turn_detection = { silence_duration_ms: this.#opts.silenceDurationMs };
    }
    if (this.#opts.textPolishing) update.outputs = { text_polishing: { enabled: true } };
    update = deepMerge(update, this.#opts.extraKwargs);
    update.type = 'session.update';
    update.audio = { ...(isObject(update.audio) ? update.audio : {}), format: 'pcm16' };
    const outputs = isObject(update.outputs) ? update.outputs : {};
    const polishing = isObject(outputs.text_polishing) ? outputs.text_polishing : undefined;
    if (polishing?.enabled) polishing.include_transcript = true;
    return update;
  }

  async #runSession(ws: WebSocket, reconnect: Promise<void>): Promise<'done' | 'reconnect'> {
    const attempt = new AbortController();
    const signal = AbortSignal.any([attempt.signal, this.abortSignal]);
    const socketDone = deferred();
    let closing = false;
    let closedConfirmed = false;
    let lastAudioAt = Date.now();
    let lastInputAt = Date.now();
    let gapFilled = false;
    let anchored = false;
    let sessionAudioDuration = 0;
    const stopHeartbeat = startWebSocketHeartbeat(ws);

    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let event: JsonObject;
      try {
        event = JSON.parse(data.toString()) as JsonObject;
      } catch {
        this.#logger.warn('ignoring non-JSON message from Zoom Scribe');
        return;
      }
      try {
        if (event.type === 'session.closed' && !closing) {
          socketDone.reject(
            new APIStatusError({
              message: `Zoom Scribe Live session.closed (${String(event.reason)})`,
              options: {
                statusCode: -1,
                requestId: this.#trackingId,
                body: event,
                retryable: true,
              },
            }),
          );
          return;
        }
        if (this.#processEvent(event)) {
          closedConfirmed = true;
          socketDone.resolve();
        }
      } catch (error) {
        if (error instanceof APIStatusError) socketDone.reject(error);
        else {
          this.#logger.error(
            { error, 'lk.pii.message': event },
            'failed to process Zoom Scribe message',
          );
        }
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      if (closing || this.abortSignal.aborted) socketDone.resolve();
      else {
        socketDone.reject(
          new APIStatusError({
            message: 'Zoom Scribe Live connection closed unexpectedly',
            options: {
              statusCode: code || -1,
              requestId: this.#trackingId,
              body: reason.toString(),
            },
          }),
        );
      }
    };
    const onError = () => {
      if (!closing) {
        socketDone.reject(
          new APIConnectionError({
            message: 'Zoom Scribe Live connection closed unexpectedly',
          }),
        );
      }
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', onError);

    const send = async () => {
      while (!signal.aborted) {
        const result = await this.input.next({ signal });
        if (result.done) break;
        const frame = result.value;
        if (frame === SpeechStream.FLUSH_SENTINEL || frame.samplesPerChannel === 0) continue;
        if (frame.channels !== 1 || frame.sampleRate !== SAMPLE_RATE) {
          throw new Error('Zoom Scribe Live requires 16 kHz mono PCM16 audio');
        }
        const bytes = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        ws.send(bytes);
        this.#audioDuration += frame.samplesPerChannel / frame.sampleRate;
        sessionAudioDuration += frame.samplesPerChannel / frame.sampleRate;
        const capturedAt = Date.now() - sessionAudioDuration * 1000;
        if (!anchored || capturedAt < this.#sessionStartTime) {
          this.#sessionStartTime = capturedAt;
          anchored = true;
        }
        lastAudioAt = lastInputAt = Date.now();
        gapFilled = false;
      }
      if (signal.aborted) return;
      closing = true;
      ws.send(JSON.stringify({ type: 'session.close' }));
      await Promise.race([
        socketDone.promise,
        new Promise<void>((resolve) => setTimeout(resolve, this.#connOptions.timeoutMs)),
      ]);
      if (!closedConfirmed)
        this.#logger.warn('Zoom Scribe Live did not confirm session.close; closing');
    };

    const keepalive = async () => {
      while (!signal.aborted && !closing) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(INPUT_GAP_MS / 2, 500)));
        if (signal.aborted || closing) return;
        const now = Date.now();
        let silence: Buffer | undefined;
        if (this.#speechStarted && !gapFilled && now - lastInputAt >= INPUT_GAP_MS) {
          const durationMs = (this.#view.silenceDurationMs || 1000) + 100;
          silence = Buffer.alloc(Math.floor((SAMPLE_RATE * 2 * durationMs) / 1000));
          gapFilled = true;
        } else if (now - lastAudioAt >= KEEPALIVE_INTERVAL_MS) {
          silence = Buffer.alloc((SAMPLE_RATE * 2) / 10);
        }
        if (silence) {
          ws.send(silence);
          this.#audioDuration += silence.length / (2 * SAMPLE_RATE);
          sessionAudioDuration += silence.length / (2 * SAMPLE_RATE);
          lastAudioAt = now;
        }
      }
    };

    const sendPromise = send();
    const keepalivePromise = keepalive();
    const reconnectRequested = reconnect.then(async () => {
      if (this.#speechStarted) {
        await Promise.race([
          new Promise<void>((resolve) => {
            const poll = setInterval(() => {
              if (!this.#speechStarted || signal.aborted) {
                clearInterval(poll);
                resolve();
              }
            }, 50);
          }),
          new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_HOLD_MS)),
        ]);
      }
      return 'reconnect' as const;
    });

    try {
      const outcome = await Promise.race([
        sendPromise.then(() => 'done' as const),
        socketDone.promise.then(() => 'done' as const),
        reconnectRequested,
        waitForAbort(this.abortSignal).then(() => 'done' as const),
      ]);
      return outcome;
    } finally {
      closing = true;
      attempt.abort();
      stopHeartbeat();
      socketDone.resolve();
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await Promise.allSettled([sendPromise, keepalivePromise, socketDone.promise]);
    }
  }

  #processEvent(event: JsonObject): boolean {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        if (!this.#speechStarted) {
          this.#speechStarted = true;
          const startMs =
            typeof event.audio_start_ms === 'number' ? event.audio_start_ms : undefined;
          this.queue.put({
            type: stt.SpeechEventType.START_OF_SPEECH,
            ...(startMs !== undefined ? { speechStartTime: this.#sessionStartTime + startMs } : {}),
          });
        }
        break;
      case 'transcription.completed':
        this.#processCompleted(event);
        break;
      case 'session.updated':
        this.#sessionUpdated = true;
        if (this.#view.diarization && event.diarization_enabled === false) {
          this.#logger.warn("Zoom Scribe Live can't label speakers for this session");
        }
        break;
      case 'error': {
        const error = isObject(event.error) ? event.error : {};
        if (error.fatal) {
          throw new APIStatusError({
            message: `Zoom Scribe Live error ${String(error.code)}: ${String(error.message)}`,
            options: {
              statusCode: -1,
              requestId: this.#trackingId,
              body: error,
              retryable: this.#sessionUpdated,
            },
          });
        }
        this.#logger
          .child({ 'lk.pii.message': error.message })
          .warn(
            `Zoom Scribe Live error ${String(error.code)} (non-fatal, tracking_id=${this.#trackingId})`,
          );
        break;
      }
      case 'session.closed':
        this.#reportUsage();
        return true;
    }
    return false;
  }

  #processCompleted(event: JsonObject): void {
    let text = _cleanTranscript(event.transcript);
    const startMs = Number(event.audio_start_ms ?? 0);
    const endMs = Number(event.audio_end_ms ?? 0);
    let speakerId: string | null = null;
    let metadata: Record<string, unknown> | undefined;
    if (this.#view.textPolishing) {
      const polished = polishedText(event);
      if (polished !== undefined) {
        metadata = { transcript: text };
        text = polished;
      }
    }
    if (this.#view.diarization) {
      const spans = Array.isArray(event.speaker_segments) ? event.speaker_segments : [];
      if (spans.length) metadata = { ...metadata, speaker_segments: spans };
      else speakerId = typeof event.speaker === 'string' && event.speaker ? event.speaker : null;
    }
    if (text && !this.#speechStarted) {
      this.#speechStarted = true;
      this.queue.put({
        type: stt.SpeechEventType.START_OF_SPEECH,
        ...('audio_start_ms' in event ? { speechStartTime: this.#sessionStartTime + startMs } : {}),
      });
    }
    const speechEndTime = this.#speechEndTime(endMs);
    if (text) {
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId: typeof event.item_id === 'string' ? event.item_id : '',
        alternatives: [
          {
            language: reportedLanguage(
              event.language,
              this.#view.languageDetection,
              this.#opts.language,
            ),
            text,
            startTime: startMs / 1000 + this.startTimeOffset + this.#sessionOffset,
            endTime: endMs / 1000 + this.startTimeOffset + this.#sessionOffset,
            confidence: 0,
            speakerId,
            ...(metadata ? { metadata } : {}),
          },
        ],
        ...(speechEndTime !== undefined ? { speechEndTime } : {}),
      });
    }
    if (this.#speechStarted) {
      this.#speechStarted = false;
      this.queue.put({
        type: stt.SpeechEventType.END_OF_SPEECH,
        ...(speechEndTime !== undefined ? { speechEndTime } : {}),
      });
    }
    this.#reportUsage();
  }

  /** Wall-clock speech end time in milliseconds. @internal */
  _speechEndTime(endMs: number): number | undefined {
    return this.#speechEndTime(endMs);
  }

  #speechEndTime(endMs: number): number | undefined {
    if (!endMs) return;
    return this.#sessionStartTime + Math.max(0, endMs - (this.#view.silenceDurationMs ?? 0));
  }

  #endOpenUtterance(): void {
    if (!this.#speechStarted) return;
    this.#speechStarted = false;
    if (!this.queue.closed) this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
  }

  #reportUsage(): void {
    if (this.#audioDuration <= 0 || this.queue.closed) return;
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      recognitionUsage: { audioDuration: this.#audioDuration },
    });
    this.#audioDuration = 0;
  }
}
