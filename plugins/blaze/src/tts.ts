// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze TTS Plugin for LiveKit Voice Agent (Node.js)
 *
 * Text-to-Speech plugin interfacing with Blaze TTS service.
 *
 * API Endpoint: POST /v1/tts/realtime
 * Input: FormData: query, language, audio_format=pcm, speaker_id, normalization=no, model
 * Output: Streaming raw PCM audio (24000 Hz, mono, 16-bit)
 */
import { AudioByteStream, tts } from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import {
  type BlazeConfig,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  resolveConfig,
} from './config.js';

/** Options for the Blaze TTS plugin. */
export interface TTSOptions {
  /**
   * Base URL for the TTS service.
   * Falls back to config.apiUrl → BLAZE_API_URL env var.
   */
  apiUrl?: string;
  /** Language code. Default: "vi" */
  language?: string;
  /** Speaker/voice identifier. Default: "default" */
  speakerId?: string;
  /** Bearer token for authentication. Falls back to BLAZE_API_TOKEN env var. */
  authToken?: string;
  /** TTS model identifier. Default: "v1_5_pro" */
  model?: string;
  /** Output sample rate in Hz. Default: 24000 */
  sampleRate?: number;
  /**
   * Dictionary of text replacements applied before synthesis.
   * Keys are search strings, values are replacements.
   * Example: `{ "$": "đô la", "%": "phần trăm" }`
   */
  normalizationRules?: Record<string, string>;
  /** Request timeout in milliseconds. Default: 60000 */
  timeout?: number;
  /** Centralized configuration object. */
  config?: BlazeConfig;
}

interface ResolvedTTSOptions {
  apiUrl: string;
  language: string;
  speakerId: string;
  authToken: string;
  model: string;
  sampleRate: number;
  normalizationRules?: Record<string, string>;
  timeout: number;
}

function snapshotTTSOptions(opts: ResolvedTTSOptions): ResolvedTTSOptions {
  return {
    ...opts,
    normalizationRules: opts.normalizationRules ? { ...opts.normalizationRules } : undefined,
  };
}

function resolveTTSOptions(opts: TTSOptions): ResolvedTTSOptions {
  const cfg: ResolvedBlazeConfig = resolveConfig(opts.config);
  return {
    apiUrl: opts.apiUrl ?? cfg.apiUrl,
    language: opts.language ?? 'vi',
    speakerId: opts.speakerId ?? 'default',
    authToken: opts.authToken ?? cfg.authToken,
    model: opts.model ?? 'v1_5_pro',
    sampleRate: opts.sampleRate ?? 24000,
    normalizationRules: opts.normalizationRules,
    timeout: opts.timeout ?? cfg.ttsTimeout,
  };
}

/**
 * Apply string replacement normalization rules to text before synthesis.
 */
