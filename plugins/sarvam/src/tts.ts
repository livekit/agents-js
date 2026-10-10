// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  log,
  normalizeLanguage,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type {
  TTSLanguages,
  TTSModels,
  TTSOutputAudioBitrate,
  TTSOutputAudioCodec,
  TTSSampleRates,
  TTSSpeakers,
  TTSV2Speakers,
  TTSV3Speakers,
  TTSV4FlashSpeakers,
} from './models.js';
import { MODEL_SPEAKER_COMPATIBILITY } from './models.js';

const SARVAM_TTS_SAMPLE_RATE = 24000;
const SARVAM_TTS_CHANNELS = 1;
const SARVAM_BASE_URL = 'https://api.sarvam.ai';
const SARVAM_WS_URL_PATH = '/text-to-speech/ws';
const MIN_SENTENCE_LENGTH = 8;
const ALLOWED_OUTPUT_AUDIO_BITRATES = new Set<TTSOutputAudioBitrate>([
  '32k',
  '64k',
  '96k',
  '128k',
  '192k',
]);
const V4_STREAM_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000]);
const PARAM_BOUNDS = {
  pitch: [-0.75, 0.75],
  pace: [0.3, 3.0],
  loudness: [0.5, 2.0],
  temperature: [0.01, 2.0],
} as const;
const V4_PARAM_BOUNDS = {
  pitch: [-0.5, 0.5],
  pace: [0.5, 2.0],
  loudness: [0.1, 2.5],
  temperature: [0.01, 1.0],
} as const;
const MODULE_LOGGER = log();

const CODEC_TO_MIME_TYPE: Record<TTSOutputAudioCodec, string> = {
  wav: 'audio/wav',
  linear16: 'audio/pcm',
  mulaw: 'audio/pcm',
  alaw: 'audio/pcm',
};

const TELEPHONY_CODECS = new Set<TTSOutputAudioCodec>(['mulaw', 'alaw']);

// ---------------------------------------------------------------------------
// Model-specific option types
// V2 supports pitch / loudness / enablePreprocessing
// V3 supports temperature (pitch, loudness, enablePreprocessing are NOT supported)
// ---------------------------------------------------------------------------

interface TTSBaseOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
  /**
   * Whether to use native WebSocket streaming for `stream()`.
   * Set to `false` to prefer non-streaming REST synthesis (used by Agent via TTS StreamAdapter).
   * Default: `true`.
   */
  streaming?: boolean;
  /** Target language code (BCP-47) */
  targetLanguageCode?: TTSLanguages | string;
  /** Speech pace. v2/v3: 0.3–3.0, v4-flash: 0.5–2.0 (default 1.0) */
  pace?: number;
  /** Output sample rate in Hz (default 24000) */
  sampleRate?: TTSSampleRates | number;
  /** Output audio codec. Defaults to `linear16`; `mulaw` and `alaw` are decoded to PCM. */
  outputAudioCodec?: TTSOutputAudioCodec;
  /** Base URL for the Sarvam API */
  baseURL?: string;
  /** Sentence tokenizer for streaming (default: basic sentence tokenizer) */
  sentenceTokenizer?: tokenize.SentenceTokenizer;
  /** Output audio bitrate. Defaults to `128k`. */
  outputAudioBitrate?: TTSOutputAudioBitrate;
  /** Minimum streaming buffer size. Defaults to 50. */
  minBufferSize?: number;
  /** Maximum streaming chunk length. Defaults to 150. */
  maxChunkLength?: number;
  /** Request a final completion event from the WebSocket. Defaults to true. */
  sendCompletionEvent?: boolean;
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
  /** Custom pronunciation dictionary ID (v3 only) */
  dictId?: string;
}

/** Options specific to bulbul:v4-flash. */
export interface TTSV4FlashOptions extends TTSBaseOptions {
  model: 'bulbul:v4-flash';
  /** Speaker voice (v4-flash voices). Default: `shubh_en_narration_gentle`. */
  speaker?: TTSV4FlashSpeakers | string;
  /** Pitch adjustment, -0.5 to 0.5. */
  pitch?: number;
  /** Loudness, 0.1 to 2.5. */
  loudness?: number;
  /** Temperature, 0.01 to 1.0. Sarvam currently forces this to 0.6 server-side. */
  temperature?: number;
  /** Enable text preprocessing. Sarvam currently forces this on server-side. */
  enablePreprocessing?: boolean;
  /** Custom pronunciation dictionary ID. */
  dictId?: string;
}

