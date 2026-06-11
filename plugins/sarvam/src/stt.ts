// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  AudioEnergyFilter,
  Future,
  Task,
  log,
  mergeFrames,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type {
  STTLanguages,
  STTModels,
  STTModes,
  STTV2Languages,
  STTV3Languages,
} from './models.js';

// ---------------------------------------------------------------------------
// Endpoint URLs
// ---------------------------------------------------------------------------

const SARVAM_STT_REST_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_STT_TRANSLATE_REST_URL = 'https://api.sarvam.ai/speech-to-text-translate';
const SARVAM_STT_WS_URL = 'wss://api.sarvam.ai/speech-to-text/ws';
const SARVAM_STT_TRANSLATE_WS_URL = 'wss://api.sarvam.ai/speech-to-text-translate/ws';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const EOS_FALLBACK_TIMEOUT = 1000;

// ---------------------------------------------------------------------------
// Model-specific option types
// ---------------------------------------------------------------------------

interface STTBaseOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
  /**
   * Whether to use native WebSocket streaming for `stream()`.
   * Set to `false` to prefer non-streaming REST recognition (used by Agent via StreamAdapter + VAD).
   * Default: `true`.
   */
  streaming?: boolean;
  /** Increase VAD sensitivity (WS only). Maps to `high_vad_sensitivity` query param. */
  highVadSensitivity?: boolean;
  /** Enable flush signal events from server (WS only). Maps to `flush_signal` query param. */
  flushSignal?: boolean;
}

/**
 * Options specific to saarika:v2.5.
 * saarika:v2.5 will be deprecated soon — prefer {@link STTV3Options} with `saaras:v3` for new integrations.
 * All v2.5 language codes are also supported by v3.
 * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe | Sarvam STT API docs}
 */
export interface STTV2Options extends STTBaseOptions {
  model: 'saarika:v2.5';
  /** Language code (BCP-47). Default: 'en-IN'. Set to 'unknown' for auto-detection. */
  languageCode?: STTV2Languages | string;
  /** Return chunk-level timestamps in REST response */
  withTimestamps?: boolean;
}

/**
 * Options specific to saaras:v2.5 (dedicated translate endpoint).
 * Uses the `/speech-to-text-translate` endpoint for Indic-to-English translation.
 * Auto-detects the source language; does not accept language codes or timestamps.
 * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text-translate/translate | Sarvam STT Translate docs}
 */
export interface STTTranslateOptions extends STTBaseOptions {
  model: 'saaras:v2.5';
  /** Conversation context to boost model accuracy */
  prompt?: string;
  /** Mode for translate WS. Default: 'translate'. */
  mode?: STTModes | string;
}

/**
 * Options specific to saaras:v3 (recommended).
 * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe | Sarvam STT API docs}
 */
export interface STTV3Options extends STTBaseOptions {
  model?: 'saaras:v3';
  /** Language code (BCP-47). Default: 'en-IN'. Set to 'unknown' for auto-detection. */
  languageCode?: STTV3Languages | string;
  /** Transcription mode (v3 only). Default: 'transcribe' */
  mode?: STTModes | string;
  /** Conversation context to boost model accuracy */
  prompt?: string;
  /** Return chunk-level timestamps in REST response */
  withTimestamps?: boolean;
  /** Fine-grained VAD positive speech threshold (WS only). */
  positiveSpeechThreshold?: number;
  /** Fine-grained VAD negative speech threshold (WS only). */
  negativeSpeechThreshold?: number;
  /** Fine-grained VAD minimum speech frames (WS only). */
  minSpeechFrames?: number;
  /** Fine-grained VAD first-turn minimum speech frames (WS only). */
  firstTurnMinSpeechFrames?: number;
  /** Fine-grained VAD negative frames count (WS only). */
  negativeFramesCount?: number;
  /** Fine-grained VAD negative frames window (WS only). */
  negativeFramesWindow?: number;
  /** Fine-grained VAD start speech volume threshold (WS only). */
  startSpeechVolumeThreshold?: number;
  /** Fine-grained VAD interrupt minimum speech frames (WS only). */
  interruptMinSpeechFrames?: number;
  /** Fine-grained VAD pre-speech padding frames (WS only). */
  preSpeechPadFrames?: number;
  /** Fine-grained VAD initial ignored frames (WS only). */
  numInitialIgnoredFrames?: number;
}

