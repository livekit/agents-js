// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  asError,
  log,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const SAMPLE_RATE = 24_000;
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
  voice: GrokVoices | string;
  language: TTSLanguages | string;
  optimizeStreamingLatency?: number;
  speed?: number;
  textNormalization?: boolean;
  tokenizer: tokenize.WordTokenizer;
}

type ResolvedTTSOptions = TTSOptions & { apiKey: string };

const defaultTTSOptions: Omit<TTSOptions, 'apiKey' | 'tokenizer'> = {
  voice: DEFAULT_VOICE,
  language: 'auto',
};

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #pool: ConnectionPool<WebSocket>;
  #streams = new Set<SynthesizeStream>();
  #logger = log();
  label = 'xai.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });

    const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('xAI API key is required, whether as an argument or as $XAI_API_KEY');
    }

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
      apiKey,
      tokenizer: opts.tokenizer ?? new tokenize.basic.WordTokenizer(false),
    };
    this.#pool = new ConnectionPool<WebSocket>({
      connectCb: (timeout) => this.#connectPooledWs(timeout),
      closeCb: (ws) => closeWebSocket(ws),
      maxSessionDuration: 3_600_000,
      markRefreshedOnGet: false,
    });
  }

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'xAI';
  }

  synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
    this.#streams.add(stream);
    return stream;
  }

  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'tokenizer'>>) {
    const before = connectionOptionsKey(this.#opts);
    this.#opts = { ...this.#opts, ...opts };

    if (connectionOptionsKey(this.#opts) !== before) {
      this.#pool.invalidate();
    }
  }

  prewarm(): void {
    this.#pool.prewarm();
  }

  async close(): Promise<void> {
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();
    await this.#pool.close();
  }

  async withConnection<R>(
    fn: (ws: WebSocket) => Promise<R>,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<R> {
    return await this.#pool.withConnection(fn, options);
  }

  async #connectPooledWs(timeout: number): Promise<WebSocket> {
    this.#logger.debug('xAI TTS creating new websocket connection (pool miss)');
    return await connectWebSocket(wsUrl(this.#opts), this.#opts.apiKey, timeout);
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  #logger = log();
  label = 'xai.SynthesizeStream';

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const segments = stream.createStreamChannel<tokenize.WordStream>();

    const tokenizeInput = async () => {
      let inputStream: tokenize.WordStream | undefined;
      try {
        for await (const input of this.input) {
          if (input === SynthesizeStream.FLUSH_SENTINEL) {
            inputStream?.endInput();
            inputStream = undefined;
            continue;
          }

          if (!inputStream) {
            inputStream = this.#opts.tokenizer.stream();
            await segments.write(inputStream);
          }
          inputStream.pushText(input);
        }
      } finally {
        inputStream?.endInput();
        await segments.close();
      }
    };

    const runSegments = async () => {
      const reader = segments.stream().getReader();
      try {
        while (!this.abortSignal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          await this.#runWs(value, requestId);
        }
      } finally {
        reader.releaseLock();
      }
    };

    try {
      await Promise.all([tokenizeInput(), runSegments()]);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIStatusError || error instanceof APIConnectionError) throw error;
      throw new APIConnectionError({
        message: `xAI TTS websocket failed: ${asError(error).message}`,
      });
    }
  }

  async #runWs(inputStream: tokenize.WordStream, requestId: string) {
    const segmentId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    let inputEnded = false;
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame || this.queue.closed) return;
      this.queue.put({ requestId, segmentId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    await this.#tts.withConnection(
      async (ws) => {
        const messages = stream.createStreamChannel<Record<string, unknown>>();
        const errorFuture = new Future<Error>();

        const onMessage = (raw: RawData) => {
          try {
            void messages.write(JSON.parse(raw.toString()));
          } catch (error) {
            this.#logger.warn({ error }, 'failed to parse xAI TTS message');
          }
        };
        const onClose = (code: number, reason: Buffer) => {
          if (!this.abortSignal.aborted) {
            errorFuture.resolve(
              new APIStatusError({
                message: 'xAI connection closed unexpectedly',
                options: { statusCode: code || -1, body: { reason: reason.toString() } },
              }),
            );
          }
          void messages.close();
        };
        const onError = (error: Error) => {
          errorFuture.resolve(
            new APIConnectionError({ message: `xAI websocket error: ${error.message}` }),
          );
          void messages.close();
        };

        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);

        const sendTask = async () => {
          for await (const word of inputStream) {
            if (this.abortSignal.aborted) return;
            this.markStarted();
            ws.send(JSON.stringify({ type: 'text.delta', delta: word.token }));
          }
          inputEnded = true;
          ws.send(JSON.stringify({ type: 'text.done' }));
        };

        const recvTask = async () => {
          const reader = messages.stream().getReader();
          try {
            while (!this.abortSignal.aborted) {
              const [result, socketError] = await Promise.race([
                reader.read().then((result) => [result, undefined] as const),
                errorFuture.await.then((error) => [undefined, error] as const),
              ]);
              if (socketError) throw socketError;
              if (!result || result.done) break;

              const msgType = result.value.type;
              if (msgType === 'audio.delta') {
                const audio = Buffer.from(result.value.delta as string, 'base64');
                for (const frame of bstream.write(audio)) {
                  sendLastFrame(false);
                  lastFrame = frame;
                }
              } else if (msgType === 'audio.done') {
                if (!inputEnded) continue;
                for (const frame of bstream.flush()) {
                  sendLastFrame(false);
                  lastFrame = frame;
                }
                sendLastFrame(true);
                break;
              } else if (msgType === 'error') {
                throw new APIStatusError({
                  message: (result.value.message as string | undefined) ?? 'unknown xAI error',
                  options: { body: result.value },
                });
              } else {
                this.#logger.warn({ data: result.value }, 'unexpected xAI TTS message');
              }
            }
          } finally {
            reader.releaseLock();
          }
        };

        try {
          await Promise.all([sendTask(), recvTask()]);
        } finally {
          ws.off('message', onMessage);
          ws.off('close', onClose);
          ws.off('error', onError);
          void messages.close();
        }
      },
      { timeout: this.connOptions.timeoutMs, signal: this.abortSignal },
    );
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #tts: TTS;
  label = 'xai.ChunkedStream';

  constructor(tts: TTS, text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, tts, connOptions, abortSignal);
    this.#tts = tts;
  }

  protected async run() {
    const requestId = shortuuid();
    const segmentId = requestId;
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame || this.queue.closed) return;
      this.queue.put({ requestId, segmentId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    try {
      await this.#tts.withConnection(
        async (ws) => {
          const messages = stream.createStreamChannel<Record<string, unknown>>();
          const errorFuture = new Future<Error>();

          const onMessage = (raw: RawData) => {
            try {
              void messages.write(JSON.parse(raw.toString()));
            } catch {
              // Ignore malformed provider messages; the stream will fail on timeout/close if needed.
            }
          };
          const onClose = (code: number, reason: Buffer) => {
            errorFuture.resolve(
              new APIStatusError({
                message: 'xAI connection closed unexpectedly',
                options: { statusCode: code || -1, body: { reason: reason.toString() } },
              }),
            );
            void messages.close();
          };
          const onError = (error: Error) => {
            errorFuture.resolve(
              new APIConnectionError({ message: `xAI websocket error: ${error.message}` }),
            );
            void messages.close();
          };

          ws.on('message', onMessage);
          ws.on('close', onClose);
          ws.on('error', onError);

          try {
            ws.send(JSON.stringify({ type: 'text.delta', delta: this.inputText }));
            ws.send(JSON.stringify({ type: 'text.done' }));

            const reader = messages.stream().getReader();
            try {
              while (!this.abortSignal.aborted) {
                const [result, socketError] = await Promise.race([
                  reader.read().then((result) => [result, undefined] as const),
                  errorFuture.await.then((error) => [undefined, error] as const),
                ]);
                if (socketError) throw socketError;
                if (!result || result.done) break;

                if (result.value.type === 'audio.delta') {
                  const audio = Buffer.from(result.value.delta as string, 'base64');
                  for (const frame of bstream.write(audio)) {
                    sendLastFrame(false);
                    lastFrame = frame;
                  }
                } else if (result.value.type === 'audio.done') {
                  for (const frame of bstream.flush()) {
                    sendLastFrame(false);
                    lastFrame = frame;
                  }
                  sendLastFrame(true);
                  break;
                } else if (result.value.type === 'error') {
                  throw new APIStatusError({
                    message: (result.value.message as string | undefined) ?? 'unknown xAI error',
                    options: { body: result.value },
                  });
                }
              }
            } finally {
              reader.releaseLock();
            }
          } finally {
            ws.off('message', onMessage);
            ws.off('close', onClose);
            ws.off('error', onError);
            void messages.close();
          }
        },
        { signal: this.abortSignal },
      );
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIStatusError || error instanceof APIConnectionError) throw error;
      throw new APIConnectionError({
        message: `xAI TTS websocket failed: ${asError(error).message}`,
      });
    }
  }
}

