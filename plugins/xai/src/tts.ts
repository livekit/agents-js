// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AsyncIterableQueue,
  AudioByteStream,
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

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'xai.TTS';

  constructor(opts: TTSOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('xAI API key is required, whether as an argument or as $XAI_API_KEY');
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
  }

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'xAI';
  }

  updateOptions(opts: Omit<Partial<TTSOptions>, 'apiKey' | 'tokenizer'>): void {
    if (opts.voice !== undefined) this.#opts.voice = opts.voice;
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.optimizeStreamingLatency !== undefined) {
      this.#opts.optimizeStreamingLatency = opts.optimizeStreamingLatency;
    }
    if (opts.speed !== undefined) this.#opts.speed = opts.speed;
    if (opts.textNormalization !== undefined) this.#opts.textNormalization = opts.textNormalization;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #opts: ResolvedTTSOptions;
  #text: string;
  #connOptions: APIConnectOptions;
  #logger = log();
  label = 'xai.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = { ...opts };
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run() {
    const requestId = shortuuid();
    const segmentId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const wordStream = this.#opts.tokenizer.stream();
    wordStream.pushText(this.#text);
    wordStream.endInput();

    try {
      await runXAITTS({
        opts: this.#opts,
        connOptions: this.#connOptions,
        abortSignal: this.abortSignal,
        words: wordStream,
        requestId,
        segmentId,
        bstream,
        logger: this.#logger,
        emitFrame: (frame, final) => {
          if (!this.queue.closed) {
            this.queue.put({ requestId, segmentId, frame, final });
          }
        },
      });
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw e;
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: ResolvedTTSOptions;
  #logger = log();
  label = 'xai.SynthesizeStream';

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = { ...opts };
  }

  protected async run() {
    const segments = new AsyncIterableQueue<tokenize.WordStream>();

    const inputTask = async () => {
      let wordStream: tokenize.WordStream | undefined;
      try {
        for await (const data of this.input) {
          if (data === SynthesizeStream.FLUSH_SENTINEL) {
            if (wordStream) {
              wordStream.endInput();
              wordStream = undefined;
            }
            continue;
          }

          if (!wordStream) {
            wordStream = this.#opts.tokenizer.stream();
            segments.put(wordStream);
          }
          wordStream.pushText(data);
        }
      } finally {
        if (wordStream && !wordStream.closed) wordStream.endInput();
        segments.close();
      }
    };

    const segmentTask = async () => {
      for await (const wordStream of segments) {
        if (this.abortSignal.aborted) break;

        const requestId = shortuuid();
        const segmentId = shortuuid();
        const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
        await runXAITTS({
          opts: this.#opts,
          connOptions: this.connOptions,
          abortSignal: this.abortSignal,
          words: wordStream,
          requestId,
          segmentId,
          bstream,
          logger: this.#logger,
          emitFrame: (frame, final) => {
            if (!this.queue.closed) {
              this.queue.put({ requestId, segmentId, frame, final });
            }
          },
        });
      }
    };

    try {
      await Promise.all([inputTask(), segmentTask()]);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (e instanceof APIStatusError || e instanceof APIConnectionError) {
        throw e;
      }
      throw new APIConnectionError({
        message: `xAI websocket failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    }
  }
}

async function runXAITTS({
  opts,
  connOptions,
  abortSignal,
  words,
  requestId,
  segmentId,
  bstream,
  logger,
  emitFrame,
}: {
  opts: ResolvedTTSOptions;
  connOptions: APIConnectOptions;
  abortSignal: AbortSignal;
  words: tokenize.WordStream;
  requestId: string;
  segmentId: string;
  bstream: AudioByteStream;
  logger: ReturnType<typeof log>;
  emitFrame: (frame: AudioFrame, final: boolean) => void;
}) {
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

  let ws: WebSocket | undefined;
  try {
    ws = await connectWebSocket({
      url: url.toString(),
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      timeoutMs: connOptions.timeoutMs,
      abortSignal,
    });
  } catch (e) {
    throw new APIConnectionError({
      message: `failed to connect to xAI TTS: ${(e as Error).message ?? 'unknown error'}`,
    });
  }

  let inputEnded = false;
  let lastFrame: AudioFrame | undefined;

  const sendLastFrame = (final: boolean) => {
    if (lastFrame) {
      emitFrame(lastFrame, final);
      lastFrame = undefined;
    }
  };

  const sendTask = async () => {
    for await (const word of words) {
      if (abortSignal.aborted) break;
      ws!.send(JSON.stringify({ type: 'text.delta', delta: word.token }));
    }
    if (!abortSignal.aborted) {
      ws!.send(JSON.stringify({ type: 'text.done' }));
      inputEnded = true;
    }
  };

  const recvTask = async () => {
    const finished = new Future<void>();

    const onMessage = (raw: RawData) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw.toString());
      } catch (err) {
        logger.warn({ err }, 'xAI TTS failed to parse message');
        return;
      }

      const msgType = data['type'];
      if (msgType === 'audio.delta') {
        const delta = data['delta'];
        if (typeof delta !== 'string') return;
        const audio = Buffer.from(delta, 'base64');
        for (const frame of bstream.write(audio)) {
          sendLastFrame(false);
          lastFrame = frame;
        }
      } else if (msgType === 'audio.done') {
        if (!inputEnded) return;
        for (const frame of bstream.flush()) {
          sendLastFrame(false);
          lastFrame = frame;
        }
        sendLastFrame(true);
        if (!finished.done) finished.resolve();
      } else if (msgType === 'error') {
        finished.reject(
          new APIStatusError({
            message: (data['message'] as string) ?? 'unknown xAI error',
            options: { body: { raw: JSON.stringify(data) }, requestId },
          }),
        );
      } else {
        logger.warn({ msgType, requestId, segmentId }, 'received unexpected message from xAI TTS');
      }
    };

    const onClose = (code: number, reason: Buffer) => {
      if (!finished.done) {
        finished.reject(
          new APIStatusError({
            message: 'xAI TTS websocket connection closed unexpectedly',
            options: {
              statusCode: code || -1,
              body: { reason: reason.toString() },
              requestId,
            },
          }),
        );
      }
    };

    const onError = (err: Error) => {
      if (!finished.done) finished.reject(err);
    };

    ws!.on('message', onMessage);
    ws!.on('close', onClose);
    ws!.on('error', onError);
    try {
      await finished.await;
    } finally {
      ws!.off('message', onMessage);
      ws!.off('close', onClose);
      ws!.off('error', onError);
    }
  };

  try {
    await Promise.all([sendTask(), recvTask()]);
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

const connectWebSocket = async ({
  url,
  headers,
  timeoutMs,
  abortSignal,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  abortSignal: AbortSignal;
}): Promise<WebSocket> => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });
  const fut = new Future<void>();

  let timeout: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('close', onClose);
    abortSignal.removeEventListener('abort', onAbort);
  };

  const onOpen = () => fut.resolve();
  const onError = (err: Error) => fut.reject(err);
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`),
    );
  const onAbort = () => fut.reject(new Error('aborted'));

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);
  abortSignal.addEventListener('abort', onAbort, { once: true });

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
