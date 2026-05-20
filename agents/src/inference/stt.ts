// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { WebSocket } from 'ws';
import { APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { type LanguageCode, areLanguagesEquivalent, normalizeLanguage } from '../language.js';
import { log } from '../log.js';
import { createStreamChannel } from '../stream/stream_channel.js';
import {
  STT as BaseSTT,
  SpeechStream as BaseSpeechStream,
  type SpeechData,
  type SpeechEvent,
  SpeechEventType,
} from '../stt/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { type AudioBuffer, Event, Task, cancelAndWait, shortuuid, waitForAbort } from '../utils.js';
import { type VAD, VADEventType, type VADStream } from '../vad.js';
import { type TimedString, createTimedString } from '../voice/io.js';
import {
  type SttServerEvent,
  type SttTranscriptEvent,
  sttKnownServerEventSchema,
  sttServerEventSchema,
} from './api_protos.js';
import { type AnyString, connectWs, createAccessToken, getDefaultInferenceUrl } from './utils.js';

export type DeepgramModels =
  | 'deepgram/flux-general'
  | 'deepgram/nova-3'
  | 'deepgram/nova-3-medical'
  | 'deepgram/nova-2'
  | 'deepgram/nova-2-medical'
  | 'deepgram/nova-2-conversationalai'
  | 'deepgram/nova-2-phonecall';

export type CartesiaModels = 'cartesia/ink-whisper';

export type AssemblyaiModels =
  | 'assemblyai/universal-streaming'
  | 'assemblyai/universal-streaming-multilingual';

export type ElevenlabsSTTModels = 'elevenlabs/scribe_v2_realtime';

export type XaiSTTModels = 'xai/stt-1';

export type SpeechmaticsModels = 'speechmatics/enhanced' | 'speechmatics/standard';

export interface CartesiaOptions {
  /** Minimum volume threshold. Default: not specified. */
  min_volume?: number;
  /** Maximum silence duration in seconds. Default: not specified. */
  max_silence_duration_secs?: number;
}

export interface DeepgramOptions {
  /** Enable filler words. Default: true. */
  filler_words?: boolean;
  /** Enable interim results. Default: true. */
  interim_results?: boolean;
  /** Endpointing timeout in milliseconds. Default: 25. */
  endpointing?: number;
  /** Enable punctuation. Default: false. */
  punctuate?: boolean;
  /** Enable smart formatting. */
  smart_format?: boolean;
  /** Keywords with boost values. */
  keywords?: Array<[string, number]>;
  /** Key terms for recognition. */
  keyterms?: string[];
  /** Enable profanity filter. */
  profanity_filter?: boolean;
  /** Convert spoken numbers to numerals. */
  numerals?: boolean;
  /** Opt out of model improvement program. */
  mip_opt_out?: boolean;
  /** Enable speaker diarization. Default: false. */
  diarize?: boolean;
  /** Eager end-of-turn threshold (0.0–1.0). Enables preflight transcripts for preemptive generation. */
  eager_eot_threshold?: number;
}

export interface AssemblyAIOptions {
  /** Enable turn formatting. Default: false. */
  format_turns?: boolean;
  /** End of turn confidence threshold. Default: 0.01. */
  end_of_turn_confidence_threshold?: number;
  /** Minimum silence duration in milliseconds when confident about end of turn. Default: 0. */
  min_end_of_turn_silence_when_confident?: number;
  /** Maximum turn silence in milliseconds. Default: not specified. */
  max_turn_silence?: number;
  /** Key terms prompt for recognition. Default: not specified. */
  keyterms_prompt?: string[];
  /** Enable speaker diarization. Default: false. */
  speaker_labels?: boolean;
}

export interface XaiOptions {
  /** Enable speaker diarization. Default: false. */
  diarize?: boolean;
  /** Silence duration in ms before utterance-final (0-5000). */
  endpointing?: number;
  /** Enable Inverse Text Normalization. Requires language. */
  format?: boolean;
  /** Default true; set false to opt out of interim transcripts. */
  interim_results?: boolean;
}

export interface SpeechmaticsOptions {
  /** Domain to use, for example "finance". */
  domain?: string;
  /** BCP-47 locale for output formatting. */
  output_locale?: string;
  /** Maximum delay in seconds. Valid range is 0.7-4.0. Default: 1.0. */
  max_delay?: number;
  /** Maximum delay mode. */
  max_delay_mode?: 'flexible' | 'fixed' | string;
  /** Enable diarization for modes other than "none". */
  diarization?:
    | 'none'
    | 'speaker'
    | 'channel'
    | 'channel_and_speaker_change'
    | 'speaker_change'
    | string;
  /** Speaker diarization sensitivity. Valid range is 0.0-1.0. */
  speaker_sensitivity?: number;
  /** Maximum number of speakers to detect. */
  max_speakers?: number;
  /** Prefer grouping nearby words as the current speaker. */
  prefer_current_speaker?: boolean;
  /** Enable partial results. Default: true, overridden by the gateway. */
  enable_partials?: boolean;
  /** Enable entity recognition. */
  enable_entities?: boolean;
  /** Punctuation override configuration. */
  punctuation_overrides?: Record<string, unknown>;
  /** Additional vocabulary entries for custom dictionary support. */
  additional_vocab?: Array<Record<string, unknown>>;
  /** Seconds of silence before finalizing an utterance. */
  end_of_utterance_silence_trigger?: number;
  /** Audio filtering configuration. */
  audio_filtering_config?: Record<string, unknown>;
  /** Transcript filtering configuration. */
  transcript_filtering_config?: Record<string, unknown>;
}

export type STTLanguages =
  | 'multi'
  | 'en'
  | 'de'
  | 'es'
  | 'fr'
  | 'ja'
  | 'pt'
  | 'zh'
  | 'hi'
  | AnyString;

const DIARIZATION_EXTRA_KEYS = ['diarize', 'speaker_labels', 'diarization'] as const;

function diarizationEnabled(extraKwargs: Record<string, unknown> | undefined): boolean {
  if (!extraKwargs) return false;
  return DIARIZATION_EXTRA_KEYS.some((key) => {
    const value = extraKwargs[key];
    if (!value) return false;
    return !(typeof value === 'string' && value.toLowerCase() === 'none');
  });
}

type _STTModels =
  | DeepgramModels
  | CartesiaModels
  | AssemblyaiModels
  | ElevenlabsSTTModels
  | XaiSTTModels
  | SpeechmaticsModels;

export type STTModels = _STTModels | 'auto' | AnyString;

export type ModelWithLanguage = `${_STTModels}:${STTLanguages}` | STTModels;

export type STTOptions<TModel extends STTModels> = TModel extends DeepgramModels
  ? DeepgramOptions
  : TModel extends CartesiaModels
    ? CartesiaOptions
    : TModel extends AssemblyaiModels
      ? AssemblyAIOptions
      : TModel extends XaiSTTModels
        ? XaiOptions
        : TModel extends SpeechmaticsModels
          ? SpeechmaticsOptions
          : Record<string, unknown>;

/** Inference Fallback Adapter: configuration for a fallback STT model that runs server-side in LiveKit Inference, providing automatic fallback between providers. Extra fields are passed through to the provider. */
export interface STTFallbackModel {
  /** Model name (e.g. "deepgram/nova-3", "assemblyai/universal-streaming", "cartesia/ink-whisper"). */
  model: string;
  /** Extra configuration for the model. */
  extraKwargs?: Record<string, unknown>;
}

export type STTFallbackModelType = STTFallbackModel | string;

/** Parse a model string into [model, language]. Language is undefined if not specified. */
export function parseSTTModelString(model: string): [string, LanguageCode | undefined] {
  const idx = model.lastIndexOf(':');
  if (idx !== -1) {
    return [model.slice(0, idx), normalizeLanguage(model.slice(idx + 1))];
  }
  return [model, undefined];
}

/** Normalize a single or list of FallbackModelType into STTFallbackModel[]. */
export function normalizeSTTFallback(
  fallback: STTFallbackModelType | STTFallbackModelType[],
): STTFallbackModel[] {
  const makeFallback = (model: STTFallbackModelType): STTFallbackModel => {
    if (typeof model === 'string') {
      const [name] = parseSTTModelString(model);
      return { model: name };
    }
    return model;
  };

  if (Array.isArray(fallback)) {
    return fallback.map(makeFallback);
  }
  return [makeFallback(fallback)];
}

type VADSource = VAD | (() => Promise<VAD>);

function isSpeechmaticsModel(model: string | undefined): boolean {
  return model?.startsWith('speechmatics/') ?? false;
}

function loadSileroVAD(model: string): () => Promise<VAD> {
  return async () => {
    try {
      const dynamicImport = (specifier: string) =>
        import(specifier) as Promise<{ VAD: { load(): Promise<VAD> } }>;
      const { VAD: SileroVAD } = await dynamicImport('@livekit/agents-plugin-silero');
      return SileroVAD.load();
    } catch (e) {
      throw new Error(
        `@livekit/agents-plugin-silero is required: model ${JSON.stringify(
          model,
        )} does not handle endpointing server-side.`,
        { cause: e },
      );
    }
  };
}

function resolveVADForModel(
  model: string | undefined,
  vad: VAD | undefined,
): VADSource | undefined {
  const speechmatics = isSpeechmaticsModel(model);
  if (vad && !speechmatics) {
    log().warn({ model }, '`vad` will be ignored: model handles endpointing server-side');
    return undefined;
  }
  if (speechmatics && vad === undefined) {
    return loadSileroVAD(model!);
  }
  return vad;
}

export type STTEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: STTEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CANCEL_TIMEOUT = 5000;

export interface InferenceSTTOptions<TModel extends STTModels> {
  model?: TModel;
  language?: LanguageCode;
  encoding: STTEncoding;
  sampleRate: number;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  modelOptions: STTOptions<TModel>;
  fallback?: STTFallbackModel[];
  connOptions?: APIConnectOptions;
}

/**
 * Livekit Cloud Inference STT
 */
export class STT<TModel extends STTModels> extends BaseSTT {
  private opts: InferenceSTTOptions<TModel>;
  private streams: Set<SpeechStream<TModel>> = new Set();
  private vad?: VADSource;

  #logger = log();

  constructor(opts?: {
    model?: ModelWithLanguage;
    language?: STTLanguages;
    baseURL?: string;
    encoding?: STTEncoding;
    sampleRate?: number;
    apiKey?: string;
    apiSecret?: string;
    modelOptions?: STTOptions<TModel>;
    fallback?: STTFallbackModelType | STTFallbackModelType[];
    connOptions?: APIConnectOptions;
    vad?: VAD;
  }) {
    const modelOptions = (opts?.modelOptions ?? {}) as STTOptions<TModel>;
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
      diarization: diarizationEnabled(modelOptions as Record<string, unknown>),
    });

    const {
      model,
      language,
      baseURL,
      encoding = DEFAULT_ENCODING,
      sampleRate = DEFAULT_SAMPLE_RATE,
      apiKey,
      apiSecret,
      fallback,
      connOptions,
      vad,
    } = opts || {};

    const lkBaseURL = baseURL || getDefaultInferenceUrl();
    const lkApiKey = apiKey || process.env.LIVEKIT_INFERENCE_API_KEY || process.env.LIVEKIT_API_KEY;
    if (!lkApiKey) {
      throw new Error('apiKey is required: pass apiKey or set LIVEKIT_API_KEY');
    }

    const lkApiSecret =
      apiSecret || process.env.LIVEKIT_INFERENCE_API_SECRET || process.env.LIVEKIT_API_SECRET;
    if (!lkApiSecret) {
      throw new Error('apiSecret is required: pass apiSecret or set LIVEKIT_API_SECRET');
    }

    // Parse language from model string if provided: "provider/model:language"
    let nextModel = model;
    let nextLanguage = language;
    if (typeof nextModel === 'string') {
      const [parsedModel, parsedLanguage] = parseSTTModelString(nextModel);
      if (parsedLanguage !== undefined) {
        if (nextLanguage && !areLanguagesEquivalent(nextLanguage, parsedLanguage)) {
          this.#logger.warn(
            '`language` is provided via both argument and model, using the one from the argument',
            { language: nextLanguage, model: nextModel },
          );
        } else {
          nextLanguage = parsedLanguage as STTLanguages;
        }
        nextModel = parsedModel as TModel;
      }
    }
    const normalizedFallback = fallback ? normalizeSTTFallback(fallback) : undefined;
    this.vad = resolveVADForModel(nextModel, vad);

    this.opts = {
      model: nextModel as TModel,
      language: nextLanguage ? normalizeLanguage(nextLanguage) : undefined,
      encoding,
      sampleRate,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      modelOptions,
      fallback: normalizedFallback,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    };
  }

  get label(): string {
    return 'inference.STT';
  }

  get model(): string {
    return this.opts.model ?? 'auto';
  }

  get provider(): string {
    return 'livekit';
  }

  static fromModelString(modelString: string): STT<AnyString> {
    const [model, language] = parseSTTModelString(modelString);
    return new STT({ model, language });
  }

  protected async _recognize(_: AudioBuffer): Promise<SpeechEvent> {
    throw new Error('LiveKit STT does not support batch recognition, use stream() instead');
  }

  updateOptions(
    opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language' | 'modelOptions'>>,
  ): void {
    const nextOpts = { ...opts };
    if (typeof nextOpts.model === 'string') {
      const [parsedModel, parsedLanguage] = parseSTTModelString(nextOpts.model);
      nextOpts.model = parsedModel as TModel;
      if (parsedLanguage !== undefined && nextOpts.language === undefined) {
        nextOpts.language = parsedLanguage;
      }
    }

    const mergedModelOptions = opts.modelOptions
      ? ({ ...this.opts.modelOptions, ...opts.modelOptions } as STTOptions<TModel>)
      : this.opts.modelOptions;

    this.opts = {
      ...this.opts,
      ...nextOpts,
      language:
        nextOpts.language !== undefined ? normalizeLanguage(nextOpts.language) : this.opts.language,
      modelOptions: mergedModelOptions,
    };

    if (nextOpts.model !== undefined) {
      this.vad = resolveVADForModel(
        nextOpts.model,
        this.vad && typeof this.vad !== 'function' ? this.vad : undefined,
      );
    }

    if (nextOpts.modelOptions) {
      this.updateCapabilities({
        diarization: diarizationEnabled(this.opts.modelOptions as Record<string, unknown>),
      });
    }

    for (const stream of this.streams) {
      stream.updateOptions(nextOpts, nextOpts.model !== undefined ? this.vad : undefined);
    }
  }

  stream(options?: {
    language?: STTLanguages | string;
    connOptions?: APIConnectOptions;
  }): SpeechStream<TModel> {
    const { language, connOptions = this.opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS } =
      options || {};
    const streamOpts = {
      ...this.opts,
      language: language !== undefined ? normalizeLanguage(language) : this.opts.language,
    } as InferenceSTTOptions<TModel>;

    const stream = new SpeechStream(this, streamOpts, connOptions, this.vad);
    this.streams.add(stream);

    return stream;
  }

  async connectWs(timeout: number): Promise<WebSocket> {
    const params = {
      settings: {
        sample_rate: String(this.opts.sampleRate),
        encoding: this.opts.encoding,
        extra: this.opts.modelOptions,
      },
    } as Record<string, unknown>;

    if (this.opts.model && this.opts.model !== 'auto') {
      params.model = this.opts.model;
    }

    if (this.opts.language) {
      (params.settings as Record<string, unknown>).language = this.opts.language;
    }

    if (this.opts.fallback?.length) {
      params.fallback = {
        models: this.opts.fallback.map((m) => ({
          model: m.model,
          extra: m.extraKwargs ?? {},
        })),
      };
    }

    if (this.opts.connOptions) {
      params.connection = {
        timeout: this.opts.connOptions.timeoutMs / 1000,
        retries: this.opts.connOptions.maxRetry,
      };
    }

    let baseURL = this.opts.baseURL;
    if (baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
      baseURL = baseURL.replace('http', 'ws');
    }

    const token = await createAccessToken(this.opts.apiKey, this.opts.apiSecret);
    const url = `${baseURL}/stt`;
    const headers = { Authorization: `Bearer ${token}` } as Record<string, string>;

    const socket = await connectWs(url, headers, timeout);
    const msg = { ...params, type: 'session.create' };
    socket.send(JSON.stringify(msg));

    return socket;
  }
}