function wsUrl(opts: ResolvedTTSOptions): string {
  const url = new URL(XAI_WEBSOCKET_URL);
  url.searchParams.set('voice', opts.voice);
  url.searchParams.set('language', opts.language);
  url.searchParams.set('codec', 'pcm');
  url.searchParams.set('sample_rate', String(SAMPLE_RATE));
  if (opts.optimizeStreamingLatency !== undefined) {
    url.searchParams.set('optimize_streaming_latency', String(opts.optimizeStreamingLatency));
  }
  if (opts.speed !== undefined) {
    url.searchParams.set('speed', String(opts.speed));
  }
  if (opts.textNormalization !== undefined) {
    url.searchParams.set('text_normalization', String(opts.textNormalization).toLowerCase());
  }
  return url.toString();
}

function connectionOptionsKey(opts: TTSOptions): string {
  return JSON.stringify({
    voice: opts.voice,
    language: opts.language,
    optimizeStreamingLatency: opts.optimizeStreamingLatency,
    speed: opts.speed,
    textNormalization: opts.textNormalization,
  });
}

async function connectWebSocket(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<WebSocket> {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: timeoutMs,
  });
  ws.on('error', () => {});

  const opened = new Future<void>();
  let timeout: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('close', onClose);
  };
  const onOpen = () => opened.resolve();
  const onError = (error: Error) => opened.reject(error);
  const onClose = (code: number, reason: Buffer) =>
    opened.reject(
      new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`),
    );

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);
  if (timeoutMs > 0) {
    timeout = setTimeout(() => opened.reject(new Error('connect timeout')), timeoutMs);
  }

  try {
    await opened.await;
    return ws;
  } catch (error) {
    closeWebSocket(ws);
    throw new APIConnectionError({
      message: `failed to connect to xAI: ${asError(error).message}`,
    });
  } finally {
    cleanup();
  }
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  ws.on('error', () => {});
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  } else {
    ws.terminate();
  }
}
