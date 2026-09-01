// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  asLanguageCode,
  log,
  mergeFrames,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const GNANI_STT_BASE_URL = 'https://api.vachana.ai';
const SAMPLE_RATE_16K = 16000;
const SAMPLE_RATE_8K = 8000;
const STREAM_CHUNK_BYTES = 1024;

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
  | 'en-IN,hi-IN'
  | 'en-hi-IN-latn'
  | 'en-hi-in-cm';

/** @public */
export interface STTOptions {
  /** Gnani API key. Defaults to $GNANI_API_KEY. */
  apiKey?: string;
  /** BCP-47 language code. Default: 'en-IN'. */
  language: GnaniSTTLanguages | string;
  /** Audio sample rate for streaming. Must be 8000 or 16000. Default: 16000. */
  sampleRate: number;
  /** Vachana API base URL. */
  baseUrl: string;
  /** Organization ID for REST recognition. Defaults to $GNANI_ORGANIZATION_ID. */
  organizationId?: string;
  /** User ID for REST recognition. Defaults to $GNANI_USER_ID. */
  userId?: string;
}

type ResolvedSTTOptions = Omit<STTOptions, 'apiKey'> & { apiKey: string };

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.GNANI_API_KEY,
  language: 'en-IN',
  sampleRate: SAMPLE_RATE_16K,
  baseUrl: GNANI_STT_BASE_URL,
  organizationId: process.env.GNANI_ORGANIZATION_ID,
  userId: process.env.GNANI_USER_ID,
};

interface GnaniSTTResponse {
  transcript?: string;
  request_id?: string;
}

interface GnaniStreamMessage {
  type?: string;
  text?: string;
  segment_id?: string;
  message?: string;
}

