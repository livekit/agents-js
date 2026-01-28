// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import type { WebSocket } from 'ws';
import { APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { log } from '../log.js';
import { createStreamChannel } from '../stream/stream_channel.js';
import {
  STT as BaseSTT,
  SpeechStream as BaseSpeechStream,
  type SpeechData,
  type SpeechEvent,
  SpeechEventType,
} from '../stt/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { type AudioBuffer, Event, Task, cancelAndWait, shortuuid, waitForAbort } from '../utils.js';
import { type TimedString, createTimedString } from '../voice/io.js';
import {
  type SttServerEvent,
  type SttTranscriptEvent,
  sttServerEventSchema,
} from './api_protos.js';
import { type AnyString, connectWs, createAccessToken } from './utils.js';

export type DeepgramModels =
  | 'deepgram/flux-general'
  | 'deepgram/nova-3'
  | 'deepgram/nova-3-medical'
  | 'deepgram/nova-2'
  | 'deepgram/nova-2-medical'
  | 'deepgram/nova-2-conversationalai'
  | 'deepgram/nova-2-phonecall';

export type CartesiaModels = 'cartesia/ink-whisper';

export type AssemblyaiModels =
  | 'assemblyai/universal-streaming'
  | 'assemblyai/universal-streaming-multilingual';

export type ElevenlabsSTTModels = 'elevenlabs/scribe_v2_realtime';

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

type _STTModels = DeepgramModels | CartesiaModels | AssemblyaiModels | ElevenlabsSTTModels;

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
    super({ streaming: true, interimResults: true, alignedTranscript: 'word' });

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

  async connectWs(timeout: number): Promise<WebSocket> {
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

    const socket = await connectWs(url, headers, timeout);
    const msg = { ...params, type: 'session.create' };
    socket.send(JSON.stringify(msg));

    return socket;
  }
}

export class SpeechStream<TModel extends STTModels> extends BaseSpeechStream {
  private opts: InferenceSTTOptions<TModel>;
  private requestId = shortuuid('stt_request_');
  private speaking = false;
  private speechDuration = 0;
  private reconnectEvent = new Event();
  private stt: STT<TModel>;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(
    sttImpl: STT<TModel>,
    opts: InferenceSTTOptions<TModel>,
    connOptions: APIConnectOptions,
  ) {
    super(sttImpl, opts.sampleRate, connOptions);
    this.opts = opts;
    this.stt = sttImpl;
    this.connOptions = connOptions;
  }

  get label(): string {
    return 'inference.SpeechStream';
  }

  updateOptions(opts: Partial<Pick<InferenceSTTOptions<TModel>, 'model' | 'language'>>): void {
    this.opts = { ...this.opts, ...opts };
    this.reconnectEvent.set();
  }

