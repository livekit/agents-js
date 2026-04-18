// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze TTS Plugin for LiveKit Voice Agent (Node.js)
 *
 * Text-to-Speech plugin interfacing with Blaze TTS service.
 *
 * Streaming Mode (SynthesizeStream):
 *   WebSocket Endpoint: ws(s)://gateway/v1/tts/realtime
 *   Protocol:
 *     1. Connect - receive type: "successful-connection"
 *     2. Send token/strategy - receive type: "successful-authentication"
 *     3. Send event: "speech-start" with params
 *     4. Send query: "..." (one or more batches)
 *     5. Send event: "speech-end"
 *     6. Receive: JSON control msgs + binary PCM frames
 *
 * One-shot Mode (ChunkedStream):
 *   HTTP Endpoint: POST /v1/tts/realtime
 *   Input: FormData (query, language, audio_format, speaker_id, normalization, model)
 *   Output: Streaming raw PCM audio
 */
import { AudioByteStream, tts, APIStatusError, APIConnectionError } from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import WebSocket from 'ws';
import {
  type BlazeConfig,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  resolveConfig,
} from './config.js';

// ────────────────────────────────────────────────
// Sentence boundary regex
// ────────────────────────────────────────────────

const SENTENCE_END_RE = /(?:\n\n+|\n|[.!?;:。！？；：](?:\s|$))/g;

// ────────────────────────────────────────────────
// Audio helpers
// ────────────────────────────────────────────────

/**
 * Apply linear fade-in and/or fade-out to PCM16-LE audio.
 */
function applyPcm16Fade(
  pcm: Buffer,
  fadeSamples: number,
  fadeIn: boolean,
  fadeOut: boolean,
): Buffer {
  if (!pcm.length || (!fadeIn && !fadeOut)) return pcm;
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount <= 0) return pcm;
  const usable = Math.min(fadeSamples, Math.floor(sampleCount / 2));
  if (usable <= 0) return pcm;

  const result = Buffer.from(pcm);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

  if (fadeIn) {
    for (let i = 0; i < usable; i++) {
      const offset = i * 2;
      const sample = view.getInt16(offset, true);
      view.setInt16(offset, Math.round(sample * (i / usable)), true);
    }
  }
  if (fadeOut) {
    for (let i = 0; i < usable; i++) {
      const offset = (sampleCount - usable + i) * 2;
      const sample = view.getInt16(offset, true);
      view.setInt16(offset, Math.round(sample * ((usable - i) / usable)), true);
    }
  }
  return result;
}

/**
 * Generate silence buffer (PCM16 zeros).
 */
function generateSilence(sampleRate: number, durationMs: number): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2);
}

// ────────────────────────────────────────────────
// Batching helpers
// ────────────────────────────────────────────────

function wordCount(s: string): number {
  return (s.match(/\S+/g) || []).length;
}

interface BatchSplitOpts {
  minChars: number;
  targetChars: number;
  maxChars: number;
  force: boolean;
  isFirstBatch: boolean;
}

/**
 * Find the optimal split position in accumulated text for TTS batching.
 * Returns the string index to split at, or null if no split is ready yet.
 */
function findBatchSplit(text: string, opts: BatchSplitOpts): number | null {
  if (!text.trim()) return null;
  const hardLimit = Math.min(text.length, opts.maxChars);

  // Find all sentence-end positions within the limit
  const positions: number[] = [];
  SENTENCE_END_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END_RE.exec(text.slice(0, hardLimit))) !== null) {
    positions.push(m.index + m[0].length);
  }

  // First batch: prioritize word count for faster first audio
  if (opts.isFirstBatch) {
    for (const pos of positions) {
      if (wordCount(text.slice(0, pos)) >= 4) return pos;
    }
  }

  // Hard limit reached — must split
  if (text.length >= opts.maxChars) {
    if (positions.length > 0) return positions[positions.length - 1]!;
    return safeSplitOnWhitespace(text, opts.maxChars, opts.minChars);
  }

  // Enough text accumulated — prefer boundary around target size
  if (text.length >= opts.minChars && positions.length > 0) {
    if (text.length >= opts.targetChars) {
      for (const pos of positions) {
        if (pos >= opts.targetChars) return pos;
      }
    }
    const candidates = positions.filter((p) => p >= opts.minChars);
    if (candidates.length > 0) return candidates[candidates.length - 1]!;
  }

  // Force flush: send whatever we have
  if (opts.force) {
    if (positions.length > 0) return positions[positions.length - 1]!;
    return safeSplitOnWhitespace(text, text.length, 1);
  }

  return null;
}

