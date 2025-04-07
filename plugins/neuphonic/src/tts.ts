// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, log, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import { type TTSEncodings, type TTSLangCodes, type TTSModels } from './models.js';

const AUTHORIZATION_HEADER = 'X-API-KEY';
const NUM_CHANNELS = 1;
const API_BASE_URL = 'api.neuphonic.com';

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncodings | string;
  sampleRate: number;
  voiceId?: string;
  speed?: number;
  apiKey?: string;
  langCode: TTSLangCodes | string;
}

const defaultTTSOptions: TTSOptions = {
  model: 'neu_hq',
  encoding: 'pcm_linear',
  sampleRate: 22050,
  langCode: 'en',
  speed: 1.0,
  apiKey: process.env.NEUPHONIC_API_KEY,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'neuphonic.TTS';

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
        'Neuphonic API key is required, whether as an argument or as $NEUPHONIC_API_KEY',
      );
    }
  }

  synthesize(text: string): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'neuphonic.ChunkedStream';
  #opts: TTSOptions;
  #text: string;

  constructor(tts: TTS, text: string, opts: TTSOptions) {
    super(text, tts);
    this.#text = text;
    this.#opts = opts;
    this.#run();
  }

  async #run() {
    const requestId = randomUUID();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const json = {
      text: this.#text,
      ...getModelParams(this.#opts),
    };

    let buffer = '';

    const req = request(
      {
        hostname: API_BASE_URL,
        port: 443,
        path: `/sse/speak/${this.#opts.langCode}`,
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const messages = buffer.split('\n'); // wait until a full message has been recv

          if (messages.length > 1) {
            buffer = messages.pop() || '';

            for (const message of messages) {
              if (message) {
                const parsedMessage = parseSSEMessage(message);

                if (parsedMessage?.data?.audio) {
                  for (const frame of bstream.write(parsedMessage.data.audio)) {
                    this.queue.put({
                      requestId,
                      frame,
                      final: false,
                      segmentId: requestId,
                    });
                  }
                }
              }
            }
          }
        });
        res.on('close', () => {
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
          this.queue.close();
        });
      },
    );

    req.write(JSON.stringify(json));
    req.end();
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  label = 'neuphonic.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
    this.#run();
  }

  async #run() {
    const requestId = randomUUID();
    let closing = false;

    const sendTask = async (ws: WebSocket) => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          ws.send(JSON.stringify({ text: '<STOP>' }));
          continue;
        }

        ws.send(JSON.stringify({ text: data }));
      }
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

      ws.on('message', (data) => {
        const json = JSON.parse(data.toString());

        if (json?.data?.audio) {
          const audio = new Int8Array(Buffer.from(json.data.audio, 'base64'));
          for (const frame of bstream.write(audio)) {
            sendLastFrame(requestId, false);
            lastFrame = frame;
            // this.queue.put({frame, requestId, segmentId: requestId, final: false})
          }

          if (json?.data?.stop) {
            // This is a bool flag, it is True when audio reaches "<STOP>"
            for (const frame of bstream.flush()) {
              sendLastFrame(requestId, false);
              lastFrame = frame;
            }
            sendLastFrame(requestId, true);
            this.queue.put(SynthesizeStream.END_OF_STREAM);

            closing = true;
            ws.close();
            return;
          }
        }
      });
      ws.on('close', (code, reason) => {
        if (!closing) {
          this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
        }
        ws.removeAllListeners();
      });
    };

    const url = `wss://${API_BASE_URL}/speak/en?${getQueryParamString(this.#opts)}&api_key=${this.#opts.apiKey}`;
    const ws = new WebSocket(url);

    try {
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', (error) => reject(error));
        ws.on('close', (code) => reject(`WebSocket returned ${code}`));
      });

      await Promise.all([sendTask(ws), recvTask(ws)]);
    } catch (e) {
      throw new Error(`failed to connect to Neuphonic: ${e}`);
    }
  }
}

/**
 * Returns all model paramters as a query parameter string ready to be sent to the Neuphonic API.
 * @param opts - The TTSOptions object.
 */
const getQueryParamString = (opts: TTSOptions): string => {
  const params = getModelParams(opts);

  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
};

/**
 * Returns all model paramters as an object in snake_case.
 * @param opts - The TTSOptions object.
 */
const getModelParams = (opts: TTSOptions): Partial<TTSOptions> => {
  const params: Record<string, string | number> = {};

  if (opts.voiceId) params.voice_id = opts.voiceId;
  if (opts.model) params.model = opts.model;
  if (opts.langCode) params.lang_code = opts.langCode;
  if (opts.encoding) params.encoding = opts.encoding;
  if (opts.sampleRate) params.sampling_rate = opts.sampleRate;
  if (opts.speed) params.speed = opts.speed;

  return params;
};

/**
 * Parse each response from the SSE endpoint.
 *
 * @remarks
 * The incoming message will be a string reading either one of:
 * - `event: error`
 * - `event: message`
 * - `data: { "status_code": 200, "data": {"audio": ... } }`
 *
 * @param message - The SSE message to parse
 * @returns The parsed message or null if invalid
 */
const parseSSEMessage = (
  message: string,
): {
  status_code: number;
  data: {
    text: string;
    audio: Int8Array;
  };
} | null => {
  message = message.trim();

  if (!message || !message.includes('data: ')) {
    return null;
  }

  const value = message.split(':').slice(1).join(':').trim();
  const parsedMessage = JSON.parse(value);

  if (parsedMessage?.errors) {
    throw new Error(`Status ${parsedMessage.status_code} error received: ${parsedMessage.errors}.`);
  }

  if (parsedMessage?.data?.audio) {
    parsedMessage.data.audio = new Int8Array(Buffer.from(parsedMessage.data.audio, 'base64'));
  }

  return parsedMessage;
};
