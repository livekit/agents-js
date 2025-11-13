// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import type { WebSocket } from 'ws';
import { type RawData } from 'ws';
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
import { type AnyString, connectWs, createAccessToken } from './utils.js';

export type DeepgramModels =
  | 'deepgram'
  | 'deepgram/nova-3'
  | 'deepgram/nova-3-general'
  | 'deepgram/nova-3-medical'
  | 'deepgram/nova-2-conversationalai'
  | 'deepgram/nova-2'
  | 'deepgram/nova-2-general'
  | 'deepgram/nova-2-medical'
  | 'deepgram/nova-2-phonecall';

export type CartesiaModels = 'cartesia' | 'cartesia/ink-whisper';

export type AssemblyaiModels = 'assemblyai' | 'assemblyai/universal-streaming';

export interface CartesiaOptions {
  min_volume?: number; // default: not specified
  max_silence_duration_secs?: number; // default: not specified
}

export interface DeepgramOptions {
  filler_words?: boolean; // default: true
  interim_results?: boolean; // default: true
  endpointing?: number; // default: 25 (ms)
  punctuate?: boolean; // default: false
  smart_format?: boolean;
  keywords?: Array<[string, number]>;
  keyterms?: string[];
  profanity_filter?: boolean;
  numerals?: boolean;
  mip_opt_out?: boolean;
}

export interface AssemblyAIOptions {
  format_turns?: boolean; // default: false
  end_of_turn_confidence_threshold?: number; // default: 0.01
  min_end_of_turn_silence_when_confident?: number; // default: 0
  max_turn_silence?: number; // default: not specified
  keyterms_prompt?: string[]; // default: not specified
}

export type STTLanguages =
  | 'multi'
  | 'en'
  | 'de'
  | 'es'
  | 'fr'
  | 'ja'
  | 'pt'
  | 'zh'
  | 'hi'
  | AnyString;

type _STTModels = DeepgramModels | CartesiaModels | AssemblyaiModels;

export type STTModels = _STTModels | 'auto' | AnyString;

export type ModelWithLanguage = `${_STTModels}:${STTLanguages}` | STTModels;

export type STTOptions<TModel extends STTModels> = TModel extends DeepgramModels
  ? DeepgramOptions
  : TModel extends CartesiaModels
    ? CartesiaOptions
    : TModel extends AssemblyaiModels
      ? AssemblyAIOptions
      : Record<string, unknown>;

export type STTEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: STTEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = 'wss://agent-gateway.livekit.cloud/v1';
const DEFAULT_CANCEL_TIMEOUT = 5000;

export interface InferenceSTTOptions<TModel extends STTModels> {
  model?: TModel;
  language?: STTLanguages;
  encoding: STTEncoding;
  sampleRate: number;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  modelOptions: STTOptions<TModel>;
}

/**
 * Livekit Cloud Inference STT
 */
export class STT<TModel extends STTModels> extends BaseSTT {
  private opts: InferenceSTTOptions<TModel>;
  private streams: Set<SpeechStream<TModel>> = new Set();

  #logger = log();

  constructor(opts?: {
    model?: TModel;
    language?: STTLanguages;
    baseURL?: string;
    encoding?: STTEncoding;
    sampleRate?: number;
    apiKey?: string;
    apiSecret?: string;
    modelOptions?: STTOptions<TModel>;
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
      modelOptions = {} as STTOptions<TModel>,
    } = opts || {};

    const lkBaseURL = baseURL || process.env.LIVEKIT_INFERENCE_URL || DEFAULT_BASE_URL;
    const lkApiKey = apiKey || process.env.LIVEKIT_INFERENCE_API_KEY || process.env.LIVEKIT_API_KEY;
    if (!lkApiKey) {
      throw new Error('apiKey is required: pass apiKey or set LIVEKIT_API_KEY');
    }

    const lkApiSecret =
      apiSecret || process.env.LIVEKIT_INFERENCE_API_SECRET || process.env.LIVEKIT_API_SECRET;
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
      modelOptions,
    };
  }

  get label(): string {
    return 'inference.STT';
  }

  static fromModelString(modelString: string): STT<AnyString> {
    if (modelString.includes(':')) {
      const [model, language] = modelString.split(':') as [AnyString, STTLanguages];
      return new STT({ model, language });
    }
    return new STT({ model: modelString });
  }

  protected async _recognize(_: AudioBuffer): Promise<SpeechEvent> {
    throw new Error('LiveKit STT does not support batch recognition, use stream() instead');
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language'>>): void {
    this.opts = { ...this.opts, ...opts };

    for (const stream of this.streams) {
      stream.updateOptions(opts);
    }
  }

  stream(options?: {
    language?: STTLanguages | string;
    connOptions?: APIConnectOptions;
  }): SpeechStream<TModel> {
    const { language, connOptions = DEFAULT_API_CONNECT_OPTIONS } = options || {};
    const streamOpts = {
      ...this.opts,
      language: language ?? this.opts.language,
    } as InferenceSTTOptions<TModel>;

    const stream = new SpeechStream(this, streamOpts, connOptions);
    this.streams.add(stream);

    return stream;
  }
}

export class SpeechStream<TModel extends STTModels> extends BaseSpeechStream {
  private opts: InferenceSTTOptions<TModel>;
  private requestId = shortuuid('stt_request_');
  private speaking = false;
  private speechDuration = 0;
  private reconnectEvent = new Event();

  #logger = log();

  constructor(
    sttImpl: STT<TModel>,
    opts: InferenceSTTOptions<TModel>,
    connOptions: APIConnectOptions,
  ) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.opts = opts;
  }

  get label(): string {
    return 'inference.SpeechStream';
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language'>>): void {
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
          extra: this.opts.modelOptions,
        },
      } as Record<string, unknown>;

      if (this.opts.model && this.opts.model !== 'auto') {
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
          const messageHandler = (d: RawData) => {
            resolve(d.toString());
            removeListeners();
          };
          const errorHandler = (e: Error) => {
            reject(e);
            removeListeners();
          };
          const closeHandler = (code: number) => {
            if (closingWs) {
              resolve('');
            } else {
              reject(
                new APIStatusError({
                  message: 'LiveKit STT connection closed unexpectedly',
                  options: { statusCode: code },
                }),
              );
            }
            removeListeners();
          };
          const removeListeners = () => {
            socket.removeListener('message', messageHandler);
            socket.removeListener('error', errorHandler);
            socket.removeListener('close', closeHandler);
          };
          socket.once('message', messageHandler);
          socket.once('error', errorHandler);
          socket.once('close', closeHandler);
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
