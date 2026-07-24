// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AsyncIterableQueue,
  AudioByteStream,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const XAI_WEBSOCKET_URL = 'wss://api.x.ai/v1/tts';
const DEFAULT_VOICE = 'ara';

export type GrokVoices = 'Ara' | 'Eve' | 'Leo' | 'Rex' | 'Sal';

export type TTSLanguages =
  | 'auto'
  | 'en'
  | 'ar-EG'
  | 'ar-SA'
  | 'ar-AE'
  | 'bn'
  | 'zh'
  | 'fr'
  | 'de'
  | 'hi'
  | 'id'
  | 'it'
  | 'ja'
  | 'ko'
  | 'pt-BR'
  | 'pt-PT'
  | 'ru'
  | 'es-MX'
  | 'es-ES'
  | 'tr'
  | 'vi';

export interface TTSOptions {
  apiKey?: string;
  voice?: GrokVoices | string;
  language?: TTSLanguages | string;
  optimizeStreamingLatency?: number;
  speed?: number;
  textNormalization?: boolean;
  tokenizer?: tokenize.WordTokenizer;
}

interface ResolvedTTSOptions {
  apiKey: string;
  voice: GrokVoices | string;
  language: TTSLanguages | string;
  optimizeStreamingLatency?: number;
  speed?: number;
  textNormalization?: boolean;
  tokenizer: tokenize.WordTokenizer;
}

