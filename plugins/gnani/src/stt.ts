// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  mergeFrames,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

export const GNANI_STT_BASE_URL = 'https://api.vachana.ai';

/** @public */
export type GnaniSTTFormat = 'verbatim' | 'transcribe';
/** @public */
export type GnaniSTTLanguages =
  | 'bn-IN'
  | 'en-IN'
  | 'gu-IN'
  | 'hi-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'pa-IN'
  | 'ta-IN'
  | 'te-IN'
  | 'en-IN,hi-IN';

export const SUPPORTED_LANGUAGES = new Set<string>([
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
  'en-IN,hi-IN',
]);

export const STREAM_SUPPORTED_LANGUAGES = new Set<string>([
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
]);

export const SAMPLE_RATE_16K = 16000;
export const SAMPLE_RATE_8K = 8000;
export const STREAM_CHUNK_BYTES = 1024;
const NUM_CHANNELS = 1;

const DEPRECATED_STT_OPTIONS = new Set(['organizationId', 'organization_id', 'userId', 'user_id']);

/** @public */
export interface STTOptions {
  /** BCP-47 language code (for example, `hi-IN` or `en-IN`). Default: `en-IN`. */
  language?: GnaniSTTLanguages | string;
  /** Gnani API key. Defaults to `$GNANI_API_KEY`. */
  apiKey?: string;
  /** Streaming audio sample rate. Must be 8000 or 16000. Default: 16000. */
  sampleRate?: typeof SAMPLE_RATE_8K | typeof SAMPLE_RATE_16K | number;
  /** Vachana API base URL. */
  baseURL?: string;
  /** Force single-language model for this code. */
  preferredLanguage?: string;
  /** `verbatim` (default) or `transcribe` to enable ITN. */
  format?: GnaniSTTFormat;
  /** Render digits in native script when `format` is `transcribe`. */
  itnNativeNumerals?: boolean;
}

interface ResolvedSTTOptions {
  apiKey: string;
  language: string;
  sampleRate: number;
  baseURL: string;
  preferredLanguage?: string;
  format: GnaniSTTFormat;
  itnNativeNumerals: boolean;
}

function warnDeprecatedOptions(opts: Record<string, unknown>, caller: string) {
  for (const name of DEPRECATED_STT_OPTIONS) {
    if (name in opts) {
      log().warn(`\`${name}\` is deprecated and no longer used by ${caller}`);
    }
  }
}

function resolveOptions(opts: STTOptions & Record<string, unknown>): ResolvedSTTOptions {
  warnDeprecatedOptions(opts, 'STT');

  const apiKey = opts.apiKey ?? process.env.GNANI_API_KEY;
  if (!apiKey) {
    throw new Error('Gnani API key is required. Provide it directly or set GNANI_API_KEY.');
  }

  const sampleRate = opts.sampleRate ?? SAMPLE_RATE_16K;
  if (sampleRate !== SAMPLE_RATE_8K && sampleRate !== SAMPLE_RATE_16K) {
    throw new Error('sampleRate must be 8000 or 16000');
  }

  return {
    apiKey,
    language: opts.language ?? 'en-IN',
    sampleRate,
    baseURL: opts.baseURL ?? GNANI_STT_BASE_URL,
    preferredLanguage: opts.preferredLanguage,
    format: opts.format ?? 'verbatim',
    itnNativeNumerals: opts.itnNativeNumerals ?? false,
  };
}

function websocketURL(baseURL: string, path: string): string {
  if (baseURL.startsWith('https://')) return `wss://${baseURL.slice('https://'.length)}${path}`;
  if (baseURL.startsWith('http://')) return `ws://${baseURL.slice('http://'.length)}${path}`;
  return `wss://${baseURL}${path}`;
}

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

