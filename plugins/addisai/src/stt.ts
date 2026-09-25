// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  type AudioBuffer,
  asLanguageCode,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { Language } from './models.js';
import {
  API_BASE_URL,
  createWav,
  isRecord,
  mapFetchError,
  parseJsonResponse,
  responseRequestId,
  timedSignal,
  unwrapData,
  validateLanguage,
} from './utils.js';

/**
 * Configuration for AddisAI batch speech recognition.
 *
 * @public
 */
export interface STTOptions {
  /** Transcription language: `am` for Amharic or `om` for Afaan Oromo. */
  language: Language | string;
  /** AddisAI API key. Defaults to `ADDIS_API_KEY`. */
  apiKey?: string;
  /** AddisAI API base URL. */
  baseURL: string;
  /** Maximum duration of one transcription request in milliseconds. */
  requestTimeoutMs: number;
}

const DEFAULT_OPTIONS: Pick<STTOptions, 'language' | 'baseURL' | 'requestTimeoutMs'> = {
  language: 'am',
  baseURL: API_BASE_URL,
  requestTimeoutMs: 30_000,
};

interface ResolvedSTTOptions {
  language: Language;
  apiKey: string;
  baseURL: string;
  requestTimeoutMs: number;
}

/**
 * Batch speech-to-text using AddisAI's `addis-whisper` model.
 *
 * @public
 */
export class STT extends stt.STT {
  readonly label = 'addisai.STT';
  #opts: ResolvedSTTOptions;

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: false,
      interimResults: false,
      alignedTranscript: false,
    });

    const apiKey = opts.apiKey ?? process.env.ADDIS_API_KEY;
    if (!apiKey) {
      throw new Error('AddisAI API key is required, either as `apiKey` or via ADDIS_API_KEY');
    }

    const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_OPTIONS.requestTimeoutMs;
    if (requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be positive');
    }

    this.#opts = {
      language: validateLanguage(opts.language ?? DEFAULT_OPTIONS.language),
      apiKey,
      baseURL: (opts.baseURL ?? DEFAULT_OPTIONS.baseURL).replace(/\/+$/, ''),
      requestTimeoutMs,
    };
  }

  get model(): string {
    return 'addis-whisper';
  }

  get provider(): string {
    return 'AddisAI';
  }

  /** Update the language used by subsequent transcription requests. */
  updateOptions(opts: { language?: Language | string }): void {
    if (opts.language !== undefined) {
      this.#opts.language = validateLanguage(opts.language);
    }
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal: AbortSignal = new AbortController().signal,
  ): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const wav = createWav(frame);
    const form = new FormData();
    form.append('request_data', JSON.stringify({ language_code: this.#opts.language }));
    form.append(
      'audio',
      new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], {
        type: 'audio/wav',
      }),
      'audio.wav',
    );

    try {
      const response = await fetch(`${this.#opts.baseURL}/api/v2/stt`, {
        method: 'POST',
        headers: {
          'x-api-key': this.#opts.apiKey,
          Accept: 'application/json',
          'X-Addis-Client': `@livekit/agents-plugin-addisai/${__PACKAGE_VERSION__}`,
        },
        body: form,
        signal: timedSignal(abortSignal, this.#opts.requestTimeoutMs),
      });

      const payload = await parseJsonResponse(response);
      const data = unwrapData(payload);
      const usage = isRecord(data.usage_metadata) ? data.usage_metadata : undefined;
      const usageRequestId = usage?.requestId ?? usage?.request_id;
      const confidenceValue = payload.confidence ?? data.confidence;
      const confidence =
        typeof confidenceValue === 'number'
          ? confidenceValue
          : Number.parseFloat(String(confidenceValue ?? '0')) || 0;
      const transcription = data.transcription;

      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId:
          (typeof usageRequestId === 'string' ? usageRequestId : undefined) ??
          responseRequestId(response),
        alternatives: [
          {
            text: typeof transcription === 'string' ? transcription : '',
            language: asLanguageCode(this.#opts.language),
            startTime: 0,
            endTime: frame.samplesPerChannel / frame.sampleRate,
            confidence,
            metadata: usage ? { usage } : undefined,
          },
        ],
      };
    } catch (error) {
      mapFetchError(error, 'STT');
    }
  }

  stream(_options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    throw new APIConnectionError({
      message:
        'AddisAI STT is batch-only. Use LiveKit with a VAD so it can adapt recognition to turns.',
      options: { retryable: false },
    });
  }
}
