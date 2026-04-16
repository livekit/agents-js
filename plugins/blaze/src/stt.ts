// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze STT Plugin for LiveKit Voice Agent (Node.js)
 *
 * Speech-to-Text plugin interfacing with Blaze transcription service.
 *
 * API Endpoint: POST `/v1/stt/transcribe`
 * Input: WAV audio file (FormData), query params: language, enable_segments
 * Output: `{ transcription: string, confidence: number }`
 */
import type { AudioBuffer } from '@livekit/agents';
import { mergeFrames, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import {
  type BlazeConfig,
  BlazeHttpError,
  MAX_RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  isRetryableError,
  resolveConfig,
  sleep,
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
   * Example: `{ "AI": "trí tuệ nhân tạo" }`
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
    apiUrl: opts.apiUrl ?? cfg.apiUrl,
    language: opts.language ?? 'vi',
    authToken: opts.authToken ?? cfg.authToken,
    normalizationRules: opts.normalizationRules,
    timeout: opts.timeout ?? cfg.sttTimeout,
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

  // Frame accumulation: buffer PCM from empty STT segments so short
  // leading fragments (hesitant speech) are prepended to the next segment.
  #pendingPcm: Buffer = Buffer.alloc(0);
  #pendingEmptyCount: number = 0;
  #lastRecognizeTime: number = 0;

  // Safety limits (mirrors Python defaults)
  readonly #maxPendingDuration: number = 5.0;  // seconds of buffered audio
  readonly #maxPendingSegments: number = 3;     // consecutive empty segments
  readonly #pendingIdleTimeout: number = 10.0;  // auto-clear after idle gap (s)

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
    if (opts.normalizationRules !== undefined)
      this.#opts.normalizationRules = opts.normalizationRules;
    if (opts.timeout !== undefined) this.#opts.timeout = opts.timeout;
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    // 1. Merge all audio frames into one
    const frame = mergeFrames(buffer);

    // 2. Extract raw PCM from the merged frame (new segment only)
    const segmentPcm = Buffer.from(
      frame.data.buffer,
      frame.data.byteOffset,
      frame.data.byteLength,
    );

    // 3. Auto-clear stale pending buffer if too much time has elapsed
    const now = Date.now() / 1000; // seconds
    if (this.#pendingPcm.length > 0 && this.#lastRecognizeTime > 0) {
      const idleGap = now - this.#lastRecognizeTime;
      if (idleGap > this.#pendingIdleTimeout) {
        this.#pendingPcm = Buffer.alloc(0);
        this.#pendingEmptyCount = 0;
      }
    }
    this.#lastRecognizeTime = now;

    // 4. Prepend buffered PCM from previous empty segments
    const pcmData =
      this.#pendingPcm.length > 0 ? Buffer.concat([this.#pendingPcm, segmentPcm]) : segmentPcm;

    // 5. Handle fully empty audio (no sound at all)
    if (pcmData.byteLength === 0) {
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: undefined,
      };
    }

    // 6. Convert PCM to WAV format
    const wavBuffer = this.#createWavFromPcm(pcmData, frame.sampleRate, frame.channels);

    // 7. Build FormData for multipart upload
    const formData = new FormData();
    const wavBytes = Uint8Array.from(wavBuffer);
    const wavBlob = new Blob([wavBytes], { type: 'audio/wav' });
    formData.append('audio_file', wavBlob, 'audio.wav');

    // 8. Build request URL with query params
    const url = new URL(`${this.#opts.apiUrl}/v1/stt/transcribe`);
    url.searchParams.set('language', this.#opts.language);
    url.searchParams.set('enable_segments', 'false');
    url.searchParams.set('enable_refinement', 'false');

    // 9. Make request with retry logic for transient failures
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
          throw new BlazeHttpError(response.status, `Blaze STT error ${response.status}: ${errorText}`);
        }

        // 10. Parse response
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

    // 11. Frame accumulation logic
    if (!text.trim()) {
      // Empty result — decide whether to buffer or discard
      this.#pendingEmptyCount++;

      const bytesPerSample = 2 * frame.channels; // 16-bit PCM
      const segmentDuration =
        frame.sampleRate && bytesPerSample
          ? segmentPcm.byteLength / (frame.sampleRate * bytesPerSample)
          : 0;
      const pendingDuration =
        this.#pendingPcm.length > 0 && frame.sampleRate && bytesPerSample
          ? this.#pendingPcm.byteLength / (frame.sampleRate * bytesPerSample)
          : 0;
      const totalPendingDuration = pendingDuration + segmentDuration;

      if (
        this.#pendingEmptyCount <= this.#maxPendingSegments &&
        totalPendingDuration <= this.#maxPendingDuration
      ) {
        // Buffer combined PCM for next call
        this.#pendingPcm = pcmData;
      } else {
        // Safety limit reached — discard buffer
        this.#pendingPcm = Buffer.alloc(0);
        this.#pendingEmptyCount = 0;
      }

      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text: '',
            language: this.#opts.language as stt.SpeechData['language'],
            startTime: 0,
            endTime: 0,
            confidence: 0.0,
          },
        ],
      };
    }

    // Got real text — clear pending buffer
    this.#pendingPcm = Buffer.alloc(0);
    this.#pendingEmptyCount = 0;

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text,
          language: this.#opts.language as stt.SpeechData['language'],
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
    const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    return this.#createWavFromPcm(pcm, frame.sampleRate, frame.channels);
  }

  /**
   * Create a WAV file buffer from raw PCM bytes + audio metadata.
   * Used when pending PCM is prepended to the current segment.
   */
  #createWavFromPcm(pcm: Buffer, sampleRate: number, channels: number): Buffer {
    const bitsPerSample = 16;
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.byteLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1 size (PCM = 16)
    header.writeUInt16LE(1, 20); // Audio format (1 = PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.byteLength, 40);

    return Buffer.concat([header, pcm]);
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
