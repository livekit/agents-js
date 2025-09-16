// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { AudioByteStream } from '../audio.js';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  stt,
} from '../index.js';
import { log } from '../log.js';
import { shortuuid } from '../utils.js';
import type { STTLanguages, STTModels } from './models.js';
import { createAccessToken } from './utils.js';

type STTEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: STTEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = 'wss://agent-gateway.livekit.cloud/v1';

export interface InferenceSTTOptions {
  model?: STTModels | string;
  language?: STTLanguages | string;
  encoding: STTEncoding;
  sampleRate: number;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  extraKwargs: Record<string, unknown>;
}

export class STT extends stt.STT {
  #opts: InferenceSTTOptions;
  #logger = log();

  constructor(opts?: {
    model?: STTModels | string;
    language?: STTLanguages | string;
    baseURL?: string;
    encoding?: STTEncoding;
    sampleRate?: number;
    apiKey?: string;
    apiSecret?: string;
    extraKwargs?: Record<string, unknown>;
  }) {
    super({ streaming: true, interimResults: true });

    const lkBaseURL = opts?.baseURL || process.env.LIVEKIT_GATEWAY_URL || DEFAULT_BASE_URL;
    const lkApiKey =
      opts?.apiKey || process.env.LIVEKIT_GATEWAY_API_KEY || process.env.LIVEKIT_API_KEY;
    if (!lkApiKey) {
      throw new Error('apiKey is required: pass apiKey or set LIVEKIT_API_KEY');
    }

    const lkApiSecret =
      opts?.apiSecret || process.env.LIVEKIT_GATEWAY_API_SECRET || process.env.LIVEKIT_API_SECRET;
    if (!lkApiSecret) {
      throw new Error('apiSecret is required: pass apiSecret or set LIVEKIT_API_SECRET');
    }

    this.#opts = {
      model: opts?.model,
      language: opts?.language,
      encoding: opts?.encoding ?? DEFAULT_ENCODING,
      sampleRate: opts?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      extraKwargs: opts?.extraKwargs ?? {},
    };
  }

  get label(): string {
    return 'inference.STT';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async _recognize(_: AudioFrame | AudioFrame[]): Promise<stt.SpeechEvent> {
    throw new Error('LiveKit STT does not support batch recognition, use stream() instead');
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions, 'model' | 'language'>>): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(options?: {
    language?: STTLanguages | string;
    connOptions?: APIConnectOptions;
  }): SpeechStream {
    const { language, connOptions = DEFAULT_API_CONNECT_OPTIONS } = options || {};
    const streamOpts: InferenceSTTOptions = { ...this.#opts };
    if (language) streamOpts.language = language;
    return new SpeechStream(this, streamOpts, connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: InferenceSTTOptions;
  #logger = log();
  #requestId = shortuuid('stt_request_');
  #speaking = false;
  #speechDuration = 0;

  constructor(sttImpl: STT, opts: InferenceSTTOptions, connOptions: APIConnectOptions) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.#opts = opts;
  }

  get label(): string {
    return 'inference.SpeechStream';
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions, 'model' | 'language'>>): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  protected async run(): Promise<void> {
    let ws: WebSocket | null = null;
    let closing = false;

    const connect = async () => {
      const params: Record<string, unknown> = {
        settings: {
          sample_rate: String(this.#opts.sampleRate),
          encoding: this.#opts.encoding,
          extra: this.#opts.extraKwargs,
        },
      };

      if (this.#opts.model) params['model'] = this.#opts.model;
      if (this.#opts.language) (params.settings as any).language = this.#opts.language;

      let baseURL = this.#opts.baseURL;
      if (baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
        baseURL = baseURL.replace('http', 'ws');
      }

      const token = await createAccessToken(this.#opts.apiKey, this.#opts.apiSecret);
      const url = `${baseURL}/stt`;
      const headers = { Authorization: `Bearer ${token}` } as Record<string, string>;

      return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        const onOpen = () => resolve(socket);
        const onError = (err: unknown) => {
          if (err && typeof err === 'object' && 'code' in err && (err as any).code === 429) {
            reject(
              new APIStatusError({
                message: 'LiveKit STT quota exceeded',
                options: { retryable: false, statusCode: 429 },
              }),
            );
          } else {
            reject(
              new APIConnectionError({
                message: 'failed to connect to LiveKit STT',
                options: { retryable: true },
              }),
            );
          }
        };
        const onClose = (code: number) => {
          if (code !== 1000) {
            reject(
              new APIConnectionError({
                message: 'failed to connect to LiveKit STT',
                options: { retryable: true },
              }),
            );
          }
        };
        socket.once('open', onOpen);
        socket.once('error', onError);
        socket.once('close', onClose);
      }).then(async (socket) => {
        const msg = { ...params, type: 'session.create' };
        socket.send(JSON.stringify(msg));
        return socket;
      });
    };

    const sendTask = async (socket: WebSocket) => {
      const audioStream = new AudioByteStream(
        this.#opts.sampleRate,
        1,
        Math.floor(this.#opts.sampleRate / 20),
      );
      for await (const ev of this.input) {
        let frames: AudioFrame[] = [];
        if (ev === SpeechStream.FLUSH_SENTINEL) {
          frames = audioStream.flush();
        } else {
          const frame = ev as AudioFrame;
          frames = audioStream.write(new Int16Array(frame.data).buffer);
        }
        for (const frame of frames) {
          this.#speechDuration += frame.samplesPerChannel / frame.sampleRate;
          const base64 = Buffer.from(frame.data.buffer).toString('base64');
          const msg = { type: 'input_audio', audio: base64 };
          socket.send(JSON.stringify(msg));
        }
      }
      closing = true;
      socket.send(JSON.stringify({ type: 'session.finalize' }));
    };

    const recvTask = async (socket: WebSocket) => {
      while (!this.closed) {
        const data = await new Promise<string>((resolve, reject) => {
          socket.once('message', (d) => resolve(d.toString()));
          socket.once('error', (e) => reject(e));
          socket.once('close', (code) => {
            if (closing) return resolve('');
            reject(
              new APIStatusError({
                message: 'LiveKit STT connection closed unexpectedly',
                options: { retryable: true, statusCode: code },
              }),
            );
          });
        });
        if (!data) return;
        const json = JSON.parse(data);
        const type = json.type as string | undefined;
        switch (type) {
          case 'session.created':
          case 'session.finalized':
          case 'session.closed':
            break;
          case 'interim_transcript':
            this.#processTranscript(json, false);
            break;
          case 'final_transcript':
            this.#processTranscript(json, true);
            break;
          case 'error':
            throw new APIStatusError({
              message: `LiveKit STT returned error: ${JSON.stringify(json)}`,
              options: { retryable: false },
            });
          default:
            this.#logger.warn('received unexpected message from LiveKit STT: %o', json);
            break;
        }
      }
    };

    try {
      ws = await connect();
      await Promise.race([sendTask(ws), recvTask(ws)]);
    } finally {
      try {
        if (ws) ws.close();
      } catch {}
    }
  }

  #processTranscript(data: Record<string, any>, isFinal: boolean) {
    const requestId = data.request_id ?? this.#requestId;
    const text = data.transcript ?? '';
    const language = data.language ?? this.#opts.language ?? 'en';

    if (!text && !isFinal) return;

    if (!this.#speaking) {
      this.#speaking = true;
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    }

    const speechData: stt.SpeechData = {
      language,
      startTime: data.start ?? 0,
      endTime: data.duration ?? 0,
      confidence: data.confidence ?? 1.0,
      text,
    };

    if (isFinal) {
      if (this.#speechDuration > 0) {
        this.queue.put({
          type: stt.SpeechEventType.RECOGNITION_USAGE,
          requestId,
          recognitionUsage: { audioDuration: this.#speechDuration },
        });
        this.#speechDuration = 0;
      }

      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId,
        alternatives: [speechData],
      });

      if (this.#speaking) {
        this.#speaking = false;
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    } else {
      this.queue.put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        requestId,
        alternatives: [speechData],
      });
    }
  }
}