/** Combined options — discriminated by `model` field */
export type STTOptions = STTV2Options | STTTranslateOptions | STTV3Options;

// ---------------------------------------------------------------------------
// Resolved (internal) options — flat union of all fields
// ---------------------------------------------------------------------------

interface ResolvedSTTOptions {
  apiKey: string;
  model: STTModels;
  streaming: boolean;
  // saarika:v2.5 and saaras:v3 only — not used by saaras:v2.5 (translate auto-detects)
  languageCode?: STTLanguages | string;
  // saaras:v3 and saaras:v2.5 (translate)
  mode?: STTModes | string;
  // saaras:v2.5 (translate) and saaras:v3
  prompt?: string;
  // saarika:v2.5 and saaras:v3 (/speech-to-text only, not translate)
  withTimestamps?: boolean;
  // WS-only flags
  highVadSensitivity?: boolean;
  flushSignal?: boolean;
  // saaras:v3 WS-only fine-grained VAD params
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechFrames?: number;
  firstTurnMinSpeechFrames?: number;
  negativeFramesCount?: number;
  negativeFramesWindow?: number;
  startSpeechVolumeThreshold?: number;
  interruptMinSpeechFrames?: number;
  preSpeechPadFrames?: number;
  numInitialIgnoredFrames?: number;
}

// ---------------------------------------------------------------------------
// Defaults per model
// ---------------------------------------------------------------------------

const SAARIKA_DEFAULTS = {
  languageCode: 'en-IN',
};

const SAARAS_V3_DEFAULTS = {
  languageCode: 'en-IN',
  mode: 'transcribe',
};

const SAARAS_TRANSLATE_DEFAULTS = {
  mode: 'translate',
};

/** Runtime set of languages supported by saarika:v2.5 (for validation on model switch) */
const STTV2_LANGUAGE_SET: ReadonlySet<string> = new Set<STTV2Languages>([
  'unknown',
  'hi-IN',
  'bn-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
  'en-IN',
  'gu-IN',
]);

// ---------------------------------------------------------------------------
// Resolve caller options into a fully-populated internal struct
// ---------------------------------------------------------------------------

