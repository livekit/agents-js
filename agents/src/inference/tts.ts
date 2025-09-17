// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { APIConnectionError, APIError, APIStatusError } from '../_exceptions.js';
import { AudioByteStream } from '../audio.js';
import { log } from '../log.js';
import { basic as tokenizeBasic } from '../tokenize/index.js';
import {
  SynthesizeStream as BaseSynthesizeStream,
  TTS as BaseTTS,
  type SynthesizedAudio,
} from '../tts/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Task, cancelAndWait, shortuuid } from '../utils.js';
import type { TTSModels } from './models.js';
import { createAccessToken } from './utils.js';

type TTSEncoding = 'pcm_s16le';

const DEFAULT_ENCODING: TTSEncoding = 'pcm_s16le';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = 'wss://agent-gateway.livekit.cloud/v1';

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

  label = 'inference.TTS';

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
      language,
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

    this.opts = {
      model,
      voice,
      language,
      encoding,
      sampleRate,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      extraKwargs,
    };
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions, 'model' | 'voice' | 'language'>>) {
    this.opts = { ...this.opts, ...opts };
    for (const stream of this.streams) {
      stream.updateOptions(opts);
    }
  }

  synthesize(): never {
    throw new Error('ChunkedStream is not implemented');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const { connOptions = DEFAULT_API_CONNECT_OPTIONS } = options || {};
    const stream = new SynthesizeStream(this, { ...this.opts }, connOptions);
    this.streams.add(stream);
    return stream;
  }
}

export class SynthesizeStream extends BaseSynthesizeStream {
  #opts: InferenceTTSOptions;
  #logger = log();
  label = 'inference.SynthesizeStream';
  private connOptions: APIConnectOptions;

  constructor(tts: TTS, opts: InferenceTTSOptions, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
    this.connOptions = connOptions;
  }

