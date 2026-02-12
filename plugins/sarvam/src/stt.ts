// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioBuffer, mergeFrames, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { STTModels, STTModes, STTV2Languages, STTV3Languages, STTLanguages } from './models.js';

const SARVAM_STT_BASE_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_STT_TRANSLATE_BASE_URL = 'https://api.sarvam.ai/speech-to-text-translate';

// ---------------------------------------------------------------------------
// Model-specific option types
// ---------------------------------------------------------------------------

interface STTBaseOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
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
}

/**
 * Options specific to saaras:v2.5 (dedicated translate endpoint).
 * Uses the `/speech-to-text-translate` endpoint for Indic-to-English translation.
 * Auto-detects the source language; does not accept language codes or modes.
 * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text-translate/translate | Sarvam STT Translate docs}
 */
export interface STTTranslateOptions extends STTBaseOptions {
  model: 'saaras:v2.5';
  /** Conversation context to boost model accuracy */
  prompt?: string;
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
}

/** Combined options — discriminated by `model` field */
export type STTOptions = STTV2Options | STTTranslateOptions | STTV3Options;

// ---------------------------------------------------------------------------
// Resolved (internal) options — flat union of all fields
// ---------------------------------------------------------------------------

interface ResolvedSTTOptions {
  apiKey: string;
  model: STTModels;
  // saarika:v2.5 and saaras:v3 only — not used by saaras:v2.5 (translate auto-detects)
  languageCode?: STTLanguages | string;
  // saaras:v3 only
  mode?: STTModes | string;
  // saaras:v2.5 only (translate endpoint)
  prompt?: string;
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

/** Runtime set of languages supported by saarika:v2.5 (for validation on model switch) */
const STTV2_LANGUAGE_SET: ReadonlySet<string> = new Set<STTV2Languages>([
  'unknown', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN',
  'od-IN', 'pa-IN', 'ta-IN', 'te-IN', 'en-IN', 'gu-IN',
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
  };

  if (model === 'saaras:v2.5') {
    // Translate endpoint: no language_code, no mode; prompt is optional
    base.prompt = (opts as STTTranslateOptions).prompt;
  } else if (model === 'saaras:v3') {
    const v3Opts = opts as STTV3Options;
    base.languageCode = v3Opts.languageCode ?? SAARAS_V3_DEFAULTS.languageCode;
    base.mode = v3Opts.mode ?? SAARAS_V3_DEFAULTS.mode;
  } else {
    // saarika:v2.5
    let languageCode =
      (opts as STTV2Options).languageCode ?? SAARIKA_DEFAULTS.languageCode;
    // Reset to default if a v3-only language is used with saarika:v2.5
    if (!STTV2_LANGUAGE_SET.has(languageCode)) {
      languageCode = SAARIKA_DEFAULTS.languageCode;
    }
    base.languageCode = languageCode;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Build the multipart form data — only sends model-relevant fields
// ---------------------------------------------------------------------------

function buildFormData(wavBlob: Blob, opts: ResolvedSTTOptions): FormData {
  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  formData.append('model', opts.model);

  // saarika:v2.5 and saaras:v3 send language_code; saaras:v2.5 (translate) does not
  if (opts.model !== 'saaras:v2.5' && opts.languageCode != null) {
    formData.append('language_code', opts.languageCode);
  }

  // mode is saaras:v3 only
  if (opts.model === 'saaras:v3' && opts.mode != null) {
    formData.append('mode', opts.mode);
  }

  // prompt is saaras:v2.5 (translate) only
  if (opts.model === 'saaras:v2.5' && opts.prompt != null) {
    formData.append('prompt', opts.prompt);
  }

  return formData;
}

// ---------------------------------------------------------------------------
// Endpoint routing — saaras:v2.5 uses the dedicated translate endpoint
// ---------------------------------------------------------------------------

function getEndpointUrl(model: STTModels): string {
  return model === 'saaras:v2.5' ? SARVAM_STT_TRANSLATE_BASE_URL : SARVAM_STT_BASE_URL;
}

// ---------------------------------------------------------------------------
// WAV encoding helper — wraps raw PCM Int16 data with a 44-byte WAV header
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
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(frame.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);

  // Use byteOffset/byteLength to handle typed array views into shared buffers correctly
  const pcm = Buffer.from(
    frame.data.buffer,
    frame.data.byteOffset,
    frame.data.byteLength,
  );
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// STT class
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
   * - `saaras:v3` (default, recommended) — supports all 22 languages, modes, and uses `/speech-to-text`.
   * - `saaras:v2.5` — Indic-to-English translation via `/speech-to-text-translate`. Auto-detects source language.
   * - `saarika:v2.5` — will be deprecated soon. All its languages are available in `saaras:v3`.
   *
   * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe | Sarvam STT API docs}
   * @see {@link https://docs.sarvam.ai/api-reference-docs/speech-to-text-translate/translate | Sarvam STT Translate docs}
   */
  constructor(opts: Partial<STTOptions> = {}) {
    super({ streaming: false, interimResults: false, alignedTranscript: false });
    this.opts = resolveOptions(opts);
  }

  /**
   * Update STT options after initialization.
   *
   * @remarks
   * When the model changes, only truly shared fields (apiKey) carry over.
   * Model-specific fields (languageCode, mode, prompt) are dropped so
   * resolveOptions re-applies the correct defaults for the new model.
   * languageCode is carried over between saarika:v2.5 and saaras:v3 —
   * resolveOptions will reset v3-only languages to the default if switching to v2.5.
   */
  updateOptions(opts: Partial<STTOptions>) {
    const modelChanging = opts.model != null && opts.model !== this.opts.model;

    const base: Partial<STTOptions> = modelChanging
      ? {
          apiKey: this.opts.apiKey,
          // Carry languageCode between models that use it (not saaras:v2.5 translate)
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

    const response = await fetch(getEndpointUrl(this.opts.model), {
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

    const data = (await response.json()) as {
      request_id: string | null;
      transcript: string;
      language_code: string | null;
      language_probability: number | null;
    };

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: data.request_id ?? undefined,
      alternatives: [
        {
          text: data.transcript || '',
          // language_code is returned when auto-detecting (language_code omitted
          // or set to 'unknown'). For saaras:v2.5 (translate), language is always
          // auto-detected. Falls back to configured languageCode or 'unknown'.
          language: data.language_code ?? this.opts.languageCode ?? 'unknown',
          startTime: 0,
          endTime: 0,
          confidence: data.language_probability ?? 0,
        },
      ],
    };
  }

  /** @internal Streaming is not supported by the Sarvam REST API. */
  stream(): stt.SpeechStream {
    throw new Error('Streaming is not supported on Sarvam STT');
  }
}