function applyNormalizationRules(text: string, rules?: Record<string, string>): string {
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

/**
 * Fetch PCM audio from Blaze TTS API and emit frames via the queue.
 *
 * Common logic shared by ChunkedStream and SynthesizeStream.
 */
async function synthesizeAudio(
  text: string,
  opts: ResolvedTTSOptions,
  requestId: string,
  segmentId: string,
  queue: { put: (item: tts.SynthesizedAudio) => void },
  abortSignal: AbortSignal,
): Promise<void> {
  const normalized = applyNormalizationRules(text, opts.normalizationRules);

  const formData = new FormData();
  formData.append('query', normalized);
  formData.append('language', opts.language);
  formData.append('audio_format', 'pcm');
  formData.append('speaker_id', opts.speakerId);
  formData.append('normalization', 'no');
  formData.append('model', opts.model);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout);
  const signal = AbortSignal.any([abortSignal, controller.signal]);

  let response: Response;
  try {
    response = await fetch(`${opts.apiUrl}/v1/tts/realtime`, {
      method: 'POST',
      headers: buildAuthHeaders(opts.authToken),
      body: formData,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Blaze TTS error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Blaze TTS: response body is null');
    }

    const bstream = new AudioByteStream(opts.sampleRate, 1);
    const reader = response.body.getReader();

    // Buffer frames to ensure final=true is only set on the last frame
    let pendingFrame: AudioFrame | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) break;

        const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        for (const frame of bstream.write(chunk)) {
          if (pendingFrame !== undefined) {
            queue.put({ requestId, segmentId, frame: pendingFrame, final: false });
          }
          pendingFrame = frame;
        }
      }

      // Flush remaining buffered samples
      for (const frame of bstream.flush()) {
        if (pendingFrame !== undefined) {
          queue.put({ requestId, segmentId, frame: pendingFrame, final: false });
        }
        pendingFrame = frame;
      }
    } finally {
      reader.releaseLock();
    }

    // Emit last frame with final=true
    if (pendingFrame !== undefined) {
      queue.put({ requestId, segmentId, frame: pendingFrame, final: true });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * One-shot TTS stream: synthesizes a complete text segment and returns audio frames.
 */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'blaze.ChunkedStream';
  readonly #opts: ResolvedTTSOptions;

  constructor(
    text: string,
    ttsInstance: TTS,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = crypto.randomUUID();
    await synthesizeAudio(
      this.inputText,
      this.#opts,
      requestId,
      requestId,
      this.queue,
      this.abortSignal,
    );
  }
}

/**
 * Streaming TTS: accumulates text until flush(), then synthesizes each segment.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'blaze.SynthesizeStream';
  readonly #opts: ResolvedTTSOptions;

  constructor(ttsInstance: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    let textBuffer = '';

    for await (const item of this.input) {
      // Check for flush sentinel (end of a text segment)
      if (item === tts.SynthesizeStream.FLUSH_SENTINEL) {
        if (textBuffer.trim()) {
          const requestId = crypto.randomUUID();
          const segmentId = requestId;

          await synthesizeAudio(
            textBuffer,
            this.#opts,
            requestId,
            segmentId,
            this.queue,
            this.abortSignal,
          );

          // Signal end of this segment
          this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
        }
        textBuffer = '';
      } else {
        textBuffer += item;
      }
    }

    // Handle any remaining text after input ends
    if (textBuffer.trim()) {
      const requestId = crypto.randomUUID();
      await synthesizeAudio(
        textBuffer,
        this.#opts,
        requestId,
        requestId,
        this.queue,
        this.abortSignal,
      );
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    }
  }
}

/**
 * Blaze Text-to-Speech Plugin.
 *
 * Converts text to speech using the Blaze TTS service.
 * Supports both one-shot synthesis (ChunkedStream) and streaming (SynthesizeStream).
 *
 * @example
 * ```typescript
 * import { TTS } from '@livekit/agents-plugin-blaze';
 *
 * const tts = new TTS({ speakerId: 'speaker-1', language: 'vi' });
 * // Or with shared config:
 * const tts = new TTS({ config: { apiUrl: 'http://tts:8080', authToken: 'tok' } });
 * ```
 */
export class TTS extends tts.TTS {
  label = 'blaze.TTS';
  #opts: ResolvedTTSOptions;

  constructor(opts: TTSOptions = {}) {
    const resolved = resolveTTSOptions(opts);
    super(resolved.sampleRate, 1, { streaming: true });
    this.#opts = resolved;
  }

  /**
   * Update TTS options at runtime.
   */
  updateOptions(opts: Partial<Omit<TTSOptions, 'config'>>): void {
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.speakerId !== undefined) this.#opts.speakerId = opts.speakerId;
    if (opts.authToken !== undefined) this.#opts.authToken = opts.authToken;
    if (opts.model !== undefined) this.#opts.model = opts.model;
    if (opts.timeout !== undefined) this.#opts.timeout = opts.timeout;
    if (opts.normalizationRules !== undefined)
      this.#opts.normalizationRules = opts.normalizationRules;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(text, this, snapshotTTSOptions(this.#opts), connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, snapshotTTSOptions(this.#opts), options?.connOptions);
  }
}
