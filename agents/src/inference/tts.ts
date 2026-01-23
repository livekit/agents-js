// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { ConnectionPool } from '../connection_pool.js';
import { log } from '../log.js';
import { createStreamChannel } from '../stream/stream_channel.js';
import { basic as tokenizeBasic } from '../tokenize/index.js';
import type { ChunkedStream } from '../tts/index.js';
import { SynthesizeStream as BaseSynthesizeStream, TTS as BaseTTS } from '../tts/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Event, Future, Task, cancelAndWait, combineSignals, shortuuid } from '../utils.js';
import {
  type TtsClientEvent,
  type TtsServerEvent,
  type TtsSessionCreateEvent,
  ttsClientEventSchema,
  ttsServerEventSchema,
} from './api_protos.js';
import { type AnyString, connectWs, createAccessToken } from './utils.js';

export type CartesiaModels =
  | 'cartesia/sonic-3'
  | 'cartesia/sonic-2'
  | 'cartesia/sonic-turbo'
  | 'cartesia/sonic';

export type DeepgramTTSModels = 'deepgram/aura' | 'deepgram/aura-2';

export type ElevenlabsModels =
  | 'elevenlabs/eleven_flash_v2'
  | 'elevenlabs/eleven_flash_v2_5'
  | 'elevenlabs/eleven_turbo_v2'
  | 'elevenlabs/eleven_turbo_v2_5'
  | 'elevenlabs/eleven_multilingual_v2';

export type InworldModels =
  | 'inworld/inworld-tts-1.5-max'
  | 'inworld/inworld-tts-1.5-mini'
  | 'inworld/inworld-tts-1-max'
  | 'inworld/inworld-tts-1';

export type RimeModels = 'rime/arcana' | 'rime/mistv2';

export interface CartesiaOptions {
  duration?: number; // max duration of audio in seconds
  speed?: 'slow' | 'normal' | 'fast'; // default: not specified
}

export interface ElevenlabsOptions {
  inactivity_timeout?: number; // default: 60
  apply_text_normalization?: 'auto' | 'off' | 'on'; // default: "auto"
}

export interface DeepgramTTSOptions {}

export interface RimeOptions {}

export interface InworldOptions {}

type _TTSModels =
  | CartesiaModels
  | DeepgramTTSModels
  | ElevenlabsModels
  | RimeModels
  | InworldModels;

export type TTSModels =
  | CartesiaModels
  | DeepgramTTSModels
  | ElevenlabsModels
  | RimeModels
  | InworldModels
  | AnyString;

export type ModelWithVoice = `${_TTSModels}:${string}` | TTSModels;

export type TTSOptions<TModel extends TTSModels> = TModel extends CartesiaModels
  ? CartesiaOptions
  : TModel extends DeepgramTTSModels
    ? DeepgramTTSOptions
    : TModel extends ElevenlabsModels
      ? ElevenlabsOptions
      : TModel extends RimeModels
        ? RimeOptions
        : TModel extends InworldModels
          ? InworldOptions
          : Record<string, unknown>;

type TTSEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: TTSEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = 'https://agent-gateway.livekit.cloud/v1';
const NUM_CHANNELS = 1;
const DEFAULT_LANGUAGE = 'en';

export interface InferenceTTSOptions<TModel extends TTSModels> {
  model?: TModel;
  voice?: string;
  language?: string;
  encoding: TTSEncoding;
  sampleRate: number;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  modelOptions: TTSOptions<TModel>;
}

/**
 * Livekit Cloud Inference TTS
 */
export class TTS<TModel extends TTSModels> extends BaseTTS {
  private opts: InferenceTTSOptions<TModel>;
  private streams: Set<SynthesizeStream<TModel>> = new Set();
  pool: ConnectionPool<WebSocket>;

  #logger = log();

