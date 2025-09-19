// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { log } from '../log.js';
import {
  STT as BaseSTT,
  SpeechStream as BaseSpeechStream,
  type SpeechData,
  type SpeechEvent,
  SpeechEventType,
} from '../stt/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { type AudioBuffer, Event, Task, cancelAndWait, shortuuid, waitForAbort } from '../utils.js';
import type { STTLanguages, STTModels } from './models.js';
import { connectWs, createAccessToken } from './utils.js';

type STTEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: STTEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = 'wss://agent-gateway.livekit.cloud/v1';
const DEFAULT_CANCEL_TIMEOUT = 5000;
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

export class STT extends BaseSTT {
  private opts: InferenceSTTOptions;
  private streams: Set<SpeechStream> = new Set();

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

    const {
      model,
      language,
      baseURL,
      encoding = DEFAULT_ENCODING,
      sampleRate = DEFAULT_SAMPLE_RATE,
      apiKey,
      apiSecret,
      extraKwargs = {},
    } = opts || {};

    const lkBaseURL = baseURL || process.env.LIVEKIT_GATEWAY_URL || DEFAULT_BASE_URL;
    const lkApiKey = apiKey || process.env.LIVEKIT_GATEWAY_API_KEY || process.env.LIVEKIT_API_KEY;
    if (!lkApiKey) {
      throw new Error('apiKey is required: pass apiKey or set LIVEKIT_API_KEY');
    }

    const lkApiSecret =
      apiSecret || process.env.LIVEKIT_GATEWAY_API_SECRET || process.env.LIVEKIT_API_SECRET;
    if (!lkApiSecret) {
      throw new Error('apiSecret is required: pass apiSecret or set LIVEKIT_API_SECRET');
    }

    this.opts = {
      model,
      language,
      encoding,
      sampleRate,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      extraKwargs,
    };
  }

  get label(): string {
    return 'inference.STT';
  }

  protected async _recognize(_: AudioBuffer): Promise<SpeechEvent> {
    throw new Error('LiveKit STT does not support batch recognition, use stream() instead');
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions, 'model' | 'language'>>): void {
    this.opts = { ...this.opts, ...opts };

    for (const stream of this.streams) {
      stream.updateOptions(opts);
    }
  }

  stream(options?: {
    language?: STTLanguages | string;
    connOptions?: APIConnectOptions;
  }): SpeechStream {
    const { language, connOptions = DEFAULT_API_CONNECT_OPTIONS } = options || {};
    const streamOpts = {
      ...this.opts,
      language: language ?? this.opts.language,
    } as InferenceSTTOptions;

    const stream = new SpeechStream(this, streamOpts, connOptions);
    this.streams.add(stream);

    return stream;
  }
}

export class SpeechStream extends BaseSpeechStream {
  private opts: InferenceSTTOptions;
  private requestId = shortuuid('stt_request_');
  private speaking = false;
  private speechDuration = 0;
  private reconnectEvent = new Event();

  #logger = log();

