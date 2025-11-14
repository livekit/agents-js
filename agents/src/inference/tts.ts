// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { log } from '../log.js';
import { createStreamChannel } from '../stream/stream_channel.js';
import { basic as tokenizeBasic } from '../tokenize/index.js';
import type { ChunkedStream } from '../tts/index.js';
import { SynthesizeStream as BaseSynthesizeStream, TTS as BaseTTS } from '../tts/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { shortuuid } from '../utils.js';
import {
  type TtsClientEvent,
  type TtsServerEvent,
  type TtsSessionCreateEvent,
  ttsClientEventSchema,
  ttsServerEventSchema,
} from './api_protos.js';
import { type AnyString, connectWs, createAccessToken } from './utils.js';

export type CartesiaModels =
  | 'cartesia'
  | 'cartesia/sonic'
  | 'cartesia/sonic-2'
  | 'cartesia/sonic-turbo';

export type ElevenlabsModels =
  | 'elevenlabs'
  | 'elevenlabs/eleven_flash_v2'
  | 'elevenlabs/eleven_flash_v2_5'
  | 'elevenlabs/eleven_turbo_v2'
  | 'elevenlabs/eleven_turbo_v2_5'
  | 'elevenlabs/eleven_multilingual_v2';

export type RimeModels = 'rime' | 'rime/mist' | 'rime/mistv2' | 'rime/arcana';

export type InworldModels = 'inworld' | 'inworld/inworld-tts-1';

export interface CartesiaOptions {
  duration?: number; // max duration of audio in seconds
  speed?: 'slow' | 'normal' | 'fast'; // default: not specified
}

export interface ElevenlabsOptions {
  inactivity_timeout?: number; // default: 60
  apply_text_normalization?: 'auto' | 'off' | 'on'; // default: "auto"
}

export interface RimeOptions {}

export interface InworldOptions {}

type _TTSModels = CartesiaModels | ElevenlabsModels | RimeModels | InworldModels;

export type TTSModels = CartesiaModels | ElevenlabsModels | RimeModels | InworldModels | AnyString;

export type ModelWithVoice = `${_TTSModels}:${string}` | TTSModels;

export type TTSOptions<TModel extends TTSModels> = TModel extends CartesiaModels
  ? CartesiaOptions
  : TModel extends ElevenlabsModels
    ? ElevenlabsOptions
    : TModel extends RimeOptions
      ? RimeOptions
      : TModel extends InworldOptions
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

    const socket = await connectWs(url, headers, timeout);
    socket.send(JSON.stringify(params));
    return socket;
  }

  async closeWs(ws: WebSocket) {
    await ws.close();
  }

  async close() {
    for (const stream of this.streams) {
      await stream.close();
    }
    this.streams.clear();
  }
}

export class SynthesizeStream<TModel extends TTSModels> extends BaseSynthesizeStream {
  private opts: InferenceTTSOptions<TModel>;
  private tts: TTS<TModel>;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(tts: TTS<TModel>, opts: InferenceTTSOptions<TModel>, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.opts = opts;
    this.tts = tts;
    this.connOptions = connOptions;
  }

  get label() {
    return 'inference.SynthesizeStream';
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions<TModel>, 'model' | 'voice' | 'language'>>) {
    this.opts = { ...this.opts, ...opts };
  }

  protected async run(): Promise<void> {
    let ws: WebSocket | null = null;
    let closing = false;
    let finalReceived = false;
    let lastFrame: AudioFrame | undefined;

    const sendTokenizerStream = new tokenizeBasic.SentenceTokenizer().stream();
    const eventChannel = createStreamChannel<TtsServerEvent>();
    const requestId = shortuuid('tts_request_');

    const resourceCleanup = () => {
      if (closing) return;
      closing = true;
      sendTokenizerStream.close();
      eventChannel.close();
      ws?.removeAllListeners();
      ws?.close();
    };

    const sendClientEvent = async (event: TtsClientEvent) => {
      const validatedEvent = await ttsClientEventSchema.parseAsync(event);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
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

    const createInputTask = async () => {
      for await (const data of this.input) {
        if (this.abortController.signal.aborted) break;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          sendTokenizerStream.flush();
          continue;
        }
        sendTokenizerStream.pushText(data);
      }
      sendTokenizerStream.endInput();
    };

    const createSentenceStreamTask = async () => {
      for await (const ev of sendTokenizerStream) {
        if (this.abortController.signal.aborted) break;

        sendClientEvent({
          type: 'input_transcript',
          transcript: ev.token + ' ',
        });
      }

      sendClientEvent({ type: 'session.flush' });
    };

    const createWsListenerTask = async (ws: WebSocket) => {
      return new Promise<void>((resolve, reject) => {
        this.abortController.signal.addEventListener('abort', () => {
          resourceCleanup();
          reject(new Error('WebSocket connection aborted'));
        });

        ws.on('message', async (data) => {
          const eventJson = JSON.parse(data.toString()) as Record<string, unknown>;
          const validatedEvent = ttsServerEventSchema.parse(eventJson);
          eventChannel.write(validatedEvent);
        });

        ws.on('error', (e) => {
          this.#logger.error({ error: e }, 'WebSocket error');
          resourceCleanup();
          reject(e);
        });

        ws.on('close', () => {
          resourceCleanup();

          if (!closing) return this.#logger.error('WebSocket closed unexpectedly');
          if (finalReceived) return resolve();

          reject(
            new APIStatusError({
              message: 'Gateway connection closed unexpectedly',
              options: { requestId },
            }),
          );
        });
      });
    };

    const createRecvTask = async () => {
      let currentSessionId: string | null = null;

      const bstream = new AudioByteStream(this.opts.sampleRate, NUM_CHANNELS);
      const serverEventStream = eventChannel.stream();
      const reader = serverEventStream.getReader();

      try {
        while (!this.closed && !this.abortController.signal.aborted) {
          const result = await reader.read();
          if (this.abortController.signal.aborted) return;
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
              finalReceived = true;
              for (const frame of bstream.flush()) {
                sendLastFrame(currentSessionId!, false);
                lastFrame = frame;
              }
              sendLastFrame(currentSessionId!, true);
              this.queue.put(SynthesizeStream.END_OF_STREAM);
              break;
            case 'session.closed':
              resourceCleanup();
              break;
            case 'error':
              this.#logger.error(
                { serverEvent },
                'Received error message from LiveKit TTS WebSocket',
              );
              resourceCleanup();
              throw new APIError(`LiveKit TTS returned error: ${serverEvent.message}`);
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
      ws = await this.tts.connectWs(this.connOptions.timeoutMs);

      await Promise.all([
        createInputTask(),
        createSentenceStreamTask(),
        createWsListenerTask(ws),
        createRecvTask(),
      ]);
    } catch (e) {
      this.#logger.error({ error: e }, 'Error in SynthesizeStream');
    } finally {
      resourceCleanup();
    }
  }
}
