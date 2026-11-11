// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { WebSocket } from 'ws';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
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

type STTWriterControl = { kind: 'update'; message: unknown } | { kind: 'handoff'; id: string };

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

export type XaiSTTModels = 'xai/stt-1' | 'xai/stt-2';

export type SpeechmaticsModels =
  | 'speechmatics/enhanced'
  | 'speechmatics/standard'
  | 'speechmatics/linden-1';

export type InworldSTTModels = 'inworld/inworld-stt-1';

export type GoogleSTTModels = 'google/gemini-3.5-transcribe-live';

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
  /** Always true for LiveKit Inference; the passed value is ignored. */
  mip_opt_out?: boolean;
  /** Enable speaker diarization. Default: false. */
  diarize?: boolean;
  /**
   * Languages to bias recognition toward. Only applies in Nova-3 multi language mode: the session
   * must also set `language: 'multi'`. Requires the gateway's `deepgram_stt_language_hint` flag.
   */
  language_hint?: string | string[];
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
  /** Always true for LiveKit Inference; the passed value is ignored. */
  mip_opt_out?: boolean;
  /** Language hint. A list biases recognition toward several languages. */
  language_hint?: string | string[];
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
  /**
   * Include `language_code` and `language_confidence` on final transcripts.
   * Default: true for multilingual and U3 Pro models, false for Universal-Streaming English.
   */
  language_detection?: boolean;
  /** Seconds of inactivity before AssemblyAI closes the session. Default: not specified. */
  inactivity_timeout?: number;
  /** Context describing the audio. Only supported with U3 Pro models; works alongside keyterms_prompt. */
  prompt?: string;
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
  /** Additional vocabulary entries in the form `{ content, sounds_like? }`. */
  additional_vocab?: Array<Record<string, unknown>>;
  /** Seconds of silence before finalizing an utterance. RT only. */
  end_of_utterance_silence_trigger?: number;
  /** Audio filtering configuration. RT only. */
  audio_filtering_config?: Record<string, unknown>;
  /** Transcript filtering configuration. */
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
function keytermsExtraForModel(
  model: string | undefined,
  opts?: {
    extraKwargs?: Record<string, unknown>;
    sessionKeyterms?: string[];
  },
): Record<string, unknown> | undefined {
  if (typeof model !== 'string' || !model) {
    return undefined;
  }

  const extraKwargs = opts?.extraKwargs ?? {};
  const sessionKeyterms = opts?.sessionKeyterms ?? [];

  if (model.startsWith('speechmatics/')) {
    // keep existing entries as-is (they may carry sounds_like etc.); append new session terms
    const rawExisting = extraKwargs.additional_vocab;
    const existing: Record<string, unknown>[] = Array.isArray(rawExisting) ? [...rawExisting] : [];
    const seen = new Set(existing.map((v) => v.content));
    const additions = sessionKeyterms.filter((term) => !seen.has(term));
    return { additional_vocab: [...existing, ...additions.map((term) => ({ content: term }))] };
  }

  let key: string | undefined;
  if (model.startsWith('deepgram/')) {
    key = 'keyterm';
  } else if (model.startsWith('assemblyai/')) {
    key = 'keyterms_prompt';
  }

  if (key === undefined) {
    return undefined;
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
  'xai/stt-2',
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
  | GoogleSTTModels;

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

function isSpeechmaticsRTModel(model: string | undefined): boolean {
  return (model?.startsWith('speechmatics/') && model !== 'speechmatics/linden-1') ?? false;
}

function resolveVADForModel(model: string | undefined, vad: VAD | undefined): VAD | undefined {
  const speechmaticsRT = isSpeechmaticsRTModel(model);
  if (vad && !speechmaticsRT) {
    log().warn({ model }, '`vad` will be ignored: model handles endpointing server-side');
    return undefined;
  }
  if (speechmaticsRT && vad === undefined) {
    // Speechmatics RT doesn't endpoint server-side, so fall back to the in-tree
    // local inference VAD rather than the deprecated silero plugin.
    return new InferenceVAD();
  }
  return vad;
}

/**
 * Deepgram applies `language_hint` only in Nova-3 multi language mode, and the gateway drops the
 * key for every other language, so sending one there is silently ignored. The Flux provider
 * forwards its hint under any language, so Flux models are exempt. False for a non-Deepgram model,
 * whose hint Deepgram's rules say nothing about and which therefore passes through.
 */
function languageHintSendable(model: string | undefined, language: string | undefined): boolean {
  if (!model?.startsWith('deepgram/')) return false;
  if (model.startsWith('deepgram/flux')) return true;
  return (language ?? '').trim().toLowerCase() === 'multi';
}

/**
 * Removes the key from `extra` in place and reports whether it removed one. Only Deepgram's
 * language rules make the key ours to withhold, so another provider's hint is left untouched.
 * Every caller passes a copy of the outgoing frame, so the hint stays in the caller's own options
 * and a later language or model change can send it again.
 */
function dropUnsupportedLanguageHint(
  model: string | undefined,
  language: string | undefined,
  extra: Record<string, unknown>,
): boolean {
  if (!model?.startsWith('deepgram/')) return false;
  if (languageHintSendable(model, language)) return false;
  if (!('language_hint' in extra)) return false;

  delete extra.language_hint;
  return true;
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

/**
 * Livekit Cloud Inference STT
 */
export class STT<TModel extends STTModels> extends BaseSTT {
  private opts: InferenceSTTOptions<TModel>;
  private streams: Set<SpeechStream<TModel>> = new Set();
  private vad?: VAD;
  private _vadPromise?: Promise<VAD | undefined>;
  /** framework-managed; merged into modelOptions @internal */
  _sessionKeyterms: string[] = [];
  #languageHintWarned = false;

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
      sampleRate = DEFAULT_SAMPLE_RATE,
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
      this.vad = resolveVADForModel(nextOpts.model, this.vad);
      this._vadPromise = undefined;
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
      // re-apply the active session keyterms on top of the update sent to live streams,
      // so a user extra update doesn't drop them. `this.opts.modelOptions` must stay a
      // pure user baseline (no session terms baked in), or a later session-keyterm
      // change could never remove previously applied terms.
      const keytermExtra = keytermsExtraForModel(this.opts.model, {
        extraKwargs: this.opts.modelOptions as Record<string, unknown>,
        sessionKeyterms: this._sessionKeyterms,
      });
      if (keytermExtra !== undefined) {
        nextOpts.modelOptions = {
          ...nextOpts.modelOptions,
          ...keytermExtra,
        } as STTOptions<TModel>;
      }
    }

    for (const stream of this.streams) {
      stream.updateOptions(nextOpts);
    }
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    if (
      keyterms.length === this._sessionKeyterms.length &&
      keyterms.every((t, i) => t === this._sessionKeyterms[i])
    ) {
      return;
    }
    const keytermExtra = keytermsExtraForModel(this.opts.model, {
      extraKwargs: this.opts.modelOptions as Record<string, unknown>,
      sessionKeyterms: keyterms,
    });
    if (keytermExtra === undefined) {
      super._updateSessionKeyterms(keyterms); // warn-and-skip for unsupported models
      return;
    }

    this._sessionKeyterms = [...keyterms];
    // inference applies extra live via session.update; defer to END_OF_SPEECH since the
    // gateway may reconnect upstream when the keyterms change
    for (const stream of this.streams) {
      if (stream._speaking) {
        stream._pendingExtra = keytermExtra;
      } else {
        stream.updateOptions({ modelOptions: keytermExtra as STTOptions<TModel> });
      }
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

  /**
   * Warn once per instance that a `language_hint` is being left off the wire, whether that happens
   * at connect time or in a mid-session update. The hint stays in the caller's `modelOptions`, so
   * a later change that makes it applicable sends it again.
   *
   * @internal
   */
  _warnLanguageHintIgnored(model: string | undefined, language: string | undefined): void {
    if (this.#languageHintWarned) return;
    this.#languageHintWarned = true;
    const sessionLanguage = language?.trim() ? language : 'unset';
    this.#logger.warn(
      `Ignoring \`language_hint\` for ${model}: it only applies with language "multi" (session language "${sessionLanguage}")`,
    );
  }

  async connectWs(
    timeout: number,
    opts: InferenceSTTOptions<TModel> = this.opts,
    sessionKeyterms: string[] = this._sessionKeyterms,
    handoffProbeId?: string,
  ): Promise<WebSocket> {
    // a copy of the caller's options: the hint is gated on this frame, never cleared from them
    const extra = {
      ...opts.modelOptions,
      ...(keytermsExtraForModel(opts.model, {
        extraKwargs: opts.modelOptions as Record<string, unknown>,
        sessionKeyterms,
      }) ?? {}),
    } as Record<string, unknown>;

    if (dropUnsupportedLanguageHint(opts.model, opts.language, extra)) {
      this._warnLanguageHintIgnored(opts.model, opts.language);
    }

    const params = {
      handoff_protocol: 1,
      settings: {
        sample_rate: String(opts.sampleRate),
        encoding: opts.encoding,
        // the framework session keyterms into the user's extra_kwargs keyterm key)
        extra,
      },
    } as Record<string, unknown>;

    if (handoffProbeId !== undefined) params.handoff_probe = { handoff_id: handoffProbeId };

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
    const msg = { ...params, type: 'session.create' };
    socket.send(JSON.stringify(msg));

    return socket;
  }
}

export class SpeechStream<TModel extends STTModels> extends BaseSpeechStream {
  private opts: InferenceSTTOptions<TModel>;
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
  private requestedHandoffId?: string;
  private handoffSerialized = false;
  private handoffId?: string;
  private handoffWrites: { encoded: string; onSent?: () => void; discardOnRetry?: boolean }[] = [];
  private abortHandoff?: () => void;
  private pendingUpdateAcks = 0;
  private updateUncertain = false;
  private handoffAudioOffset = 0;
  private connectionAudioDuration = 0;
  private retryHandoffOpts?: InferenceSTTOptions<TModel>;
  private retryHandoffKeyterms?: string[];

  private sendOrBuffer(message: unknown, onSent?: () => void, discardOnRetry = false): void {
    const encoded = JSON.stringify(message);
    if (this.handoffId !== undefined) {
      if (this.handoffWrites.length < 1024) {
        this.handoffWrites.push({ encoded, onSent, discardOnRetry });
        return;
      }
      try {
        this.abortHandoff?.();
      } catch {
        throw new APIConnectionError({ message: 'STT handoff could not resume' });
      }
    }
    if (!this.activeWs || this.activeWs.readyState !== 1) {
      throw new APIConnectionError({ message: 'STT WebSocket is closed' });
    }
    try {
      this.activeWs.send(encoded);
    } catch {
      throw new APIConnectionError({ message: 'STT WebSocket write failed' });
    }
    onSent?.();
  }

  private releaseHandoffWrites(socket: WebSocket): void {
    while (this.handoffWrites.length > 0) {
      const next = this.handoffWrites[0]!;
      if (socket.readyState !== 1)
        throw new APIConnectionError({ message: 'STT WebSocket is closed' });
      try {
        socket.send(next.encoded);
      } catch {
        throw new APIConnectionError({ message: 'STT WebSocket write failed' });
      }
      this.handoffWrites.shift();
      next.onSent?.();
    }
  }

  #logger = log();

  constructor(
    sttImpl: STT<TModel>,
    opts: InferenceSTTOptions<TModel>,
    connOptions: APIConnectOptions,
  ) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.opts = opts;
    this.stt = sttImpl;
    this.connOptions = connOptions;
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
    const mergedModelOptions = opts.modelOptions
      ? ({ ...this.opts.modelOptions, ...opts.modelOptions } as STTOptions<TModel>)
      : this.opts.modelOptions;

    this.opts = {
      ...this.opts,
      ...opts,
      language: opts.language !== undefined ? normalizeLanguage(opts.language) : this.opts.language,
      modelOptions: mergedModelOptions,
    };

    if (opts.modelOptions !== undefined) {
      this._pendingExtra = undefined;
    }

    // When the WebSocket is live, send a mid-stream session.update so providers
    // that support it (e.g. AssemblyAI, Deepgram Flux) apply changes without
    // reconnecting. Unsupported providers ignore the message.
    if (this.activeWs && this.activeWs.readyState === 1) {
      const settings: Record<string, unknown> = {};
      // the hint the model and language can carry right now, if the caller configured one
      const hint = languageHintSendable(this.opts.model, this.opts.language)
        ? (this.opts.modelOptions as Record<string, unknown>).language_hint
        : undefined;
      if (opts.model !== undefined) settings.model = opts.model;
      if (opts.language !== undefined) settings.language = normalizeLanguage(opts.language);
      if (opts.modelOptions !== undefined) {
        // judged against the language this.opts already merged, so an update that sets `multi`
        // keeps a hint supplied in the same call
        const extra = { ...opts.modelOptions } as Record<string, unknown>;
        if (dropUnsupportedLanguageHint(this.opts.model, this.opts.language, extra)) {
          this.stt._warnLanguageHintIgnored(this.opts.model, this.opts.language);
        }
        // this frame carries the caller's keys alone, so a configured hint that no earlier frame
        // could send is added to it, and only that key
        if (hint !== undefined) extra.language_hint = hint;
        settings.extra = extra;
      } else if (opts.language !== undefined || opts.model !== undefined) {
        // A language or model change decides whether the configured hint can go on the wire, and
        // no frame carried it while it could not: send it now that it can.
        if (hint !== undefined) {
          settings.extra = { language_hint: hint };
        }
      }
      if (Object.keys(settings).length > 0) {
        try {
          if (this.handoffSerialized) {
            (this.input as unknown as { put(value: STTWriterControl): void }).put({
              kind: 'update',
              message: { type: 'session.update', settings },
            });
          } else {
            this.sendOrBuffer({ type: 'session.update', settings }, () => {
              this.pendingUpdateAcks++;
            });
          }
        } catch (e) {
          this.#logger.debug({ err: e }, 'failed to send session.update, ws may be closing');
        }
      }
    }
  }

  private onEndOfSpeech(): void {
    if (this._pendingExtra !== undefined) {
      this.updateOptions({ modelOptions: this._pendingExtra as STTOptions<TModel> });
      this._pendingExtra = undefined;
    }
  }

  protected async run(): Promise<void> {
    this.handoffAudioOffset = 0;
    this.connectionAudioDuration = 0;
    while (true) {
      const vad = await this.stt.vadPromise;
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
      let replacementWs: WebSocket | undefined;
      let replacementMessageMonitor: (() => void) | undefined;
      let attachSocket: ((socket: WebSocket) => void) | undefined;
      let handoffOpts: InferenceSTTOptions<TModel> | undefined;
      let handoffKeyterms: string[] = [];
      let audioStream: AudioByteStream | undefined;
      let handoffTimer: ReturnType<typeof setTimeout> | undefined;

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

      const sendSessionFinalize = (onSent?: () => void) => {
        this.sendOrBuffer({ type: 'session.finalize' }, onSent, onSent !== undefined);
      };

      const resourceCleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (this.requestedHandoffId !== undefined || this.handoffWrites.length > 0) {
          this.retryHandoffOpts = handoffOpts ?? this.retryHandoffOpts;
          this.retryHandoffKeyterms = handoffOpts ? handoffKeyterms : this.retryHandoffKeyterms;
          if (audioStream && this.retryHandoffOpts !== undefined) {
            for (const frame of audioStream.flush()) {
              const audio = Buffer.from(frame.data.buffer).toString('base64');
              this.handoffWrites.push({
                encoded: JSON.stringify({ type: 'input_audio', audio }),
                onSent: () => {
                  this.speechDuration += frame.samplesPerChannel / frame.sampleRate;
                  this.connectionAudioDuration += frame.samplesPerChannel / frame.sampleRate;
                },
              });
            }
          }
          this.requestedHandoffId = undefined;
          this.handoffId = undefined;
          this.abortHandoff = undefined;
          this.handoffWrites = this.handoffWrites.filter((entry) => !entry.discardOnRetry);
        }
        if (finalizationTimeout) clearTimeout(finalizationTimeout);
        if (handoffTimer) clearTimeout(handoffTimer);
        replacementWs?.close();
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

          attachSocket = (socket: WebSocket) => {
            socket.on('message', (data) => {
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

            socket.on('error', (e) => {
              if (socket !== this.activeWs) return;
              this.#logger.error({ error: e }, 'WebSocket error');
              resourceCleanup();
              reject(e);
            });

            socket.on('close', (code: number) => {
              if (socket !== this.activeWs) return;
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
          };
          attachSocket(ws);
        });
      };

      const sendAudioFrame = (frame: AudioFrame) => {
        const base64 = Buffer.from(frame.data.buffer).toString('base64');
        this.sendOrBuffer({ type: 'input_audio', audio: base64 }, () => {
          this.speechDuration += frame.samplesPerChannel / frame.sampleRate;
          this.connectionAudioDuration += frame.samplesPerChannel / frame.sampleRate;
        });
      };

      const send = async (signal: AbortSignal) => {
        audioStream = new AudioByteStream(
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

          if (typeof ev === 'object' && ev !== null && 'kind' in ev) {
            const control = ev as unknown as STTWriterControl;
            if (control.kind === 'update') {
              this.sendOrBuffer(control.message, () => {
                this.pendingUpdateAcks++;
              });
            } else if (
              control.kind === 'handoff' &&
              control.id === this.requestedHandoffId &&
              this.activeWs
            ) {
              for (const frame of audioStream.flush()) sendAudioFrame(frame);
              this.handoffId = control.id;
              this.activeWs.send(
                JSON.stringify({ type: 'session.handoff.pause', handoff_id: control.id }),
              );
            }
            continue;
          }

          let frames: AudioFrame[];
          if (ev === SpeechStream.FLUSH_SENTINEL) {
            frames = audioStream.flush();
          } else {
            const frame = ev as AudioFrame;
            vadStream?.pushFrame(frame);
            frames = audioStream.write(new Int16Array(frame.data).buffer);
          }

          for (const frame of frames) {
            sendAudioFrame(frame);
          }
        }

        vadStream?.endInput();
        sendSessionFinalize(() => {
          inputEnded = true;
          scheduleFinalizationTimeout();
        });
      };

      const processVAD = async (stream: VADStream, signal: AbortSignal) => {
        // VADStream.next() does not support cancellation.
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const { result, isAborted } = await waitUntilAborted(iterator.next(), signal);
          if (isAborted) return;
          if (result.done) break;
          if (result.value.type !== VADEventType.END_OF_SPEECH) continue;
          if (this.activeWs?.readyState !== 1) return;
          sendSessionFinalize();
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

            const handoff = result.value as { type: string; handoff_id?: unknown };
            if (handoff.type === 'session.updated') {
              const ack = result.value as { success?: unknown };
              if (this.pendingUpdateAcks > 0) this.pendingUpdateAcks--;
              else this.updateUncertain = true;
              if (ack.success !== true) this.updateUncertain = true;
              continue;
            }
            if (
              handoff.type === 'session.handoff.request' &&
              typeof handoff.handoff_id === 'string' &&
              this.requestedHandoffId === undefined &&
              this.activeWs
            ) {
              if (vadStream || this._pendingExtra !== undefined) {
                this.activeWs.send(
                  JSON.stringify({ type: 'session.handoff.abort', handoff_id: handoff.handoff_id }),
                );
                continue;
              }
              this.handoffSerialized = true;
              this.requestedHandoffId = handoff.handoff_id;
              handoffOpts = {
                ...this.opts,
                modelOptions: { ...this.opts.modelOptions },
              } as InferenceSTTOptions<TModel>;
              handoffKeyterms = [...this.stt._sessionKeyterms];
              this.retryHandoffOpts = handoffOpts;
              this.retryHandoffKeyterms = handoffKeyterms;
              this.abortHandoff = () => {
                if (this.requestedHandoffId === undefined || !this.activeWs) return;
                this.activeWs.send(
                  JSON.stringify({
                    type: 'session.handoff.abort',
                    handoff_id: this.requestedHandoffId,
                  }),
                );
                this.requestedHandoffId = undefined;
                this.handoffId = undefined;
                replacementWs?.close();
                replacementWs = undefined;
                this.releaseHandoffWrites(this.activeWs);
                this.retryHandoffOpts = undefined;
                this.retryHandoffKeyterms = undefined;
              };
              handoffTimer = setTimeout(() => {
                try {
                  this.abortHandoff?.();
                } catch {
                  this.activeWs?.terminate();
                }
              }, 10_000);
              try {
                (this.input as unknown as { put(value: STTWriterControl): void }).put({
                  kind: 'handoff',
                  id: handoff.handoff_id,
                });
              } catch {
                this.abortHandoff();
              }
              continue;
            }
            if (
              handoff.type === 'session.handoff.abort' &&
              handoff.handoff_id === this.requestedHandoffId
            ) {
              if (handoffTimer) clearTimeout(handoffTimer);
              this.abortHandoff = undefined;
              this.requestedHandoffId = undefined;
              this.handoffId = undefined;
              replacementWs?.close();
              replacementWs = undefined;
              if (this.activeWs) {
                this.releaseHandoffWrites(this.activeWs);
                this.retryHandoffOpts = undefined;
                this.retryHandoffKeyterms = undefined;
              }
              continue;
            }
            if (
              handoff.type === 'session.handoff.drained' &&
              handoff.handoff_id === this.handoffId &&
              this.activeWs
            ) {
              if (this.pendingUpdateAcks > 0 || this.updateUncertain) {
                this.abortHandoff?.();
                continue;
              }
              const requestedId = this.handoffId;
              let next: WebSocket | undefined;
              try {
                next = await this.stt.connectWs(
                  this.connOptions.timeoutMs,
                  handoffOpts,
                  handoffKeyterms,
                  requestedId,
                );
                replacementWs = next;
                const created = await new Promise<boolean>((resolve) => {
                  let sawCreated = false;
                  const timer = setTimeout(() => finish(false), this.connOptions.timeoutMs);
                  const finish = (ok: boolean) => {
                    clearTimeout(timer);
                    next?.off('message', onMessage);
                    next?.off('close', onClose);
                    next?.off('error', onClose);
                    resolve(ok);
                  };
                  const onMessage = (raw: import('ws').RawData) => {
                    try {
                      const event = JSON.parse(raw.toString()) as {
                        type: string;
                        handoff_id?: string;
                      };
                      if (event.type === 'session.created') {
                        sawCreated = true;
                        return;
                      }
                      finish(
                        sawCreated &&
                          event.type === 'session.handoff.ready' &&
                          event.handoff_id === requestedId,
                      );
                    } catch {
                      finish(false);
                    }
                  };
                  const onClose = () => finish(false);
                  next?.on('message', onMessage);
                  next?.once('close', onClose);
                  next?.once('error', onClose);
                });
                if (!created) throw new Error('replacement STT session was refused');
                if (signal.aborted || this.handoffId !== requestedId) {
                  next.close();
                  continue;
                }
              } catch {
                next?.close();
                this.abortHandoff?.();
                continue;
              }
              replacementWs = next;
              const replacementFailed = () => {
                if (replacementWs === next && this.handoffId === requestedId) this.abortHandoff?.();
              };
              next.on('error', replacementFailed);
              next.on('close', replacementFailed);
              replacementMessageMonitor = replacementFailed;
              next.on('message', replacementMessageMonitor);
              this.activeWs.send(
                JSON.stringify({ type: 'session.handoff.complete', handoff_id: this.handoffId }),
              );
              continue;
            }
            if (
              handoff.type === 'session.handoff.accepted' &&
              handoff.handoff_id === this.handoffId &&
              replacementWs &&
              this.activeWs
            ) {
              if (replacementWs.readyState !== 1) {
                this.abortHandoff?.();
                continue;
              }
              const old = this.activeWs;
              if (replacementMessageMonitor) {
                replacementWs.off('message', replacementMessageMonitor);
                replacementMessageMonitor = undefined;
              }
              try {
                old.send(
                  JSON.stringify({ type: 'session.handoff.switched', handoff_id: this.handoffId }),
                );
              } catch {
                // The replacement is ready even if the old socket closes before the metric acknowledgment.
              }
              this.activeWs = replacementWs;
              ws = replacementWs;
              replacementWs = undefined;
              attachSocket?.(this.activeWs);
              this.handoffAudioOffset += this.connectionAudioDuration;
              this.connectionAudioDuration = 0;
              if (handoffTimer) clearTimeout(handoffTimer);
              this.abortHandoff = undefined;
              this.requestedHandoffId = undefined;
              this.handoffId = undefined;
              this.releaseHandoffWrites(this.activeWs);
              this.retryHandoffOpts = undefined;
              this.retryHandoffKeyterms = undefined;
              old.close();
              continue;
            }

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
        ws = await this.stt.connectWs(
          this.connOptions.timeoutMs,
          this.retryHandoffOpts ?? this.opts,
          this.retryHandoffKeyterms,
        );
        // An abort that landed during connectWs has no listener yet: the socket would
        // otherwise idle until the finalization timeout, holding a gateway concurrency slot.
        if (this.abortController.signal.aborted) break;
        this.activeWs = ws;
        this.pendingUpdateAcks = 0;
        this.updateUncertain = false;
        if (this.retryHandoffOpts) {
          this.releaseHandoffWrites(ws);
          this.retryHandoffOpts = undefined;
          this.retryHandoffKeyterms = undefined;
        }
        vadStream = vad?.stream() ?? null;

        // Use a per-connection controller so reconnect loops don't inherit a permanently-aborted signal.
        const connController = new AbortController();
        const onStreamAbort = () => connController.abort();
        this.abortController.signal.addEventListener('abort', onStreamAbort);

        const sendTask = Task.from(({ signal }) => send(signal), connController);
        const wsListenerTask = Task.from(
          ({ signal }) => createWsListener(ws!, signal),
          connController,
        );
        const recvTask = Task.from(({ signal }) => recv(signal), connController);
        const activeVADStream = vadStream;
        const vadTask = activeVADStream
          ? Task.from(({ signal }) => processVAD(activeVADStream, signal), connController)
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
        startTime: this.startTimeOffset + this.handoffAudioOffset + data.start,
        endTime: this.startTimeOffset + this.handoffAudioOffset + data.start + data.duration,
        confidence: data.confidence,
        text,
        speakerId: data.speaker_id ?? undefined,
        words: data.words.map(
          (word): TimedString =>
            createTimedString({
              text: word.word,
              startTime: word.start + this.startTimeOffset + this.handoffAudioOffset,
              endTime: word.end + this.startTimeOffset + this.handoffAudioOffset,
              startTimeOffset: this.startTimeOffset + this.handoffAudioOffset,
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
