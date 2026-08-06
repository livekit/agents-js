// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  Event as AsyncEvent,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  type VAD,
  VADEventType,
  type VADStream,
  getBaseLanguage,
  inference,
  mergeFrames,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import { type MessageEvent, WebSocket } from 'ws';
import { z } from 'zod';
import type { GroqAudioModels, STTModels } from './models.js';
import type * as api_proto from './realtime/api_proto.js';

const REALTIME_SAMPLE_RATE = 24000;
const REALTIME_NUM_CHANNELS = 1;
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-whisper';
const REALTIME_ONLY_MODELS = ['gpt-realtime-whisper', 'gpt-live-transcribe'];
const CONTEXT_HINT_MODELS = ['gpt-transcribe', 'gpt-live-transcribe'];

/**
 * Build the realtime transcription WebSocket URL.
 *
 * For OpenAI-compatible gateways (LiteLLM, Cloudflare AI Gateway, etc.) the
 * model is included on the upgrade URL so the gateway can route by model
 * before the subsequent `session.update` frame arrives. OpenAI's own
 * `wss://api.openai.com/.../realtime` endpoint, on the other hand, treats a
 * `?model=` query param as selecting a conversation session and rejects the
 * subsequent transcription-mode `session.update` with
 * `error.invalid_request_error.invalid_model`, so the model is intentionally
 * omitted for native OpenAI connections — the model is conveyed via
 * `session.update → audio.input.transcription.model` instead.
 *
 * The scheme of `baseURL` is respected: `http://` maps to `ws://`
 * and `https://` maps to `wss://`.
 *
 * @internal
 */
export function buildRealtimeSttUrl(baseURL: string | undefined, model: string): string {
  const url = new URL(baseURL || 'https://api.openai.com/v1');
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }

  const path = url.pathname.replace(/\/$/, '');
  if (!path || path === '/v1') {
    url.pathname = `${path}/realtime`;
  } else if (!path.endsWith('/realtime')) {
    url.pathname = `${path}/realtime`;
  }

  url.searchParams.set('intent', 'transcription');
  if (url.hostname !== 'api.openai.com') {
    url.searchParams.set('model', model);
  }
  return url.toString();
}

const DEFAULT_REALTIME_TURN_DETECTION: api_proto.TurnDetectionType = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 600,
  silence_duration_ms: 350,
};
const REALTIME_MODELS_WITHOUT_SERVER_TURN_DETECTION = new Set(REALTIME_ONLY_MODELS);

function isRealtimeOnly(model: string): boolean {
  return REALTIME_ONLY_MODELS.some((candidate) => model.startsWith(candidate));
}

function supportsContextHints(model: string): boolean {
  return CONTEXT_HINT_MODELS.some((candidate) => model.startsWith(candidate));
}

function asLanguages(language: string | string[]): string[] {
  return (typeof language === 'string' ? [language] : language).filter(Boolean);
}

function normalizedLanguages(languages: string[]): string[] {
  return [...new Set(languages.map(getBaseLanguage))];
}

function transcriptLanguage(languages: string[]): ReturnType<typeof normalizeLanguage> {
  return normalizeLanguage(languages.length === 1 ? languages[0]! : '');
}

function validateContext(model: string, languages: string[], keywords: string[]): void {
  if (supportsContextHints(model)) return;
  const supported = CONTEXT_HINT_MODELS.join(' and ');
  if (keywords.length > 0) {
    throw new Error(`keywords are only supported by ${supported}, not ${model}`);
  }
  if (languages.length > 1) {
    throw new Error(`${model} accepts a single language; only ${supported} accept a list`);
  }
}

export function buildRealtimeTranscriptionConfig(options: {
  model: string;
  languages: string[];
  keywords?: string[];
  prompt?: string;
}): api_proto.InputAudioTranscription {
  const supportsHints = supportsContextHints(options.model);
  const languages = normalizedLanguages(options.languages);
  return {
    model: options.model,
    prompt: options.prompt ?? '',
    ...(supportsHints
      ? {
          keywords: options.keywords ?? [],
          ...(languages.length > 0 ? { languages } : {}),
        }
      : languages.length > 0
        ? { language: languages[0] }
        : {}),
  };
}

const realtimeTranscriptionSpeechStartedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_started'),
  item_id: z.string().optional(),
  audio_start_ms: z.number().optional(),
});

const realtimeTranscriptionSpeechStoppedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_stopped'),
  item_id: z.string().optional(),
  audio_end_ms: z.number().optional(),
});

const realtimeTranscriptionDeltaEventSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.delta'),
  item_id: z.string().optional(),
  delta: z.string().optional(),
});

const realtimeTranscriptionCompletedEventSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.completed'),
  item_id: z.string().optional(),
  transcript: z.string().optional(),
  languages: z.array(z.object({ code: z.string() })).optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

const realtimeTranscriptionErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z
    .object({
      message: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const knownRealtimeTranscriptionServerEventSchema = z.discriminatedUnion('type', [
  realtimeTranscriptionSpeechStartedEventSchema,
  realtimeTranscriptionSpeechStoppedEventSchema,
  realtimeTranscriptionDeltaEventSchema,
  realtimeTranscriptionCompletedEventSchema,
  realtimeTranscriptionErrorEventSchema,
]);

const knownRealtimeTranscriptionServerEventTypes = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'error',
]);

const unknownRealtimeTranscriptionServerEventSchema = z
  .object({
    type: z.string().refine((type) => !knownRealtimeTranscriptionServerEventTypes.has(type)),
  })
  .passthrough();

type RealtimeTranscriptionKnownServerEvent = z.infer<
  typeof knownRealtimeTranscriptionServerEventSchema
>;

type RealtimeTranscriptionUnknownServerEvent = {
  type: 'unknown';
  event: z.infer<typeof unknownRealtimeTranscriptionServerEventSchema>;
};

type RealtimeTranscriptionServerEvent =
  | RealtimeTranscriptionKnownServerEvent
  | RealtimeTranscriptionUnknownServerEvent;

function parseRealtimeTranscriptionServerEvent(data: string): RealtimeTranscriptionServerEvent {
  const event = JSON.parse(data) as unknown;
  const knownEvent = knownRealtimeTranscriptionServerEventSchema.safeParse(event);
  if (knownEvent.success) {
    return knownEvent.data;
  }
  return {
    type: 'unknown',
    event: unknownRealtimeTranscriptionServerEventSchema.parse(event),
  };
}

export async function _loadRealtimeVad(vad?: VAD): Promise<VAD> {
  if (vad) return vad;

  throw new Error(
    'OpenAI realtime STT models without server-side endpointing must provide a VAD via the ' +
      '`vad` option.',
  );
}

export function _requiresRealtimeVad(
  model: string,
  turnDetection: api_proto.TurnDetectionType | null | undefined,
): boolean {
  return turnDetection === null || REALTIME_MODELS_WITHOUT_SERVER_TURN_DETECTION.has(model);
}

export function _normalizeRealtimeTurnDetection(
  model: string,
  turnDetection: SessionTurnDetection | null | undefined,
): api_proto.TurnDetectionType | null | undefined {
  if (turnDetection !== null && REALTIME_MODELS_WITHOUT_SERVER_TURN_DETECTION.has(model)) {
    console.warn(
      `Turn detection is not supported for ${model}; ignoring the provided turnDetection and ` +
        'using plugin-side VAD commits instead.',
    );
    return null;
  }
  return turnDetection
    ? ({ type: 'server_vad', ...turnDetection } as api_proto.TurnDetectionType)
    : turnDetection;
}

export function _validateRealtimeVad(
  model: string,
  turnDetection: api_proto.TurnDetectionType | null | undefined,
  vad: VAD | undefined,
): void {
  if (_requiresRealtimeVad(model, turnDetection) && !vad) {
    throw new Error(
      `A VAD instance is required for ${model}. Pass a VAD via the \`vad\` option so the ` +
        'plugin can commit audio at end-of-speech.',
    );
  }
}

