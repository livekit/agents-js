// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
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

const SUPPORTED_SAMPLE_RATE = 48000;
const DEFAULT_MODEL_ENDPOINT = 'wss://api.gradium.ai/api/speech/tts';

/** @public */
export interface TTSOptions {
  /** Gradium API key. Defaults to $GRADIUM_API_KEY. */
  apiKey?: string;
  /** Gradium model endpoint. Defaults to $GRADIUM_MODEL_ENDPOINT or Gradium's hosted TTS endpoint. */
  modelEndpoint?: string;
  /** Gradium model name. */
  modelName?: string;
  /** Speaker voice. */
  voice?: string | null;
  /** Speaker voice ID. */
  voiceId?: string | null;
  /** Optional pronunciation ID. */
  pronunciationId?: string | null;
  /** Additional Gradium model configuration. */
  jsonConfig?: Record<string, unknown> | null;
  /** Tokenizer used for streaming text. */
  wordTokenizer?: tokenize.WordTokenizer;
}

interface ResolvedTTSOptions {
  apiKey: string;
  modelEndpoint: string;
  modelName: string;
  voice?: string | null;
  voiceId?: string | null;
  pronunciationId?: string | null;
  jsonConfig?: Record<string, unknown> | null;
  wordTokenizer: tokenize.WordTokenizer;
}

function resolveOptions(opts: Partial<TTSOptions>): ResolvedTTSOptions {
  const apiKey = opts.apiKey ?? process.env.GRADIUM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Gradium API key is required, either pass it as `apiKey` or set $GRADIUM_API_KEY',
    );
  }

  const modelEndpoint =
    opts.modelEndpoint ?? process.env.GRADIUM_MODEL_ENDPOINT ?? DEFAULT_MODEL_ENDPOINT;
  if (!modelEndpoint) {
    throw new Error('Gradium model endpoint is required');
  }

  return {
    apiKey,
    modelEndpoint,
    modelName: opts.modelName ?? 'default',
    voice: opts.voice,
    voiceId: opts.voiceId ?? 'YTpq7expH9539ERJ',
    pronunciationId: opts.pronunciationId,
    jsonConfig: opts.jsonConfig,
    wordTokenizer: opts.wordTokenizer ?? new tokenize.basic.WordTokenizer(false),
  };
}

function rawDataToString(data: RawData): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof Buffer) return data.toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return undefined;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function setupMessage(opts: ResolvedTTSOptions): string {
  const setup: Record<string, unknown> = {
    type: 'setup',
    model_name: opts.modelName,
    output_format: 'pcm',
  };
  if (opts.voice != null) setup.voice = opts.voice;
  if (opts.voiceId != null) setup.voice_id = opts.voiceId;
  if (opts.pronunciationId != null) setup.pronunciation_id = opts.pronunciationId;
  if (opts.jsonConfig != null) setup.json_config = JSON.stringify(opts.jsonConfig);
  return JSON.stringify(setup);
}