  protected async run(): Promise<void> {
    while (true) {
      // Create fresh resources for each connection attempt
      let ws: WebSocket | null = null;
      let closing = false;
      let finalReceived = false;

      const eventChannel = createStreamChannel<SttServerEvent>();

      const resourceCleanup = () => {
        if (closing) return;
        closing = true;
        eventChannel.close();
        ws?.removeAllListeners();
        ws?.close();
      };

      const createWsListener = async (ws: WebSocket, signal: AbortSignal) => {
        return new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            resourceCleanup();
            reject(new Error('WebSocket connection aborted'));
          };

          signal.addEventListener('abort', onAbort, { once: true });

          ws.on('message', (data) => {
            const json = JSON.parse(data.toString()) as SttServerEvent;
            eventChannel.write(json);
          });

          ws.on('error', (e) => {
            this.#logger.error({ error: e }, 'WebSocket error');
            resourceCleanup();
            reject(e);
          });

          ws.on('close', (code: number) => {
            resourceCleanup();

            if (!closing) return this.#logger.error('WebSocket closed unexpectedly');
            if (finalReceived) return resolve();

            reject(
              new APIStatusError({
                message: 'LiveKit STT connection closed unexpectedly',
                options: { statusCode: code },
              }),
            );
          });
        });
      };

      const send = async (socket: WebSocket, signal: AbortSignal) => {
        const audioStream = new AudioByteStream(
          this.opts.sampleRate,
          1,
          Math.floor(this.opts.sampleRate / 20), // 50ms
        );

        // Create abort promise once to avoid memory leak
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            return reject(new Error('Send aborted'));
          }
          const onAbort = () => reject(new Error('Send aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        });

        // Manual iteration to support cancellation
        const iterator = this.input[Symbol.asyncIterator]();
        try {
          while (true) {
            const result = await Promise.race([iterator.next(), abortPromise]);

            if (result.done) break;
            const ev = result.value;

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

          closing = true;
          socket.send(JSON.stringify({ type: 'session.finalize' }));
        } catch (e) {
          if ((e as Error).message === 'Send aborted') {
            // Expected abort, don't log
            return;
          }
          throw e;
        }
      };

      const recv = async (signal: AbortSignal) => {
        const serverEventStream = eventChannel.stream();
        const reader = serverEventStream.getReader();

        try {
          while (!this.closed && !signal.aborted) {
            const result = await reader.read();
            if (signal.aborted) return;
            if (result.done) return;

            // Parse and validate with Zod schema
            const parseResult = await sttServerEventSchema.safeParseAsync(result.value);
            if (!parseResult.success) {
              this.#logger.warn(
                { error: parseResult.error, rawData: result.value },
                'Failed to parse STT server event',
              );
              continue;
            }

            const event: SttServerEvent = parseResult.data;

            switch (event.type) {
              case 'session.created':
              case 'session.finalized':
                break;
              case 'session.closed':
                finalReceived = true;
                resourceCleanup();
                break;
              case 'interim_transcript':
                this.processTranscript(event, false);
                break;
              case 'final_transcript':
                this.processTranscript(event, true);
                break;
              case 'error':
                this.#logger.error({ error: event }, 'Received error from LiveKit STT');
                resourceCleanup();
                throw new APIError(`LiveKit STT returned error: ${JSON.stringify(event)}`);
            }
          }
        } finally {
          reader.releaseLock();
          try {
            await serverEventStream.cancel();
          } catch (e) {
            this.#logger.debug('Error cancelling serverEventStream (may already be cancelled):', e);
          }
        }
      };

      try {
        ws = await this.stt.connectWs(this.connOptions.timeoutMs);

        const controller = this.abortController; // Use base class abortController for proper cancellation
        const sendTask = Task.from(({ signal }) => send(ws!, signal), controller);
        const wsListenerTask = Task.from(({ signal }) => createWsListener(ws!, signal), controller);
        const recvTask = Task.from(({ signal }) => recv(signal), controller);
        const waitReconnectTask = Task.from(
          ({ signal }) => Promise.race([this.reconnectEvent.wait(), waitForAbort(signal)]),
          controller,
        );

        try {
          await Promise.race([
            Promise.all([sendTask.result, wsListenerTask.result, recvTask.result]),
            waitReconnectTask.result,
          ]);

          // If reconnect didn't trigger, tasks finished - exit loop
          if (!waitReconnectTask.done) break;

          // Reconnect triggered - clear event and continue loop
          this.reconnectEvent.clear();
        } finally {
          // Cancel all tasks to ensure cleanup
          await cancelAndWait(
            [sendTask, wsListenerTask, recvTask, waitReconnectTask],
            DEFAULT_CANCEL_TIMEOUT,
          );
          resourceCleanup();
        }
      } finally {
        // Ensure cleanup even if connectWs throws
        resourceCleanup();
      }
    }
  }

  private processTranscript(data: SttTranscriptEvent, isFinal: boolean) {
    // Check if queue is closed to avoid race condition during disconnect
    if (this.queue.closed) return;

    const requestId = data.session_id || this.requestId;
    const text = data.transcript;
    const language = data.language || this.opts.language || 'en';

    if (!text && !isFinal) return;

    try {
      // We'll have a more accurate way of detecting when speech started when we have VAD
      if (!this.speaking) {
        this.speaking = true;
        this.queue.put({ type: SpeechEventType.START_OF_SPEECH });
      }

      const speechData: SpeechData = {
        language,
        startTime: this.startTimeOffset + data.start,
        endTime: this.startTimeOffset + data.start + data.duration,
        confidence: data.confidence,
        text,
        words: data.words.map(
          (word): TimedString =>
            createTimedString({
              text: word.word,
              startTime: word.start + this.startTimeOffset,
              endTime: word.end + this.startTimeOffset,
              startTimeOffset: this.startTimeOffset,
              confidence: word.confidence,
            }),
        ),
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
    } catch (e) {
      if (e instanceof Error && e.message.includes('Queue is closed')) {
        // Expected behavior on disconnect, log as warning
        this.#logger.warn(
          { err: e },
          'Queue closed during transcript processing (expected during disconnect)',
        );
      } else {
        this.#logger.error({ err: e }, 'Error putting transcript to queue');
      }
    }
  }
}