  constructor(opts: {
    model: TModel;
    voice?: string;
    language?: string;
    baseURL?: string;
    encoding?: TTSEncoding;
    sampleRate?: number;
    apiKey?: string;
    apiSecret?: string;
    modelOptions?: TTSOptions<TModel>;
  }) {
    const sampleRate = opts?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    super(sampleRate, 1, { streaming: true });

    const {
      model,
      voice,
      language = DEFAULT_LANGUAGE,
      baseURL,
      encoding = DEFAULT_ENCODING,
      apiKey,
      apiSecret,
      modelOptions = {} as TTSOptions<TModel>,
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

    // read voice id from the model if provided: "provider/model:voice_id"
    let nextModel = model;
    let nextVoice = voice;
    if (typeof nextModel === 'string') {
      const idx = nextModel.lastIndexOf(':');
      if (idx !== -1) {
        const voiceFromModel = nextModel.slice(idx + 1);
        if (nextVoice && nextVoice !== voiceFromModel) {
          this.#logger.warn(
            '`voice` is provided via both argument and model, using the one from the argument',
            { voice: nextVoice, model: nextModel },
          );
        } else {
          nextVoice = voiceFromModel;
        }
        nextModel = nextModel.slice(0, idx) as TModel;
      }
    }

    this.opts = {
      model: nextModel,
      voice: nextVoice,
      language,
      encoding,
      sampleRate,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      modelOptions,
    };

    // Initialize connection pool
    this.pool = new ConnectionPool<WebSocket>({
      connectCb: (timeout) => this.connectWs(timeout),
      closeCb: (ws) => this.closeWs(ws),
      maxSessionDuration: 300_000,
      markRefreshedOnGet: true,
      connectTimeout: 10_000, // 10 seconds default
    });
  }

  get label() {
    return 'inference.TTS';
  }

  static fromModelString(modelString: string): TTS<AnyString> {
    if (modelString.includes(':')) {
      const [model, voice] = modelString.split(':') as [TTSModels, string];
      return new TTS({ model, voice });
    }
    return new TTS({ model: modelString });
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions<TModel>, 'model' | 'voice' | 'language'>>) {
    this.opts = { ...this.opts, ...opts };
    for (const stream of this.streams) {
      stream.updateOptions(opts);
    }
  }

  synthesize(_: string): ChunkedStream {
    throw new Error('ChunkedStream is not implemented');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream<TModel> {
    const { connOptions = DEFAULT_API_CONNECT_OPTIONS } = options || {};
    const stream = new SynthesizeStream(this, { ...this.opts }, connOptions);
    this.streams.add(stream);
    return stream;
  }

  async connectWs(timeout: number): Promise<WebSocket> {
    let baseURL = this.opts.baseURL;
    if (baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
      baseURL = baseURL.replace('http', 'ws');
    }

    const token = await createAccessToken(this.opts.apiKey, this.opts.apiSecret);
    const url = `${baseURL}/tts`;
    const headers = { Authorization: `Bearer ${token}` } as Record<string, string>;

    const params = {
      type: 'session.create',
      sample_rate: String(this.opts.sampleRate),
      encoding: this.opts.encoding,
      extra: this.opts.modelOptions,
    } as TtsSessionCreateEvent;

    if (this.opts.voice) params.voice = this.opts.voice;
    if (this.opts.model) params.model = this.opts.model;
    if (this.opts.language) params.language = this.opts.language;

    this.#logger.debug({ url }, 'inference.TTS creating new websocket connection (pool miss)');
    const socket = await connectWs(url, headers, timeout);
    socket.send(JSON.stringify(params));
    return socket;
  }

  async closeWs(ws: WebSocket) {
    await ws.close();
  }

  prewarm(): void {
    this.pool.prewarm();
  }

  async close() {
    for (const stream of this.streams) {
      await stream.close();
    }
    this.streams.clear();
    await this.pool.close();
  }
}

export class SynthesizeStream<TModel extends TTSModels> extends BaseSynthesizeStream {
  private opts: InferenceTTSOptions<TModel>;
  private tts: TTS<TModel>;

  #logger = log();

  constructor(tts: TTS<TModel>, opts: InferenceTTSOptions<TModel>, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.opts = opts;
    this.tts = tts;
  }

  get label() {
    return 'inference.SynthesizeStream';
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions<TModel>, 'model' | 'voice' | 'language'>>) {
    this.opts = { ...this.opts, ...opts };
  }