function resolveOptions(opts: Partial<STTOptions>): ResolvedSTTOptions {
  const apiKey = opts.apiKey ?? process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error('Sarvam API key is required, whether as an argument or as $SARVAM_API_KEY');
  }

  const model: STTModels = opts.model ?? 'saaras:v3';

  const base: ResolvedSTTOptions = {
    apiKey,
    model,
    streaming: opts.streaming ?? true,
    highVadSensitivity: opts.highVadSensitivity,
    flushSignal: opts.flushSignal,
  };

  if (model === 'saaras:v2.5') {
    const translateOpts = opts as STTTranslateOptions;
    base.prompt = translateOpts.prompt;
    base.mode = translateOpts.mode ?? SAARAS_TRANSLATE_DEFAULTS.mode;
  } else if (model === 'saaras:v3') {
    const v3Opts = opts as STTV3Options;
    base.languageCode = normalizeLanguage(v3Opts.languageCode ?? SAARAS_V3_DEFAULTS.languageCode);
    base.mode = v3Opts.mode ?? SAARAS_V3_DEFAULTS.mode;
    base.prompt = v3Opts.prompt;
    base.withTimestamps = v3Opts.withTimestamps;
    base.positiveSpeechThreshold = v3Opts.positiveSpeechThreshold;
    base.negativeSpeechThreshold = v3Opts.negativeSpeechThreshold;
    base.minSpeechFrames = v3Opts.minSpeechFrames;
    base.firstTurnMinSpeechFrames = v3Opts.firstTurnMinSpeechFrames;
    base.negativeFramesCount = v3Opts.negativeFramesCount;
    base.negativeFramesWindow = v3Opts.negativeFramesWindow;
    base.startSpeechVolumeThreshold = v3Opts.startSpeechVolumeThreshold;
    base.interruptMinSpeechFrames = v3Opts.interruptMinSpeechFrames;
    base.preSpeechPadFrames = v3Opts.preSpeechPadFrames;
    base.numInitialIgnoredFrames = v3Opts.numInitialIgnoredFrames;
  } else {
    // saarika:v2.5
    let languageCode = normalizeLanguage(
      (opts as STTV2Options).languageCode ?? SAARIKA_DEFAULTS.languageCode,
    );
    if (!STTV2_LANGUAGE_SET.has(languageCode)) {
      languageCode = normalizeLanguage(SAARIKA_DEFAULTS.languageCode);
    }
    base.languageCode = languageCode;
    base.withTimestamps = (opts as STTV2Options).withTimestamps;
  }

  return base;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function getRestUrl(model: STTModels): string {
  return model === 'saaras:v2.5' ? SARVAM_STT_TRANSLATE_REST_URL : SARVAM_STT_REST_URL;
}

function getWsUrl(model: STTModels): string {
  return model === 'saaras:v2.5' ? SARVAM_STT_TRANSLATE_WS_URL : SARVAM_STT_WS_URL;
}

function buildWsUrl(opts: ResolvedSTTOptions): string {
  const base = getWsUrl(opts.model);
  const params = new URLSearchParams();
  params.set('model', opts.model);
  params.set('vad_signals', 'true');
  params.set('sample_rate', String(SAMPLE_RATE));
  params.set('input_audio_codec', 'pcm_s16le');

  if (opts.model !== 'saaras:v2.5' && opts.languageCode != null) {
    params.set('language-code', opts.languageCode);
  }

  // mode: v3 on STT WS, and translate WS (both endpoints support it)
  if (opts.mode != null) {
    params.set('mode', opts.mode);
  }

  // Optional WS params
  if (opts.highVadSensitivity != null) {
    params.set('high_vad_sensitivity', String(opts.highVadSensitivity));
  }
  if (opts.flushSignal != null) {
    params.set('flush_signal', String(opts.flushSignal));
  }
  if (opts.model === 'saaras:v3') {
    if (opts.positiveSpeechThreshold != null) {
      params.set('positive_speech_threshold', String(opts.positiveSpeechThreshold));
    }
    if (opts.negativeSpeechThreshold != null) {
      params.set('negative_speech_threshold', String(opts.negativeSpeechThreshold));
    }
    if (opts.minSpeechFrames != null) {
      params.set('min_speech_frames', String(opts.minSpeechFrames));
    }
    if (opts.firstTurnMinSpeechFrames != null) {
      params.set('first_turn_min_speech_frames', String(opts.firstTurnMinSpeechFrames));
    }
    if (opts.negativeFramesCount != null) {
      params.set('negative_frames_count', String(opts.negativeFramesCount));
    }
    if (opts.negativeFramesWindow != null) {
      params.set('negative_frames_window', String(opts.negativeFramesWindow));
    }
    if (opts.startSpeechVolumeThreshold != null) {
      params.set('start_speech_volume_threshold', String(opts.startSpeechVolumeThreshold));
    }
    if (opts.interruptMinSpeechFrames != null) {
      params.set('interrupt_min_speech_frames', String(opts.interruptMinSpeechFrames));
    }
    if (opts.preSpeechPadFrames != null) {
      params.set('pre_speech_pad_frames', String(opts.preSpeechPadFrames));
    }
    if (opts.numInitialIgnoredFrames != null) {
      params.set('num_initial_ignored_frames', String(opts.numInitialIgnoredFrames));
    }
  }

  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Build the multipart form data (REST) — only sends model-relevant fields
// ---------------------------------------------------------------------------

function buildFormData(wavBlob: Blob, opts: ResolvedSTTOptions): FormData {
  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  formData.append('model', opts.model);

  if (opts.model !== 'saaras:v2.5' && opts.languageCode != null) {
    formData.append('language_code', opts.languageCode);
  }
  if (opts.model === 'saaras:v3' && opts.mode != null) {
    formData.append('mode', opts.mode);
  }
  if ((opts.model === 'saaras:v2.5' || opts.model === 'saaras:v3') && opts.prompt != null) {
    formData.append('prompt', opts.prompt);
  }
  if (opts.model !== 'saaras:v2.5' && opts.withTimestamps) {
    formData.append('with_timestamps', 'true');
  }

  return formData;
}

// ---------------------------------------------------------------------------
// WAV encoding helper
// ---------------------------------------------------------------------------

function createWav(frame: AudioFrame): Buffer {
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
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);

  const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  return Buffer.concat([header, pcm]);
}