/** Combined options — discriminated by `model` field */
export type TTSOptions = TTSV2Options | TTSV3Options | TTSV4FlashOptions;

// ---------------------------------------------------------------------------
// Resolved (internal) options — flat union of all fields
// ---------------------------------------------------------------------------

interface ResolvedTTSOptions {
  apiKey: string;
  streaming: boolean;
  model: TTSModels;
  speaker: TTSSpeakers | string;
  targetLanguageCode: string;
  pace: number;
  sampleRate: number;
  outputAudioCodec: TTSOutputAudioCodec;
  baseURL: string;
  sentenceTokenizer: tokenize.SentenceTokenizer;
  outputAudioBitrate: TTSOutputAudioBitrate;
  minBufferSize: number;
  maxChunkLength: number;
  sendCompletionEvent: boolean;
  pitch: number;
  loudness: number;
  enablePreprocessing: boolean;
  temperature: number;
  dictId?: string;
}

const TTS_OPTIONS = new WeakMap<TTS, ResolvedTTSOptions>();

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

const V4_DEFAULTS = {
  speaker: 'shubh_en_narration_gentle' as const,
  pitch: 0,
  pace: 1.0,
  loudness: 1.0,
  temperature: 0.6,
  enablePreprocessing: false,
};

type ParamName = keyof typeof PARAM_BOUNDS;

function paramBounds(model: TTSModels, param: ParamName): readonly [number, number] {
  return model === 'bulbul:v4-flash' ? V4_PARAM_BOUNDS[param] : PARAM_BOUNDS[param];
}

function validateParam(model: TTSModels, param: ParamName, value: number): void {
  const [low, high] = paramBounds(model, param);
  if (value < low || value > high) {
    throw new Error(`${param} must be between ${low} and ${high} for model '${model}'`);
  }
}

function clampPitch(model: TTSModels, pitch: number): number {
  const [low, high] = paramBounds(model, 'pitch');
  if (pitch >= low && pitch <= high) return pitch;
  MODULE_LOGGER.warn(
    { pitch, model, low, high },
    'pitch is outside the Sarvam API accepted range; clamping to the nearest bound',
  );
  return Math.max(low, Math.min(high, pitch));
}

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
  const isV4 = model === 'bulbul:v4-flash';
  const modelOpts = opts as Partial<{
    pitch: number;
    loudness: number;
    enablePreprocessing: boolean;
    temperature: number;
    dictId: string;
  }>;

  const base: ResolvedTTSOptions = {
    apiKey,
    streaming: opts.streaming ?? true,
    model,
    speaker:
      opts.speaker ??
      (isV4 ? V4_DEFAULTS.speaker : isV3 ? V3_DEFAULTS.speaker : V2_DEFAULTS.speaker),
    targetLanguageCode: normalizeLanguage(opts.targetLanguageCode ?? 'en-IN'),
    pace: opts.pace ?? (isV4 ? V4_DEFAULTS.pace : isV3 ? V3_DEFAULTS.pace : V2_DEFAULTS.pace),
    sampleRate: opts.sampleRate ?? SARVAM_TTS_SAMPLE_RATE,
    outputAudioCodec: opts.outputAudioCodec ?? 'linear16',
    baseURL: opts.baseURL ?? SARVAM_BASE_URL,
    sentenceTokenizer:
      opts.sentenceTokenizer ??
      new tokenize.basic.SentenceTokenizer({ minSentenceLength: MIN_SENTENCE_LENGTH }),
    outputAudioBitrate: opts.outputAudioBitrate ?? '128k',
    minBufferSize: opts.minBufferSize ?? 50,
    maxChunkLength: opts.maxChunkLength ?? 150,
    sendCompletionEvent: opts.sendCompletionEvent ?? true,
    pitch: modelOpts.pitch ?? (isV4 ? V4_DEFAULTS.pitch : V2_DEFAULTS.pitch),
    loudness: modelOpts.loudness ?? (isV4 ? V4_DEFAULTS.loudness : V2_DEFAULTS.loudness),
    enablePreprocessing:
      modelOpts.enablePreprocessing ??
      (isV4 ? V4_DEFAULTS.enablePreprocessing : V2_DEFAULTS.enablePreprocessing),
    temperature:
      modelOpts.temperature ?? (isV4 ? V4_DEFAULTS.temperature : V3_DEFAULTS.temperature),
    dictId: modelOpts.dictId,
  };

  if (!MODEL_SPEAKER_COMPATIBILITY[model].includes(base.speaker)) {
    throw new Error(`Speaker '${base.speaker}' is not compatible with model '${model}'`);
  }
  base.pitch = clampPitch(model, base.pitch);
  validateParam(model, 'pace', base.pace);
  validateParam(model, 'loudness', base.loudness);
  validateParam(model, 'temperature', base.temperature);
  if (!ALLOWED_OUTPUT_AUDIO_BITRATES.has(base.outputAudioBitrate)) {
    throw new Error('outputAudioBitrate must be one of 32k, 64k, 96k, 128k, or 192k');
  }
  if (base.minBufferSize < 30 || base.minBufferSize > 200) {
    throw new Error('minBufferSize must be between 30 and 200');
  }
  if (base.maxChunkLength < 50 || base.maxChunkLength > 500) {
    throw new Error('maxChunkLength must be between 50 and 500');
  }

  return base;
}

