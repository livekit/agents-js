// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { log } from '../log.js';
import { basic as tokenizeBasic } from '../tokenize/index.js';
import {
  SynthesizeStream as BaseSynthesizeStream,
  TTS as BaseTTS,
  ChunkedStream,
} from '../tts/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { shortuuid, waitForAbort } from '../utils.js';
import type { TTSModels } from './models.js';
import { connectWs, createAccessToken } from './utils.js';

type TTSEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: TTSEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = 'https://agent-gateway.livekit.cloud/v1';
const NUM_CHANNELS = 1;
const DEFAULT_LANGUAGE = 'en';

export interface InferenceTTSOptions {
  model?: TTSModels | string;
  voice?: string;
  language?: string;
  encoding: TTSEncoding;
  sampleRate: number;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  extraKwargs: Record<string, unknown>;
}

export class TTS extends BaseTTS {
  private opts: InferenceTTSOptions;
  private streams: Set<SynthesizeStream> = new Set();

  #logger = log();

  constructor(opts?: {
    model?: TTSModels | string;
    voice?: string;
    language?: string;
    baseURL?: string;
    encoding?: TTSEncoding;
    sampleRate?: number;
    apiKey?: string;
    apiSecret?: string;
    extraKwargs?: Record<string, unknown>;
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
        nextModel = nextModel.slice(0, idx);
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
      extraKwargs,
    };
  }

  get label() {
    return 'inference.TTS';
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions, 'model' | 'voice' | 'language'>>) {
    this.opts = { ...this.opts, ...opts };
    for (const stream of this.streams) {
      stream.updateOptions(opts);
    }
  }

  synthesize(_: string): ChunkedStream {
    throw new Error('ChunkedStream is not implemented');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
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

    this.#logger.info({ url, headers }, 'Connecting to LiveKit TTS WebSocket');
    const params = {
      type: 'session.create',
      sample_rate: String(this.opts.sampleRate),
      encoding: this.opts.encoding,
      extra: this.opts.extraKwargs,
    } as Record<string, unknown>;

    if (this.opts.voice) params.voice = this.opts.voice;
    if (this.opts.model) params.model = this.opts.model;
    if (this.opts.language) params.language = this.opts.language;

    this.#logger.info({ params }, 'Sending session.create message to LiveKit TTS WebSocket');

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

export class SynthesizeStream extends BaseSynthesizeStream {
  private opts: InferenceTTSOptions;
  private tts: TTS;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(tts: TTS, opts: InferenceTTSOptions, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.opts = opts;
    this.tts = tts;
    this.connOptions = connOptions;
  }

  get label() {
    return 'inference.SynthesizeStream';
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions, 'model' | 'voice' | 'language'>>) {
    this.opts = { ...this.opts, ...opts };
  }

  protected async run(): Promise<void> {
    let ws: WebSocket | null = null;
    let closing = false;

    const sendTokenizerStream = new tokenizeBasic.SentenceTokenizer().stream();
    const requestId = shortuuid('tts_request_');

    const createInputTask = async (signal: AbortSignal) => {
      for await (const data of this.input) {
        if (signal.aborted) break;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          sendTokenizerStream.flush();
          continue;
        }
        sendTokenizerStream.pushText(data);
      }
      sendTokenizerStream.endInput();
    };

    const createSentenceStreamTask = async (ws: WebSocket) => {
      const basePacket = { type: 'input_transcript' };
      for await (const ev of sendTokenizerStream) {
        if (this.abortController.signal.aborted) break;

        const tokenPacket = { ...basePacket, transcript: ev.token + ' ' };
        // TODO(brian): mark started
        ws.send(JSON.stringify(tokenPacket));
      }

      const endPacket = { type: 'session.flush' };
      ws.send(JSON.stringify(endPacket));
    };

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const createRecvTask = async (ws: WebSocket) => {
      let currentSessionId: string | null = null;
      let finalReceived = false;
      const bstream = new AudioByteStream(this.opts.sampleRate, NUM_CHANNELS);

      while (!this.closed && !this.abortController.signal.aborted) {
        try {
          const dataPromise = new Promise<string | void>((resolve, reject) => {
            ws.once('message', (d) => resolve(d.toString()));
            ws.once('error', (e) => {
              this.#logger.error('WebSocket error', { error: e });
              reject(e);
            });
            ws.once('close', () => {
              if (!closing) {
                this.#logger.error('WebSocket closed unexpectedly');
              }

              if (!finalReceived) {
                reject(
                  new APIStatusError({
                    message: 'Gateway connection closed unexpectedly',
                    options: { requestId },
                  }),
                );
              } else {
                resolve();
              }
            });
          });

          const data = await Promise.race([dataPromise, waitForAbort(this.abortController.signal)]);
          if (!data || this.abortController.signal.aborted) return;

          const json = JSON.parse(data) as Record<string, unknown>;
          const sessionId = json.session_id as string | undefined;
          const type = json.type as string | undefined;

          if (currentSessionId === null && sessionId) {
            currentSessionId = sessionId;
          }

          switch (type) {
            case 'session.created':
              break;
            case 'output_audio':
              const audio = json.audio as string;
              const base64Data = new Int8Array(Buffer.from(audio, 'base64'));
              for (const frame of bstream.write(base64Data)) {
                sendLastFrame(currentSessionId!, false);
                lastFrame = frame;
              }
            case 'done':
              finalReceived = true;
              for (const frame of bstream.flush()) {
                sendLastFrame(currentSessionId!, false);
                lastFrame = frame;
              }
              sendLastFrame(currentSessionId!, true);
              this.queue.put(SynthesizeStream.END_OF_STREAM);

              closing = true;
              ws.close();
              break;
            case 'error':
              throw new APIError(`LiveKit TTS returned error: ${json.error}`);
            default:
              this.#logger.warn('Unexpected message %s', json);
              break;
          }
        } catch (err) {
          // skip log error for normal websocket close
          if (err instanceof Error && !err.message.includes('WebSocket closed')) {
            this.#logger.error({ err }, 'Error in recvTask from LiveKit TTS WebSocket');
          }
          break;
        }
      }
    };

    ws = await this.tts.connectWs(this.connOptions.timeoutMs);

    try {
      await Promise.all([
        createInputTask(this.abortController.signal),
        createSentenceStreamTask(ws),
        createRecvTask(ws),
      ]);
    } finally {
      await sendTokenizerStream.close();
    }
  }
}