  constructor(sttImpl: STT, opts: InferenceSTTOptions, connOptions: APIConnectOptions) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.opts = opts;
  }

  get label(): string {
    return 'inference.SpeechStream';
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions, 'model' | 'language'>>): void {
    this.opts = { ...this.opts, ...opts };
  }

  protected async run(): Promise<void> {
    let ws: WebSocket | null = null;
    let closingWs = false;

    this.reconnectEvent.set();

    const connect = async () => {
      const params = {
        settings: {
          sample_rate: String(this.opts.sampleRate),
          encoding: this.opts.encoding,
          extra: this.opts.extraKwargs,
        },
      } as Record<string, unknown>;

      if (this.opts.model) {
        params.model = this.opts.model;
      }

      if (this.opts.language) {
        (params.settings as Record<string, unknown>).language = this.opts.language;
      }

      let baseURL = this.opts.baseURL;
      if (baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
        baseURL = baseURL.replace('http', 'ws');
      }

      const token = await createAccessToken(this.opts.apiKey, this.opts.apiSecret);
      const url = `${baseURL}/stt`;
      const headers = { Authorization: `Bearer ${token}` } as Record<string, string>;

      const socket = await connectWs(url, headers, 10000);
      const msg = { ...params, type: 'session.create' };
      socket.send(JSON.stringify(msg));

      return socket;
    };

    const send = async (socket: WebSocket, signal: AbortSignal) => {
      const audioStream = new AudioByteStream(
        this.opts.sampleRate,
        1,
        Math.floor(this.opts.sampleRate / 20), // 50ms
      );

      for await (const ev of this.input) {
        if (signal.aborted) break;
        let frames: AudioFrame[];

        if (ev === SpeechStream.FLUSH_SENTINEL) {
          frames = audioStream.flush();
        } else {
          const frame = ev as AudioFrame;
          frames = audioStream.write(new Int16Array(frame.data).buffer);
        }

        for (const frame of frames) {
          this.speechDuration += frame.samplesPerChannel / frame.sampleRate;
          const base64 = Buffer.from(frame.data.buffer).toString('base64');
          const msg = { type: 'input_audio', audio: base64 };
          socket.send(JSON.stringify(msg));
        }
      }

      closingWs = true;
      socket.send(JSON.stringify({ type: 'session.finalize' }));
    };

    const recv = async (socket: WebSocket, signal: AbortSignal) => {
      while (!this.closed && !signal.aborted) {
        const dataPromise = new Promise<string>((resolve, reject) => {
          socket.once('message', (d) => resolve(d.toString()));
          socket.once('error', (e) => reject(e));
          socket.once('close', (code) => {
            if (closingWs) return resolve('');
            reject(
              new APIStatusError({
                message: 'LiveKit STT connection closed unexpectedly',
                options: { statusCode: code },
              }),
            );
          });
        });

        const data = await Promise.race([dataPromise, waitForAbort(signal)]);
        if (!data || signal.aborted) return;

        const json = JSON.parse(data);
        const type = json.type as string | undefined;

        switch (type) {
          case 'session.created':
          case 'session.finalized':
          case 'session.closed':
            break;
          case 'interim_transcript':
            this.processTranscript(json, false);
            break;
          case 'final_transcript':
            this.processTranscript(json, true);
            break;
          case 'error':
            this.#logger.error('received error from LiveKit STT: %o', json);
            throw new APIError(`LiveKit STT returned error: ${JSON.stringify(json)}`);
          default:
            this.#logger.warn('received unexpected message from LiveKit STT: %o', json);
            break;
        }
      }
    };

    while (true) {
      try {
        ws = await connect();

        const sendTask = Task.from(async ({ signal }) => {
          await send(ws!, signal);
        });

        const recvTask = Task.from(async ({ signal }) => {
          await recv(ws!, signal);
        });

        const tasks = [sendTask, recvTask];
        const waitReconnectTask = Task.from(async ({ signal }) => {
          await Promise.race([this.reconnectEvent.wait(), waitForAbort(signal)]);
        });

        try {
          await Promise.race([
            Promise.all(tasks.map((task) => task.result)),
            waitReconnectTask.result,
          ]);

          if (!waitReconnectTask.done) break;
          this.reconnectEvent.clear();
        } finally {
          await cancelAndWait([sendTask, recvTask, waitReconnectTask], DEFAULT_CANCEL_TIMEOUT);
        }
      } finally {
        try {
          if (ws) ws.close();
        } catch {}
      }
    }
  }

  private processTranscript(data: Record<string, any>, isFinal: boolean) {
    const requestId = data.request_id ?? this.requestId;
    const text = data.transcript ?? '';
    const language = data.language ?? this.opts.language ?? 'en';

    if (!text && !isFinal) return;

    // We'll have a more accurate way of detecting when speech started when we have VAD
    if (!this.speaking) {
      this.speaking = true;
      this.queue.put({ type: SpeechEventType.START_OF_SPEECH });
    }

    const speechData: SpeechData = {
      language,
      startTime: data.start ?? 0,
      endTime: data.duration ?? 0,
      confidence: data.confidence ?? 1.0,
      text,
    };

    if (isFinal) {
      if (this.speechDuration > 0) {
        this.queue.put({
          type: SpeechEventType.RECOGNITION_USAGE,
          requestId,
          recognitionUsage: { audioDuration: this.speechDuration },
        });
        this.speechDuration = 0;
      }

      this.queue.put({
        type: SpeechEventType.FINAL_TRANSCRIPT,
        requestId,
        alternatives: [speechData],
      });

      if (this.speaking) {
        this.speaking = false;
        this.queue.put({ type: SpeechEventType.END_OF_SPEECH });
      }
    } else {
      this.queue.put({
        type: SpeechEventType.INTERIM_TRANSCRIPT,
        requestId,
        alternatives: [speechData],
      });
    }
  }
}
