// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { WebSocket } from 'ws';
import { APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { type LanguageCode, areLanguagesEquivalent, normalizeLanguage } from '../language.js';
import { ChatMessage } from '../llm/index.js';
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
import { type AudioBuffer, Task, cancelAndWait, shortuuid, waitUntilAborted } from '../utils.js';
import { type VAD, VADEventType, type VADStream } from '../vad.js';
import type { ConversationItemAddedEvent } from '../voice/events.js';
import { type TimedString, createTimedString } from '../voice/io.js';
import {
  type SttServerEvent,
  type SttTranscriptEvent,
  sttKnownServerEventSchema,
  sttServerEventSchema,
} from './api_protos.js';
import { type AnyString, connectWs, createAccessToken, getDefaultInferenceUrl } from './utils.js';
import { VAD as InferenceVAD } from './vad.js';

export type DeepgramModels =
  | 'deepgram/nova-3'
  | 'deepgram/nova-3-medical'
  | 'deepgram/nova-2'
  | 'deepgram/nova-2-medical'
  | 'deepgram/nova-2-conversationalai'
  | 'deepgram/nova-2-phonecall';

export type DeepgramFluxModels =
  | 'deepgram/flux-general'
  | 'deepgram/flux-general-en'
  | 'deepgram/flux-general-multi';

export type CartesiaModels = 'cartesia/ink-whisper' | 'cartesia/ink-2';

export type AssemblyaiModels =
  | 'assemblyai/universal-streaming'
  | 'assemblyai/universal-streaming-multilingual'
  | 'assemblyai/u3-rt-pro'
  | 'assemblyai/universal-3-5-pro'
  | 'assemblyai/universal-3-6-pro';

export type XaiSTTModels = 'xai/stt-1';

export type SpeechmaticsModels =
  | 'speechmatics/enhanced'
  | 'speechmatics/standard'
  | 'speechmatics/linden-1';

export type InworldSTTModels = 'inworld/inworld-stt-1';

export type GoogleSTTModels = 'google/gemini-3.5-transcribe-live';

export type OpenAIModels = 'openai/gpt-live-transcribe';

export interface CartesiaOptions {
  /** Minimum volume threshold. Ink Whisper only. Default: not specified. */
  min_volume?: number;
  /** Maximum silence duration in seconds. Ink Whisper only. Default: not specified. */
  max_silence_duration_secs?: number;
  // Turn-detection tuning for turn-detecting models such as Ink 2. The gateway validates
  // these values against Cartesia's documented ranges.
  /** Turn-start threshold (0.5-0.9). Default: 0.8. */
  turn_start_threshold?: number;
  /** Eager turn-end threshold (0.3-0.6). Default: 0.4. */
  turn_eager_end_threshold?: number;
  /** Turn-end threshold (0.05-0.5). Default: 0.2. */
  turn_end_threshold?: number;
  /** Turn-end timeout in milliseconds (640-11200). Default: 5600. */
  turn_end_timeout_ms?: number;
  /** Key terms, up to 100 terms totaling 1200 characters. */
  keyterm?: string | string[];
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
  keyterm?: string | string[];
  /** Enable profanity filter. */
  profanity_filter?: boolean;
  /** Convert spoken numbers to numerals. */
  numerals?: boolean;
  /** Opt out of model improvement program. */
  mip_opt_out?: boolean;
  /** Enable speaker diarization. Default: false. */
  diarize?: boolean;
}

export interface DeepgramFluxOptions {
  /** Eager end-of-turn threshold (0.3–0.9). Enables preflight transcripts for preemptive generation. Default: 0.5. */
  eager_eot_threshold?: number;
  /** End-of-turn threshold (0.5–0.9). */
  eot_threshold?: number;
  /** End-of-turn timeout in milliseconds. */
  eot_timeout_ms?: number;
  /** Key terms for recognition. */
  keyterm?: string | string[];
  /** Opt out of model improvement program. Default: false. */
  mip_opt_out?: boolean;
  /** Language hint. */
  language_hint?: string;
  /** Enable automatic language detection. */
  detect_language?: boolean;
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
  /** Context to bias recognition. Only supported with U3 Pro models. Max 1750 chars. */
  agent_context?: string;
  /** Prior turns carried as context; 0 disables carryover. Only supported with U3 Pro models. */
  previous_context_n_turns?: number;
  /** Isolate the primary voice. Only supported with u3-rt-pro. */
  voice_focus?: 'near-field' | 'far-field';
  /** Background suppression strength. Only supported with u3-rt-pro. */
  voice_focus_threshold?: number;
  /** Accuracy/latency preset. Only supported with u3-rt-pro. */
  mode?: 'min_latency' | 'balanced' | 'max_accuracy';
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
  /** Maximum delay in seconds. Valid range is 0.7-4.0. Default: 1.0. RT only. */
  max_delay?: number;
  /** Maximum delay mode. RT only. */
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
  /** Enable entity recognition. RT only. */
  enable_entities?: boolean;
  /** Punctuation override configuration. */
  punctuation_overrides?: Record<string, unknown>;
  /** Additional vocabulary entries for custom dictionary support. RT only. */
  additional_vocab?: Array<Record<string, unknown>>;
  /** Seconds of silence before finalizing an utterance. RT only. */
  end_of_utterance_silence_trigger?: number;
  /** Audio filtering configuration. RT only. */
  audio_filtering_config?: Record<string, unknown>;
  /** Transcript filtering configuration. RT only. */
  transcript_filtering_config?: Record<string, unknown>;
}

export interface InworldSTTOptions {
  /** Enable Voice Profile detection. Default: true. */
  enable_voice_profile?: boolean;
  /** Max labels per category in voice-profile responses (1–20). Default: 10. */
  voice_profile_top_n?: number;
  /** Enable word-level timestamps. Default: true. */
  include_word_timestamps?: boolean;
  /** Wire-format encoding sent to Inworld. Default: LINEAR16. */
  audio_encoding?: 'LINEAR16' | 'AUTO_DETECT';
  /** Stop transcription after this many seconds of silence; 0 disables. */
  inactivity_timeout_seconds?: number;
  /** End-of-turn confidence threshold (0.0–1.0). Default: 0.5. */
  end_of_turn_confidence_threshold?: number;
  /** Domain-specific contextual hints passed to the model. */
  prompts?: string[];
  /** Minimum end-of-turn silence in milliseconds when confident. */
  min_end_of_turn_silence_when_confident?: number;
  /** VAD threshold (0.0–1.0). Default: 0.5. */
  vad_threshold?: number;
}

export interface GoogleSTTOptions {
  /** BCP-47 language codes. Omit or pass an empty list to detect the language. */
  language_codes?: string[];
  /** Up to 1000 terms that bias recognition. */
  custom_vocabulary?: string[];
}

/**
 * OpenAI Realtime transcription session configuration.
 * https://developers.openai.com/api/docs/guides/realtime-transcription
 */
export interface OpenAIOptions {
  /** Expected input languages. Overrides `language`. */
  languages?: string[];
  /** Description of the recording or its setting, up to 1024 characters. */
  prompt?: string;
  /** Literal terms the audio may contain. */
  keywords?: string[];
  /** Latency versus accuracy preference. */
  delay?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Noise reduction mode. */
  noise_reduction?: 'near_field' | 'far_field';
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

// AssemblyAI U3 Pro models accept `agent_context`, so assistant replies can be carried over.
const ASSEMBLYAI_CARRYOVER_MODELS = new Set([
  'assemblyai/u3-rt-pro',
  'assemblyai/universal-3-5-pro',
  'assemblyai/universal-3-6-pro',
]);

const ASSEMBLYAI_MAX_AGENT_CONTEXT_CHARS = 1750;

function supportsChatContext(model: string | undefined): boolean {
  return model !== undefined && ASSEMBLYAI_CARRYOVER_MODELS.has(model);
}

/**
 * Return the provider's keyterm `extra` entry: user keyterms (from `extraKwargs`)
 * merged with the framework `sessionKeyterms`.
 *
 * `undefined` if the model has no keyterm prompting, so
 * `keytermsExtraForModel(model) !== undefined` is also the capability check.
 */
function keytermsKeyForModel(model: string | undefined): string | undefined {
  if (typeof model !== 'string' || !model || model === 'speechmatics/linden-1') return undefined;
  if (model.startsWith('speechmatics/')) return 'additional_vocab';
  if (model.startsWith('deepgram/')) return 'keyterm';
  if (model.startsWith('assemblyai/')) return 'keyterms_prompt';
  if (isOpenAIModel(model)) return 'keywords';
  return undefined;
}

function keytermsExtraForModel(
  model: string | undefined,
  opts?: {
    extraKwargs?: Record<string, unknown>;
    sessionKeyterms?: string[];
  },
): Record<string, unknown> | undefined {
  const key = keytermsKeyForModel(model);
  if (key === undefined) return undefined;

  const extraKwargs = opts?.extraKwargs ?? {};
  const sessionKeyterms = opts?.sessionKeyterms ?? [];

  if (key === 'additional_vocab') {
    // keep existing entries as-is (they may carry sounds_like etc.); append new session terms
    const rawExisting = extraKwargs[key];
    const existing: Record<string, unknown>[] = Array.isArray(rawExisting) ? [...rawExisting] : [];
    const seen = new Set(existing.map((v) => v.content));
    const additions = sessionKeyterms.filter((term) => !seen.has(term));
    return { [key]: [...existing, ...additions.map((term) => ({ content: term }))] };
  }
  // deepgram's keyterm may be a bare string; wrap it so it isn't splat char-by-char
  const rawUser = extraKwargs[key] ?? [];
  const existing = typeof rawUser === 'string' ? [rawUser] : Array.isArray(rawUser) ? rawUser : [];
  return { [key]: [...new Set([...existing, ...sessionKeyterms])] };
}

// Models verified to carry word timings. Unknown models stay disabled until verified.
const WORD_ALIGNED_MODELS = new Set([
  'deepgram/nova-3',
  'deepgram/nova-3-medical',
  'deepgram/nova-2',
  'deepgram/nova-2-medical',
  'deepgram/nova-2-conversationalai',
  'deepgram/nova-2-phonecall',
  'deepgram/flux-general',
  'deepgram/flux-general-en',
  'deepgram/flux-general-multi',
  'cartesia/ink-whisper',
  'assemblyai/universal-streaming',
  'assemblyai/universal-streaming-multilingual',
  'assemblyai/u3-rt-pro',
  'assemblyai/universal-3-5-pro',
  'assemblyai/universal-3-6-pro',
  'xai/stt-1',
  'speechmatics/enhanced',
  'speechmatics/standard',
]);

/**
 * Word-level alignment, which adaptive interruption relies on to gatekeep transcripts.
 *
 * Returns false when the model sends no word timings, and for `auto`, where the provider is
 * picked server-side per language and cannot be known here. Claiming alignment we do not have
 * is the costlier error because it disables the fast VAD barge-in path.
 */
function alignedTranscriptForModel(model: string | undefined): 'word' | false {
  return model && WORD_ALIGNED_MODELS.has(model) ? 'word' : false;
}

type _STTModels =
  | DeepgramModels
  | DeepgramFluxModels
  | CartesiaModels
  | AssemblyaiModels
  | XaiSTTModels
  | SpeechmaticsModels
  | InworldSTTModels
  | GoogleSTTModels
  | OpenAIModels;

export type STTModels = _STTModels | 'auto' | AnyString;

export type ModelWithLanguage = `${_STTModels}:${STTLanguages}` | STTModels;

export type STTOptions<TModel extends STTModels> = TModel extends DeepgramFluxModels
  ? DeepgramFluxOptions
  : TModel extends DeepgramModels
    ? DeepgramOptions
    : TModel extends CartesiaModels
      ? CartesiaOptions
      : TModel extends AssemblyaiModels
        ? AssemblyAIOptions
        : TModel extends XaiSTTModels
          ? XaiOptions
          : TModel extends SpeechmaticsModels
            ? SpeechmaticsOptions
            : TModel extends InworldSTTModels
              ? InworldSTTOptions
              : TModel extends GoogleSTTModels
                ? GoogleSTTOptions
                : TModel extends OpenAIModels
                  ? OpenAIOptions
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

function isOpenAIModel(model: string): boolean {
  return model === 'openai' || model.startsWith('openai/');
}

function providerForModel(model: string | undefined): string | undefined {
  return model?.split('/', 1)[0] || undefined;
}

function needsClientEndpointing(model: string | undefined): boolean {
  if (model?.startsWith('speechmatics/')) return model !== 'speechmatics/linden-1';
  return model !== undefined && isOpenAIModel(model);
}

function requiredSampleRate(model: string | undefined): number | undefined {
  return model !== undefined && isOpenAIModel(model) ? 24000 : undefined;
}

function warnIfSampleRateRefused(model: string | undefined, sampleRate: number): void {
  const required = requiredSampleRate(model);
  if (required !== undefined && required !== sampleRate) {
    log().warn(
      { model, requiredSampleRate: required, sampleRate },
      `model takes audio only at ${required} Hz; the gateway will refuse ${sampleRate} Hz`,
    );
  }
}

function resolveVADForModel(model: string | undefined, vad: VAD | undefined): VAD | undefined {
  const needsVAD = needsClientEndpointing(model);
  if (vad && !needsVAD) {
    log().warn({ model }, '`vad` will be ignored: model handles endpointing server-side');
    return undefined;
  }
  if (needsVAD && vad === undefined) {
    // These models don't endpoint server-side, so fall back to the in-tree
    // local inference VAD rather than the deprecated silero plugin.
    return new InferenceVAD();
  }
  return vad;
}

export type STTEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: STTEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CANCEL_TIMEOUT = 5000;
const INACTIVITY_TIMEOUT_ERROR_CODE = 2007;
const FINALIZATION_TIMEOUT_MS = 30_000;
const FINAL_TRANSCRIPT_INACTIVITY_TIMEOUT_MS = 3_000;

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

async function connectInferenceSTT<TModel extends STTModels>(
  opts: InferenceSTTOptions<TModel>,
  sessionKeyterms: string[],
  timeout: number,
): Promise<WebSocket> {
  const params = {
    settings: {
      sample_rate: String(opts.sampleRate),
      encoding: opts.encoding,
      extra: {
        ...opts.modelOptions,
        ...(keytermsExtraForModel(opts.model, {
          extraKwargs: opts.modelOptions as Record<string, unknown>,
          sessionKeyterms,
        }) ?? {}),
      },
    },
  } as Record<string, unknown>;

  if (opts.model && opts.model !== 'auto') {
    params.model = opts.model;
  }

  if (opts.language) {
    (params.settings as Record<string, unknown>).language = opts.language;
  }

  if (opts.fallback?.length) {
    params.fallback = {
      models: opts.fallback.map((m) => ({
        model: m.model,
        extra: m.extraKwargs ?? {},
      })),
    };
  }

  if (opts.connOptions) {
    params.connection = {
      timeout: opts.connOptions.timeoutMs / 1000,
      retries: opts.connOptions.maxRetry,
    };
  }

  let baseURL = opts.baseURL;
  if (baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
    baseURL = baseURL.replace('http', 'ws');
  }

  const token = await createAccessToken(opts.apiKey, opts.apiSecret);
  const url = `${baseURL}/stt?model=${encodeURIComponent(opts.model ?? 'auto')}`;
  const headers = { Authorization: `Bearer ${token}` } as Record<string, string>;

  const socket = await connectWs(url, headers, timeout);
  socket.send(JSON.stringify({ ...params, type: 'session.create' }));
  return socket;
}

/**
 * Livekit Cloud Inference STT
 */
export class STT<TModel extends STTModels> extends BaseSTT {
  private opts: InferenceSTTOptions<TModel>;
  private streams: Set<SpeechStream<TModel>> = new Set();
  private vad?: VAD;
  private _vadPromise?: Promise<VAD | undefined>;
  private readonly explicitSampleRate: boolean;
  /** framework-managed; merged into modelOptions @internal */
  _sessionKeyterms: string[] = [];

  /**
   * Resolves to the VAD instance for the current model, or `undefined` if the model
   * handles endpointing server-side. Lazily computed on first read.
   */
  get vadPromise(): Promise<VAD | undefined> {
    if (this._vadPromise === undefined) {
      this._vadPromise = Promise.resolve(this.vad);
    }
    return this._vadPromise;
  }

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
    const initialModel =
      typeof opts?.model === 'string' ? parseSTTModelString(opts.model)[0] : undefined;
    const normalizedFallback = opts?.fallback ? normalizeSTTFallback(opts.fallback) : undefined;
    const alignmentModels = [
      initialModel,
      ...(normalizedFallback?.map(({ model }) => model) ?? []),
    ];
    const alignedTranscript = alignmentModels.every(alignedTranscriptForModel) ? 'word' : false;
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript,
      diarization: diarizationEnabled(modelOptions as Record<string, unknown>),
      keyterms: keytermsExtraForModel(initialModel) !== undefined,
      chatContext: supportsChatContext(initialModel),
    });

    const {
      model,
      language,
      baseURL,
      encoding = DEFAULT_ENCODING,
      sampleRate,
      apiKey,
      apiSecret,
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
    this.vad = resolveVADForModel(nextModel, vad);
    const resolvedSampleRate = sampleRate ?? requiredSampleRate(nextModel) ?? DEFAULT_SAMPLE_RATE;
    warnIfSampleRateRefused(nextModel, resolvedSampleRate);
    this.explicitSampleRate = sampleRate !== undefined;

    this.opts = {
      model: nextModel as TModel,
      language: nextLanguage ? normalizeLanguage(nextLanguage) : undefined,
      encoding,
      sampleRate: resolvedSampleRate,
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
    const explicitLanguage = opts.language;
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
      this.vad = resolveVADForModel(nextOpts.model, this.vad);
      this._vadPromise = undefined;
      if (!this.explicitSampleRate) {
        this.opts.sampleRate = requiredSampleRate(nextOpts.model) ?? DEFAULT_SAMPLE_RATE;
      }
      warnIfSampleRateRefused(nextOpts.model, this.opts.sampleRate);
      const alignmentModels = [
        this.opts.model,
        ...(this.opts.fallback?.map(({ model }) => model) ?? []),
      ];
      this.updateCapabilities({
        keyterms: keytermsExtraForModel(this.opts.model) !== undefined,
        chatContext: supportsChatContext(this.opts.model),
        alignedTranscript: alignmentModels.every(alignedTranscriptForModel) ? 'word' : false,
      });
    }

    if (nextOpts.modelOptions) {
      this.updateCapabilities({
        diarization: diarizationEnabled(this.opts.modelOptions as Record<string, unknown>),
      });
    }

    for (const stream of this.streams) {
      stream.updateOptions({ ...nextOpts, language: explicitLanguage });
    }
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    if (
      keyterms.length === this._sessionKeyterms.length &&
      keyterms.every((t, i) => t === this._sessionKeyterms[i])
    ) {
      return;
    }
    if (keytermsExtraForModel(this.opts.model) === undefined) {
      super._updateSessionKeyterms(keyterms); // warn-and-skip for unsupported models
      return;
    }

    this._sessionKeyterms = [...keyterms];
    for (const stream of this.streams) {
      stream['onSessionKeytermsChanged']();
    }
  }

  override _pushConversationItem(ev: ConversationItemAddedEvent): void {
    const chatItem = ev.item;
    if (chatItem instanceof ChatMessage && chatItem.role === 'assistant' && chatItem.textContent) {
      // count code points, not UTF-16 units, to match the provider's character limit
      const chars = Array.from(chatItem.textContent);
      if (chars.length > ASSEMBLYAI_MAX_AGENT_CONTEXT_CHARS) {
        this.#logger.debug(
          { fromChars: chars.length, toChars: ASSEMBLYAI_MAX_AGENT_CONTEXT_CHARS },
          'truncating agent_context carryover',
        );
      }
      const agentContext = chars.slice(-ASSEMBLYAI_MAX_AGENT_CONTEXT_CHARS).join('');
      this.updateOptions({ modelOptions: { agent_context: agentContext } as STTOptions<TModel> });
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

    const stream = new SpeechStream(this, streamOpts, connOptions);
    this.streams.add(stream);

    return stream;
  }

  async connectWs(timeout: number): Promise<WebSocket> {
    return connectInferenceSTT(this.opts, this._sessionKeyterms, timeout);
  }
}