  protected async run(): Promise<void> {
    let closing = false;
    let lastFrame: AudioFrame | undefined;

    const sendTokenizerStream = new tokenizeBasic.SentenceTokenizer().stream();
    const eventChannel = createStreamChannel<TtsServerEvent>();
    const requestId = shortuuid('tts_request_');
    const inputSentEvent = new Event();

    // Signal for protocol-driven completion (when 'done' message is received)
    const completionFuture = new Future<void>();

    const resourceCleanup = async () => {
      if (closing) return;
      closing = true;
      sendTokenizerStream.close();
      // close() returns a promise; don't leak it
      await eventChannel.close();
    };

    const sendClientEvent = async (event: TtsClientEvent, ws: WebSocket, signal: AbortSignal) => {
      // Don't send events to a closed WebSocket or aborted controller
      if (signal.aborted || closing) return;

      const validatedEvent = await ttsClientEventSchema.parseAsync(event);
      if (ws.readyState !== WebSocket.OPEN) {
        this.#logger.warn('Trying to send client TTS event to a closed WebSocket');
        return;
      }
      ws.send(JSON.stringify(validatedEvent));
    };

    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const createInputTask = async (signal: AbortSignal) => {
      for await (const data of this.input) {
        if (signal.aborted || closing) break;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          sendTokenizerStream.flush();
          continue;
        }
        sendTokenizerStream.pushText(data);
      }
      // Only call endInput if the stream hasn't been closed by cleanup
      if (!closing) {
        sendTokenizerStream.endInput();
      }
    };

    const createSentenceStreamTask = async (ws: WebSocket, signal: AbortSignal) => {
      for await (const ev of sendTokenizerStream) {
        if (signal.aborted || closing) break;

        await sendClientEvent(
          {
            type: 'input_transcript',
            transcript: ev.token + ' ',
          },
          ws,
          signal,
        );
        inputSentEvent.set();
      }

      await sendClientEvent({ type: 'session.flush' }, ws, signal);
      // needed in case empty input is sent
      inputSentEvent.set();
    };

    // Handles WebSocket message routing and error handling
    // Completes based on protocol messages, NOT on ws.close()
    const createWsListenerTask = async (ws: WebSocket, signal: AbortSignal) => {
      const onMessage = (data: Buffer) => {
        try {
          const eventJson = JSON.parse(data.toString()) as Record<string, unknown>;
          const validatedEvent = ttsServerEventSchema.parse(eventJson);
          // writer.write returns a promise; avoid unhandled rejections if stream is closed
          void eventChannel.write(validatedEvent).catch((error) => {
            this.#logger.debug(
              { error },
              'Failed writing TTS event to stream channel (likely closed)',
            );
          });
        } catch (e) {
          this.#logger.error({ error: e }, 'Error parsing WebSocket message');
        }
      };

      const onError = (e: Error) => {
        this.#logger.error({ error: e }, 'WebSocket error');
        void resourceCleanup();
        try {
          // If the ws is misbehaving, hard-stop it immediately to avoid buffering.
          ws.terminate?.();
        } catch {
          // ignore
        }
        // Ensure this ws is not reused
        this.tts.pool.remove(ws);
        completionFuture.reject(e);
      };

      const onClose = () => {
        // WebSocket closed unexpectedly (not by us)
        if (!closing) {
          this.#logger.error('WebSocket closed unexpectedly');
          void resourceCleanup();
          // Ensure this ws is not reused
          this.tts.pool.remove(ws);
          completionFuture.reject(
            new APIStatusError({
              message: 'Gateway connection closed unexpectedly',
              options: { requestId },
            }),
          );
        }
      };

      const onAbort = () => {
        void resourceCleanup();
        try {
          // On interruption/abort, close the websocket immediately so the server stops streaming
          // and the ws library doesn't buffer unread frames in memory.
          ws.terminate?.();
        } catch {
          // ignore
        }
        this.tts.pool.remove(ws);
        inputSentEvent.set();
        completionFuture.resolve();
      };

      // Attach listeners
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
      signal.addEventListener('abort', onAbort);