export interface STTOptions {
  apiKey?: string;
  language: string | string[];
  prompt?: string;
  /** Literal terms expected in the audio. Supported by gpt-transcribe and gpt-live-transcribe. */
  keywords?: string[];
  detectLanguage: boolean;
  model: STTModels | string;
  baseURL?: string;
  client?: OpenAI;
  useRealtime: boolean;
  turnDetection?: SessionTurnDetection | null;
  noiseReductionType?: api_proto.NoiseReductionType;
  /** Pass null to opt out of the default client VAD and commit audio manually. */
  vad?: VAD | null;
  temperature?: number;
}

export type SessionTurnDetection =
  | (Omit<Extract<api_proto.TurnDetectionType, { type: 'server_vad' }>, 'type'> & {
      type?: 'server_vad';
    })
  | Extract<api_proto.TurnDetectionType, { type: 'semantic_vad' }>;

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.OPENAI_API_KEY,
  language: 'en',
  detectLanguage: false,
  model: DEFAULT_REALTIME_MODEL,
  useRealtime: true,
};

type ResolvedSTTOptions = Omit<STTOptions, 'apiKey' | 'language' | 'keywords' | 'turnDetection'> & {
  apiKey: string;
  languages: string[];
  keywords: string[];
  turnDetection?: api_proto.TurnDetectionType | null;
};

