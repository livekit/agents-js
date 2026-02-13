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

// ---------------------------------------------------------------------------
// Model-specific option types
// ---------------------------------------------------------------------------

interface STTBaseOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
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
  // saaras:v3 and saaras:v2.5 (translate)
  mode?: STTModes | string;
  // saaras:v2.5 (translate) and saaras:v3
  prompt?: string;
  // saarika:v2.5 and saaras:v3 (/speech-to-text only, not translate)
  withTimestamps?: boolean;
  // WS-only flags
  highVadSensitivity?: boolean;
  flushSignal?: boolean;
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
    highVadSensitivity: opts.highVadSensitivity,
    flushSignal: opts.flushSignal,
  };

  if (model === 'saaras:v2.5') {
    const translateOpts = opts as STTTranslateOptions;
    base.prompt = translateOpts.prompt;
    base.mode = translateOpts.mode ?? SAARAS_TRANSLATE_DEFAULTS.mode;
  } else if (model === 'saaras:v3') {
    const v3Opts = opts as STTV3Options;
    base.languageCode = v3Opts.languageCode ?? SAARAS_V3_DEFAULTS.languageCode;
    base.mode = v3Opts.mode ?? SAARAS_V3_DEFAULTS.mode;
    base.prompt = v3Opts.prompt;
    base.withTimestamps = v3Opts.withTimestamps;
  } else {
    // saarika:v2.5
    let languageCode = (opts as STTV2Options).languageCode ?? SAARIKA_DEFAULTS.languageCode;
    if (!STTV2_LANGUAGE_SET.has(languageCode)) {
      languageCode = SAARIKA_DEFAULTS.languageCode;
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
  timestamps?: Record<string, unknown> | null;
  diarized_transcript?: Record<string, unknown> | null;
  metrics?: {
    audio_duration?: number;
    processing_latency?: number;
  };
}

/** type: "events" */
interface SarvamWSEventData {
  event_type?: string;
  timestamp?: string;
  signal_type?: 'START_SPEECH' | 'END_SPEECH';
  occured_at?: number;
}

/** type: "error" — server sends { data: { message: "...", code: "..." } } */
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
    super({ streaming: true, interimResults: false, alignedTranscript: false });
    this.opts = resolveOptions(opts);
  }

  updateOptions(opts: Partial<STTOptions>) {
    const modelChanging = opts.model != null && opts.model !== this.opts.model;

    const base: Partial<STTOptions> = modelChanging
      ? {
          apiKey: this.opts.apiKey,
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
          language: data.language_code ?? this.opts.languageCode ?? 'unknown',
          startTime,
          endTime,
          confidence: data.language_probability ?? 0,
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
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

  protected async run() {
    const maxRetry = 32;
    let retries = 0;

    while (!this.input.closed && !this.closed) {
      const wsUrl = buildWsUrl(this.#opts);
      this.#logger.info(`Sarvam STT connecting to: ${wsUrl}`);
      const ws = new WebSocket(wsUrl, {
        headers: { 'api-subscription-key': this.#opts.apiKey },
      });

      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', (err: Error) => reject(err));
          ws.once('close', (code: number) =>
            reject(new Error(`WebSocket closed with code ${code}`)),
          );
        });

        retries = 0;
        await this.#runWS(ws);
      } catch (e) {
        // Clean up the WebSocket on failure to prevent listener leaks
        ws.removeAllListeners();
        ws.close();

        if (!this.closed && !this.input.closed) {
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
            frames = stream.write(data.data.buffer as ArrayBuffer);
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
              const signalType = eventData.signal_type;

              if (signalType === 'START_SPEECH') {
                if (!this.#speaking) {
                  this.#speaking = true;
                  putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                }
              } else if (signalType === 'END_SPEECH') {
                if (this.#speaking) {
                  this.#speaking = false;
                  putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
                }
              }
            } else if (msgType === 'data') {
              const td = (json['data'] as SarvamWSTranscriptData | undefined) ?? {};
              const transcript = td.transcript ?? '';
              const language = td.language_code ?? this.#opts.languageCode ?? 'unknown';
              const requestId = td.request_id ?? '';
              const confidence = td.language_probability ?? 1.0;
              this.#requestId = requestId;

              // Log metrics when available
              if (td.metrics) {
                this.#logger.debug(
                  `Sarvam STT metrics: audio_duration=${td.metrics.audio_duration}s, latency=${td.metrics.processing_latency}s`,
                );
              }

              if (transcript) {
                if (!this.#speaking) {
                  this.#speaking = true;
                  putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                }

                putMessage({
                  type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                  requestId,
                  alternatives: [
                    {
                      text: transcript,
                      language,
                      startTime: 0,
                      endTime: td.metrics?.audio_duration ?? 0,
                      confidence,
                    },
                  ],
                });
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
    });

    try {
      await Promise.race([
        this.#resetWS.await,
        Promise.all([sendTask(), listenTask.result, wsMonitor.result]),
      ]);
    } finally {
      closing = true;
      sessionController.abort();
      listenTask.cancel();
      wsMonitor.cancel();
      ws.close();
    }
  }
}