export class SpeechStream<TModel extends STTModels> extends BaseSpeechStream {
  private opts: InferenceSTTOptions<TModel>;
  private userModelOptions: STTOptions<TModel>;
  private requestId = shortuuid('stt_request_');
  private speaking = false;
  // keyterm extra set while the user is speaking; applied at END_OF_SPEECH (latest wins).
  // inference applies live, but the gateway may reconnect upstream, so defer to a calm moment.
  /** @internal */
  _pendingExtra?: Record<string, unknown>;
  private speechDuration = 0;
  private stt: STT<TModel>;
  private connOptions: APIConnectOptions;
  private activeWs?: WebSocket;
  private readonly vadPromise: Promise<VAD | undefined>;

  #logger = log();

  constructor(
    sttImpl: STT<TModel>,
    opts: InferenceSTTOptions<TModel>,
    connOptions: APIConnectOptions,
  ) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.opts = opts;
    this.userModelOptions = { ...opts.modelOptions } as STTOptions<TModel>;
    this.stt = sttImpl;
    this.connOptions = connOptions;
    // Snapshot the current VAD before the parent can switch models.
    this.vadPromise = sttImpl.vadPromise;
  }

  get label(): string {
    return 'inference.SpeechStream';
  }

  /** @internal */
  get _speaking(): boolean {
    return this.speaking;
  }

  updateOptions(
    opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language' | 'modelOptions'>>,
  ): void {
    let model = opts.model;
    let language = opts.language;
    let refused = false;
    let changedProvider = false;
    if (typeof model === 'string') {
      const [parsedModel, parsedLanguage] = parseSTTModelString(model);
      model = parsedModel as TModel;
      const required = requiredSampleRate(model);
      refused = required !== undefined && required !== this.opts.sampleRate;
      if (refused) {
        this.#logger.warn(
          {
            runningModel: this.opts.model,
            model,
            requiredSampleRate: required,
            sampleRate: this.opts.sampleRate,
          },
          `live stream stays on its running model: requested model takes audio only at ${required} Hz, this stream was created at ${this.opts.sampleRate} Hz`,
        );
      }
      changedProvider = providerForModel(model) !== providerForModel(this.opts.model);
      if (parsedLanguage !== undefined && language === undefined && !refused && !changedProvider) {
        language = parsedLanguage;
      }
    }

    if (language !== undefined) this.opts.language = normalizeLanguage(language);

    let forwardExtra: Record<string, unknown> | undefined;
    if (opts.modelOptions !== undefined && !changedProvider) {
      this.userModelOptions = {
        ...this.userModelOptions,
        ...opts.modelOptions,
      } as STTOptions<TModel>;
      forwardExtra = this.forwardExtra(opts.modelOptions as Record<string, unknown>);
      this.opts.modelOptions = {
        ...this.userModelOptions,
        ...this.keytermPayload(),
      } as STTOptions<TModel>;
    }

    this.sendLiveUpdate({ model, language, modelOptions: forwardExtra as STTOptions<TModel> });
  }

  private keytermPayload(): Record<string, unknown> {
    return (
      keytermsExtraForModel(this.opts.model, {
        extraKwargs: this.userModelOptions as Record<string, unknown>,
        sessionKeyterms: this.stt._sessionKeyterms,
      }) ?? {}
    );
  }

  private forwardExtra(extra: Record<string, unknown>): Record<string, unknown> {
    const key = keytermsKeyForModel(this.opts.model);
    if (key !== undefined && key in extra) {
      this._pendingExtra = undefined;
      return { ...extra, ...this.keytermPayload() };
    }
    return { ...extra };
  }

  private sendLiveUpdate(
    opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language' | 'modelOptions'>>,
  ): void {
    if (!this.activeWs || this.activeWs.readyState !== 1) return;
    const settings: Record<string, unknown> = {};
    if (opts.model !== undefined) settings.model = opts.model;
    if (opts.language !== undefined) settings.language = normalizeLanguage(opts.language);
    if (opts.modelOptions !== undefined) settings.extra = opts.modelOptions;
    if (Object.keys(settings).length === 0) return;
    try {
      this.activeWs.send(JSON.stringify({ type: 'session.update', settings }));
    } catch (e) {
      this.#logger.debug({ err: e }, 'failed to send session.update, ws may be closing');
    }
  }

  private onSessionKeytermsChanged(): void {
    const extra = this.keytermPayload();
    if (Object.keys(extra).length === 0) return;
    this.opts.modelOptions = {
      ...this.userModelOptions,
      ...extra,
    } as STTOptions<TModel>;
    if (this.speaking) this._pendingExtra = extra;
    else this.sendLiveUpdate({ modelOptions: extra as STTOptions<TModel> });
  }

  private onEndOfSpeech(): void {
    if (this._pendingExtra !== undefined) {
      this.sendLiveUpdate({ modelOptions: this._pendingExtra as STTOptions<TModel> });
      this._pendingExtra = undefined;
    }
  }

  protected async run(): Promise<void> {
    while (true) {
      const vad = await this.vadPromise;
      // Create fresh resources for each connection attempt
      let ws: WebSocket | null = null;
      let inputEnded = false;
      let cleanedUp = false;
      let finalTranscriptReceived = false;
      let finalizationComplete = false;
      let sessionClosedReceived = false;
      let sessionCloseSent = false;
      let finalizationTimeout: ReturnType<typeof setTimeout> | undefined;
      let vadStream: VADStream | null = null;

      const eventChannel = createStreamChannel<SttServerEvent>();

      const sendSessionClose = (socket: WebSocket) => {
        if (sessionCloseSent || sessionClosedReceived || socket.readyState !== 1) return;
        sessionCloseSent = true;
        if (finalizationTimeout) {
          clearTimeout(finalizationTimeout);
          finalizationTimeout = undefined;
        }
        socket.send(JSON.stringify({ type: 'session.close' }));
      };

      const sendSessionFinalize = (socket: WebSocket) => {
        socket.send(JSON.stringify({ type: 'session.finalize' }));
      };

      const resourceCleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (finalizationTimeout) clearTimeout(finalizationTimeout);
        void eventChannel.close().catch((error) => {
          this.#logger.debug({ error }, 'Failed to close STT event channel');
        });
        if (ws) {
          try {
            sendSessionClose(ws);
          } catch (error) {
            this.#logger.debug({ error }, 'Failed to send session.close');
          }
          ws.close();
        }
      };

      const finishFinalization = () => {
        if (finalizationComplete) return;
        finalizationComplete = true;
        resourceCleanup();
      };

      const scheduleFinalizationTimeout = () => {
        if (
          !inputEnded ||
          finalizationComplete ||
          sessionCloseSent ||
          sessionClosedReceived ||
          cleanedUp
        ) {
          return;
        }
        if (finalizationTimeout) clearTimeout(finalizationTimeout);
        // Lifecycle acknowledgments are optional and may precede trailing transcripts.
        // ponytail: Add an interim-specific deadline only if shutdown latency requires it.
        const timeout = finalTranscriptReceived
          ? FINAL_TRANSCRIPT_INACTIVITY_TIMEOUT_MS
          : FINALIZATION_TIMEOUT_MS;
        finalizationTimeout = setTimeout(finishFinalization, timeout);
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
            if (json.type === 'final_transcript') {
              finalTranscriptReceived = true;
            }
            // a transcript keeps the finalization wait open; an interim with no text is not one
            // (xai/stt-1 sends an empty interim every second after session.finalized, for as
            // long as the socket is open, and the stream would never end)
            const transcriptText = (json as { transcript?: string }).transcript;
            if (
              json.type === 'final_transcript' ||
              json.type === 'preflight_transcript' ||
              (json.type === 'interim_transcript' && Boolean(transcriptText))
            ) {
              scheduleFinalizationTimeout();
            }
            void eventChannel.write(json).catch((error) => {
              this.#logger.debug({ error }, 'Failed to queue STT server event');
            });
          });

          ws.on('error', (e) => {
            this.#logger.error({ error: e }, 'WebSocket error');
            resourceCleanup();
            reject(e);
          });

          ws.on('close', (code: number) => {
            const expectedClose =
              signal.aborted || inputEnded || finalizationComplete || sessionCloseSent;
            resourceCleanup();

            if (expectedClose) return resolve();

            this.#logger.error('WebSocket closed unexpectedly');

            reject(
              new APIStatusError({
                message: 'LiveKit STT connection closed unexpectedly',
                options: { statusCode: code, retryable: !inputEnded },
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

        const nextInput = async () => {
          try {
            return await this.input.next({ signal });
          } catch (e) {
            if (signal.aborted) return undefined;
            throw e;
          }
        };
        while (true) {
          const result = await nextInput();
          if (result === undefined) {
            // Expected abort, don't log
            return;
          }
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

        inputEnded = true;
        try {
          vadStream?.endInput();
        } catch (e) {
          this.#logger.debug({ err: e }, 'VAD stream already closed at input end');
        }
        sendSessionFinalize(socket);
        scheduleFinalizationTimeout();
      };

      const processVAD = async (stream: VADStream, socket: WebSocket, signal: AbortSignal) => {
        // VADStream.next() does not support cancellation.
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const { result, isAborted } = await waitUntilAborted(iterator.next(), signal);
          if (isAborted) return;
          if (result.done) break;
          if (result.value.type !== VADEventType.END_OF_SPEECH) continue;
          if (socket.readyState !== 1) return;
          try {
            sendSessionFinalize(socket);
          } catch (e) {
            this.#logger.debug({ err: e }, 'failed to send session.finalize from VAD');
            return;
          }
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
                {
                  error: parseResult.error,
                  'lk.pii.raw_data': result.value,
                },
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
                break;
              case 'session.finalized':
                break;
              case 'session.closed':
                if (!inputEnded && !sessionCloseSent) {
                  throw new APIStatusError({
                    message: 'LiveKit STT session closed before input ended',
                    options: { statusCode: -1, retryable: true },
                  });
                }
                sessionClosedReceived = true;
                finishFinalization();
                break;
              case 'start_of_speech':
                this.processStartOfSpeech();
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
                this.#logger.error({ 'lk.pii.event': event }, 'Received error from LiveKit STT');
                resourceCleanup();
                if (event.code === INACTIVITY_TIMEOUT_ERROR_CODE) {
                  throw new APIStatusError({
                    message: 'LiveKit STT returned an error',
                    options: {
                      statusCode: event.code,
                      body: { code: event.code },
                      retryable: false,
                    },
                  });
                }
                throw new APIStatusError({
                  message: `LiveKit Inference STT returned error: ${event.message}`,
                  options: {
                    statusCode: event.code ?? -1,
                    body: event,
                  },
                });
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
        ws =
          this.stt.connectWs === STT.prototype.connectWs
            ? await connectInferenceSTT(
                this.opts,
                this.stt._sessionKeyterms,
                this.connOptions.timeoutMs,
              )
            : await this.stt.connectWs(this.connOptions.timeoutMs);
        // An abort that landed during connectWs has no listener yet: the socket would
        // otherwise idle until the finalization timeout, holding a gateway concurrency slot.
        if (this.abortController.signal.aborted) break;
        this.activeWs = ws;
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

        try {
          const taskResults = [sendTask.result, wsListenerTask.result, recvTask.result];
          if (vadTask) taskResults.push(vadTask.result);

          await ThrowsPromise.all(taskResults);
          break;
        } finally {
          connController.abort();
          this.abortController.signal.removeEventListener('abort', onStreamAbort);
          this.activeWs = undefined;
          vadStream?.close();
          const tasks = [sendTask, wsListenerTask, recvTask];
          if (vadTask) tasks.push(vadTask);
          await cancelAndWait(tasks, DEFAULT_CANCEL_TIMEOUT);
          resourceCleanup();
        }

        if (this.abortController.signal.aborted) break;
      } finally {
        // Ensure cleanup even if connectWs throws
        this.activeWs = undefined;
        resourceCleanup();
      }
    }
  }

  /** Onset reported by a provider that detects it server-side (e.g. Cartesia Ink-2).
   *
   * Without this the first transcript has to stand in for onset, which lands about
   * 800ms late because it waits for a word to be decoded.
   */
  private processStartOfSpeech(): void {
    if (this.queue.closed) return;
    if (this.speaking) return;
    this.speaking = true;
    this.queue.put({ type: SpeechEventType.START_OF_SPEECH });
  }

  private processTranscript(data: SttTranscriptEvent, eventType: SpeechEventType) {
    // Check if queue is closed to avoid race condition during disconnect
    if (this.queue.closed) return;

    const requestId = data.session_id || this.requestId;
    const text = data.transcript;
    const language = normalizeLanguage(data.language || this.opts.language || 'en');

    if (!text && eventType !== SpeechEventType.FINAL_TRANSCRIPT) return;

    try {
      this.processStartOfSpeech();

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
          this.onEndOfSpeech();
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
