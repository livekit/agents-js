// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, AudioByteStream, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type {
  TTSLanguages,
  TTSModels,
  TTSSampleRates,
  TTSSpeakers,
  TTSV2Speakers,
  TTSV3Speakers,
} from './models.js';

const SARVAM_TTS_SAMPLE_RATE = 24000;
const SARVAM_TTS_CHANNELS = 1;
const SARVAM_BASE_URL = 'https://api.sarvam.ai';

// ---------------------------------------------------------------------------
// Model-specific option types
// V2 supports pitch / loudness / enablePreprocessing
// V3 supports temperature (pitch, loudness, enablePreprocessing are NOT supported)
// ---------------------------------------------------------------------------

interface TTSBaseOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
  /** Target language code (BCP-47) */
  targetLanguageCode?: TTSLanguages | string;
  /** Speech pace. v2: 0.3–3.0, v3: 0.5–2.0 (default 1.0) */
  pace?: number;
  /** Output sample rate in Hz (default 24000) */
  sampleRate?: TTSSampleRates | number;
  /** Base URL for the Sarvam API */
  baseURL?: string;
}

/** Options specific to bulbul:v2 */
export interface TTSV2Options extends TTSBaseOptions {
  model?: 'bulbul:v2';
  /** Speaker voice (v2 voices). Default: 'anushka' */
  speaker?: TTSV2Speakers | string;
  /** Pitch adjustment, -0.75 to 0.75 (v2 only) */
  pitch?: number;
  /** Loudness, 0.3 to 3.0 (v2 only) */
  loudness?: number;
  /** Enable text preprocessing (v2 only) */
  enablePreprocessing?: boolean;
}

/** Options specific to bulbul:v3 */
export interface TTSV3Options extends TTSBaseOptions {
  model: 'bulbul:v3';
  /** Speaker voice (v3 voices). Default: 'shubh' */
  speaker?: TTSV3Speakers | string;
  /** Temperature for voice variation, 0.01 to 2.0 (v3 only, default 0.6) */
  temperature?: number;
}

/** Combined options — discriminated by `model` field */
export type TTSOptions = TTSV2Options | TTSV3Options;

// ---------------------------------------------------------------------------
// Resolved (internal) options — flat union of all fields
// ---------------------------------------------------------------------------

interface ResolvedTTSOptions {
  apiKey: string;
  model: TTSModels;
  speaker: TTSSpeakers | string;
  targetLanguageCode: string;
  pace: number;
  sampleRate: number;
  baseURL: string;
  // V2 only
  pitch?: number;
  loudness?: number;
  enablePreprocessing?: boolean;
  // V3 only
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Defaults per model
// ---------------------------------------------------------------------------

const V2_DEFAULTS = {
  speaker: 'anushka' as const,
  pitch: 0,
  pace: 1.0,
  loudness: 1.0,
  enablePreprocessing: false,
};

const V3_DEFAULTS = {
  speaker: 'shubh' as const,
  pace: 1.0,
  temperature: 0.6,
};

// ---------------------------------------------------------------------------
// Resolve caller options into a fully-populated internal struct
// ---------------------------------------------------------------------------

function resolveOptions(opts: Partial<TTSOptions>): ResolvedTTSOptions {
  const apiKey = opts.apiKey ?? process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error('Sarvam API key is required, whether as an argument or as $SARVAM_API_KEY');
  }

  const model: TTSModels = opts.model ?? 'bulbul:v2';
  const isV3 = model === 'bulbul:v3';

  const base: ResolvedTTSOptions = {
    apiKey,
    model,
    speaker: opts.speaker ?? (isV3 ? V3_DEFAULTS.speaker : V2_DEFAULTS.speaker),
    targetLanguageCode: opts.targetLanguageCode ?? 'en-IN',
    pace: opts.pace ?? (isV3 ? V3_DEFAULTS.pace : V2_DEFAULTS.pace),
    sampleRate: opts.sampleRate ?? SARVAM_TTS_SAMPLE_RATE,
    baseURL: opts.baseURL ?? SARVAM_BASE_URL,
  };