function extractConfidence(
  payload: { language_probability?: unknown },
  logger: ReturnType<typeof log>,
): number {
  const value = payload.language_probability;
  if (typeof value === 'number') {
    return value;
  }
  if (value != null) {
    logger.debug(
      `Unexpected language_probability type: ${typeof value} (value=${JSON.stringify(value)}); falling back to confidence=1.0`,
    );
  }
  return 1;
}

// ---------------------------------------------------------------------------
// REST response type
// ---------------------------------------------------------------------------

interface SarvamSTTResponse {
  request_id: string | null;
  transcript: string;
  language_code: string | null;
  language_probability?: number | null;
  timestamps?: {
    words: string[];
    start_time_seconds: number[];
    end_time_seconds: number[];
  } | null;
}

// ---------------------------------------------------------------------------
// WS response types (from server Publish messages)
// ---------------------------------------------------------------------------

/** type: "data" */
interface SarvamWSTranscriptData {
  request_id?: string;
  transcript?: string;
  language_code?: string | null;
  language_probability?: number | null;
  speech_start?: number | null;
  speech_end?: number | null;
  timestamps?: Record<string, unknown> | null;
  diarized_transcript?: Record<string, unknown> | null;
  metrics?: {
    audio_duration?: number;
    processing_latency?: number;
  };
}

/** type: "events" */
interface SarvamWSEventData {
  request_id?: string;
  event_type?: string;
  timestamp?: string;
  signal_type?: 'START_SPEECH' | 'END_SPEECH';
  occured_at?: number;
}

/** type: "error" — server sends data with message and code fields */
interface SarvamWSErrorData {
  message?: string;
  error?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// STT class — supports both REST (recognize) and WebSocket (stream)
// ---------------------------------------------------------------------------

export class STT extends stt.STT {
  private opts: ResolvedSTTOptions;
  label = 'sarvam.STT';

  /**
   * Create a new instance of Sarvam AI STT.
   *
   * @remarks
   * `apiKey` must be set to your Sarvam API key, either using the argument or by setting the
   * `SARVAM_API_KEY` environment variable.
   *
   * Supported models:
   * - `saaras:v3` (default, recommended) — supports all 22 languages, modes, prompt, timestamps, and uses `/speech-to-text`.
   * - `saaras:v2.5` — Indic-to-English translation via `/speech-to-text-translate`. Auto-detects source language. Supports prompt.
   * - `saarika:v2.5` — will be deprecated soon. Supports timestamps. All its languages are available in `saaras:v3`.
   *
   * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe | Sarvam STT API docs}
   * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text-translate/translate | Sarvam STT Translate docs}
   */
  constructor(opts: Partial<STTOptions> = {}) {
    const resolved = resolveOptions(opts);
    super({
      streaming: resolved.streaming,
      interimResults: false,
      alignedTranscript: false,
    });
    this.opts = resolved;
  }

