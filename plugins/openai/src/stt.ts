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
  mergeFrames,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import { type MessageEvent, WebSocket } from 'ws';
import { z } from 'zod';
import type { GroqAudioModels, WhisperModels } from './models.js';
import type * as api_proto from './realtime/api_proto.js';

const REALTIME_SAMPLE_RATE = 24000;
const REALTIME_NUM_CHANNELS = 1;
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-whisper';

/**
 * Build the realtime transcription WebSocket URL.
 *
 * Includes the model on the upgrade URL so OpenAI-compatible gateways
 * (which can only see the URL at the WebSocket upgrade, not the subsequent
 * `session.update` frame) can route by model. Mirrors the existing
 * convention in `realtime/realtime_model.ts` for the conversational
 * Realtime API. OpenAI's native endpoint accepts and ignores the
 * parameter, so this is a no-op for direct connections.
 *
 * Maps `http://` → `ws://` and `https://` → `wss://` so plain-HTTP
 * baseURLs (e.g. an in-cluster LiteLLM proxy) connect without a
 * spurious TLS handshake.
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
  url.searchParams.set('model', model);
  return url.toString();
}

const DEFAULT_REALTIME_TURN_DETECTION: api_proto.TurnDetectionType = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 600,
  silence_duration_ms: 350,
};
const REALTIME_MODELS_WITHOUT_SERVER_TURN_DETECTION = new Set([DEFAULT_REALTIME_MODEL]);

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
  turnDetection: api_proto.TurnDetectionType | null | undefined,
): api_proto.TurnDetectionType | null | undefined {
  if (turnDetection !== null && REALTIME_MODELS_WITHOUT_SERVER_TURN_DETECTION.has(model)) {
    console.warn(
      `Turn detection is not supported for ${model}; ignoring the provided turnDetection and ` +
        'using plugin-side VAD commits instead.',
    );
    return null;
  }
  return turnDetection;
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
  language: string;
  prompt?: string;
  detectLanguage: boolean;
  model: WhisperModels | string;
  baseURL?: string;
  client?: OpenAI;
  useRealtime: boolean;
  turnDetection?: api_proto.TurnDetectionType | null;
  noiseReductionType?: api_proto.NoiseReductionType;
  vad?: VAD;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.OPENAI_API_KEY,
  language: 'en',
  detectLanguage: false,
  model: DEFAULT_REALTIME_MODEL,
  useRealtime: true,
};

type ResolvedSTTOptions = Omit<STTOptions, 'apiKey'> & { apiKey: string };

export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  #client: OpenAI;
  #streams = new Set<SpeechStream>();
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
    const useRealtime = opts.useRealtime ?? defaultSTTOptions.useRealtime;
    const model = opts.model ?? (useRealtime ? DEFAULT_REALTIME_MODEL : 'whisper-1');
    super({
      streaming: useRealtime,
      interimResults: useRealtime,
      alignedTranscript: false,
    });

    const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
    if (apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    const turnDetection = _normalizeRealtimeTurnDetection(
      model,
      opts.turnDetection !== undefined
        ? opts.turnDetection
        : model === DEFAULT_REALTIME_MODEL
          ? null
          : DEFAULT_REALTIME_TURN_DETECTION,
    );
    if (useRealtime) {
      _validateRealtimeVad(model, turnDetection, opts.vad);
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey,
      language: normalizeLanguage(opts.language ?? defaultSTTOptions.language),
      model,
      useRealtime,
      turnDetection,
    };

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: this.#opts.baseURL,
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
      language: string;
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
      language: string;
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

  #sanitizeOptions(language?: string): ResolvedSTTOptions {
    if (language) {
      return { ...this.#opts, language: normalizeLanguage(language) };
    } else {
      return this.#opts;
    }
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
    const config = this.#sanitizeOptions();
    buffer = mergeFrames(buffer);
    const wavBuffer = this.#createWav(buffer);
    const file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' });

    const resp = await this.#client.audio.transcriptions.create(
      {
        file,
        model: this.#opts.model,
        language: config.language,
        prompt: config.prompt,
        response_format: 'json',
      },
      {
        signal: abortSignal,
      },
    );

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: resp.text || '',
          language: normalizeLanguage(config.language || ''),
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
    const turnDetection = _normalizeRealtimeTurnDetection(
      model,
      opts.turnDetection !== undefined
        ? opts.turnDetection
        : opts.model === DEFAULT_REALTIME_MODEL
          ? null
          : this.#opts.turnDetection,
    );
    if (useRealtime) {
      _validateRealtimeVad(model, turnDetection, opts.vad ?? this.#opts.vad);
    }
    this.#opts = {
      ...this.#opts,
      ...opts,
      apiKey: opts.apiKey ?? this.#opts.apiKey,
      language: opts.language ? normalizeLanguage(opts.language) : this.#opts.language,
      model,
      useRealtime,
      turnDetection,
    };
    this.updateCapabilities({
      streaming: useRealtime,
      interimResults: useRealtime,
    });
    for (const stream of this.#streams) {
      if (stream.isClosed) {
        this.#streams.delete(stream);
        continue;
      }
      stream.updateOptions(this.#opts);
    }
  }

  stream(options: { connOptions?: APIConnectOptions } = {}): stt.SpeechStream {
    if (!this.#opts.useRealtime) {
      throw new Error('Streaming is not supported on OpenAI STT unless useRealtime is enabled');
    }

    const stream = new SpeechStream(
      this,
      { ...this.#opts },
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

  updateOptions(options: ResolvedSTTOptions): void {
    this.#options = { ...options };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  override close(): void {
    super.close();
    this.#onClose();
  }

  protected async run(): Promise<void> {
    _validateRealtimeVad(this.#options.model, this.#options.turnDetection, this.#options.vad);
    const vad = _requiresRealtimeVad(this.#options.model, this.#options.turnDetection)
      ? await _loadRealtimeVad(this.#options.vad)
      : undefined;

    if (vad) {
      this.#options.vad = vad;
    }

    const vadStream = vad?.stream();
    const ws = await this.#connect();
    const abort = () => {
      if (ws.readyState < WebSocket.CLOSING) {
        ws.close();
      }
    };
    this.abortSignal.addEventListener('abort', abort, { once: true });

    try {
      ws.send(JSON.stringify(this.#sessionUpdateEvent()));
      const tasks = [this.#forwardInput(ws, vadStream), this.#forwardEvents(ws)];
      if (vadStream) {
        tasks.push(this.#forwardVadEvents(ws, vadStream));
      }
      await Promise.all(tasks);
    } finally {
      this.abortSignal.removeEventListener('abort', abort);
      vadStream?.close();
      if (ws.readyState < WebSocket.CLOSING) {
        ws.close();
      }
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
    const transcription: api_proto.InputAudioTranscription = {
      model: this.#options.model,
      ...(this.#options.prompt ? { prompt: this.#options.prompt } : {}),
      ...(!this.#options.detectLanguage && this.#options.language
        ? { language: this.#options.language }
        : {}),
    };

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
            turn_detection: this.#options.turnDetection,
            ...(this.#options.noiseReductionType
              ? { noise_reduction: { type: this.#options.noiseReductionType } }
              : {}),
          },
        },
      },
    };
  }

  async #forwardInput(ws: WebSocket, vadStream?: VADStream): Promise<void> {
    const audioStream = new AudioByteStream(
      REALTIME_SAMPLE_RATE,
      REALTIME_NUM_CHANNELS,
      REALTIME_SAMPLE_RATE / 20,
    );

    for await (const item of this.input) {
      if (item === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of audioStream.flush()) {
          this.#sendAudioFrame(ws, frame);
        }
        if (this.#options.turnDetection === null) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
        continue;
      }

      vadStream?.pushFrame(item);
      for (const frame of audioStream.write(item.data.buffer as ArrayBuffer)) {
        this.#sendAudioFrame(ws, frame);
      }
    }
    vadStream?.endInput();
  }

  async #forwardVadEvents(ws: WebSocket, vadStream: VADStream): Promise<void> {
    for await (const event of vadStream) {
      if (event.type === VADEventType.START_OF_SPEECH) {
        this.#emitStartOfSpeech();
      } else if (
        event.type === VADEventType.END_OF_SPEECH &&
        this.#options.turnDetection === null
      ) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    }
  }

  async #forwardEvents(ws: WebSocket): Promise<void> {
    for await (const data of this.#messages(ws)) {
      const event = parseRealtimeTranscriptionServerEvent(data);
      switch (event.type) {
        case 'input_audio_buffer.speech_started': {
          const itemId = event.item_id ?? '';
          this.#currentItemId = itemId;
          this.#itemAudioTiming.set(itemId, {
            startMs: event.audio_start_ms,
          });
          this.#emitStartOfSpeech();
          break;
        }
        case 'input_audio_buffer.speech_stopped': {
          const itemId = event.item_id ?? this.#currentItemId;
          const timing = this.#itemAudioTiming.get(itemId) ?? {};
          timing.endMs = event.audio_end_ms;
          this.#itemAudioTiming.set(itemId, timing);
          break;
        }
        case 'conversation.item.input_audio_transcription.delta':
          this.#currentItemId = event.item_id ?? this.#currentItemId;
          if (event.delta) {
            this.#targetTranscript += event.delta;
            this.#emitStartOfSpeech();
            this.queue.put(this.#speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT));
          }
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = event.item_id ?? this.#currentItemId;
          const transcript = event.transcript ?? '';
          if (transcript) {
            this.#targetTranscript = transcript;
            this.#emitStartOfSpeech();
            this.queue.put(this.#speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, itemId));
          }
          this.#emitRecognitionUsage(event, itemId);
          this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
          this.#targetTranscript = '';
          this.#currentItemId = '';
          this.#speaking = false;
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

  #speechEvent(type: stt.SpeechEventType, requestId = this.#currentItemId): stt.SpeechEvent {
    return {
      type,
      requestId,
      alternatives: [
        {
          text: this.#targetTranscript,
          language: normalizeLanguage(this.#options.language || ''),
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