  updateOptions(opts: Partial<Pick<InferenceTTSOptions, 'model' | 'voice' | 'language'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  protected async run(): Promise<void> {
    let ws: WebSocket | null = null;
    let closing = false;

    const connect = async () => {
      const params: Record<string, unknown> = {
        type: 'session.create',
        sample_rate: String(this.#opts.sampleRate),
        encoding: this.#opts.encoding,
        extra: this.#opts.extraKwargs,
      };
      if (this.#opts.voice) params['voice'] = this.#opts.voice;
      if (this.#opts.model) params['model'] = this.#opts.model;
      if (this.#opts.language) params['language'] = this.#opts.language;

      let baseURL = this.#opts.baseURL;
      if (baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
        baseURL = baseURL.replace('http', 'ws');
      }

      const token = await createAccessToken(this.#opts.apiKey, this.#opts.apiSecret);
      const url = `${baseURL}/tts`;
      const headers = { Authorization: `Bearer ${token}` } as Record<string, string>;

      return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        const timeout = setTimeout(() => {
          try {
            socket.close();
          } catch {}
          reject(new APIConnectionError({ message: 'Timeout connecting to LiveKit TTS' }));
        }, 10000);

        const onOpen = () => {
          clearTimeout(timeout);
          try {
            socket.send(JSON.stringify(params));
          } catch (e) {
            try {
              socket.close();
            } catch {}
            return reject(
              new APIConnectionError({
                message: 'failed to send session.create message to LiveKit TTS',
              }),
            );
          }
          resolve(socket);
        };
        const onError = (err: unknown) => {
          clearTimeout(timeout);
          if (err && typeof err === 'object' && 'code' in err && (err as any).code === 429) {
            reject(
              new APIStatusError({
                message: 'LiveKit TTS quota exceeded',
                options: { statusCode: 429 },
              }),
            );
          } else {
            reject(new APIConnectionError({ message: 'failed to connect to LiveKit TTS' }));
          }
        };
        const onClose = (code: number) => {
          clearTimeout(timeout);
          if (code !== 1000) {
            reject(new APIConnectionError({ message: 'failed to connect to LiveKit TTS' }));
          }
        };
        socket.once('open', onOpen);
        socket.once('error', onError);
        socket.once('close', onClose);
      });
    };

    const tokenizer = new tokenizeBasic.SentenceTokenizer().stream();
    const requestId = shortuuid('tts_request_');

    const createRecvTask = (wsConn: WebSocket) =>
      Task.from(async ({ signal }) => {
        let finalReceived = false;
        const bstream = new AudioByteStream(this.#opts.sampleRate, 1);
        let lastFrame: AudioFrame | undefined;
        const sendLast = (segmentId: string, final: boolean) => {
          if (lastFrame && !this.queue.closed) {
            this.queue.put({ requestId, segmentId, frame: lastFrame, final });
            lastFrame = undefined;
          }
        };

        const readOnce = () =>
          new Promise<string | null>((resolve, reject) => {
            wsConn.once('message', (d) => resolve(d.toString()));
            wsConn.once('error', (e) => reject(e));
            wsConn.once('close', (code, reason) => {
              if (!closing && !finalReceived) {
                reject(
                  new APIStatusError({
                    message: `Gateway connection closed unexpectedly: ${reason}`,
                    options: { statusCode: code },
                  }),
                );
              } else {
                resolve(null);
              }
            });
            const timer = setTimeout(() => {
              try {
                closing = true;
                wsConn.close();
              } catch {}
              resolve(null);
            }, this.connOptions.timeoutMs);
            // Clear timer on any completion
            const clearAll = () => clearTimeout(timer);
            wsConn.once('message', clearAll);
            wsConn.once('error', clearAll);
            wsConn.once('close', clearAll);
          });

        while (!this.closed && !signal.aborted) {
          const data = await Promise.race([
            readOnce(),
            new Promise<null>((resolve) =>
              signal.addEventListener('abort', () => resolve(null), { once: true }),
            ),
          ]);
          if (!data) break;

          const json = JSON.parse(data) as Record<string, unknown>;
          const type = json['type'];
          if (type === 'session.created') {
            this.#logger.debug('received session created from LiveKit TTS');
            continue;
          } else if (type === 'output_audio') {
            this.#logger.debug('received output audio from LiveKit TTS');
            const segmentId = (json['session_id'] as string | undefined) ?? requestId;
            const audioB64 = json['audio'] as string | undefined;
            if (!audioB64) continue;
            const bytes = new Int8Array(Buffer.from(audioB64, 'base64'));
            for (const frame of bstream.write(bytes.buffer)) {
              sendLast(segmentId, false);
              lastFrame = frame;
            }
          } else if (type === 'done') {
            this.#logger.debug('received done from LiveKit TTS');
            const segmentId = (json['session_id'] as string | undefined) ?? requestId;
            finalReceived = true;
            for (const frame of bstream.flush()) {
              sendLast(segmentId, false);
              lastFrame = frame;
            }
            sendLast(segmentId, true);
            if (!this.queue.closed) {
              this.queue.put(BaseSynthesizeStream.END_OF_STREAM as unknown as SynthesizedAudio);
            }
            closing = true;
            try {
              wsConn.close();
            } catch {}
            break;
          } else if (type === 'error') {
            this.#logger.error('received error from LiveKit TTS: %o', json);
            throw new APIError(`LiveKit TTS returned error: ${data}`);
          } else {
            this.#logger.warn('unexpected message from LiveKit TTS: %o', json);
          }
        }
      });

    try {
      ws = await connect();
      const inputTask = Task.from(async () => {
        try {
          for await (const data of this.input) {
            if (this.abortController.signal.aborted) break;
            if (data === BaseSynthesizeStream.FLUSH_SENTINEL) {
              tokenizer.flush();
              continue;
            }
            tokenizer.pushText(data);
          }
          tokenizer.endInput();
        } finally {
          tokenizer.close();
        }
      });

      const sentenceTask = Task.from(async ({ signal }) => {
        while (!signal.aborted) {
          const ev = await Promise.race([
            tokenizer.next(),
            new Promise<IteratorResult<unknown>>((resolve) => {
              signal.addEventListener(
                'abort',
                () => resolve({ done: true, value: undefined } as IteratorResult<unknown>),
                { once: true },
              );
            }),
          ]);
          if (!ev || ev.done) break;
          const token = (ev.value as { token: string }).token;
          try {
            ws!.send(
              JSON.stringify({
                type: 'input_transcript',
                transcript: token + ' ',
              }),
            );
          } catch (e) {
            if (!closing) throw e;
            break;
          }
        }
        try {
          ws!.send(JSON.stringify({ type: 'session.flush' }));
        } catch {}
      });

      const recvTask = createRecvTask(ws);

      // Wait for all tasks to complete to ensure we don't exit early while
      // the receiver is still streaming audio. This mirrors the Python
      // implementation which gathers all tasks.
      await Promise.all([recvTask.result, sentenceTask.result, inputTask.result]);
    } finally {
      closing = true;
      // tasks may not be defined if connect failed; cancel any that exist
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tasks: any[] = [];
      // @ts-expect-error dynamic scope
      if (typeof recvTask !== 'undefined') tasks.push(recvTask);
      // @ts-expect-error dynamic scope
      if (typeof sentenceTask !== 'undefined') tasks.push(sentenceTask);
      // @ts-expect-error dynamic scope
      if (typeof inputTask !== 'undefined') tasks.push(inputTask);
      await cancelAndWait(tasks, 2000);
      try {
        if (ws) ws.close();
      } catch {}
    }
  }
}