  updateOptions(opts: Partial<STTOptions>) {
    const modelChanging = opts.model != null && opts.model !== this.opts.model;

    const base: Partial<STTOptions> = modelChanging
      ? {
          apiKey: this.opts.apiKey,
          streaming: this.opts.streaming,
          ...(this.opts.highVadSensitivity != null
            ? { highVadSensitivity: this.opts.highVadSensitivity }
            : {}),
          ...(this.opts.flushSignal != null ? { flushSignal: this.opts.flushSignal } : {}),
          ...(this.opts.languageCode != null && opts.model !== 'saaras:v2.5'
            ? { languageCode: this.opts.languageCode as STTV3Languages }
            : {}),
        }
      : ({ ...this.opts } as Partial<STTOptions>);

    this.opts = resolveOptions({ ...base, ...opts } as STTOptions);
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const wavBuffer = createWav(frame);
    const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });

    const formData = buildFormData(wavBlob, this.opts);

    const response = await fetch(getRestUrl(this.opts.model), {
      method: 'POST',
      headers: {
        'api-subscription-key': this.opts.apiKey,
      },
      body: formData,
      signal: abortSignal ?? null,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Sarvam STT API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as SarvamSTTResponse;
    const logger = log();

    let startTime = 0;
    let endTime = 0;
    if (data.timestamps) {
      const starts = data.timestamps.start_time_seconds;
      const ends = data.timestamps.end_time_seconds;
      if (starts.length > 0) startTime = starts[0] ?? 0;
      if (ends.length > 0) endTime = ends[ends.length - 1] ?? 0;
    }

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: data.request_id ?? undefined,
      alternatives: [
        {
          text: data.transcript || '',
          language: normalizeLanguage(data.language_code ?? this.opts.languageCode ?? 'unknown'),
          startTime,
          endTime,
          confidence: extractConfidence(data, logger),
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    if (!this.capabilities.streaming) {
      throw new Error(
        'Sarvam STT streaming is disabled (`streaming: false`). Use recognize() for REST or wrap with stt.StreamAdapter + VAD for streaming behavior.',
      );
    }
    return new SpeechStream(this, this.opts, options?.connOptions);
  }
}

// ---------------------------------------------------------------------------
// WebSocket streaming SpeechStream
// ---------------------------------------------------------------------------

export class SpeechStream extends stt.SpeechStream {
  #opts: ResolvedSTTOptions;
  #audioEnergyFilter: AudioEnergyFilter;
  #logger = log();
  #speaking = false;
  #resetWS = new Future();
  #requestId = '';
  #pendingFinalData: SarvamWSTranscriptData | undefined;
  #pendingEos = false;
  #eosFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  #finalReceivedForUtterance = false;
  #eosEmittedForUtterance = false;
  label = 'sarvam.SpeechStream';

  constructor(sttInstance: STT, opts: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, SAMPLE_RATE, connOptions);
    this.#opts = opts;
    this.closed = false;
    this.#audioEnergyFilter = new AudioEnergyFilter();
  }

  updateOptions(opts: Partial<STTOptions>) {
    const modelChanging = opts.model != null && opts.model !== this.#opts.model;

    const base: Partial<STTOptions> = modelChanging
      ? {
          apiKey: this.#opts.apiKey,
          ...(this.#opts.highVadSensitivity != null
            ? { highVadSensitivity: this.#opts.highVadSensitivity }
            : {}),
          ...(this.#opts.flushSignal != null ? { flushSignal: this.#opts.flushSignal } : {}),
          ...(this.#opts.languageCode != null && opts.model !== 'saaras:v2.5'
            ? { languageCode: this.#opts.languageCode as STTV3Languages }
            : {}),
        }
      : ({ ...this.#opts } as Partial<STTOptions>);

    this.#opts = resolveOptions({ ...base, ...opts } as STTOptions);
    this.#resetWS.resolve();
  }

  #positiveTime(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return value + this.startTimeOffset;
  }

  #resetUtteranceState() {
    this.#cancelEosFallback();
    this.#pendingFinalData = undefined;
    this.#pendingEos = false;
    this.#finalReceivedForUtterance = false;
    this.#eosEmittedForUtterance = false;
  }

  #cancelEosFallback() {
    if (this.#eosFallbackTimer != null) {
      clearTimeout(this.#eosFallbackTimer);
      this.#eosFallbackTimer = undefined;
    }
  }

  #emitEndOfSpeech(putMessage: (event: stt.SpeechEvent) => void) {
    if (this.#eosEmittedForUtterance) {
      return;
    }

    this.#cancelEosFallback();
    putMessage({ type: stt.SpeechEventType.END_OF_SPEECH, requestId: this.#requestId });
    this.#eosEmittedForUtterance = true;
    this.#pendingEos = false;
  }

  #sendFinalTranscript(
    transcriptData: SarvamWSTranscriptData,
    putMessage: (event: stt.SpeechEvent) => void,
  ): boolean {
    const transcript = transcriptData.transcript ?? '';
    if (!transcript) {
      return false;
    }

    const language = normalizeLanguage(
      transcriptData.language_code ?? this.#opts.languageCode ?? 'unknown',
    );
    const requestId = transcriptData.request_id ?? this.#requestId;
    const confidence = extractConfidence(transcriptData, this.#logger);
    this.#requestId = requestId;

    putMessage({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId,
      alternatives: [
        {
          text: transcript,
          language,
          startTime: this.#positiveTime(transcriptData.speech_start) ?? 0,
          endTime: this.#positiveTime(transcriptData.speech_end) ?? 0,
          confidence,
        },
      ],
    });
    return true;
  }

  #tryCommitUtterance(putMessage: (event: stt.SpeechEvent) => void) {
    if (this.#pendingFinalData == null || this.#eosEmittedForUtterance) {
      return;
    }

    const committedData = this.#pendingFinalData;
    if (this.#sendFinalTranscript(committedData, putMessage)) {
      this.#emitEndOfSpeech(putMessage);
      this.#pendingFinalData = undefined;
    }
  }

  protected async run() {
    const maxRetry = 32;
    let retries = 0;

    while (!this.input.closed && !this.closed) {
      const wsUrl = buildWsUrl(this.#opts);
      this.#logger.info(`Sarvam STT connecting to: ${wsUrl}`);
      const ws = new WebSocket(wsUrl, {
        headers: { 'api-subscription-key': this.#opts.apiKey },
      });

      let sessionStart = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', (err: Error) => reject(err));
          ws.once('close', (code: number) =>
            reject(new Error(`WebSocket closed with code ${code}`)),
          );
        });

        sessionStart = Date.now();
        await this.#runWS(ws);
        retries = 0;
      } catch (e) {
        // Clean up the WebSocket on failure to prevent listener leaks
        ws.removeAllListeners();
        ws.close();

        if (!this.closed && !this.input.closed) {
          // If the session ran for a meaningful duration (>5s), this was a working
          // session that ended normally (e.g. server idle timeout ~20s). Reset retries
          // so expected idle-timeout reconnections don't accumulate toward the fatal limit.
          if (sessionStart > 0 && Date.now() - sessionStart > 5000) {
            retries = 0;
          }
          if (retries >= maxRetry) {
            throw new Error(`Failed to connect to Sarvam STT after ${retries} attempts: ${e}`);
          }
          const delay = Math.min(retries * 5, 10);
          retries++;
          this.#logger.warn(
            `Failed to connect to Sarvam STT, retrying in ${delay}s: ${e} (${retries}/${maxRetry})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        } else {
          this.#logger.warn(
            `Sarvam STT disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
      }
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket) {
    this.#resetWS = new Future();
    this.#speaking = false;
    this.#resetUtteranceState();
    let closing = false;
    // Session-scoped controller: aborted in finally to cancel sendTask on WS reset
    const sessionController = new AbortController();

    // Config message: only supported on translate WS endpoint (saaras:v2.5)
    // @see https://docs.sarvam.ai/api-reference-docs/speech-to-text-translate/translate/ws
    if (this.#opts.model === 'saaras:v2.5' && this.#opts.prompt != null) {
      ws.send(JSON.stringify({ type: 'config', prompt: this.#opts.prompt }));
    }

    // No keepalive — Sarvam rejects messages without 'audio' field, and sending
    // silent audio could confuse server-side VAD. On idle timeout (~20s), the
    // server closes the connection and the outer retry loop in run() reconnects.
    // This matches the Python SDK's approach.

    const wsMonitor = Task.from(async (controller) => {
      const closed = new Promise<void>((_, reject) => {
        ws.once('close', (code: number, reason: Buffer) => {
          if (!closing) {
            this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
            reject(new Error('WebSocket closed'));
          }
        });
      });
      await Promise.race([closed, waitForAbort(controller.signal)]);
    });

    const sendTask = async () => {
      const samples50Ms = Math.floor(SAMPLE_RATE / 20); // 50ms chunks
      const stream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, samples50Ms);
      const abortPromise = waitForAbort(this.abortSignal);
      const sessionAbort = waitForAbort(sessionController.signal);

      try {
        while (!this.closed) {
          const result = await Promise.race([this.input.next(), abortPromise, sessionAbort]);
          if (result === undefined) return; // aborted
          if (result.done) break;

          const data = result.value;

          let frames: AudioFrame[];
          if (data === SpeechStream.FLUSH_SENTINEL) {
            frames = stream.flush();
          } else if (data.sampleRate !== SAMPLE_RATE || data.channels !== NUM_CHANNELS) {
            throw new Error(
              `Expected ${SAMPLE_RATE}Hz/${NUM_CHANNELS}ch, got ${data.sampleRate}Hz/${data.channels}ch`,
            );
          } else {
            frames = stream.write(
              data.data.buffer.slice(
                data.data.byteOffset,
                data.data.byteOffset + data.data.byteLength,
              ) as ArrayBuffer,
            );
          }

          for (const frame of frames) {
            if (this.#audioEnergyFilter.pushFrame(frame)) {
              // Sarvam expects base64-encoded PCM in a JSON message
              const pcmBuffer = Buffer.from(
                frame.data.buffer,
                frame.data.byteOffset,
                frame.data.byteLength,
              );
              const base64Audio = pcmBuffer.toString('base64');
              ws.send(
                JSON.stringify({
                  audio: {
                    data: base64Audio,
                    encoding: 'audio/wav',
                    sample_rate: SAMPLE_RATE,
                  },
                }),
              );
            }
          }

          // Send flush message on FLUSH_SENTINEL (VAD end of speech)
          if (data === SpeechStream.FLUSH_SENTINEL) {
            ws.send(JSON.stringify({ type: 'flush' }));
          }
        }
      } finally {
        closing = true;
        // Match Python: end_of_stream includes an empty audio field to avoid
        // "audio must not be None" rejection from the server
        try {
          ws.send(
            JSON.stringify({
              type: 'end_of_stream',
              audio: { data: '', encoding: 'audio/wav', sample_rate: SAMPLE_RATE },
            }),
          );
        } catch {
          // ws may already be closed
        }
        wsMonitor.cancel();
      }
    };

    const listenTask = Task.from(async (controller) => {
      const putMessage = (event: stt.SpeechEvent) => {
        if (!this.queue.closed) {
          try {
            this.queue.put(event);
          } catch {
            // ignore
          }
        }
      };

      const listenMessage = new Promise<void>((resolve, reject) => {
        ws.once('close', () => resolve());
        ws.on('message', (msg: RawData) => {
          try {
            const raw = msg.toString();
            this.#logger.debug(`Sarvam STT raw WS message: ${raw.substring(0, 500)}`);
            const json = JSON.parse(raw);
            const msgType: string = json['type'] ?? '';

            if (msgType === 'events') {
              const eventData = (json['data'] as SarvamWSEventData | undefined) ?? {};
              if (eventData.request_id) {
                this.#requestId = eventData.request_id;
              }
              const signalType = eventData.signal_type;

              if (signalType === 'START_SPEECH') {
                if (!this.#speaking) {
                  this.#resetUtteranceState();
                  this.#speaking = true;
                  putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                }
              } else if (signalType === 'END_SPEECH') {
                if (this.#speaking) {
                  this.#speaking = false;
                  this.#pendingEos = true;
                  this.#tryCommitUtterance(putMessage);
                  if (this.#pendingEos && this.#pendingFinalData == null) {
                    if (this.#finalReceivedForUtterance) {
                      this.#emitEndOfSpeech(putMessage);
                    } else if (this.#eosFallbackTimer == null) {
                      this.#eosFallbackTimer = setTimeout(() => {
                        if (this.#pendingEos && !this.#eosEmittedForUtterance) {
                          this.#emitEndOfSpeech(putMessage);
                        }
                      }, EOS_FALLBACK_TIMEOUT);
                    }
                  }
                }
              }
            } else if (msgType === 'data') {
              const td = (json['data'] as SarvamWSTranscriptData | undefined) ?? {};
              const transcript = td.transcript ?? '';
              const requestId = td.request_id ?? '';
              if (requestId) {
                this.#requestId = requestId;
              }

              // Log metrics when available
              if (td.metrics) {
                this.#logger.debug(
                  `Sarvam STT metrics: audio_duration=${td.metrics.audio_duration}s, latency=${td.metrics.processing_latency}s`,
                );
              }

              if (transcript) {
                if (!this.#speaking && !this.#pendingEos && !this.#eosEmittedForUtterance) {
                  this.#speaking = true;
                  putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                }

                if (this.#pendingEos) {
                  this.#pendingFinalData = td;
                  this.#finalReceivedForUtterance = true;
                  this.#tryCommitUtterance(putMessage);
                } else if (this.#sendFinalTranscript(td, putMessage)) {
                  this.#finalReceivedForUtterance = true;
                }
              }
            } else if (msgType === 'error') {
              // Server format: { type: "error", data: { message: "...", code: "..." } }
              // Also check top-level and 'error' field as fallback
              const nested = json['data'] as SarvamWSErrorData | undefined;
              const errorInfo =
                nested?.message ??
                nested?.error ??
                json['error'] ??
                json['message'] ??
                'Unknown error';
              const errorCode = nested?.code ?? json['code'] ?? '';
              this.#logger.error(`Sarvam STT WebSocket error [${errorCode}]: ${errorInfo}`);
              reject(new Error(`Sarvam STT API error [${errorCode}]: ${errorInfo}`));
              return;
            }

            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`Error processing Sarvam STT message: ${msg}`);
            reject(err);
          }
        });
      });

      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    }, this.abortController);

    try {
      await Promise.race([
        this.#resetWS.await,
        Promise.all([sendTask(), listenTask.result, wsMonitor.result]),
      ]);
    } finally {
      closing = true;
      sessionController.abort();
      this.#cancelEosFallback();
      // Do NOT call listenTask.cancel() — it would abort this.abortController
      // (passed to Task.from) and permanently break the stream. Instead, ws.close()
      // triggers the ws.once('close') handler inside listenMessage, letting listenTask
      // exit naturally. On close(), the parent abort signal handles it directly.
      wsMonitor.cancel();
      ws.close();
      // Suppress unhandled rejection from orphaned listenTask on reconnect
      listenTask.result.catch(() => {});
    }
  }
}