      try {
        // Wait for protocol-driven completion or error
        await completionFuture.await;
      } finally {
        // IMPORTANT: Remove listeners so connection can be reused
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
        signal.removeEventListener('abort', onAbort);
      }
    };

    const createRecvTask = async (signal: AbortSignal) => {
      let currentSessionId: string | null = null;

      const bstream = new AudioByteStream(this.opts.sampleRate, NUM_CHANNELS);
      const serverEventStream = eventChannel.stream();
      const reader = serverEventStream.getReader();

      try {
        await inputSentEvent.wait();

        while (!this.closed && !signal.aborted) {
          const result = await reader.read();
          if (signal.aborted) return;
          if (result.done) return;

          const serverEvent = result.value;
          switch (serverEvent.type) {
            case 'session.created':
              currentSessionId = serverEvent.session_id;
              break;
            case 'output_audio':
              const base64Data = new Int8Array(Buffer.from(serverEvent.audio, 'base64'));
              for (const frame of bstream.write(base64Data.buffer)) {
                sendLastFrame(currentSessionId!, false);
                lastFrame = frame;
              }
              break;
            case 'done':
              for (const frame of bstream.flush()) {
                sendLastFrame(currentSessionId!, false);
                lastFrame = frame;
              }
              sendLastFrame(currentSessionId!, true);
              this.queue.put(SynthesizeStream.END_OF_STREAM);
              await resourceCleanup();
              completionFuture.resolve();
              return;
            case 'session.closed':
              await resourceCleanup();
              completionFuture.resolve();
              return;
            case 'error':
              this.#logger.error(
                { serverEvent },
                'Received error message from LiveKit TTS WebSocket',
              );
              await resourceCleanup();
              completionFuture.reject(
                new APIError(`LiveKit TTS returned error: ${serverEvent.message}`),
              );
              return;
            default:
              this.#logger.warn('Unexpected message %s', serverEvent);
              break;
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
      await this.tts.pool.withConnection(
        async (ws: WebSocket) => {
          try {
            // IMPORTANT: don't cancel the stream's controller on normal completion,
            // otherwise the pool will remove+close the ws and every run becomes a pool miss.
            const runController = new AbortController();
            const onStreamAbort = () => runController.abort(this.abortController.signal.reason);
            this.abortController.signal.addEventListener('abort', onStreamAbort, { once: true });

            const tasks = [
              Task.from(
                async (controller) => {
                  const combined = combineSignals(runController.signal, controller.signal);
                  await createInputTask(combined);
                },
                undefined,
                'inference-tts-input',
              ),
              Task.from(
                async (controller) => {
                  const combined = combineSignals(runController.signal, controller.signal);
                  await createSentenceStreamTask(ws, combined);
                },
                undefined,
                'inference-tts-sentence',
              ),
              Task.from(
                async (controller) => {
                  const combined = combineSignals(runController.signal, controller.signal);
                  await createWsListenerTask(ws, combined);
                },
                undefined,
                'inference-tts-ws-listener',
              ),
              Task.from(
                async (controller) => {
                  const combined = combineSignals(runController.signal, controller.signal);
                  await createRecvTask(combined);
                },
                undefined,
                'inference-tts-recv',
              ),
            ];

            try {
              await Promise.all(tasks.map((t) => t.result));
            } finally {
              // Mirror python finally: unblock recv and cancel all tasks.
              inputSentEvent.set();
              await resourceCleanup();
              await cancelAndWait(tasks, 5000);
              this.abortController.signal.removeEventListener('abort', onStreamAbort);
            }
          } catch (e) {
            // If aborted, don't throw - let cleanup handle it
            if (e instanceof Error && e.name === 'AbortError') {
              return;
            }
            throw e;
          }
        },
        {
          timeout: this.connOptions.timeoutMs,
        },
      );
    } catch (e) {
      // Handle connection errors
      if (e instanceof Error && e.name === 'AbortError') {
        // Abort is expected during normal shutdown
        return;
      }
      throw e;
    } finally {
      // Ensure cleanup always runs (and don't leak the promise)
      await resourceCleanup();
    }
  }
}
