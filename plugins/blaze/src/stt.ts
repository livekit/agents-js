// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze STT Plugin for LiveKit Voice Agent (Node.js)
 *
 * Speech-to-Text plugin interfacing with Blaze transcription service.
 *
 * Batch API: POST `/v1/stt/transcribe` (default model: v2.0)
 * Realtime API: WS `/v1/stt/realtime` (default model: stt-stream-1.5)
 *
 * Batch input: WAV audio file (FormData), query params: language, model, enable_segments
 * Batch output: `{ transcription: string, confidence: number }`
 */
import type { APIConnectOptions, AudioBuffer } from '@livekit/agents';
import { APIConnectionError, APIStatusError, mergeFrames, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import WebSocket from 'ws';
import {
  type BlazeConfig,
  MAX_RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  resolveConfig,
  sleep,
} from './config.js';
import type { BlazeSTTResponse } from './models.js';
import { DEFAULT_STT_BATCH_MODEL, DEFAULT_STT_STREAM_MODEL } from './models.js';

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
   * Batch STT model for POST /v1/stt/transcribe.
   * Default: v2.0
   */
  model?: string;
  /**
   * Realtime STT model for WS /v1/stt/realtime.
   * Default: stt-stream-1.5
   */
  streamModel?: string;
  /**
   * Dictionary of text replacements applied to transcription output.
   * Keys are search strings, values are replacements.
   * Example: `{ "AI": "trí tuệ nhân tạo" }`
   */
  normalizationRules?: Record<string, string>;
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /** Sample rate for streaming PCM (Hz). Default: 16000 */
  sampleRate?: number;
  /** Centralized configuration object. */
  config?: BlazeConfig;
}

interface ResolvedSTTOptions {
  apiUrl: string;
  language: string;
  authToken: string;
  model: string;
  streamModel: string;
  sampleRate: number;
  normalizationRules?: Record<string, string>;
  timeout: number;
  wsUrl: string;
}

function resolveSTTOptions(opts: STTOptions): ResolvedSTTOptions {
  const cfg: ResolvedBlazeConfig = resolveConfig(opts.config);
  const apiUrl = opts.apiUrl ?? cfg.apiUrl;
  const wsBase = apiUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  return {
    apiUrl,
    language: opts.language ?? 'vi',
    authToken: opts.authToken ?? cfg.authToken,
    model: opts.model ?? DEFAULT_STT_BATCH_MODEL,
    streamModel: opts.streamModel ?? DEFAULT_STT_STREAM_MODEL,
    sampleRate: opts.sampleRate ?? 16000,
    normalizationRules: opts.normalizationRules,
    timeout: opts.timeout ?? cfg.sttTimeout,
    wsUrl: `${wsBase}/v1/stt/realtime`,
  };
}

function isRetryableRecognizeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof APIStatusError) return err.retryable;
  return true;
}

