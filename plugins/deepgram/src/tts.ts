// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, log, tokenize, tts } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

const AUTHORIZATION_HEADER = 'Authorization';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

// @see https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/tts.py
// @see https://developers.deepgram.com/docs/tts-websocket

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  apiKey?: string;
  baseUrl?: string;
}

const defaultTTSOptions: TTSOptions = {
  model: 'aura-asteria-en',
  encoding: 'linear16',
  sampleRate: 24000,
  apiKey: process.env.DEEPGRAM_API_KEY,
  baseUrl: 'https://api.deepgram.com/v1/speak',
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'deepgram.TTS';

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
        'Deepgram API key is required, whether as an argument or as $DEEPGRAM_API_KEY',
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
  label = 'deepgram.ChunkedStream';
  #opts: TTSOptions;
  #logger = log();
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
    const json = { text: this.#text };
    const url = new URL(this.#opts.baseUrl!);
    url.searchParams.append('sample_rate', this.#opts.sampleRate.toString());
    url.searchParams.append('model', this.#opts.model);
    url.searchParams.append('encoding', this.#opts.encoding);

    const req = request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: `Token ${this.#opts.apiKey!}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          throw new Error(`Failed to synthesize audio: ${res.statusCode}`);
        }

        res.on('data', (chunk) => {
          for (const frame of bstream.write(chunk)) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
        });

        res.on('error', (err) => {
          this.#logger.error(`Error: ${err}`);
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
  #tokenizer = new tokenize.basic.SentenceTokenizer(undefined, BUFFERED_WORDS_COUNT).stream();
  label = 'deepgram.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
    this.#run();
  }

  async #run() {
    const requestId = randomUUID();
    const segmentId = randomUUID();
    let closing = false;

    const sentenceStreamTask = async (ws: WebSocket) => {
      for await (const event of this.#tokenizer) {
        ws.send(
          JSON.stringify({
            type: 'Speak',
            text: event.token,
          }),
        );
      }

      ws.send(
        JSON.stringify({
          type: 'Flush',
        }),
      );

      closing = true;
      ws.send(
        JSON.stringify({
          type: 'Close',
        }),
      );
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

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const message = JSON.parse(data.toString());

          if (message.type === 'Flushed') {
            for (const frame of bstream.flush()) {
              this.queue.put({ requestId, segmentId, frame, final: false });
            }
            this.queue.put(SynthesizeStream.END_OF_STREAM);
          }

          return;
        }

        for (const frame of bstream.write(new Int8Array(data as Buffer))) {
          this.queue.put({ requestId, segmentId, frame, final: false });
        }
      });
      ws.on('error', (error) => {
        this.#logger.error(`WebSocket error: ${error}`);
      });
      ws.on('close', (code, reason) => {
        if (!closing) {
          this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
        }
        ws.removeAllListeners();
      });
    };

    const url = new URL(this.#opts.baseUrl!);
    url.searchParams.append('sample_rate', this.#opts.sampleRate.toString());
    url.searchParams.append('model', this.#opts.model);
    url.searchParams.append('encoding', this.#opts.encoding);
    url.protocol = 'wss:';

    const ws = new WebSocket(url, {
      headers: {
        [AUTHORIZATION_HEADER]: `Token ${this.#opts.apiKey!}`,
      },
    });

    try {
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        ws.on('close', (code) => reject(`WebSocket returned ${code}`));
      });

      await Promise.all([inputTask(), sentenceStreamTask(ws), recvTask(ws)]);
    } catch (e) {
      throw new Error(`failed to connect to Deepgram: ${e}`);
    }
  }
}
