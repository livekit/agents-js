// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  Future,
  log,
  shortuuid,
  tokenize,
  tts,
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

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
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

            for (const frame of bstream.write(audioBytes)) {
              this.queue.put({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });
            }

            for (const frame of bstream.flush()) {
              this.queue.put({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });
            }

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
  #tokenizer = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: BUFFERED_WORDS_COUNT,
  }).stream();
  #websocket: WebSocket | null = null;
  #requestId = 0;
  label = 'resemble.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    let closing = false;
    const activeRequests = new Set<number>();

    const sentenceStreamTask = async (ws: WebSocket) => {
      const packet = toResembleOptions(this.#opts, true);

      for await (const event of this.#tokenizer) {
        const reqId = this.#requestId++;
        packet.data = event.token + ' ';
        packet.request_id = reqId;
        packet.continue = true;

        activeRequests.add(reqId);

        ws.send(JSON.stringify(packet));
      }
    };

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenizer.flush();
          continue;
        }
        this.#tokenizer.pushText(data);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
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

      // Use promise-based message handling similar to ElevenLabs
      while ((!closing && activeRequests.size > 0) || !this.#tokenizer.closed) {
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
                  if (activeRequests.size === 0 && this.#tokenizer.closed) {
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
                  this.queue.put(SynthesizeStream.END_OF_STREAM);
                  ws.close();
                  reject(new Error(`Resemble API error: ${errorName}`));
                  return;
                }
                resolve();
              } catch (error) {
                this.#logger.error(`Error parsing WebSocket message: ${error}`);
                reject(error);
              }
            });

            ws.on('error', (error) => {
              this.#logger.error(`WebSocket error: ${error}`);
              if (!closing) {
                closing = true;
                this.queue.put(SynthesizeStream.END_OF_STREAM);
                ws.close();
              }
              reject(error);
            });

            ws.on('close', (code, reason) => {
              if (!closing) {
                this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
                this.queue.put(SynthesizeStream.END_OF_STREAM);
              }
              // Only reject if we haven't received all expected frames
              if (activeRequests.size > 0 || !this.#tokenizer.closed) {
                reject(new Error(`WebSocket closed prematurely with code ${code}: ${reason}`));
              } else {
                resolve();
              }
            });
          });
        } catch (err) {
          // Skip log error for normal websocket close
          if (err instanceof Error && !err.message.includes('WebSocket closed prematurely')) {
            this.#logger.error({ err }, 'Error in recvTask from Resemble WebSocket');
          }
          break;
        }
      }
    };

    const ws = new WebSocket(RESEMBLE_WEBSOCKET_URL, {
      headers: {
        Authorization: `Bearer ${this.#opts.apiKey}`,
      },
    });
    this.#websocket = ws;

    try {
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', (error) => reject(error));
        ws.on('close', (code) => reject(`WebSocket returned ${code}`));
      });

      await Promise.all([inputTask(), sentenceStreamTask(ws), recvTask(ws)]);
    } catch (e) {
      throw new Error(`failed to connect to Resemble: ${e}`);
    }
  }

  override close(): void {
    if (this.#websocket) {
      this.#websocket.close();
      this.#websocket = null;
    }

    this.#tokenizer.close();

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