export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  #client: OpenAI;
  #streams = new Set<SpeechStream>();
  #specifiedLanguages: string[];
  #userKeywords: string[];
  #sessionKeyterms: string[] = [];
  #vadOptedOut: boolean;
  label = 'openai.STT';

  get model(): string {
    return this.#opts.model;
  }

  get turnDetection(): api_proto.TurnDetectionType | null | undefined {
    return this.#opts.turnDetection;
  }

  get provider(): string {
    try {
      const url = new URL(this.#client.baseURL);
      return url.host;
    } catch {
      return 'api.openai.com';
    }
  }

  /**
   * Create a new instance of OpenAI STT.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environment variable.
   */
  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    const useRealtime =
      opts.useRealtime ?? (opts.model ? isRealtimeOnly(opts.model) : defaultSTTOptions.useRealtime);
    const model = opts.model ?? (useRealtime ? DEFAULT_REALTIME_MODEL : 'whisper-1');
    super({
      streaming: useRealtime,
      interimResults: useRealtime,
      alignedTranscript: false,
      keyterms: supportsContextHints(model),
    });

    const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
    if (apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    const turnDetection = _normalizeRealtimeTurnDetection(
      model,
      opts.turnDetection !== undefined
        ? opts.turnDetection
        : isRealtimeOnly(model)
          ? null
          : DEFAULT_REALTIME_TURN_DETECTION,
    );
    let resolvedVad = opts.vad;
    this.#vadOptedOut = opts.vad === null;
    if (useRealtime && isRealtimeOnly(model) && opts.vad === undefined) {
      resolvedVad = new inference.VAD();
    }
    if (useRealtime && !this.#vadOptedOut) {
      _validateRealtimeVad(model, turnDetection, resolvedVad ?? undefined);
    }

    this.#specifiedLanguages = asLanguages(opts.language ?? defaultSTTOptions.language);
    const languages = opts.detectLanguage ? [] : this.#specifiedLanguages;
    const keywords = [...(opts.keywords ?? [])];
    validateContext(model, languages, keywords);
    this.#userKeywords = keywords;

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey,
      languages,
      keywords,
      model,
      useRealtime,
      turnDetection,
      vad: resolvedVad,
    };

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: this.#opts.baseURL,
        maxRetries: 0,
        apiKey: this.#opts.apiKey,
      });
  }

  /**
   * Create a new instance of Groq STT.
   *
   * @remarks
   * `apiKey` must be set to your Groq API key, either using the argument or by setting the
   * `GROQ_API_KEY` environment variable.
   */
  static withGroq(
    opts: Partial<{
      model: string | GroqAudioModels;
      apiKey?: string;
      baseURL?: string;
      client: OpenAI;
      language: string | string[];
      detectLanguage: boolean;
    }> = {},
  ): STT {
    opts.apiKey = opts.apiKey || process.env.GROQ_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('Groq API key is required, whether as an argument or as $GROQ_API_KEY');
    }

    return new STT({
      model: 'whisper-large-v3-turbo',
      baseURL: 'https://api.groq.com/openai/v1',
      ...opts,
      useRealtime: false,
    });
  }

  /**
   * Create a new instance of OVHcloud AI Endpoints STT.
   *
   * @remarks
   * `apiKey` must be set to your OVHcloud AI Endpoints API key, either using the argument or by setting the
   * `OVHCLOUD_API_KEY` environment variable.
   */
  static withOVHcloud(
    opts: Partial<{
      model: string;
      apiKey?: string;
      baseURL?: string;
      client: OpenAI;
      language: string | string[];
      detectLanguage: boolean;
    }> = {},
  ): STT {
    opts.apiKey = opts.apiKey || process.env.OVHCLOUD_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'OVHcloud AI Endpoints API key is required, whether as an argument or as $OVHCLOUD_API_KEY',
      );
    }

    return new STT({
      model: 'whisper-large-v3-turbo',
      baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
      ...opts,
      useRealtime: false,
    });
  }

  #createWav(frame: AudioFrame): Buffer {
    const bitsPerSample = 16;
    const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
    const blockAlign = (frame.channels * bitsPerSample) / 8;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + frame.data.byteLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(frame.channels, 22);
    header.writeUInt32LE(frame.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(frame.data.byteLength, 40);
    return Buffer.concat([header, Buffer.from(frame.data.buffer)]);
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const config = this.#opts;
    buffer = mergeFrames(buffer);
    const wavBuffer = this.#createWav(buffer);
    const file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' });

    const contextHints = supportsContextHints(config.model);
    const languages = normalizedLanguages(config.languages);
    const transcriptionParams = {
      file,
      model: config.model,
      ...(contextHints
        ? { languages: languages.length > 0 ? languages : undefined, keywords: config.keywords }
        : { language: languages[0] }),
      prompt: config.prompt,
      response_format: 'json' as const,
      temperature: config.temperature,
    };
    const resp = (await this.#client.audio.transcriptions.create(transcriptionParams as never, {
      signal: abortSignal,
    })) as { text: string; languages?: { code: string }[] };

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: resp.text || '',
          language: resp.languages?.[0]?.code
            ? normalizeLanguage(resp.languages[0].code)
            : transcriptLanguage(config.languages),
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    };
  }

  updateOptions(opts: Partial<STTOptions>): void {
    const useRealtime = opts.useRealtime ?? this.#opts.useRealtime;
    const model = opts.model ?? this.#opts.model;
    const languages =
      opts.language !== undefined
        ? asLanguages(opts.language)
        : opts.detectLanguage
          ? []
          : opts.detectLanguage === false && this.#opts.languages.length === 0
            ? (console.warn(
                `detectLanguage: false names no language; falling back to ${this.#specifiedLanguages.join(', ')}`,
              ),
              this.#specifiedLanguages)
            : this.#opts.languages;
    const userKeywords = opts.keywords !== undefined ? [...opts.keywords] : this.#userKeywords;
    validateContext(model, languages, userKeywords);
    if (opts.language === undefined) {
      for (const stream of this.#streams) {
        validateContext(model, stream.languages, userKeywords);
      }
    }
    if (opts.model !== undefined && isRealtimeOnly(opts.model)) {
      if (!this.capabilities.streaming) {
        throw new Error(
          `${model} is served only over the realtime API, and this STT was created for the ` +
            'transcriptions endpoint; pass useRealtime: true to the constructor to reach it',
        );
      }
      if (!this.#opts.vad && !this.#vadOptedOut) {
        throw new Error(
          `${model} has no server-side endpointing, so it needs a vad to commit the audio buffer`,
        );
      }
    }
    const turnDetection = _normalizeRealtimeTurnDetection(
      model,
      opts.turnDetection !== undefined
        ? opts.turnDetection
        : isRealtimeOnly(model)
          ? null
          : opts.model !== undefined && isRealtimeOnly(this.#opts.model)
            ? DEFAULT_REALTIME_TURN_DETECTION
            : this.#opts.turnDetection,
    );
    if (useRealtime && !this.#vadOptedOut) {
      _validateRealtimeVad(model, turnDetection, opts.vad ?? this.#opts.vad ?? undefined);
    }
    const languagesChanged =
      languages.some((value, index) => value !== this.#opts.languages[index]) ||
      languages.length !== this.#opts.languages.length;
    const languageGiven = opts.language !== undefined || languagesChanged;
    if (languages.length > 0) this.#specifiedLanguages = languages;
    this.#userKeywords = userKeywords;
    const keywords = supportsContextHints(model)
      ? [...new Set([...userKeywords, ...this.#sessionKeyterms])]
      : [];
    this.#opts = {
      ...this.#opts,
      ...opts,
      apiKey: opts.apiKey ?? this.#opts.apiKey,
      languages,
      keywords,
      model,
      useRealtime,
      turnDetection,
    };
    this.updateCapabilities({
      streaming: useRealtime,
      interimResults: useRealtime,
      keyterms: supportsContextHints(model),
    });
    for (const stream of this.#streams) {
      if (stream.isClosed) {
        this.#streams.delete(stream);
        continue;
      }
      stream._updateOptions(this.#opts, languageGiven ? languages : undefined);
    }
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    if (!this.capabilities.keyterms) {
      super._updateSessionKeyterms(keyterms);
      return;
    }
    if (
      keyterms.length === this.#sessionKeyterms.length &&
      keyterms.every((term, index) => term === this.#sessionKeyterms[index])
    ) {
      return;
    }
    this.#sessionKeyterms = [...keyterms];
    this.#opts.keywords = [...new Set([...this.#userKeywords, ...keyterms])];
    for (const stream of this.#streams) stream._updateOptions(this.#opts);
  }

  stream(
    options: { connOptions?: APIConnectOptions; language?: string | string[] } = {},
  ): stt.SpeechStream {
    if (!this.#opts.useRealtime) {
      throw new Error('Streaming is not supported on OpenAI STT unless useRealtime is enabled');
    }

    const streamOptions = {
      ...this.#opts,
      languages:
        options.language !== undefined ? asLanguages(options.language) : [...this.#opts.languages],
      keywords: [...this.#opts.keywords],
    };
    validateContext(streamOptions.model, streamOptions.languages, streamOptions.keywords);
    const stream = new SpeechStream(
      this,
      streamOptions,
      options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      () => this.#streams.delete(stream),
    );
    this.#streams.add(stream);
    return stream;
  }

  override async close(): Promise<void> {
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();
  }
}

export class SpeechStream extends stt.SpeechStream {
  label = 'openai.SpeechStream';
  #options: ResolvedSTTOptions;
  #onClose: () => void;
  #targetTranscript = '';
  #currentItemId = '';
  #itemAudioTiming = new Map<string, { startMs?: number; endMs?: number }>();
  #speaking = false;
  #ws?: WebSocket;
  #wsReady = new AsyncEvent();
  #vadStream?: VADStream;
  #reconnectRequested = false;

  constructor(
    stt: STT,
    options: ResolvedSTTOptions,
    connOptions?: APIConnectOptions,
    onClose: () => void = () => {},
  ) {
    super(stt, REALTIME_SAMPLE_RATE, connOptions);
    this.#options = options;
    this.#onClose = onClose;
  }

  get languages(): string[] {
    return this.#options.languages;
  }

  updateOptions(options: { language?: string | string[] }): void {
    const languages =
      options.language !== undefined ? asLanguages(options.language) : this.#options.languages;
    validateContext(this.#options.model, languages, this.#options.keywords);
    this.#applyOptions(this.#options, languages);
  }

  /** @internal */
  _updateOptions(options: ResolvedSTTOptions, languages?: string[]): void {
    this.#applyOptions(options, languages ?? this.#options.languages);
  }

  #applyOptions(options: ResolvedSTTOptions, languages: string[]): void {
    const previous = this.#options;
    this.#options = {
      ...options,
      languages: [...languages],
      keywords: [...options.keywords],
    };
    const modelChanged = previous.model !== this.#options.model;
    const clearedLanguage = previous.languages.length > 0 && this.#options.languages.length === 0;
    if (!this.#ws) return;
    if (modelChanged || clearedLanguage) {
      this.#reconnectRequested = true;
      this.#ws.close();
      return;
    }
    try {
      this.#ws.send(JSON.stringify(this.#sessionUpdateEvent()));
    } catch (error) {
      console.warn('failed to update the OpenAI transcription session', error);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  override close(): void {
    super.close();
    this.#onClose();
  }

  protected async run(): Promise<void> {
    // Avoid fusing an open segment into the next connection attempt after a retry.
    this.#emitEndOfSpeech();
    const inputTask = this.#forwardInput();
    try {
      while (!this.abortSignal.aborted) {
        const vad = _requiresRealtimeVad(this.#options.model, this.#options.turnDetection)
          ? this.#options.vad
            ? await _loadRealtimeVad(this.#options.vad)
            : undefined
          : undefined;
        const vadStream = vad?.stream();
        const ws = await this.#connect();
        this.#ws = ws;
        this.#vadStream = vadStream;
        this.#wsReady.set();
        const abort = () => {
          if (ws.readyState < WebSocket.CLOSING) ws.close();
        };
        this.abortSignal.addEventListener('abort', abort, { once: true });

        try {
          ws.send(JSON.stringify(this.#sessionUpdateEvent()));
          const connectionTasks: Promise<void>[] = [this.#forwardEvents(ws, Boolean(vadStream))];
          if (vadStream) connectionTasks.push(this.#forwardVadEvents(ws, vadStream));
          await Promise.race([inputTask, ...connectionTasks]);
        } finally {
          this.#ws = undefined;
          this.#vadStream = undefined;
          this.#wsReady.clear();
          this.abortSignal.removeEventListener('abort', abort);
          vadStream?.close();
          if (ws.readyState < WebSocket.CLOSING) ws.close();
        }

        if (!this.#reconnectRequested) return;
        this.#reconnectRequested = false;
        this.#emitEndOfSpeech();
      }
    } finally {
      this.#onClose();
    }
  }

  async #connect(): Promise<WebSocket> {
    const ws = new WebSocket(this.#realtimeUrl(), {
      headers: {
        Authorization: `Bearer ${this.#options.apiKey}`,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (error) => reject(new Error(error.message));
    });

    return ws;
  }

  #realtimeUrl(): string {
    return buildRealtimeSttUrl(this.#options.baseURL, this.#options.model);
  }

  #sessionUpdateEvent(): api_proto.SessionUpdateEvent {
    const transcription = buildRealtimeTranscriptionConfig(this.#options);

    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: REALTIME_SAMPLE_RATE,
            },
            transcription,
            ...(!isRealtimeOnly(this.#options.model)
              ? { turn_detection: this.#options.turnDetection }
              : {}),
            ...(this.#options.noiseReductionType
              ? { noise_reduction: { type: this.#options.noiseReductionType } }
              : {}),
          },
        },
      },
    };
  }

  async #forwardInput(): Promise<void> {
    const audioStream = new AudioByteStream(
      REALTIME_SAMPLE_RATE,
      REALTIME_NUM_CHANNELS,
      REALTIME_SAMPLE_RATE / 20,
    );

    for await (const item of this.input) {
      while (!this.#ws && !this.abortSignal.aborted) await this.#wsReady.wait();
      const ws = this.#ws;
      if (!ws) return;
      const vadStream = this.#vadStream;
      if (item === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of audioStream.flush()) {
          this.#sendAudioFrame(ws, frame);
        }
        if (isRealtimeOnly(this.#options.model) && !this.#options.vad) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
        continue;
      }

      vadStream?.pushFrame(item);
      for (const frame of audioStream.write(item.data.buffer as ArrayBuffer)) {
        this.#sendAudioFrame(ws, frame);
      }
    }
    this.#vadStream?.endInput();
  }

  async #forwardVadEvents(ws: WebSocket, vadStream: VADStream): Promise<void> {
    for await (const event of vadStream) {
      if (event.type === VADEventType.START_OF_SPEECH) {
        this.#emitStartOfSpeech();
      } else if (event.type === VADEventType.END_OF_SPEECH) {
        this.#emitEndOfSpeech();
        if (isRealtimeOnly(this.#options.model)) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
      }
    }
  }

  async #forwardEvents(ws: WebSocket, hasClientVad: boolean): Promise<void> {
    for await (const data of this.#messages(ws)) {
      const event = parseRealtimeTranscriptionServerEvent(data);
      switch (event.type) {
        case 'input_audio_buffer.speech_started': {
          const itemId = event.item_id ?? '';
          this.#currentItemId = itemId;
          this.#itemAudioTiming.set(itemId, {
            startMs: event.audio_start_ms,
          });
          if (!hasClientVad) {
            this.#emitStartOfSpeech();
          }
          break;
        }
        case 'input_audio_buffer.speech_stopped': {
          const itemId = event.item_id ?? this.#currentItemId;
          const timing = this.#itemAudioTiming.get(itemId) ?? {};
          timing.endMs = event.audio_end_ms;
          this.#itemAudioTiming.set(itemId, timing);
          if (!hasClientVad) {
            this.#emitEndOfSpeech();
          }
          break;
        }
        case 'conversation.item.input_audio_transcription.delta':
          this.#currentItemId = event.item_id ?? this.#currentItemId;
          if (event.delta) {
            this.#targetTranscript += event.delta;
            this.queue.put(this.#speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT));
          }
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = event.item_id ?? this.#currentItemId;
          const transcript = event.transcript ?? '';
          if (transcript) {
            this.#targetTranscript = transcript;
            this.queue.put(
              this.#speechEvent(
                stt.SpeechEventType.FINAL_TRANSCRIPT,
                itemId,
                event.languages?.[0]?.code,
              ),
            );
          }
          this.#emitRecognitionUsage(event, itemId);
          this.#targetTranscript = '';
          this.#currentItemId = '';
          break;
        }
        case 'error': {
          throw new Error(event.error?.message || 'OpenAI realtime transcription error');
        }
      }
    }
  }

  async *#messages(ws: WebSocket): AsyncGenerator<string> {
    const queue: string[] = [];
    const messageEvent = new AsyncEvent();
    let closed = false;
    let error: Error | undefined;

    ws.onmessage = (message: MessageEvent) => {
      queue.push(
        typeof message.data === 'string'
          ? message.data
          : Buffer.from(message.data as ArrayBuffer).toString(),
      );
      messageEvent.set();
    };
    ws.onclose = () => {
      closed = true;
      messageEvent.set();
    };
    ws.onerror = (event) => {
      error = new Error(event.message);
      closed = true;
      messageEvent.set();
    };

    while (!closed || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }

      messageEvent.clear();
      if (closed || queue.length > 0) continue;
      await messageEvent.wait();
    }

    if (error) throw error;
  }

  #sendAudioFrame(ws: WebSocket, frame: AudioFrame): void {
    if (frame.data.byteLength === 0 || frame.samplesPerChannel === 0) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength,
        ).toString('base64'),
      }),
    );
  }

  #emitStartOfSpeech(): void {
    if (this.#speaking) return;
    this.#speaking = true;
    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
  }

  #emitEndOfSpeech(): void {
    if (!this.#speaking) return;
    this.#speaking = false;
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
  }

  #speechEvent(
    type: stt.SpeechEventType,
    requestId = this.#currentItemId,
    detectedLanguage?: string,
  ): stt.SpeechEvent {
    return {
      type,
      requestId,
      alternatives: [
        {
          text: this.#targetTranscript,
          language: detectedLanguage
            ? normalizeLanguage(detectedLanguage)
            : transcriptLanguage(this.#options.languages),
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ],
    };
  }

  #emitRecognitionUsage(
    event: z.infer<typeof realtimeTranscriptionCompletedEventSchema>,
    itemId: string,
  ): void {
    const timing = this.#itemAudioTiming.get(itemId);
    this.#itemAudioTiming.delete(itemId);
    const audioDuration =
      timing?.startMs !== undefined && timing.endMs !== undefined && timing.endMs > timing.startMs
        ? (timing.endMs - timing.startMs) / 1000
        : 0;
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: itemId,
      recognitionUsage: {
        audioDuration,
        inputTokens: event.usage?.input_tokens,
        outputTokens: event.usage?.output_tokens,
      },
    });
  }
}
