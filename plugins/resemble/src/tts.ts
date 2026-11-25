// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  AudioByteStream,
  Future,
  log,
  shortuuid,
  tokenize,
  tts,
  waitForWebSocketOpen,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import type { OutputFormat, Precision, ResembleModel } from './models.js';

export const TTSDefaultVoiceId = '55592656';

const RESEMBLE_WEBSOCKET_URL = 'wss://websocket.cluster.resemble.ai/stream';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

export interface TTSOptions {
  voiceUuid: string;
  sampleRate: number;
  precision: Precision;
  model?: ResembleModel;
  outputFormat?: OutputFormat;
  apiKey?: string;
}

const defaultTTSOptions: TTSOptions = {
  voiceUuid: TTSDefaultVoiceId,
  sampleRate: 44100,
  precision: 'PCM_16',
  apiKey: process.env.RESEMBLE_API_KEY,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'resemble.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(opts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: true,
    });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
    };

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Resemble API key is required, whether as an argument or as $RESEMBLE_API_KEY',
      );
    }
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
  label = 'resemble.ChunkedStream';
  #logger = log();
  #opts: TTSOptions;
  #text: string;

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const json = toResembleOptions(this.#opts);

    json.data = this.#text;
    const doneFut = new Future<void>();

    const req = request(
      {
        hostname: 'f.cluster.resemble.ai',
        port: 443,
        path: '/synthesize',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey!}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: this.abortSignal,
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);

            if (!response.success) {
              const issues = response.issues || ['Unknown error'];
              const errorMsg = issues.join('; ');
              throw new Error(`Resemble API returned failure: ${errorMsg}`);
            }

            const audioContentB64 = response.audio_content;
            if (!audioContentB64) {
              throw new Error('No audio content in response');
            }

            const audioBytes = Buffer.from(audioContentB64, 'base64');
            let lastFrame: AudioFrame | undefined;
            const sendLastFrame = (final: boolean) => {
              if (lastFrame) {
                this.queue.put({
                  requestId,
                  frame: lastFrame,
                  final,
                  segmentId: requestId,
                });
                lastFrame = undefined;
              }
            };

            for (const frame of bstream.write(audioBytes)) {
              sendLastFrame(false);
              lastFrame = frame;
            }

            for (const frame of bstream.flush()) {
              if (frame.samplesPerChannel === 0) continue;
              sendLastFrame(false);
              lastFrame = frame;
            }

            sendLastFrame(true);
            this.queue.close();
            doneFut.resolve();
          } catch (error) {
            this.#logger.error('Error processing Resemble API response:', error);
            this.queue.close();
            doneFut.resolve();
          }
        });

        res.on('close', () => {
          this.queue.close();
          doneFut.resolve();
        });

        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'Resemble TTS response error');
        });
      },
    );

    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      this.#logger.error({ err }, 'Resemble TTS request error');
    });
    req.on('close', () => doneFut.resolve());
    req.write(JSON.stringify(json));
    req.end();

    await doneFut.await;
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #websocket: WebSocket | null = null;
  label = 'resemble.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const tokenizer = new tokenize.blingfire.SentenceTokenizer({
      minSentenceLength: BUFFERED_WORDS_COUNT,
    }).stream();
    let requestCounter = 0;
    let closing = false;
    const activeRequests = new Set<number>();

    const sentenceStreamTask = async (ws: WebSocket) => {
      const packet = toResembleOptions(this.#opts, true);

      for await (const event of tokenizer) {
        if (closing || this.abortSignal.aborted) return;
        const reqId = requestCounter++;
        packet.data = event.token + ' ';
        packet.request_id = reqId;
        packet.continue = true;

        activeRequests.add(reqId);

        this.markStarted();
        ws.send(JSON.stringify(packet));
      }
    };

    const inputTask = async () => {
      for await (const data of this.input) {
        // A failed attempt closes its tokenizer; a retry reads the replayed input instead.
        if (tokenizer.closed) return;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          tokenizer.flush();
          continue;
        }
        tokenizer.pushText(data);
      }
      if (tokenizer.closed) return;
      tokenizer.endInput();
      tokenizer.close();
    };

    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      // Use promise-based message handling similar to ElevenLabs. A failure rejects the attempt
      // without ending the output, so the base class can retry it before any audio.
      while ((!closing && activeRequests.size > 0) || !tokenizer.closed) {
        try {
          await new Promise<void>((resolve, reject) => {
            ws.removeAllListeners();
            ws.on('message', (data) => {
              try {
                const json = JSON.parse(data.toString());
                const segmentId = json.request_id;

                if ('audio_content' in json) {
                  try {
                    const audioData = Buffer.from(json.audio_content, 'base64');
                    for (const frame of bstream.write(audioData)) {
                      sendLastFrame(segmentId, false);
                      lastFrame = frame;
                    }
                  } catch (audioError) {
                    this.#logger.error(`Error processing audio content: ${audioError}`);
                  }
                } else if ('type' in json && json.type === 'audio_end') {
                  for (const frame of bstream.flush()) {
                    sendLastFrame(segmentId, false);
                    lastFrame = frame;
                  }
                  sendLastFrame(segmentId, true);

                  activeRequests.delete(Number(segmentId));

                  // Only end the stream when all requests are complete and tokenizer is closed
                  if (activeRequests.size === 0 && tokenizer.closed) {
                    this.queue.put(SynthesizeStream.END_OF_STREAM);
                    closing = true;
                    ws.close();
                    resolve();
                    return;
                  }
                } else if ('success' in json && json.success === false) {
                  const errorName = json.error_name || 'Unknown';
                  const explanation = json.error_params?.explanation || 'No details provided';
                  this.#logger
                    .child({ error: errorName })
                    .error(`Resemble API error: ${explanation}`);

                  closing = true;
                  ws.close();
                  reject(new APIError(`Resemble API error: ${errorName}`, { retryable: false }));
                  return;
                }
                resolve();
              } catch (error) {
                this.#logger.error(`Error parsing WebSocket message: ${error}`);
                reject(error);
              }
            });

            ws.on('error', (error) => {
              if (!closing) {
                closing = true;
                ws.close();
              }
              reject(new APIConnectionError({ message: `Resemble WebSocket error: ${error}` }));
            });

            ws.on('close', (code, reason) => {
              // Only reject if we haven't received all expected frames
              if (activeRequests.size > 0 || !tokenizer.closed) {
                reject(
                  new APIConnectionError({
                    message: `Resemble WebSocket closed prematurely with code ${code}: ${reason}`,
                  }),
                );
              } else {
                resolve();
              }
            });
          });
        } catch (err) {
          // close() tears the socket down; that ends the attempt without a failure.
          if (this.abortSignal.aborted) break;
          throw err;
        }
      }
    };

    const ws = new WebSocket(RESEMBLE_WEBSOCKET_URL, {
      handshakeTimeout: this.connOptions.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.#opts.apiKey}`,
      },
    });
    this.#websocket = ws;

    let tasks: Promise<void>[] = [];
    try {
      await waitForWebSocketOpen(ws, 'Resemble');

      tasks = [inputTask(), sentenceStreamTask(ws), recvTask(ws)];
      await Promise.all(tasks);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (e instanceof APIError) throw e;
      throw new APIConnectionError({ message: `failed to connect to Resemble: ${e}` });
    } finally {
      closing = true;
      if (!this.input.closed) this.input.close();
      tokenizer.close();
      if (this.#websocket === ws) this.#websocket = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      await Promise.allSettled(tasks);
    }
  }

  override close(): void {
    if (this.#websocket) {
      this.#websocket.close();
      this.#websocket = null;
    }

    super.close();
  }
}

const toResembleOptions = (
  opts: TTSOptions,
  stream: boolean = false,
): { [id: string]: unknown } => {
  const options: { [id: string]: unknown } = {
    voice_uuid: opts.voiceUuid,
    sample_rate: opts.sampleRate,
    precision: opts.precision,
  };

  if (opts.model) {
    options.model = opts.model;
  }

  if (stream) {
    options.no_audio_header = true;
  } else {
    options.output_format = opts.outputFormat?.toLowerCase();
  }

  return options;
};