  if (isV3) {
    base.temperature = (opts as TTSV3Options).temperature ?? V3_DEFAULTS.temperature;
  } else {
    const v2 = opts as TTSV2Options;
    base.pitch = v2.pitch ?? V2_DEFAULTS.pitch;
    base.loudness = v2.loudness ?? V2_DEFAULTS.loudness;
    base.enablePreprocessing = v2.enablePreprocessing ?? V2_DEFAULTS.enablePreprocessing;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Build the API request body — only sends model-relevant fields
// ---------------------------------------------------------------------------

function buildRequestBody(text: string, opts: ResolvedTTSOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text,
    target_language_code: opts.targetLanguageCode,
    speaker: opts.speaker,
    model: opts.model,
    pace: opts.pace,
    speech_sample_rate: String(opts.sampleRate),
    // Always request WAV — AudioByteStream requires raw PCM, which we get by
    // stripping the 44-byte WAV header. Other codecs produce compressed audio
    // that cannot be fed into AudioByteStream.
    output_audio_codec: 'wav',
  };

  if (opts.model === 'bulbul:v3') {
    if (opts.temperature != null) body.temperature = opts.temperature;
  } else {
    if (opts.pitch != null) body.pitch = opts.pitch;
    if (opts.loudness != null) body.loudness = opts.loudness;
    if (opts.enablePreprocessing != null) body.enable_preprocessing = opts.enablePreprocessing;
  }

  return body;
}

// ---------------------------------------------------------------------------
// TTS class
// ---------------------------------------------------------------------------

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'sarvam.TTS';

  /**
   * Create a new instance of Sarvam AI TTS.
   *
   * @remarks
   * `apiKey` must be set to your Sarvam API key, either using the argument or by setting the
   * `SARVAM_API_KEY` environment variable.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved = resolveOptions(opts);
    super(resolved.sampleRate, SARVAM_TTS_CHANNELS, { streaming: false });
    this.#opts = resolved;
  }

  /**
   * Update TTS options after initialization.
   *
   * @remarks
   * When the model changes, model-specific defaults are re-applied for any
   * fields not explicitly provided. This prevents stale v2 fields (e.g.
   * speaker 'anushka', pitch, loudness) from leaking into v3 requests and
   * vice-versa.
   */
  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = resolveOptions({ ...this.#opts, ...opts } as TTSOptions);
  }

  /**
   * Synthesize text to audio using Sarvam AI TTS.
   *
   * @param text - Text to synthesize (max 2500 chars for v3, 1500 for v2)
   * @param connOptions - API connection options
   * @param abortSignal - Abort signal for cancellation
   * @returns A chunked stream of synthesized audio
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  /** @internal Streaming is not supported by the Sarvam REST API. */
  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Sarvam TTS');
  }
}

// ---------------------------------------------------------------------------
// Chunked stream (non-streaming synthesis)
// ---------------------------------------------------------------------------

/** Chunked stream for Sarvam AI TTS that processes a single synthesis request. */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'sarvam.ChunkedStream';
  private opts: ResolvedTTSOptions;

  /** @internal */
  constructor(
    tts: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();

    const response = await fetch(`${this.opts.baseURL}/text-to-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': this.opts.apiKey,
      },
      body: JSON.stringify(buildRequestBody(this.inputText, this.opts)),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Sarvam TTS API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as { audios: string[] };
    const audioBase64 = data.audios[0];
    if (!audioBase64) {
      throw new Error('Sarvam TTS returned empty audio');
    }

    // Decode base64 WAV and strip 44-byte header to get raw PCM
    const raw = Buffer.from(audioBase64, 'base64');
    const pcmData = raw.buffer.slice(raw.byteOffset + 44, raw.byteOffset + raw.byteLength);

    const audioByteStream = new AudioByteStream(this.opts.sampleRate, SARVAM_TTS_CHANNELS);
    const frames = [...audioByteStream.write(pcmData), ...audioByteStream.flush()];

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    for (const frame of frames) {
      sendLastFrame(requestId, false);
      lastFrame = frame;
    }
    sendLastFrame(requestId, true);

    this.queue.close();
  }
}