function codecToMimeType(codec: TTSOutputAudioCodec): string {
  return CODEC_TO_MIME_TYPE[codec];
}

function buildMuLawTable(): Int16Array {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80 ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const sample = ((mantissa << 3) + 0x84) << exponent;
    table[i] = sign * (sample - 0x84);
  }
  return table;
}

function buildALawTable(): Int16Array {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55;
    const sign = a & 0x80 ? 1 : -1;
    const exponent = (a >> 4) & 0x07;
    const mantissa = a & 0x0f;
    const sample =
      exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
    table[i] = sign * sample;
  }
  return table;
}

const MULAW_TABLE = buildMuLawTable();
const ALAW_TABLE = buildALawTable();

function decodeTelephony(codec: TTSOutputAudioCodec, data: Buffer): Buffer {
  const table = codec === 'mulaw' ? MULAW_TABLE : ALAW_TABLE;
  const pcm = Buffer.allocUnsafe(data.byteLength * 2);
  for (let i = 0; i < data.byteLength; i++) {
    pcm.writeInt16LE(table[data[i]!]!, i * 2);
  }
  return pcm;
}

function decodeAudio(codec: TTSOutputAudioCodec, data: Buffer): Buffer {
  const mimeType = codecToMimeType(codec);
  if (TELEPHONY_CODECS.has(codec)) {
    return decodeTelephony(codec, data);
  }
  if (mimeType === 'audio/wav') {
    return data.subarray(44);
  }
  return data;
}

function isClosedTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /close|closing|closed|not open/i.test(message);
}

/** @internal */
export function extractErrorStatusCode(data: Record<string, unknown> | undefined): number {
  const code = data?.code;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof code === 'string' && /^\s*\d{3}\s*$/.test(code)) return Number(code);
  const match = /^\s*(\d{3})\s*:/.exec(String(data?.message ?? ''));
  return match?.[1] ? Number(match[1]) : -1;
}

function validateStreamingOptions(opts: ResolvedTTSOptions): void {
  if (opts.model !== 'bulbul:v4-flash') return;
  if (!V4_STREAM_SAMPLE_RATES.has(opts.sampleRate)) {
    throw new Error(
      `sampleRate must be one of ${[...V4_STREAM_SAMPLE_RATES].join(', ')} when streaming bulbul:v4-flash with codec '${opts.outputAudioCodec}'`,
    );
  }
}