function safeSplitOnWhitespace(text: string, preferredIdx: number, floorIdx: number): number {
  let idx = Math.min(Math.max(preferredIdx, 1), text.length);
  const floor = Math.max(1, Math.min(floorIdx, idx));
  while (idx > floor && !/\s/.test(text[idx - 1] ?? '')) {
    idx--;
  }
  if (idx <= floor) return preferredIdx;
  while (idx < text.length && /\s/.test(text[idx] ?? '')) {
    idx++;
  }
  return idx;
}

function normalizeBatchText(text: string): string {
  let result = text.replace(/\n{2,}/g, '\n');
  result = result.replace(/[ \t]{2,}/g, ' ');
  return result;
}

// ────────────────────────────────────────────────
// Normalization rules
// ────────────────────────────────────────────────

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

// ────────────────────────────────────────────────
// TTS Options
// ────────────────────────────────────────────────

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
  /** Audio output format: 'pcm' | 'mp3' | 'wav'. Default: 'pcm' */
  audioFormat?: string;
  /** Audio playback speed multiplier. Default: '1' */
  audioSpeed?: string;
  /** Audio quality (bitrate for mp3). Default: 32 */
  audioQuality?: number;
  /** Output sample rate in Hz. Default: 24000 */
  sampleRate?: number;
  /**
   * Dictionary of text replacements applied before synthesis.
   * Keys are search strings, values are replacements.
   * Example: `{ "$": "đô la", "%": "phần trăm" }`
   */
  normalizationRules?: Record<string, string>;
  /** Minimum chars before first batch can be sent. Default: 100 */
  batchMinChars?: number;
  /** Target chars per batch. Default: 200 */
  batchTargetChars?: number;
  /** Maximum chars per batch (hard limit). Default: 350 */
  batchMaxChars?: number;
  /** Max wait time (ms) before force-flushing a batch. Default: 450 */
  batchMaxWaitMs?: number;
  /** Silence duration between TTS segments (ms). Default: 150 */
  interSentenceSilenceMs?: number;
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
  audioFormat: string;
  audioSpeed: string;
  audioQuality: number;
  sampleRate: number;
  normalizationRules?: Record<string, string>;
  batchMinChars: number;
  batchTargetChars: number;
  batchMaxChars: number;
  batchMaxWaitMs: number;
  interSentenceSilenceMs: number;
  timeout: number;
  wsUrl: string;
}

function resolveTTSOptions(opts: TTSOptions): ResolvedTTSOptions {
  const cfg: ResolvedBlazeConfig = resolveConfig(opts.config);
  const apiUrl = opts.apiUrl ?? cfg.apiUrl;
  const wsBase = apiUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  let audioFormat = (opts.audioFormat ?? 'pcm').trim().toLowerCase();
  if (!['pcm', 'mp3', 'wav'].includes(audioFormat)) audioFormat = 'pcm';

  return {
    apiUrl,
    language: opts.language ?? 'vi',
    speakerId: opts.speakerId ?? 'default',
    authToken: opts.authToken ?? cfg.authToken,
    model: opts.model ?? 'v1_5_pro',
    audioFormat,
    audioSpeed: opts.audioSpeed ?? '1',
    audioQuality: opts.audioQuality ?? 32,
    sampleRate: opts.sampleRate ?? 24000,
    normalizationRules: opts.normalizationRules,
    batchMinChars: opts.batchMinChars ?? 100,
    batchTargetChars: opts.batchTargetChars ?? 200,
    batchMaxChars: opts.batchMaxChars ?? 350,
    batchMaxWaitMs: opts.batchMaxWaitMs ?? 450,
    interSentenceSilenceMs: opts.interSentenceSilenceMs ?? 150,
    timeout: opts.timeout ?? cfg.ttsTimeout,
    wsUrl: `${wsBase}/v1/tts/realtime`,
  };
}

function snapshotTTSOptions(opts: ResolvedTTSOptions): ResolvedTTSOptions {
  return {
    ...opts,
    normalizationRules: opts.normalizationRules ? { ...opts.normalizationRules } : undefined,
  };
}