function resolveOptions(opts: Partial<STTOptions>): ResolvedSTTOptions {
  const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
  if (!apiKey) {
    throw new Error(
      'Gnani API key is required. Pass one in via the `apiKey` parameter, or set it as the `GNANI_API_KEY` environment variable',
    );
  }

  const sampleRate = opts.sampleRate ?? defaultSTTOptions.sampleRate;
  if (sampleRate !== SAMPLE_RATE_8K && sampleRate !== SAMPLE_RATE_16K) {
    throw new Error('sampleRate must be 8000 or 16000');
  }

  return {
    ...defaultSTTOptions,
    ...opts,
    apiKey,
    sampleRate,
    language: opts.language ?? defaultSTTOptions.language,
    baseUrl: opts.baseUrl ?? defaultSTTOptions.baseUrl,
    organizationId: opts.organizationId ?? defaultSTTOptions.organizationId,
    userId: opts.userId ?? defaultSTTOptions.userId,
  };
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

function baseUrlWithPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function buildWebSocketUrl(baseUrl: string): string {
  const normalizedBaseUrl = /^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  const url = new URL(baseUrlWithPath(normalizedBaseUrl, '/stt/v3/stream'));
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  return url.toString();
}

/** @public */
export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  label = 'gnani.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    const resolved = resolveOptions(opts);
    super({
      streaming: true,
      interimResults: false,
      alignedTranscript: false,
    });

    this.#opts = resolved;
  }

  get model(): string {
    return 'vachana-stt-v3';
  }

  get provider(): string {
    return 'Gnani';
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = resolveOptions({ ...this.#opts, ...opts });
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const wavBuffer = createWav(frame);
    const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('audio_file', wavBlob, 'audio.wav');
    formData.append('language_code', this.#opts.language);

    const headers: Record<string, string> = {
      'X-API-Key-ID': this.#opts.apiKey,
    };
    if (this.#opts.organizationId) headers['X-Organization-ID'] = this.#opts.organizationId;
    if (this.#opts.userId) headers['X-API-User-ID'] = this.#opts.userId;

    try {
      const response = await fetch(baseUrlWithPath(this.#opts.baseUrl, '/stt/v3'), {
        method: 'POST',
        headers,
        body: formData,
        signal: abortSignal ?? null,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new APIStatusError({
          message: `Gnani STT API error (${response.status}): ${errorBody}`,
          options: { statusCode: response.status, body: { error: errorBody } },
        });
      }

      const data = (await response.json()) as GnaniSTTResponse;
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId: data.request_id,
        alternatives: [
          {
            language: asLanguageCode(this.#opts.language),
            text: data.transcript ?? '',
            startTime: 0,
            endTime: 0,
            confidence: 1,
          },
        ],
      };
    } catch (error) {
      if (error instanceof APIStatusError || error instanceof APIConnectionError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new APITimeoutError({ message: 'Gnani STT API request timed out' });
      }
      throw new APIConnectionError({ message: `Gnani STT error: ${error}` });
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: ResolvedSTTOptions;
  #logger = log();
  label = 'gnani.SpeechStream';

  constructor(sttInstance: STT, opts: Partial<STTOptions>, connOptions?: APIConnectOptions) {
    const resolved = resolveOptions(opts);
    super(sttInstance, resolved.sampleRate, connOptions);
    this.#opts = resolved;
    this.closed = false;
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = resolveOptions({ ...this.#opts, ...opts });
  }

  protected async run(): Promise<void> {
    const wsUrl = buildWebSocketUrl(this.#opts.baseUrl);
    const ws = new WebSocket(wsUrl, {
      headers: {
        'x-api-key-id': this.#opts.apiKey,
        lang_code: this.#opts.language,
      },
      handshakeTimeout: 10_000,
    });

    try {
      await this.#waitForOpen(ws);
      await this.#waitForConnectedMessage(ws);

      const sendTask = this.#sendAudio(ws);
      const recvTask = this.#recvMessages(ws);

      try {
        const first = await Promise.race([
          sendTask.then(() => 'send' as const),
          recvTask.then(() => 'recv' as const),
        ]);

        if (first === 'send') {
          await Promise.race([recvTask, new Promise((resolve) => setTimeout(resolve, 1000))]);
        }
      } finally {
        ws.close();
        await Promise.allSettled([sendTask, recvTask]);
      }
    } catch (error) {
      if (error instanceof APIConnectionError || error instanceof APIStatusError) throw error;
      if (error instanceof APITimeoutError) throw error;
      throw new APIConnectionError({ message: `Gnani STT WebSocket error: ${error}` });
    } finally {
      this.closed = true;
    }
  }

  async #waitForOpen(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
        this.abortSignal.removeEventListener('abort', onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`WebSocket closed with code ${code}`));
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async #waitForConnectedMessage(ws: WebSocket): Promise<void> {
    const msg = await new Promise<RawData | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new APITimeoutError({ message: 'Gnani STT WebSocket connection timed out' }));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
        this.abortSignal.removeEventListener('abort', onAbort);
      };
      const onMessage = (data: RawData) => {
        cleanup();
        resolve(data);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`WebSocket closed with code ${code}`));
      };
      const onAbort = () => {
        cleanup();
        resolve(undefined);
      };

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    });

    if (msg === undefined) return;

    const data = JSON.parse(msg.toString()) as GnaniStreamMessage;
    if (data.type !== 'connected') {
      this.#logger.warn({ data }, 'Unexpected first message from Gnani STT');
    }
  }

  async #sendAudio(ws: WebSocket): Promise<void> {
    let audioBuffer = Buffer.alloc(0);
    const abortPromise = waitForAbort(this.abortSignal);

    while (!this.closed) {
      const result = await Promise.race([this.input.next(), abortPromise]);
      if (result === undefined) return;
      if (result.done) break;

      const data = result.value;
      if (data === SpeechStream.FLUSH_SENTINEL) {
        if (audioBuffer.byteLength > 0) {
          ws.send(audioBuffer);
          audioBuffer = Buffer.alloc(0);
        }
        continue;
      }

      audioBuffer = Buffer.concat([
        audioBuffer,
        Buffer.from(data.data.buffer, data.data.byteOffset, data.data.byteLength),
      ]);

      while (audioBuffer.byteLength >= STREAM_CHUNK_BYTES) {
        ws.send(audioBuffer.subarray(0, STREAM_CHUNK_BYTES));
        audioBuffer = audioBuffer.subarray(STREAM_CHUNK_BYTES);
      }
    }

    if (audioBuffer.byteLength > 0) {
      ws.send(audioBuffer);
    }
  }

  async #recvMessages(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
        this.abortSignal.removeEventListener('abort', onAbort);
      };
      const onMessage = (msg: RawData, isBinary: boolean) => {
        try {
          if (isBinary) return;

          const data = JSON.parse(msg.toString()) as GnaniStreamMessage;
          switch (data.type) {
            case 'transcript': {
              const text = data.text ?? '';
              if (!text) return;
              this.queue.put({
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                requestId: data.segment_id,
                alternatives: [
                  {
                    language: asLanguageCode(this.#opts.language),
                    text,
                    startTime: 0,
                    endTime: 0,
                    confidence: 1,
                  },
                ],
              });
              break;
            }
            case 'speech_start':
            case 'vad_start':
              this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
              break;
            case 'speech_end':
            case 'vad_end':
              this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
              break;
            case 'processing':
              break;
            case 'error': {
              const message = data.message ?? 'Unknown error';
              cleanup();
              reject(
                new APIStatusError({
                  message: `Gnani STT stream error: ${message}`,
                  options: { statusCode: 500, body: { error: message } },
                }),
              );
              break;
            }
          }
        } catch (error) {
          cleanup();
          reject(
            new APIConnectionError({ message: `Error receiving Gnani STT messages: ${error}` }),
          );
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