function sendWsJson(ws: WebSocket, payload: unknown, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (ws.readyState !== WebSocket.OPEN) {
    throw new APIConnectionError({ message: 'Sarvam TTS WebSocket is closed' });
  }

  return new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => {
      if (!error || signal.aborted) {
        resolve();
        return;
      }
      reject(error);
    });
  });
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
    output_audio_codec: opts.outputAudioCodec,
    output_audio_bitrate: opts.outputAudioBitrate,
    min_buffer_size: opts.minBufferSize,
    max_chunk_length: opts.maxChunkLength,
  };

  if (opts.model === 'bulbul:v3' || opts.model === 'bulbul:v4-flash') {
    body.temperature = opts.temperature;
    if (opts.dictId != null) body.dict_id = opts.dictId;
  }
  if (opts.model === 'bulbul:v2' || opts.model === 'bulbul:v4-flash') {
    body.pitch = opts.pitch;
    body.loudness = opts.loudness;
    body.enable_preprocessing = opts.enablePreprocessing;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Build WS config message (sent as first message after connection)
// ---------------------------------------------------------------------------

function buildWsConfigMessage(opts: ResolvedTTSOptions): Record<string, unknown> {
  const data: Record<string, unknown> = {
    target_language_code: opts.targetLanguageCode,
    speaker: opts.speaker,
    model: opts.model,
    pace: opts.pace,
    speech_sample_rate: String(opts.sampleRate),
    output_audio_codec: opts.outputAudioCodec,
  };

  if (opts.model === 'bulbul:v3' || opts.model === 'bulbul:v4-flash') {
    data.temperature = opts.temperature;
    if (opts.dictId != null) data.dict_id = opts.dictId;
    data.output_audio_bitrate = opts.outputAudioBitrate;
    data.min_buffer_size = opts.minBufferSize;
    data.max_chunk_length = opts.maxChunkLength;
  }
  if (opts.model === 'bulbul:v2' || opts.model === 'bulbul:v4-flash') {
    data.pitch = opts.pitch;
    data.loudness = opts.loudness;
    data.enable_preprocessing = opts.enablePreprocessing;
  }

  return { type: 'config', data };
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
    super(resolved.sampleRate, SARVAM_TTS_CHANNELS, { streaming: resolved.streaming });
    this.#opts = resolved;
    TTS_OPTIONS.set(this, resolved);
  }

  /**
   * Update TTS options after initialization.
   *
   * @remarks
   * Updates are validated atomically against the resulting model. A rejected
   * update leaves the current options unchanged.
   */
  updateOptions(opts: Partial<TTSOptions>) {
    const resolved = resolveOptions({ ...this.#opts, ...opts } as TTSOptions);
    this.#opts = resolved;
    TTS_OPTIONS.set(this, resolved);
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

  stream(): tts.SynthesizeStream {
    if (!this.capabilities.streaming) {
      throw new Error(
        'Sarvam TTS streaming is disabled (`streaming: false`). Use synthesize() for REST or wrap with tts.StreamAdapter for streaming behavior.',
      );
    }
    return new SynthesizeStream(this, this.#opts);
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

    const raw = Buffer.from(audioBase64, 'base64');
    const pcmData = decodeAudio(this.opts.outputAudioCodec, raw);

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

// ---------------------------------------------------------------------------
// WebSocket streaming synthesis
// ---------------------------------------------------------------------------

export class SynthesizeStream extends tts.SynthesizeStream {
  private opts: ResolvedTTSOptions;
  private readonly sarvam: TTS;
  private tokenizer: tokenize.SentenceStream;
  #logger = log();
  label = 'sarvam.SynthesizeStream';

  constructor(tts: TTS, opts: ResolvedTTSOptions) {
    super(tts);
    this.sarvam = tts;
    this.opts = opts;
    this.tokenizer = opts.sentenceTokenizer.stream();
  }

  private async closeWebSocket(ws: WebSocket): Promise<void> {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'flush' }));

        try {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 1000);

            ws.once('message', () => {
              clearTimeout(timeout);
              resolve();
            });
            ws.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            ws.once('error', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        } catch {
          // Ignore timeout or other errors during close sequence
        }
      }
    } catch (e) {
      this.#logger.warn(`Error during WebSocket close sequence: ${e}`);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  protected async run() {
    this.opts = {
      ...TTS_OPTIONS.get(this.sarvam)!,
      sampleRate: this.opts.sampleRate,
      outputAudioCodec: this.opts.outputAudioCodec,
    };
    validateStreamingOptions(this.opts);
    const requestId = shortuuid();
    const segmentId = shortuuid();

    // Build WS URL: wss://api.sarvam.ai/text-to-speech/ws?model=...&send_completion_event=true
    const wsBaseUrl = this.opts.baseURL.replace(/^http/, 'ws');
    const path =
      this.opts.model === 'bulbul:v4-flash' ? `${SARVAM_WS_URL_PATH}/v2` : SARVAM_WS_URL_PATH;
    const url = new URL(`${wsBaseUrl}${path}`);
    url.searchParams.set('model', this.opts.model);
    url.searchParams.set('send_completion_event', String(this.opts.sendCompletionEvent));

    const ws = new WebSocket(url, {
      headers: {
        'api-subscription-key': this.opts.apiKey,
      },
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Sarvam TTS WS connection error: ${error.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`Sarvam TTS WS closed during connect: ${code}`));
      };
      const cleanup = () => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
      };
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
    });

    // Send config message immediately after connection. This always includes
    // output_audio_codec so Sarvam does not fall back to model-specific defaults.
    await sendWsJson(ws, buildWsConfigMessage(this.opts), this.abortController.signal);

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.tokenizer.flush();
          continue;
        }
        this.tokenizer.pushText(data);
      }
      this.tokenizer.endInput();
      this.tokenizer.close();
    };

    const sendTask = async () => {
      for await (const event of this.tokenizer) {
        if (this.abortController.signal.aborted) break;

        const text = event.token;
        this.markStarted();
        await sendWsJson(ws, { type: 'text', data: { text } }, this.abortController.signal);
      }

      if (!this.abortController.signal.aborted) {
        await sendWsJson(ws, { type: 'flush' }, this.abortController.signal);
      }
    };

    const recvTask = async () => {
      const bstream = new AudioByteStream(this.opts.sampleRate, SARVAM_TTS_CHANNELS);
      let finalReceived = false;
      let lastFrame: AudioFrame | undefined;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      return new Promise<void>((resolve, reject) => {
        ws.on('message', (data: RawData) => {
          let msg: { type: string; data?: Record<string, unknown> };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            this.#logger.warn('Sarvam WS: received non-JSON message');
            return;
          }

          switch (msg.type) {
            case 'audio': {
              const audioB64 = (msg.data?.audio as string) ?? '';
              if (!audioB64) break;

              const raw = Buffer.from(audioB64, 'base64');
              const pcm = decodeAudio(this.opts.outputAudioCodec, raw);

              for (const frame of bstream.write(pcm)) {
                sendLastFrame(false);
                lastFrame = frame;
              }
              break;
            }

            case 'event': {
              const eventType = msg.data?.event_type as string | undefined;
              if (eventType === 'final') {
                finalReceived = true;
                for (const frame of bstream.flush()) {
                  sendLastFrame(false);
                  lastFrame = frame;
                }
                sendLastFrame(true);

                if (!this.queue.closed) {
                  this.queue.put(SynthesizeStream.END_OF_STREAM);
                }
                resolve();
              }
              break;
            }

            case 'error': {
              const statusCode = extractErrorStatusCode(msg.data);
              const requestId =
                typeof msg.data?.request_id === 'string' ? msg.data.request_id : undefined;
              this.#logger.error(
                {
                  error_code: statusCode,
                  'lk.pii.error_message': msg.data?.message,
                  'lk.pii.raw_message': msg,
                },
                'TTS API error',
              );
              reject(
                new APIStatusError({
                  message: `TTS API error from Sarvam (status ${statusCode})`,
                  options: { statusCode, requestId },
                }),
              );
              break;
            }
          }
        });

        ws.on('close', () => {
          if (!finalReceived) {
            for (const frame of bstream.flush()) {
              sendLastFrame(false);
              lastFrame = frame;
            }
            sendLastFrame(true);

            if (!this.queue.closed) {
              this.queue.put(SynthesizeStream.END_OF_STREAM);
            }
          }
          resolve();
        });

        ws.on('error', (error) => {
          if (this.abortController.signal.aborted && isClosedTransportError(error)) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    };

    try {
      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (e) {
      if (this.abortController.signal.aborted) return;
      if (e instanceof APIStatusError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new APIConnectionError({ message: `Sarvam TTS streaming failed: ${msg}` });
    } finally {
      await this.closeWebSocket(ws);
    }
  }
}
