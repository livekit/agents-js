// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
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

function validateSpeed(speed: number | undefined) {
  if (speed !== undefined && (speed < 0.7 || speed > 1.5)) {
    throw new Error(`Deepgram TTS speed must be between 0.7 and 1.5, got ${speed}`);
  }
}

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  speed?: number;
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

  get model(): string {
    return this.opts.model;
  }

  get provider(): string {
    return 'Deepgram';
  }

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

    validateSpeed(this.opts.speed);
  }

  updateOptions(opts: { speed?: number }): void {
    validateSpeed(opts.speed);
    this.opts = {
      ...this.opts,
      ...opts,
    };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.opts, options?.connOptions);
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
    if (this.opts.speed !== undefined) {
      url.searchParams.append('speed', this.opts.speed.toString());
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

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
            settle(() =>
              reject(
                new Error(
                  `Deepgram TTS HTTP request failed: ${res.statusCode} ${res.statusMessage}`,
                ),
              ),
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
            settle(() => reject(err));
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
            settle(() => resolve());
          });
        },
      );

      req.on('error', (err) => {
        if (err.name === 'AbortError') return;
        this.#logger.error({ err }, 'Deepgram TTS request error');
        settle(() => reject(err));
      });

      req.on('close', () => settle(() => resolve()));
      req.write(JSON.stringify(json));
      req.end();
    });
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  private opts: TTSOptions;
  private tokenizer: tokenize.SentenceStream;
  #logger = log();
  label = 'deepgram.SynthesizeStream';

  private static readonly FLUSH_MSG = JSON.stringify({ type: 'Flush' });
  private static readonly CLOSE_MSG = JSON.stringify({ type: 'Close' });

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
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
    if (this.opts.speed !== undefined) {
      url.searchParams.append('speed', this.opts.speed.toString());
    }

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

    let markInputSent: () => void = () => {};
    const inputSent = new Promise<void>((resolve) => {
      markInputSent = resolve;
    });

    const sendTask = async () => {
      try {
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
          markInputSent();
        }

        if (!this.abortController.signal.aborted) {
          ws.send(SynthesizeStream.FLUSH_MSG);
          markInputSent();
        }
      } finally {
        markInputSent();
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

      const resetMessageTimeout = (reject: (reason?: unknown) => void) => {
        clearMessageTimeout();
        timeout = setTimeout(() => {
          reject(new APITimeoutError({ message: 'Deepgram TTS recv idle timeout' }));
        }, this.connOptions.timeoutMs);
      };

      await inputSent;
      if (this.abortController.signal.aborted) return;

      return new Promise<void>((resolve, reject) => {
        resetMessageTimeout(reject);

        ws.on('message', (data: RawData, isBinary: boolean) => {
          clearMessageTimeout();

          if (!isBinary) {
            const message = JSON.parse(data.toString());
            if (message.type === 'Flushed') {
              finalReceived = true;
              for (const frame of bstream.flush()) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
              sendLastFrame(segmentId, true);

              if (!this.queue.closed) {
                this.queue.put(SynthesizeStream.END_OF_STREAM);
              }
              resolve();
              return;
            } else if (message.type === 'Warning') {
              this.#logger.warn(`Deepgram warning: ${message.warn_msg}`);
            } else if (message.type === 'Error' || message.type === 'error') {
              reject(new APIError('Deepgram TTS returned error', { body: message }));
              return;
            } else if (message.type !== 'Metadata') {
              this.#logger.warn({ message }, 'Unknown Deepgram message type');
            }

            resetMessageTimeout(reject);
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
          resetMessageTimeout(reject);
        });

        ws.on('close', (code, reason) => {
          clearMessageTimeout();
          if (!finalReceived) {
            reject(
              new APIStatusError({
                message: 'Deepgram websocket connection closed unexpectedly',
                options: {
                  statusCode: code || -1,
                  body: { reason: reason.toString() },
                },
              }),
            );
            return;
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
      if (this.abortController.signal.aborted) return;
      if (e instanceof APIError) throw e;
      throw new APIConnectionError({
        message: `Deepgram TTS WebSocket failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    } finally {
      await this.closeWebSocket(ws);
    }
  }
}
