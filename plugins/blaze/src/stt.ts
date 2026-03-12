// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze STT Plugin for LiveKit Voice Agent (Node.js)
 *
 * Speech-to-Text plugin interfacing with Blaze transcription service.
 *
 * API Endpoint: POST /v1/stt/transcribe
 * Input: WAV audio file (FormData), query params: language, enable_segments
 * Output: { transcription: string, confidence: number }
 */

import type { AudioBuffer } from '@livekit/agents';
import { mergeFrames, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import {
  type BlazeConfig,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  resolveConfig,
  MAX_RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
  sleep,
  isRetryableError,
} from './config.js';
import type { BlazeSTTResponse } from './models.js';

/** Options for the Blaze STT plugin. */
export interface STTOptions {
  /**
   * Base URL for the STT service.
   * Falls back to config.apiUrl → BLAZE_API_URL env var.
   */
  apiUrl?: string;
  /** Language code for transcription. Default: "vi" */
  language?: string;
  /** Bearer token for authentication. Falls back to BLAZE_API_TOKEN env var. */
  authToken?: string;
  /**
   * Dictionary of text replacements applied to transcription output.
   * Keys are search strings, values are replacements.
   * Example: { "AI": "trí tuệ nhân tạo" }
   */
  normalizationRules?: Record<string, string>;
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /** Centralized configuration object. */
  config?: BlazeConfig;
}

interface ResolvedSTTOptions {
  apiUrl: string;
  language: string;
  authToken: string;
  normalizationRules?: Record<string, string>;
  timeout: number;
}

function resolveSTTOptions(opts: STTOptions): ResolvedSTTOptions {
  const cfg: ResolvedBlazeConfig = resolveConfig(opts.config);
  return {
    apiUrl:            opts.apiUrl    ?? cfg.apiUrl,
    language:          opts.language  ?? 'vi',
    authToken:         opts.authToken ?? cfg.authToken,
    normalizationRules: opts.normalizationRules,
    timeout:           opts.timeout   ?? cfg.sttTimeout,
  };
}

/**
 * Blaze Speech-to-Text Plugin.
 *
 * Converts audio to text using the Blaze transcription service.
 * Supports batch recognition only (no real-time streaming).
 * Includes retry logic with exponential backoff for transient failures.
 *
 * @example
 * ```typescript
 * import { STT } from '@livekit/agents-plugin-blaze';
 *
 * const stt = new STT({ language: 'vi' });
 * // Or with shared config:
 * const stt = new STT({ config: { apiUrl: 'https://api.blaze.vn', authToken: 'tok' } });
 * ```
 */
export class STT extends stt.STT {
  label = 'blaze.STT';
  #opts: ResolvedSTTOptions;

  constructor(opts: STTOptions = {}) {
    super({ streaming: false, interimResults: false, alignedTranscript: false });
    this.#opts = resolveSTTOptions(opts);
  }

  /**
   * Update STT options at runtime.
   */
  updateOptions(opts: Partial<Omit<STTOptions, 'config'>>): void {
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.authToken !== undefined) this.#opts.authToken = opts.authToken;
    if (opts.normalizationRules !== undefined) this.#opts.normalizationRules = opts.normalizationRules;
    if (opts.timeout !== undefined) this.#opts.timeout = opts.timeout;
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    // 1. Merge all audio frames into one
    const frame = mergeFrames(buffer);

    // 2. Handle empty audio
    if (frame.data.byteLength === 0) {
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: undefined,
      };
    }

    // 3. Convert PCM frame to WAV format
    const wavBuffer = this.#createWav(frame);

    // 4. Build FormData for multipart upload
    const formData = new FormData();
    const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
    formData.append('audio_file', wavBlob, 'audio.wav');

    // 5. Build request URL with query params
    const url = new URL(`${this.#opts.apiUrl}/v1/stt/transcribe`);
    url.searchParams.set('language', this.#opts.language);
    url.searchParams.set('enable_segments', 'false');
    url.searchParams.set('enable_refinement', 'false');

    // 6. Make request with retry logic for transient failures
    let result: BlazeSTTResponse | undefined;

    for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.#opts.timeout);
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, controller.signal])
        : controller.signal;

      try {
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: buildAuthHeaders(this.#opts.authToken),
          body: formData,
          signal,
        });

        // Retry on 5xx server errors
        if (response.status >= 500 && attempt < MAX_RETRY_COUNT) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown error');
          throw new Error(`Blaze STT error ${response.status}: ${errorText}`);
        }

        // 7. Parse response
        result = (await response.json()) as BlazeSTTResponse;
        break; // Success

      } catch (err) {
        if (attempt < MAX_RETRY_COUNT && isRetryableError(err)) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (!result) {
      throw new Error('Blaze STT: all retry attempts failed');
    }

    const rawText = result.transcription ?? '';
    const text = this.#applyNormalizationRules(rawText);
    const confidence = result.confidence ?? 1.0;

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text,
          language: this.#opts.language,
          startTime: 0,
          endTime: 0,
          confidence,
        },
      ],
    };
  }

  stream(): stt.SpeechStream {
    throw new Error(
      'Blaze STT does not support streaming recognition. ' +
      'Use _recognize() for batch transcription.',
    );
  }

  /**
   * Create a WAV file buffer from an AudioFrame (PCM 16-bit signed).
   * Follows the same 44-byte RIFF header pattern as the OpenAI STT plugin.
   */
  #createWav(frame: AudioFrame): Buffer {
    const bitsPerSample = 16;
    const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
    const blockAlign = (frame.channels * bitsPerSample) / 8;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + frame.data.byteLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                     // Subchunk1 size (PCM = 16)
    header.writeUInt16LE(1, 20);                      // Audio format (1 = PCM)
    header.writeUInt16LE(frame.channels, 22);
    header.writeUInt32LE(frame.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(frame.data.byteLength, 40);

    return Buffer.concat([
      header,
      Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    ]);
  }

  /**
   * Apply case-sensitive string replacements to transcribed text.
   */
  #applyNormalizationRules(text: string): string {
    const rules = this.#opts.normalizationRules;
    if (!rules) return text;
    let result = text;
    // Apply longer patterns first for more deterministic results.
    const entries = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of entries) {
      if (!from) continue;
      result = result.replaceAll(from, to);
    }
    return result;
  }
}
