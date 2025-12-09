// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

const AUTHORIZATION_HEADER = 'Authorization';
const NUM_CHANNELS = 1;
const MIN_SENTENCE_LENGTH = 8;

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  apiKey?: string;
  baseUrl?: string;
  sentenceTokenizer: tokenize.SentenceTokenizer;
  capabilities: tts.TTSCapabilities;
}

const defaultTTSOptions: TTSOptions = {
  model: 'aura-asteria-en',
  encoding: 'linear16',
  sampleRate: 24000,
  apiKey: process.env.DEEPGRAM_API_KEY,
  baseUrl: 'https://api.deepgram.com',
  capabilities: {
    streaming: true,
  },
  sentenceTokenizer: new tokenize.basic.SentenceTokenizer({
    minSentenceLength: MIN_SENTENCE_LENGTH,
  }),
};

export class TTS extends tts.TTS {
  private opts: TTSOptions;
  label = 'deepgram.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(opts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: opts.capabilities?.streaming ?? defaultTTSOptions.capabilities.streaming,
    });

    this.opts = {
      ...defaultTTSOptions,
      ...opts,
    };

    if (this.opts.apiKey === undefined) {
      throw new Error(
        'Deepgram API key is required, whether as an argument or as $DEEPGRAM_API_KEY',
      );
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'deepgram.ChunkedStream';
  #logger = log();
  private opts: TTSOptions;
  private text: string;

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.text = text;
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.opts.sampleRate, NUM_CHANNELS);
    const json = { text: this.text };
    const url = new URL(`${this.opts.baseUrl!}/v1/speak`);
    url.searchParams.append('sample_rate', this.opts.sampleRate.toString());
    url.searchParams.append('model', this.opts.model);
    url.searchParams.append('encoding', this.opts.encoding);

    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            [AUTHORIZATION_HEADER]: `Token ${this.opts.apiKey!}`,
            'Content-Type': 'application/json',
          },
          signal: this.abortSignal,
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(
              new Error(`Deepgram TTS HTTP request failed: ${res.statusCode} ${res.statusMessage}`),
            );
            return;
          }

          res.on('data', (chunk) => {
            for (const frame of bstream.write(chunk)) {
              if (!this.queue.closed) {
                this.queue.put({
                  requestId,
                  frame,
                  final: false,
                  segmentId: requestId,
                });
              }
            }
          });

          res.on('error', (err) => {
            if (err.message === 'aborted') return;
            this.#logger.error({ err }, 'Deepgram TTS response error');
          });

          res.on('close', () => {
            for (const frame of bstream.flush()) {
              if (!this.queue.closed) {
                this.queue.put({
                  requestId,
                  frame,
                  final: false,
                  segmentId: requestId,
                });
              }
            }
            if (!this.queue.closed) {
              this.queue.close();
            }
            resolve();
          });
        },
      );

      req.on('error', (err) => {
        if (err.name === 'AbortError') return;
        this.#logger.error({ err }, 'Deepgram TTS request error');
      });

      req.on('close', () => resolve());
      req.write(JSON.stringify(json));
      req.end();
    });
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  private opts: TTSOptions;
  private tokenizer: tokenize.SentenceStream;
  label = 'deepgram.SynthesizeStream';

  private static readonly FLUSH_MSG = JSON.stringify({ type: 'Flush' });
  private static readonly CLOSE_MSG = JSON.stringify({ type: 'Close' });

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.opts = opts;
    this.tokenizer = opts.sentenceTokenizer.stream();
  }

  private async closeWebSocket(ws: WebSocket): Promise<void> {
    try {
      // Send Flush and Close messages to ensure Deepgram processes all remaining audio
      // and properly terminates the session, preventing lingering TTS sessions
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(SynthesizeStream.FLUSH_MSG);
        ws.send(SynthesizeStream.CLOSE_MSG);

        // Wait for server acknowledgment to prevent race conditions and ensure
        // proper cleanup, avoiding 429 Too Many Requests errors from lingering sessions
        try {
          await new Promise<void>((resolve, _reject) => {
            const timeout = setTimeout(() => {
              resolve();
            }, 1000);

            ws.once('message', () => {
              clearTimeout(timeout);
              resolve();
            });

            ws.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });

            ws.once('error', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        } catch (e) {
          // Ignore timeout or other errors during close sequence
        }
      }
    } catch (e) {
      console.warn(`Error during WebSocket close sequence: ${e}`);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  protected async run() {
    const requestId = shortuuid();
    const segmentId = shortuuid();

    const wsUrl = this.opts.baseUrl!.replace(/^http/, 'ws');
    const url = new URL(`${wsUrl}/v1/speak`);
    url.searchParams.append('sample_rate', this.opts.sampleRate.toString());
    url.searchParams.append('model', this.opts.model);
    url.searchParams.append('encoding', this.opts.encoding);

    const ws = new WebSocket(url, {
      headers: {
        [AUTHORIZATION_HEADER]: `Token ${this.opts.apiKey!}`,
      },
    });

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', (error) => reject(error));
      ws.on('close', (code) => reject(`WebSocket returned ${code}`));
    });

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.tokenizer.flush();
          continue;
        }
        this.tokenizer.pushText(data);
      }
      this.tokenizer.endInput();
      this.tokenizer.close();
    };

    const sendTask = async () => {
      for await (const event of this.tokenizer) {
        if (this.abortController.signal.aborted) break;

        let text = event.token;
        if (!text.endsWith(' ')) {
          text += ' ';
        }

        const message = JSON.stringify({
          type: 'Speak',
          text: text,
        });

        ws.send(message);
      }

      if (!this.abortController.signal.aborted) {
        ws.send(SynthesizeStream.FLUSH_MSG);
      }
    };

    const recvTask = async () => {
      const bstream = new AudioByteStream(this.opts.sampleRate, NUM_CHANNELS);
      let finalReceived = false;
      let timeout: NodeJS.Timeout | null = null;
      let lastFrame: AudioFrame | undefined;

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      const clearMessageTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      return new Promise<void>((resolve, reject) => {
        ws.on('message', (data: RawData, isBinary: boolean) => {
          clearMessageTimeout();

          if (!isBinary) {
            const message = JSON.parse(data.toString());
            if (message.type === 'Flushed') {
              finalReceived = true;
              clearMessageTimeout();
              for (const frame of bstream.flush()) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
              sendLastFrame(segmentId, true);

              if (!this.queue.closed) {
                this.queue.put(SynthesizeStream.END_OF_STREAM);
              }
              resolve();
            }

            return;
          }

          const buffer =
            data instanceof Buffer
              ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
              : (data as ArrayBuffer);
          for (const frame of bstream.write(buffer as ArrayBuffer)) {
            sendLastFrame(segmentId, false);
            lastFrame = frame;
          }
        });

        ws.on('close', (_code, _reason) => {
          if (!finalReceived) {
            for (const frame of bstream.flush()) {
              sendLastFrame(segmentId, false);
              lastFrame = frame;
            }
            sendLastFrame(segmentId, true);

            if (!this.queue.closed) {
              this.queue.put(SynthesizeStream.END_OF_STREAM);
            }
          }
          resolve();
        });

        ws.on('error', (error) => {
          clearMessageTimeout();
          reject(error);
        });
      });
    };

    try {
      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (e) {
      throw new Error(`failed in main task: ${e}`);
    } finally {
      await this.closeWebSocket(ws);
    }
  }
}