// ────────────────────────────────────────────────
// WebSocket helpers
// ────────────────────────────────────────────────

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    const onOpen = () => {
      ws.off('error', onError);
      resolve(ws);
    };
    const onError = (err: Error) => {
      ws.off('open', onOpen);
      reject(
        new APIConnectionError({
          message: `Blaze TTS failed to connect to WebSocket: ${err.message}`,
        }),
      );
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function waitForWsTextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onMessage = (data: Buffer | string) => {
      cleanup();
      resolve(typeof data === 'string' ? data : data.toString());
    };
    const onError = (err: Error) => {
      cleanup();
      reject(
        new APIConnectionError({
          message: `Blaze TTS WebSocket error: ${err.message}`,
        }),
      );
    };
    const onClose = () => {
      cleanup();
      reject(new APIConnectionError({ message: 'Blaze TTS WebSocket closed unexpectedly' }));
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

// ────────────────────────────────────────────────
// HTTP-based one-shot synthesis (for ChunkedStream)
// ────────────────────────────────────────────────

/**
 * Fetch PCM audio from Blaze TTS HTTP API and emit frames via the queue.
 * Used by ChunkedStream for one-shot synthesis.
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
  formData.append('audio_format', opts.audioFormat);
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
      throw new APIStatusError({
        message: `Blaze TTS error ${response.status}: ${errorText}`,
        options: { statusCode: response.status },
      });
    }

    if (!response.body) {
      throw new APIConnectionError({ message: 'Blaze TTS: response body is null' });
    }

    const bstream = new AudioByteStream(opts.sampleRate, 1);
    const reader = response.body.getReader();
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

      for (const frame of bstream.flush()) {
        if (pendingFrame !== undefined) {
          queue.put({ requestId, segmentId, frame: pendingFrame, final: false });
        }
        pendingFrame = frame;
      }
    } finally {
      reader.releaseLock();
    }

    if (pendingFrame !== undefined) {
      queue.put({ requestId, segmentId, frame: pendingFrame, final: true });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ────────────────────────────────────────────────
// ChunkedStream: one-shot synthesis via HTTP POST
// ────────────────────────────────────────────────

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

// ────────────────────────────────────────────────
// SynthesizeStream: WebSocket streaming with batching
// ────────────────────────────────────────────────

const TIMEOUT_SENTINEL = Symbol('TIMEOUT');

/**
 * Streaming TTS: opens a persistent WebSocket connection and streams text
 * in optimally-sized batches for low first-audio latency.
 *
 * Text tokens from the LLM are accumulated and split at sentence boundaries
 * using the configurable batch size parameters. Audio is received concurrently
 * from the TTS service, with inter-sentence silence injection and PCM fade
 * applied per segment.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'blaze.SynthesizeStream';
  readonly #opts: ResolvedTTSOptions;

  constructor(ttsInstance: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const opts = this.#opts;
    const requestId = crypto.randomUUID();
    const segmentId = requestId;
    const fadeSamples = Math.max(1, Math.floor(opts.sampleRate * 0.008));
    const silenceBuf = generateSilence(opts.sampleRate, opts.interSentenceSilenceMs);

    // --- Open WebSocket and perform handshake ---
    let ws: WebSocket;
    try {
      ws = await openWebSocket(opts.wsUrl);
    } catch (err) {
      throw new APIConnectionError({
        message: `Blaze TTS: failed to connect to ${opts.wsUrl}: ${err}`,
      });
    }

    try {
      // Wait for connection acknowledgment
      const connMsg = await waitForWsTextMessage(ws);
      const connData = JSON.parse(connMsg) as Record<string, string>;
      if (connData.type !== 'successful-connection') {
        throw new APIConnectionError({
          message: `Blaze TTS: unexpected connection response: ${connMsg}`,
        });
      }

      // Authenticate
      ws.send(JSON.stringify({ token: opts.authToken, strategy: 'livekit' }));
      const authMsg = await waitForWsTextMessage(ws);
      const authData = JSON.parse(authMsg) as Record<string, string>;
      if (authData.type !== 'successful-authentication') {
        throw new APIConnectionError({
          message: `Blaze TTS: authentication failed: ${authMsg}`,
        });
      }

      // Send speech-start with TTS parameters
      ws.send(
        JSON.stringify({
          event: 'speech-start',
          language: opts.language,
          speaker_id: opts.speakerId,
          model: opts.model,
          audio_format: opts.audioFormat,
          audio_speed: opts.audioSpeed,
          audio_quality: String(opts.audioQuality),
          normalization: 'no',
        }),
      );

      // --- Set up concurrent audio reader (event-driven) ---
      const bstream = new AudioByteStream(opts.sampleRate, 1);
      let pendingFrame: AudioFrame | undefined;
      let hasPrevSegment = false;
      let speechEnded = false;

      let audioReaderResolve!: () => void;
      let audioReaderReject!: (err: Error) => void;
      const audioReaderDone = new Promise<void>((resolve, reject) => {
        audioReaderResolve = resolve;
        audioReaderReject = reject;
      });
      // Prevent transient unhandledRejection before we await audioReaderDone later.
      audioReaderDone.catch(() => {});

      const emitFrame = (frame: AudioFrame, isFinal: boolean) => {
        this.queue.put({ requestId, segmentId, frame, final: isFinal });
      };

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        try {
          if (isBinary) {
            // Binary audio data
            const buf = data as Buffer;
            const chunk = new Uint8Array(buf).buffer;
            for (const frame of bstream.write(chunk)) {
              if (pendingFrame !== undefined) {
                emitFrame(pendingFrame, false);
              }
              pendingFrame = frame;
            }
          } else {
            // JSON control message
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<
              string,
              string
            >;
            const status = msg.status ?? msg.type ?? '';

            if (status === 'started-byte-stream') {
              // New TTS segment starting — inject inter-sentence silence
              if (hasPrevSegment && silenceBuf.length > 0) {
                const silenceChunk = new Uint8Array(silenceBuf).buffer;
                for (const frame of bstream.write(silenceChunk)) {
                  if (pendingFrame !== undefined) {
                    emitFrame(pendingFrame, false);
                  }
                  pendingFrame = frame;
                }
              }
            } else if (status === 'finished-byte-stream') {
              hasPrevSegment = true;
            } else if (status === 'speech-end') {
              speechEnded = true;
              // Flush remaining buffered audio
              for (const frame of bstream.flush()) {
                if (pendingFrame !== undefined) {
                  emitFrame(pendingFrame, false);
                }
                pendingFrame = frame;
              }
              // Emit last frame as final
              if (pendingFrame !== undefined) {
                emitFrame(pendingFrame, true);
                pendingFrame = undefined;
              }
              audioReaderResolve();
            } else if (status === 'failed-request' || status === 'error') {
              audioReaderReject(new APIConnectionError({
                message: `Blaze TTS error: ${msg.message ?? status}`,
              }));
            }
          }
        } catch (err) {
          audioReaderReject(err instanceof APIConnectionError ? err : new APIConnectionError({
            message: `Blaze TTS stream error: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      });

      ws.on('error', (err: Error) => {
        if (!speechEnded) {
          audioReaderReject(
            new APIConnectionError({
              message: `Blaze TTS WebSocket error: ${err.message}`,
            }),
          );
        }
      });

      ws.on('close', () => {
        if (!speechEnded) {
          // Unexpected close — flush what we have
          for (const frame of bstream.flush()) {
            if (pendingFrame !== undefined) {
              emitFrame(pendingFrame, false);
            }
            pendingFrame = frame;
          }
          if (pendingFrame !== undefined) {
            emitFrame(pendingFrame, true);
            pendingFrame = undefined;
          }
          audioReaderResolve();
        }
      });

      // --- Text batching loop ---
      let textBuf = '';
      let batchCount = 0;
      let inputDone = false;

      const sendQuery = (text: string) => {
        const normalized = applyNormalizationRules(text, opts.normalizationRules);
        const cleaned = normalizeBatchText(normalized);
        if (!cleaned.trim()) return;
        batchCount++;
        ws.send(JSON.stringify({ query: cleaned }));
      };

      const drainBatches = (force: boolean) => {
        while (textBuf.length > 0) {
          const idx = findBatchSplit(textBuf, {
            minChars: opts.batchMinChars,
            targetChars: opts.batchTargetChars,
            maxChars: opts.batchMaxChars,
            force,
            isFirstBatch: batchCount === 0,
          });
          if (idx === null) break;
          const chunk = textBuf.slice(0, idx);
          textBuf = textBuf.slice(idx);
          if (!chunk.trim()) continue;
          if (chunk.trim().length < 8 && !force) {
            textBuf = chunk + textBuf;
            break;
          }
          sendQuery(chunk);
        }
      };

      // Read input tokens with batch timeout support.
      // We manually iterate to support timeout-based flushing.
      const inputIter = this.input[Symbol.asyncIterator]();
      let pendingNext: Promise<
        IteratorResult<string | typeof tts.SynthesizeStream.FLUSH_SENTINEL>
      > | null = null;

      while (!inputDone) {
        if (this.abortSignal.aborted) break;

        if (!pendingNext) {
          pendingNext = inputIter.next();
        }

        // Race between next token and batch timeout. Always clear the timeout
        // when the token path wins to avoid orphaned timers.
        let batchTimeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
          batchTimeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), opts.batchMaxWaitMs);
        });

        let result: IteratorResult<string | typeof tts.SynthesizeStream.FLUSH_SENTINEL> | typeof TIMEOUT_SENTINEL;
        try {
          result = await Promise.race([
            pendingNext.then(
              (r) => r as IteratorResult<string | typeof tts.SynthesizeStream.FLUSH_SENTINEL>,
            ),
            timeoutPromise,
          ]);
        } finally {
          if (batchTimeoutId !== undefined) {
            clearTimeout(batchTimeoutId);
          }
        }

        if (result === TIMEOUT_SENTINEL) {
          // Timeout — flush accumulated text if we have enough for first batch
          if (textBuf.trim() && batchCount === 0 && wordCount(textBuf) >= 4) {
            sendQuery(textBuf);
            textBuf = '';
          } else {
            drainBatches(false);
          }
          continue;
        }

        pendingNext = null; // Consumed

        if (result.done) {
          inputDone = true;
          break;
        }

        const item = result.value;
        if (item === tts.SynthesizeStream.FLUSH_SENTINEL) {
          drainBatches(true);
          continue;
        }

        textBuf += item;
        drainBatches(false);
      }

      // Flush any remaining text
      if (textBuf.trim()) {
        sendQuery(textBuf);
        textBuf = '';
      }

      // End speech session
      ws.send(JSON.stringify({ event: 'speech-end' }));

      // Wait for all audio to be received
      await audioReaderDone;

      // Signal end of stream to framework
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }
}

// ────────────────────────────────────────────────
// TTS Plugin
// ────────────────────────────────────────────────

/**
 * Blaze Text-to-Speech Plugin.
 *
 * Converts text to speech using the Blaze TTS service.
 * Supports both one-shot synthesis (ChunkedStream) via HTTP and
 * streaming synthesis (SynthesizeStream) via WebSocket with text batching.
 *
 * @example
 * ```typescript
 * import { TTS } from '@livekit/agents-plugin-blaze';
 *
 * const tts = new TTS({ speakerId: 'speaker-1', language: 'vi' });
 * // Or with shared config and batching options:
 * const tts = new TTS({
 *   config: { apiUrl: 'http://tts:8080', authToken: 'tok' },
 *   batchMinChars: 80,
 *   batchTargetChars: 150,
 *   interSentenceSilenceMs: 200,
 * });
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
    if (opts.audioFormat !== undefined) this.#opts.audioFormat = opts.audioFormat;
    if (opts.audioSpeed !== undefined) this.#opts.audioSpeed = opts.audioSpeed;
    if (opts.audioQuality !== undefined) this.#opts.audioQuality = opts.audioQuality;
    if (opts.timeout !== undefined) this.#opts.timeout = opts.timeout;
    if (opts.normalizationRules !== undefined)
      this.#opts.normalizationRules = opts.normalizationRules;
    if (opts.batchMinChars !== undefined) this.#opts.batchMinChars = opts.batchMinChars;
    if (opts.batchTargetChars !== undefined) this.#opts.batchTargetChars = opts.batchTargetChars;
    if (opts.batchMaxChars !== undefined) this.#opts.batchMaxChars = opts.batchMaxChars;
    if (opts.batchMaxWaitMs !== undefined) this.#opts.batchMaxWaitMs = opts.batchMaxWaitMs;
    if (opts.interSentenceSilenceMs !== undefined)
      this.#opts.interSentenceSilenceMs = opts.interSentenceSilenceMs;
    // Recompute WS URL if apiUrl changed
    if (opts.apiUrl !== undefined) {
      this.#opts.apiUrl = opts.apiUrl;
      const wsBase = opts.apiUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      this.#opts.wsUrl = `${wsBase}/v1/tts/realtime`;
    }
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