export class SpeechStream<TModel extends STTModels> extends BaseSpeechStream {
  private opts: InferenceSTTOptions<TModel>;
  private requestId = shortuuid('stt_request_');
  private speaking = false;
  private speechDuration = 0;
  private reconnectEvent = new Event();
  private stt: STT<TModel>;
  private connOptions: APIConnectOptions;
  private vadPromise: Promise<VAD | undefined>;

  #logger = log();

  constructor(
    sttImpl: STT<TModel>,
    opts: InferenceSTTOptions<TModel>,
    connOptions: APIConnectOptions,
    vadSource: VADSource | undefined,
  ) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.opts = opts;
    this.stt = sttImpl;
    this.connOptions = connOptions;
    this.vadPromise = typeof vadSource === 'function' ? vadSource() : Promise.resolve(vadSource);
  }

  get label(): string {
    return 'inference.SpeechStream';
  }

  updateOptions(
    opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language' | 'modelOptions'>>,
    vadSource?: VADSource,
  ): void {
    const mergedModelOptions = opts.modelOptions
      ? ({ ...this.opts.modelOptions, ...opts.modelOptions } as STTOptions<TModel>)
      : this.opts.modelOptions;

    this.opts = {
      ...this.opts,
      ...opts,
      language: opts.language !== undefined ? normalizeLanguage(opts.language) : this.opts.language,
      modelOptions: mergedModelOptions,
    };
    if (vadSource !== undefined) {
      this.vadPromise = typeof vadSource === 'function' ? vadSource() : Promise.resolve(vadSource);
    }
    this.reconnectEvent.set();
  }

  protected async run(): Promise<void> {
    while (true) {
      const vad = await this.vadPromise;
      // Create fresh resources for each connection attempt
      let ws: WebSocket | null = null;
      let closing = false;
      let finalReceived = false;
      let vadStream: VADStream | null = null;

      const eventChannel = createStreamChannel<SttServerEvent>();

      const resourceCleanup = () => {
        if (closing) return;
        closing = true;
        eventChannel.close();
        ws?.removeAllListeners();
        ws?.close();
      };

      const createWsListener = async (ws: WebSocket, signal: AbortSignal) => {
        return new ThrowsPromise<void, Error | APIStatusError>((resolve, reject) => {
          const onAbort = () => {
            resourceCleanup();
            reject(new Error('WebSocket connection aborted'));
          };

          signal.addEventListener('abort', onAbort, { once: true });

          ws.on('message', (data) => {
            const json = JSON.parse(data.toString()) as SttServerEvent;
            eventChannel.write(json);
          });

          ws.on('error', (e) => {
            this.#logger.error({ error: e }, 'WebSocket error');
            resourceCleanup();
            reject(e);
          });

          ws.on('close', (code: number) => {
            resourceCleanup();

            if (!closing) return this.#logger.error('WebSocket closed unexpectedly');
            if (finalReceived) return resolve();

            reject(
              new APIStatusError({
                message: 'LiveKit STT connection closed unexpectedly',
                options: { statusCode: code },
              }),
            );
          });
        });
      };

      const send = async (socket: WebSocket, signal: AbortSignal) => {
        const audioStream = new AudioByteStream(
          this.opts.sampleRate,
          1,
          Math.floor(this.opts.sampleRate / 20), // 50ms
        );

        // Create abort promise once to avoid memory leak
        const abortPromise = new ThrowsPromise<never, Error>((_, reject) => {
          if (signal.aborted) {
            return reject(new Error('Send aborted'));
          }
          const onAbort = () => reject(new Error('Send aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        });

        // Manual iteration to support cancellation
        const iterator = this.input[Symbol.asyncIterator]();
        try {
          while (true) {
            const result = await ThrowsPromise.race([iterator.next(), abortPromise]);

            if (result.done) break;
            const ev = result.value;

            let frames: AudioFrame[];
            if (ev === SpeechStream.FLUSH_SENTINEL) {
              frames = audioStream.flush();
            } else {
              const frame = ev as AudioFrame;
              vadStream?.pushFrame(frame);
              frames = audioStream.write(new Int16Array(frame.data).buffer);
            }

            for (const frame of frames) {
              this.speechDuration += frame.samplesPerChannel / frame.sampleRate;
              const base64 = Buffer.from(frame.data.buffer).toString('base64');
              const msg = { type: 'input_audio', audio: base64 };
              socket.send(JSON.stringify(msg));
            }
          }

          closing = true;
          vadStream?.endInput();
          socket.send(JSON.stringify({ type: 'session.finalize' }));
        } catch (e) {
          if ((e as Error).message === 'Send aborted') {
            // Expected abort, don't log
            return;
          }
          throw e;
        }
      };

      const processVAD = async (stream: VADStream, socket: WebSocket, signal: AbortSignal) => {
        const abortPromise = new ThrowsPromise<never, Error>((_, reject) => {
          if (signal.aborted) {
            return reject(new Error('VAD aborted'));
          }
          const onAbort = () => reject(new Error('VAD aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        });

        const iterator = stream[Symbol.asyncIterator]();
        try {
          while (true) {
            const result = await ThrowsPromise.race([iterator.next(), abortPromise]);
            if (result.done) break;
            if (result.value.type !== VADEventType.END_OF_SPEECH) continue;
            if (socket.readyState !== 1) return;
            socket.send(JSON.stringify({ type: 'session.finalize' }));
          }
        } catch (e) {
          if ((e as Error).message === 'VAD aborted') return;
          throw e;
        }
      };

      const recv = async (signal: AbortSignal) => {
        const serverEventStream = eventChannel.stream();
        const reader = serverEventStream.getReader();

        try {
          while (!this.closed && !signal.aborted) {
            const result = await reader.read();
            if (signal.aborted) return;
            if (result.done) return;

            // Parse broadly first; warn only on genuinely malformed messages.
            const parseResult = await sttServerEventSchema.safeParseAsync(result.value);
            if (!parseResult.success) {
              this.#logger.warn(
                { error: parseResult.error, rawData: result.value },
                'Failed to parse STT server event',
              );
              continue;
            }

            // Narrow to known event types; unknown types are silently skipped.
            const knownResult = sttKnownServerEventSchema.safeParse(parseResult.data);
            if (!knownResult.success) {
              continue;
            }

            const event = knownResult.data;

            switch (event.type) {
              case 'session.created':
              case 'session.finalized':
                break;
              case 'session.closed':
                finalReceived = true;
                resourceCleanup();
                break;
              case 'interim_transcript':
                this.processTranscript(event, SpeechEventType.INTERIM_TRANSCRIPT);
                break;
              case 'final_transcript':
                this.processTranscript(event, SpeechEventType.FINAL_TRANSCRIPT);
                break;
              case 'preflight_transcript':
                this.processTranscript(event, SpeechEventType.PREFLIGHT_TRANSCRIPT);
                break;
              case 'error':
                this.#logger.error({ error: event }, 'Received error from LiveKit STT');
                resourceCleanup();
                throw new APIError(`LiveKit STT returned error: ${JSON.stringify(event)}`);
            }
          }
        } finally {
          reader.releaseLock();
          try {
            await serverEventStream.cancel();
          } catch (e) {
            this.#logger.debug('Error cancelling serverEventStream (may already be cancelled):', e);
          }
        }
      };

      try {
        ws = await this.stt.connectWs(this.connOptions.timeoutMs);
        vadStream = vad?.stream() ?? null;

        // Use a per-connection controller so reconnect loops don't inherit a permanently-aborted signal.
        const connController = new AbortController();
        const onStreamAbort = () => connController.abort();
        this.abortController.signal.addEventListener('abort', onStreamAbort);

        const sendTask = Task.from(({ signal }) => send(ws!, signal), connController);
        const wsListenerTask = Task.from(
          ({ signal }) => createWsListener(ws!, signal),
          connController,
        );
        const recvTask = Task.from(({ signal }) => recv(signal), connController);
        const activeVADStream = vadStream;
        const vadTask = activeVADStream
          ? Task.from(({ signal }) => processVAD(activeVADStream, ws!, signal), connController)
          : undefined;
        const waitReconnectTask = Task.from(
          ({ signal }) => ThrowsPromise.race([this.reconnectEvent.wait(), waitForAbort(signal)]),
          connController,
        );

        try {
          const taskResults = [sendTask.result, wsListenerTask.result, recvTask.result];
          if (vadTask) taskResults.push(vadTask.result);

          await ThrowsPromise.race([ThrowsPromise.all(taskResults), waitReconnectTask.result]);

          // If reconnect didn't trigger, tasks finished - exit loop
          if (!waitReconnectTask.done) break;

          // Reconnect triggered - clear event and continue loop
          this.reconnectEvent.clear();
        } finally {
          connController.abort();
          this.abortController.signal.removeEventListener('abort', onStreamAbort);
          vadStream?.close();
          const tasks = [sendTask, wsListenerTask, recvTask, waitReconnectTask];
          if (vadTask) tasks.push(vadTask);
          await cancelAndWait(tasks, DEFAULT_CANCEL_TIMEOUT);
          resourceCleanup();
        }

        if (this.abortController.signal.aborted) break;
      } finally {
        // Ensure cleanup even if connectWs throws
        resourceCleanup();
      }
    }
  }

  private processTranscript(data: SttTranscriptEvent, eventType: SpeechEventType) {
    // Check if queue is closed to avoid race condition during disconnect
    if (this.queue.closed) return;

    const requestId = data.session_id || this.requestId;
    const text = data.transcript;
    const language = normalizeLanguage(data.language || this.opts.language || 'en');

    if (!text && eventType !== SpeechEventType.FINAL_TRANSCRIPT) return;

    try {
      // We'll have a more accurate way of detecting when speech started when we have VAD
      if (!this.speaking) {
        this.speaking = true;
        this.queue.put({ type: SpeechEventType.START_OF_SPEECH });
      }

      // The gateway carries provider-specific data on the `extra` field
      // of the transcript message. We surface it on SpeechData.metadata.
      const extra = data.extra;
      const metadata =
        extra &&
        typeof extra === 'object' &&
        !Array.isArray(extra) &&
        Object.keys(extra as Record<string, unknown>).length > 0
          ? (extra as Record<string, unknown>)
          : undefined;

      const speechData: SpeechData = {
        language,
        startTime: this.startTimeOffset + data.start,
        endTime: this.startTimeOffset + data.start + data.duration,
        confidence: data.confidence,
        text,
        speakerId: data.speaker_id ?? undefined,
        words: data.words.map(
          (word): TimedString =>
            createTimedString({
              text: word.word,
              startTime: word.start + this.startTimeOffset,
              endTime: word.end + this.startTimeOffset,
              startTimeOffset: this.startTimeOffset,
              confidence: word.confidence,
              speakerId: word.speaker_id ?? undefined,
            }),
        ),
        metadata,
      };

      if (eventType === SpeechEventType.FINAL_TRANSCRIPT) {
        if (this.speechDuration > 0) {
          this.queue.put({
            type: SpeechEventType.RECOGNITION_USAGE,
            requestId,
            recognitionUsage: { audioDuration: this.speechDuration },
          });
          this.speechDuration = 0;
        }

        this.queue.put({
          type: SpeechEventType.FINAL_TRANSCRIPT,
          requestId,
          alternatives: [speechData],
        });

        if (this.speaking) {
          this.speaking = false;
          this.queue.put({ type: SpeechEventType.END_OF_SPEECH });
        }
      } else {
        this.queue.put({
          type: eventType,
          requestId,
          alternatives: [speechData],
        });
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Queue is closed')) {
        // Expected behavior on disconnect, log as warning
        this.#logger.warn(
          { err: e },
          'Queue closed during transcript processing (expected during disconnect)',
        );
      } else {
        this.#logger.error({ err: e }, 'Error putting transcript to queue');
      }
    }
  }
}