async function connect(opts: ResolvedTTSOptions): Promise<WebSocket> {
  const ws = new WebSocket(opts.modelEndpoint, {
    headers: { 'x-api-key': opts.apiKey, 'x-api-source': 'livekit' },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

/** @public */
export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'gradium.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved = resolveOptions(opts);
    super(SUPPORTED_SAMPLE_RATE, 1, { streaming: true });
    this.#opts = resolved;
  }

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'Gradium';
  }

  updateOptions(opts: Partial<Pick<TTSOptions, 'voice' | 'jsonConfig'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options: { connOptions?: APIConnectOptions } = {}): SynthesizeStream {
    return new SynthesizeStream(
      this,
      this.#opts,
      options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
  }
}

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  #opts: ResolvedTTSOptions;
  #logger = log();
  label = 'gradium.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#opts = { ...opts };
  }

  protected async run(): Promise<void> {
    const ws = await connect(this.#opts);
    const requestId = shortuuid();
    const segmentId = requestId;
    const audioByteStream = new AudioByteStream(SUPPORTED_SAMPLE_RATE, 1);
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame) return;
      this.queue.put({ requestId, segmentId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    const onAbort = () => ws.close();
    if (this.abortSignal.aborted) {
      ws.close();
    } else {
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      ws.send(setupMessage(this.#opts));
      ws.send(JSON.stringify({ type: 'text', text: this.inputText }));
      ws.send(JSON.stringify({ type: 'end_of_stream' }));

      await new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          try {
            const raw = rawDataToString(data);
            if (!raw) return;
            const message = JSON.parse(raw) as Record<string, unknown>;
            const type = message.type;
            if (type === 'audio') {
              const audio = Buffer.from(String(message.audio ?? ''), 'base64');
              for (const frame of audioByteStream.write(bufferToArrayBuffer(audio))) {
                sendLastFrame(false);
                lastFrame = frame;
              }
            } else if (type === 'end_of_stream') {
              for (const frame of audioByteStream.flush()) {
                sendLastFrame(false);
                lastFrame = frame;
              }
              sendLastFrame(true);
              resolve();
            } else if (type !== 'text' && type !== 'ready') {
              this.#logger.warn(`unknown message type from Gradium: ${String(type)}`);
            }
          } catch (error) {
            reject(error);
          }
        });
        ws.once('close', () => {
          sendLastFrame(true);
          resolve();
        });
        ws.once('error', reject);
        this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      this.abortSignal.removeEventListener('abort', onAbort);
      ws.close();
    }
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: ResolvedTTSOptions;
  #logger = log();
  label = 'gradium.SynthesizeStream';

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = { ...opts };
  }

  protected async run(): Promise<void> {
    let wordStream: tokenize.WordStream | undefined;
    const segments = new AsyncIterableQueue<tokenize.WordStream>();

    const inputTask = async () => {
      try {
        for await (const input of this.input) {
          if (input === SynthesizeStream.FLUSH_SENTINEL) {
            wordStream?.endInput();
            wordStream = undefined;
            continue;
          }

          if (!wordStream) {
            wordStream = this.#opts.wordTokenizer.stream();
            segments.put(wordStream);
          }
          wordStream.pushText(input);
        }
        wordStream?.endInput();
      } finally {
        segments.close();
      }
    };

    const segmentTask = async () => {
      for await (const segment of segments) {
        if (this.abortSignal.aborted) break;
        await this.#runSegment(segment);
      }
    };

    await Promise.all([inputTask(), segmentTask()]);
  }

  async #runSegment(wordStream: tokenize.WordStream): Promise<void> {
    const ws = await connect(this.#opts);
    const requestId = shortuuid();
    const segmentId = shortuuid();
    const audioByteStream = new AudioByteStream(SUPPORTED_SAMPLE_RATE, 1);
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame) return;
      this.queue.put({ requestId, segmentId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    // Signals the send/receive loops to unwind on abort. Without this the send
    // loop would keep awaiting `wordStream` (and pushing to a dead socket) after
    // an interruption, leaving `Promise.all` — and the `ws.close()` in the
    // `finally` — permanently pending. Mirrors the Python plugin's
    // `gracefully_cancel` of the send/receive tasks.
    const abortFuture = new Future();
    const onAbort = () => {
      if (!abortFuture.done) abortFuture.resolve();
    };
    if (this.abortSignal.aborted) {
      abortFuture.resolve();
    } else {
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const sendTask = async () => {
      ws.send(setupMessage(this.#opts));
      while (!this.abortSignal.aborted) {
        const result = await Promise.race([
          wordStream.next(),
          abortFuture.await.then(
            () => ({ done: true, value: undefined }) as IteratorResult<tokenize.TokenData>,
          ),
        ]);
        if (result.done || this.abortSignal.aborted) break;
        ws.send(JSON.stringify({ type: 'text', text: `${result.value.token} ` }));
      }
      if (!this.abortSignal.aborted) {
        ws.send(JSON.stringify({ type: 'end_of_stream' }));
      }
    };

    const receiveTask = async () => {
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          try {
            const raw = rawDataToString(data);
            if (!raw) return;
            const message = JSON.parse(raw) as Record<string, unknown>;
            const type = message.type;
            if (type === 'audio') {
              const audio = Buffer.from(String(message.audio ?? ''), 'base64');
              for (const frame of audioByteStream.write(bufferToArrayBuffer(audio))) {
                sendLastFrame(false);
                lastFrame = frame;
              }
            } else if (type === 'end_of_stream') {
              for (const frame of audioByteStream.flush()) {
                sendLastFrame(false);
                lastFrame = frame;
              }
              sendLastFrame(true);
              resolve();
            } else if (type !== 'text' && type !== 'ready') {
              this.#logger.warn(`unknown message type from Gradium: ${String(type)}`);
            }
          } catch (error) {
            reject(error);
          }
        });
        ws.once('close', () => {
          sendLastFrame(true);
          resolve();
        });
        ws.once('error', reject);
        void abortFuture.await.then(() => resolve());
      });
    };

    try {
      await Promise.all([sendTask(), receiveTask()]);
    } finally {
      this.abortSignal.removeEventListener('abort', onAbort);
      ws.close();
    }
  }
}