function buildFormData(wavBlob: Blob, opts: ResolvedSTTOptions, language?: string): FormData {
  const formData = new FormData();
  formData.append('audio_file', wavBlob, 'audio.wav');
  formData.append('language_code', language ?? opts.language);
  formData.append('format', opts.format);
  if (opts.preferredLanguage != null) {
    formData.append('preferred_language', opts.preferredLanguage);
  }
  if (opts.itnNativeNumerals) {
    formData.append('itn_native_numerals', 'true');
  }
  return formData;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function mapWebSocketError(error: Error): APIConnectionError {
  if (/timed? out|timeout/i.test(error.message)) {
    return new APITimeoutError({
      message: `Gnani STT WebSocket connection timed out: ${error.message}`,
    });
  }
  return new APIConnectionError({ message: `Gnani STT WebSocket error: ${error.message}` });
}

async function waitForDrain(receiveTask: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      receiveTask,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** @public */
export class STT extends stt.STT {
  _opts: ResolvedSTTOptions;
  label = 'gnani.STT';

  /** Create a new Gnani Vachana Speech-to-Text instance. */
  constructor(opts: STTOptions & Record<string, unknown> = {}) {
    const resolved = resolveOptions(opts);
    super({ streaming: true, interimResults: false, alignedTranscript: false });
    this._opts = resolved;
  }

  get model(): string {
    return 'vachana-stt-v3';
  }

  get provider(): string {
    return 'Gnani';
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const wavBuffer = createWav(frame);
    const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });

    const response = await fetch(`${this._opts.baseURL}/stt/v3`, {
      method: 'POST',
      headers: { 'X-API-Key-ID': this._opts.apiKey },
      body: buildFormData(wavBlob, this._opts),
      signal: withTimeout(abortSignal, DEFAULT_API_CONNECT_OPTIONS.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new APITimeoutError({ message: 'Gnani STT API request timed out' });
      }
      throw new APIConnectionError({ message: `Gnani STT error: ${String(error)}` });
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new APIStatusError({
        message: `Gnani STT API Error (${response.status}): ${errorText}`,
        options: { statusCode: response.status, body: { error: errorText } },
      });
    }

    const data = (await response.json()) as { transcript?: string; request_id?: string };
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: data.request_id ?? '',
      alternatives: [
        {
          language: normalizeLanguage(this._opts.language),
          text: data.transcript ?? '',
          confidence: 1,
          startTime: 0,
          endTime: 0,
        },
      ],
    };
  }

  stream(options?: { language?: string; connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(
      this,
      { ...this._opts, language: options?.language ?? this._opts.language },
      options?.connOptions,
    );
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  _opts: ResolvedSTTOptions;
  label = 'gnani.SpeechStream';
  private readonly timeoutMs: number;

  constructor(sttInstance: STT, opts: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this._opts = opts;
    this.timeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
  }

  buildWsUrl(): string {
    return websocketURL(this._opts.baseURL, '/stt/v3/stream');
  }

  protected async run() {
    const ws = new WebSocket(this.buildWsUrl(), {
      headers: this.buildHeaders(),
      handshakeTimeout: this.timeoutMs,
    });
    const onHandshakeAbort = () => ws.close();
    let established = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(mapWebSocketError(error));
        };
        const onClose = (code: number) => {
          cleanup();
          if (this.abortSignal.aborted) resolve();
          else reject(new APIConnectionError({ message: `Gnani STT WebSocket closed: ${code}` }));
        };
        const cleanup = () => {
          ws.removeListener('open', onOpen);
          ws.removeListener('error', onError);
          ws.removeListener('close', onClose);
          this.abortSignal.removeEventListener('abort', onHandshakeAbort);
        };
        ws.on('open', onOpen);
        ws.on('error', onError);
        ws.on('close', onClose);
        this.abortSignal.addEventListener('abort', onHandshakeAbort, { once: true });
        if (this.abortSignal.aborted) onHandshakeAbort();
      });
      if (this.abortSignal.aborted) return;
      established = true;

      const receiveState = { allowClose: false };
      const sendTask = this.sendAudio(ws).then(() => {
        receiveState.allowClose = true;
      });
      const receiveTask = this.receiveMessages(ws, receiveState);
      const completed = await Promise.race([
        sendTask.then(() => 'send'),
        receiveTask.then(() => 'receive'),
      ]);
      if (completed === 'send') {
        await waitForDrain(receiveTask, 1000);
      }
    } finally {
      if (this.abortSignal.aborted && established) ws.terminate();
      else ws.close();
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key-id': this._opts.apiKey,
      lang_code: this._opts.language,
      'x-sample-rate': String(this._opts.sampleRate),
    };
    if (this._opts.format !== 'verbatim') {
      headers['x-format'] = this._opts.format;
    }
    if (this._opts.preferredLanguage != null) {
      headers.preferred_language = this._opts.preferredLanguage;
    }
    if (this._opts.itnNativeNumerals) {
      headers.itn_native_numerals = 'true';
    }
    return headers;
  }

  private async sendAudio(ws: WebSocket) {
    const stream = new AudioByteStream(this._opts.sampleRate, NUM_CHANNELS, STREAM_CHUNK_BYTES / 2);
    try {
      for await (const data of this.input) {
        const frames =
          data === SpeechStream.FLUSH_SENTINEL
            ? stream.flush()
            : stream.write(
                data.data.buffer.slice(
                  data.data.byteOffset,
                  data.data.byteOffset + data.data.byteLength,
                ) as ArrayBuffer,
              );

        for (const frame of frames) {
          const chunk = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          );
          ws.send(chunk);
        }
      }
      for (const frame of stream.flush()) {
        ws.send(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      }
    } catch (error) {
      if (!this.abortSignal.aborted) throw error;
    }
  }

  private async receiveMessages(ws: WebSocket, state: { allowClose: boolean }) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const receiveTimeout = setTimeout(() => {
        settle(new APITimeoutError({ message: 'Gnani STT WebSocket receive timed out' }));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(receiveTimeout);
        ws.removeListener('message', onMessage);
        ws.removeListener('close', onClose);
        ws.removeListener('error', onError);
        this.abortSignal.removeEventListener('abort', onAbort);
      };
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (msg: RawData, isBinary: boolean) => {
        if (isBinary) return;
        clearTimeout(receiveTimeout);

        try {
          const data = JSON.parse(msg.toString()) as Record<string, unknown>;
          const msgType = data.type;

          if (msgType === 'connected' || msgType === 'processing') return;

          if (msgType === 'transcript') {
            const text = typeof data.text === 'string' ? data.text : '';
            if (!text) return;
            this.queue.put({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              requestId: typeof data.segment_id === 'string' ? data.segment_id : '',
              alternatives: [
                {
                  language: normalizeLanguage(this._opts.language),
                  text,
                  confidence: 1,
                  startTime: 0,
                  endTime: 0,
                },
              ],
            });
          } else if (msgType === 'speech_start' || msgType === 'vad_start') {
            this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          } else if (msgType === 'speech_end' || msgType === 'vad_end') {
            this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
          } else if (msgType === 'error') {
            const message = typeof data.message === 'string' ? data.message : 'Unknown error';
            settle(
              new APIStatusError({
                message: `Gnani STT stream error: ${message}`,
                options: { statusCode: 500, body: { error: message } },
              }),
            );
          }
        } catch (error) {
          settle(
            new APIConnectionError({ message: `Error receiving Gnani STT messages: ${error}` }),
          );
        }
      };
      const onClose = (code: number) => {
        if (this.abortSignal.aborted || state.allowClose) settle();
        else
          settle(
            new APIConnectionError({
              message: `Gnani STT WebSocket closed before input completed: ${code}`,
            }),
          );
      };
      const onError = (error: Error) => settle(mapWebSocketError(error));
      const onAbort = () => {
        settle();
        ws.terminate();
      };
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (this.abortSignal.aborted) onAbort();
    });
  }
}