/**
 * Blaze Speech-to-Text Plugin.
 *
 * Converts audio to text using the Blaze transcription service.
 * Supports batch recognition (v2.0) and realtime streaming via
 * WebSocket /v1/stt/realtime (stt-stream-1.5).
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
  readonly #maxPendingDuration: number = 5.0; // seconds of buffered audio
  readonly #maxPendingSegments: number = 3; // consecutive empty segments
  readonly #pendingIdleTimeout: number = 10.0; // auto-clear after idle gap (s)

  constructor(opts: STTOptions = {}) {
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.#opts = resolveSTTOptions(opts);
  }

  /**
   * Update STT options at runtime.
   */
  updateOptions(opts: Partial<Omit<STTOptions, 'config'>>): void {
    if (opts.apiUrl !== undefined) {
      this.#opts.apiUrl = opts.apiUrl;
      const wsBase = opts.apiUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      this.#opts.wsUrl = `${wsBase}/v1/stt/realtime`;
    }
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.authToken !== undefined) this.#opts.authToken = opts.authToken;
    if (opts.model !== undefined) this.#opts.model = opts.model;
    if (opts.streamModel !== undefined) this.#opts.streamModel = opts.streamModel;
    if (opts.sampleRate !== undefined) this.#opts.sampleRate = opts.sampleRate;
    if (opts.normalizationRules !== undefined)
      this.#opts.normalizationRules = opts.normalizationRules;
    if (opts.timeout !== undefined) this.#opts.timeout = opts.timeout;
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    // 1. Merge all audio frames into one
    const frame = mergeFrames(buffer);

    // 2. Extract raw PCM from the merged frame (copy to avoid sharing the input ArrayBuffer)
    const segmentPcm = Buffer.from(
      Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
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
    url.searchParams.set('model', this.#opts.model);

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
          // Drain/cancel response body so undici can release the socket back to the pool.
          await response.body?.cancel().catch(() => {});
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown error');
          throw new APIStatusError({
            message: `Blaze STT error ${response.status}: ${errorText}`,
            options: { statusCode: response.status },
          });
        }

        // 10. Parse response
        result = (await response.json()) as BlazeSTTResponse;
        break; // Success
      } catch (err) {
        if (attempt < MAX_RETRY_COUNT && isRetryableRecognizeError(err)) {
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

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }

  /** @internal */
  get resolvedOptions(): ResolvedSTTOptions {
    return this.#opts;
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

/**
 * Realtime STT over Blaze WebSocket `/v1/stt/realtime` (stt-stream-1.5).
 *
 * Protocol:
 *   1. Connect WS, send `{token, language, model}`
 *   2. Wait for `{type: "ready"}` (or connection-ready messages)
 *   3. Stream binary PCM (s16le mono, typically 16 kHz)
 *   4. Receive `{type: "partial"|"final"|"error", text: "..."}`
 */
export class SpeechStream extends stt.SpeechStream {
  label = 'blaze.SpeechStream';
  #opts: ResolvedSTTOptions;

  constructor(sttInstance: STT, opts: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    if (!this.#opts.authToken) {
      throw new APIConnectionError({
        message: 'Blaze STT streaming requires an auth token (BLAZE_API_TOKEN)',
      });
    }

    const ws = new WebSocket(this.#opts.wsUrl);
    const closeWsSilently = () => {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          ws.off('open', onOpen);
          ws.off('error', onError);
        };
        ws.on('open', onOpen);
        ws.on('error', onError);
      });

      ws.send(
        JSON.stringify({
          token: this.#opts.authToken,
          language: this.#opts.language,
          model: this.#opts.streamModel,
        }),
      );

      // Wait for ready / auth ack.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new APIConnectionError({ message: 'STT realtime: timed out waiting for ready' }));
        }, this.#opts.timeout);

        const onMessage = (data: WebSocket.RawData) => {
          const text =
            typeof data === 'string'
              ? data
              : Buffer.isBuffer(data)
                ? data.toString('utf8')
                : '';
          if (!text) return;
          let msg: { type?: string; text?: string };
          try {
            msg = JSON.parse(text) as { type?: string; text?: string };
          } catch {
            return;
          }
          if (
            msg.type === 'ready' ||
            msg.type === 'successful-connection' ||
            msg.type === 'successful-authentication'
          ) {
            cleanup();
            resolve();
            return;
          }
          if (msg.type === 'error') {
            cleanup();
            reject(
              new APIConnectionError({
                message: `STT realtime auth error: ${msg.text ?? JSON.stringify(msg)}`,
              }),
            );
          }
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          clearTimeout(timer);
          ws.off('message', onMessage);
          ws.off('error', onError);
        };
        ws.on('message', onMessage);
        ws.on('error', onError);
      });
    } catch (err) {
      // Handshake failures must not leak open sockets across base-class retries.
      closeWsSilently();
      throw err;
    }

    // Abort controller so sendLoop terminates when the socket ends (error/close)
    // without waiting forever for the still-open mic input queue.
    const socketEnded = new AbortController();
    let socketError: Error | null = null;
    let speaking = false;

    const sendLoop = (async () => {
      try {
        for await (const frame of this.input) {
          if (socketEnded.signal.aborted) break;
          if (frame === SpeechStream.FLUSH_SENTINEL) {
            continue;
          }
          if (ws.readyState !== WebSocket.OPEN) break;
          const pcm = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          );
          if (pcm.byteLength > 0) {
            try {
              ws.send(pcm);
            } catch {
              break;
            }
          }
        }
      } catch {
        // Input closed / aborted — normal shutdown path.
      }
    })();

    try {
      await new Promise<void>((resolve, reject) => {
        const onMessage = (data: WebSocket.RawData) => {
          const text =
            typeof data === 'string'
              ? data
              : Buffer.isBuffer(data)
                ? data.toString('utf8')
                : '';
          if (!text) return;
          let msg: { type?: string; text?: string; confidence?: number };
          try {
            msg = JSON.parse(text) as {
              type?: string;
              text?: string;
              confidence?: number;
            };
          } catch {
            return;
          }

          if (msg.type === 'error') {
            socketError = new APIConnectionError({
              message: `STT realtime error: ${msg.text ?? JSON.stringify(msg)}`,
            });
            socketEnded.abort();
            reject(socketError);
            return;
          }

          if (msg.type !== 'partial' && msg.type !== 'final' && msg.type !== 'interim') {
            return;
          }

          let transcript = msg.text ?? '';
          const rules = this.#opts.normalizationRules;
          if (rules) {
            const entries = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
            for (const [from, to] of entries) {
              if (!from) continue;
              transcript = transcript.replaceAll(from, to);
            }
          }
          if (!transcript.trim() && msg.type !== 'final') return;

          // AgentSession stt turn-detection needs START_OF_SPEECH to open the user turn.
          if (transcript.trim() && !speaking) {
            speaking = true;
            this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          }

          const eventType =
            msg.type === 'final'
              ? stt.SpeechEventType.FINAL_TRANSCRIPT
              : stt.SpeechEventType.INTERIM_TRANSCRIPT;

          this.queue.put({
            type: eventType,
            alternatives: [
              {
                text: transcript,
                language: this.#opts.language as stt.SpeechData['language'],
                startTime: 0,
                endTime: 0,
                confidence: msg.confidence ?? 1.0,
              },
            ],
          });

          if (msg.type === 'final' && speaking) {
            speaking = false;
            this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
          }
        };

        const onClose = () => {
          socketEnded.abort();
          resolve();
        };
        const onError = (err: Error) => {
          socketError = err;
          socketEnded.abort();
          reject(err);
        };

        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);

        void sendLoop
          .then(() => {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.close();
            } catch {
              // ignore
            }
          })
          .catch(reject);
      });
      if (socketError) throw socketError;
    } finally {
      socketEnded.abort();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
      // Don't await sendLoop forever — race against a short drain so mid-stream
      // socket failures cannot deadlock run() while mic input stays open.
      await Promise.race([
        sendLoop.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 250)),
      ]);
    }
  }
}