type WebSocketEvent =
  | { type: 'message'; data: RawData }
  | { type: 'close'; code: number; reason: Buffer }
  | { type: 'error'; error: Error };

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #streams = new Set<SynthesizeStream>();
  pool: ConnectionPool<WebSocket>;
  label = 'xai.TTS';

  constructor(opts: TTSOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'xAI API key is required, either as argument or set XAI_API_KEY environment variable',
      );
    }

    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });

    this.#opts = {
      apiKey,
      voice: opts.voice ?? DEFAULT_VOICE,
      language: opts.language ?? 'auto',
      optimizeStreamingLatency: opts.optimizeStreamingLatency,
      speed: opts.speed,
      textNormalization: opts.textNormalization,
      tokenizer: opts.tokenizer ?? new tokenize.basic.WordTokenizer(false),
    };

    this.pool = new ConnectionPool<WebSocket>({
      connectCb: (timeout) => this.connectWs(timeout),
      closeCb: (ws) => this.closeWs(ws),
      // xAI's TTS server enforces an undocumented ~2100s deadline per websocket
      // connection; stay below it so connections rotate before the server kills them.
      maxSessionDuration: 1_800_000,
      markRefreshedOnGet: false,
      connectTimeout: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    });
  }

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'xAI';
  }

  updateOptions(opts: Omit<Partial<TTSOptions>, 'apiKey' | 'tokenizer'>): void {
    const before = [
      this.#opts.voice,
      this.#opts.language,
      this.#opts.optimizeStreamingLatency,
      this.#opts.speed,
      this.#opts.textNormalization,
    ];

    if (opts.voice !== undefined) this.#opts.voice = opts.voice;
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.optimizeStreamingLatency !== undefined) {
      this.#opts.optimizeStreamingLatency = opts.optimizeStreamingLatency;
    }
    if (opts.speed !== undefined) this.#opts.speed = opts.speed;
    if (opts.textNormalization !== undefined) this.#opts.textNormalization = opts.textNormalization;

    const after = [
      this.#opts.voice,
      this.#opts.language,
      this.#opts.optimizeStreamingLatency,
      this.#opts.speed,
      this.#opts.textNormalization,
    ];

    if (after.some((value, index) => value !== before[index])) {
      this.pool.invalidate();
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
    this.#streams.add(stream);
    return stream;
  }

  prewarm(): void {
    this.pool.prewarm();
  }

  async close(): Promise<void> {
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();
    await this.pool.close();
  }

  async connectWs(timeout: number): Promise<WebSocket> {
    const url = new URL(XAI_WEBSOCKET_URL);
    url.searchParams.set('voice', this.#opts.voice);
    url.searchParams.set('language', this.#opts.language);
    url.searchParams.set('codec', 'pcm');
    url.searchParams.set('sample_rate', String(SAMPLE_RATE));

    if (this.#opts.optimizeStreamingLatency !== undefined) {
      url.searchParams.set(
        'optimize_streaming_latency',
        String(this.#opts.optimizeStreamingLatency),
      );
    }
    if (this.#opts.speed !== undefined) {
      url.searchParams.set('speed', String(this.#opts.speed));
    }
    if (this.#opts.textNormalization !== undefined) {
      url.searchParams.set(
        'text_normalization',
        String(this.#opts.textNormalization).toLowerCase(),
      );
    }

    try {
      return await connectWebSocket({
        url: url.toString(),
        headers: { Authorization: `Bearer ${this.#opts.apiKey}` },
        timeoutMs: timeout,
      });
    } catch (e) {
      throw new APIConnectionError({
        message: `failed to connect to xAI: ${(e as Error).message ?? 'unknown error'}`,
      });
    }
  }

  async closeWs(ws: WebSocket): Promise<void> {
    ws.close();
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'xai.ChunkedStream';
  #tts: TTS;
  #text: string;
  #connOptions: APIConnectOptions;

  constructor(tts: TTS, text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, tts, connOptions, abortSignal);
    this.#tts = tts;
    this.#text = text;
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run(): Promise<void> {
    const stream = this.#tts.stream({ connOptions: this.#connOptions });
    const onAbort = () => stream.close();
    this.abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      stream.pushText(this.#text);
      stream.endInput();

      for await (const audio of stream) {
        if (audio === tts.SynthesizeStream.END_OF_STREAM) break;
        this.queue.put(audio);
      }
    } finally {
      this.abortSignal.removeEventListener('abort', onAbort);
      stream.close();
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'xai.SynthesizeStream';
  #logger = log();
  #tts: TTS;
  #opts: ResolvedTTSOptions;

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const segments = new AsyncIterableQueue<tokenize.WordStream>();

    const tokenizeInput = async () => {
      let inputStream: tokenize.WordStream | null = null;

      try {
        for await (const input of this.input) {
          if (input === SynthesizeStream.FLUSH_SENTINEL) {
            if (inputStream) {
              inputStream.endInput();
              inputStream = null;
            }
            continue;
          }

          if (!inputStream) {
            inputStream = this.#opts.tokenizer.stream();
            segments.put(inputStream);
          }
          inputStream.pushText(input);
        }

        if (inputStream) {
          inputStream.endInput();
        }
      } finally {
        segments.close();
      }
    };

    const runSegments = async () => {
      for await (const inputStream of segments) {
        await this.#runWs(inputStream);
      }
      if (!this.queue.closed) {
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    };

    try {
      await Promise.all([tokenizeInput(), runSegments()]);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (e instanceof APIStatusError || e instanceof APIConnectionError) {
        throw e;
      }
      throw new APIConnectionError({
        message: `xAI TTS websocket failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    }
  }

  async #runWs(inputStream: tokenize.WordStream): Promise<void> {
    const requestId = shortuuid();
    const segmentId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    let lastFrame: AudioFrame | undefined;
    let inputEnded = false;

    const sendLastFrame = (final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    await this.#tts.pool.withConnection(
      async (ws) => {
        const events = new AsyncIterableQueue<WebSocketEvent>();
        const done = new Future<void>();
        let doneSettled = false;

        const settleDone = (error?: Error) => {
          if (doneSettled) return;
          doneSettled = true;
          if (error) done.reject(error);
          else done.resolve();
        };

        const onMessage = (data: RawData) => events.put({ type: 'message', data });
        const onClose = (code: number, reason: Buffer) =>
          events.put({ type: 'close', code, reason });
        const onError = (error: Error) => events.put({ type: 'error', error });
        const onAbort = () => settleDone(new Error('aborted'));

        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);
        this.abortSignal.addEventListener('abort', onAbort, { once: true });

        const sendTask = async () => {
          for await (const word of inputStream) {
            if (this.abortSignal.aborted) return;
            this.markStarted();
            ws.send(JSON.stringify({ type: 'text.delta', delta: word.token }));
          }
          ws.send(JSON.stringify({ type: 'text.done' }));
          inputEnded = true;
        };

        const recvTask = async () => {
          for await (const event of events) {
            if (event.type === 'error') {
              throw event.error;
            }

            if (event.type === 'close') {
              throw new APIStatusError({
                message: 'xAI connection closed unexpectedly',
                options: {
                  statusCode: event.code || -1,
                  body: { reason: event.reason.toString() },
                },
              });
            }

            let data: Record<string, unknown>;
            try {
              data = JSON.parse(event.data.toString()) as Record<string, unknown>;
            } catch (e) {
              this.#logger.warn({ err: e }, 'Unexpected xAI message');
              continue;
            }

            switch (data.type) {
              case 'audio.delta':
                if (typeof data.delta !== 'string') break;
                for (const frame of bstream.write(Buffer.from(data.delta, 'base64'))) {
                  sendLastFrame(false);
                  lastFrame = frame;
                }
                break;
              case 'audio.done':
                if (inputEnded) {
                  for (const frame of bstream.flush()) {
                    sendLastFrame(false);
                    lastFrame = frame;
                  }
                  sendLastFrame(true);
                  settleDone();
                  return;
                }
                break;
              case 'error':
                throw new APIStatusError({
                  message: typeof data.message === 'string' ? data.message : 'unknown xAI error',
                  options: { body: data },
                });
              default:
                this.#logger.warn({ data }, 'Unexpected xAI message');
            }
          }
        };

        try {
          await Promise.all([sendTask(), recvTask(), done.await]);
        } finally {
          ws.off('message', onMessage);
          ws.off('close', onClose);
          ws.off('error', onError);
          this.abortSignal.removeEventListener('abort', onAbort);
          events.close();
        }
      },
      { timeout: this.connOptions.timeoutMs, signal: this.abortSignal },
    );
  }
}

const connectWebSocket = async ({
  url,
  headers,
  timeoutMs,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<WebSocket> => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });
  const fut = new Future<void>();

  let timeout: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('close', onClose);
  };

  const onOpen = () => fut.resolve();
  const onError = (error: Error) => fut.reject(error);
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`),
    );

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);

  if (timeoutMs > 0) {
    timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);
  }

  try {
    await fut.await;
    return ws;
  } catch (e) {
    try {
      ws.on('error', () => {});
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      } else {
        ws.terminate();
      }
    } catch {
      // ignore
    }
    throw e;
  } finally {
    cleanup();
  }
};
