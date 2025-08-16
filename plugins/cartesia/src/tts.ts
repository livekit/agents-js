// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, log, tokenize, tts } from '@livekit/agents';
import { shortuuid } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import {
  TTSDefaultVoiceId,
  type TTSEncoding,
  type TTSModels,
  type TTSVoiceEmotion,
  type TTSVoiceSpeed,
} from './models.js';

const AUTHORIZATION_HEADER = 'X-API-Key';
const VERSION_HEADER = 'Cartesia-Version';
const VERSION = '2024-06-10';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  voice: string | number[];
  speed?: TTSVoiceSpeed | number;
  emotion?: (TTSVoiceEmotion | string)[];
  apiKey?: string;
  language: string;
}

const defaultTTSOptions: TTSOptions = {
  model: 'sonic-english',
  encoding: 'pcm_s16le',
  sampleRate: 24000,
  voice: TTSDefaultVoiceId,
  apiKey: process.env.CARTESIA_API_KEY,
  language: 'en',
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'cartesia.TTS';

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
        'Cartesia API key is required, whether as an argument or as $CARTESIA_API_KEY',
      );
    }
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(text: string): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'cartesia.ChunkedStream';
  #opts: TTSOptions;
  #text: string;

  // set Promise<T> to any because OpenAI returns an annoying Response type
  constructor(tts: TTS, text: string, opts: TTSOptions) {
    super(text, tts);
    this.#text = text;
    this.#opts = opts;
    this.#run();
  }

  async #run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const json = toCartesiaOptions(this.#opts);
    json.transcript = this.#text;

    const req = request(
      {
        hostname: 'api.cartesia.ai',
        port: 443,
        path: '/tts/bytes',
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
          [VERSION_HEADER]: VERSION,
        },
      },
      (res) => {
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
  #tokenizer = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: BUFFERED_WORDS_COUNT,
  }).stream();
  label = 'cartesia.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  protected async run() {
    const requestId = shortuuid();
    let closing = false;

    const sentenceStreamTask = async (ws: WebSocket) => {
      const packet = toCartesiaOptions(this.#opts);
      for await (const event of this.#tokenizer) {
        ws.send(
          JSON.stringify({
            ...packet,
            context_id: requestId,
            transcript: event.token + ' ',
            continue: true,
          }),
        );
      }

      ws.send(
        JSON.stringify({
          ...packet,
          context_id: requestId,
          transcript: ' ',
          continue: false,
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

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      ws.on('message', (data) => {
        const json = JSON.parse(data.toString());
        const segmentId = json.context_id;
        if ('data' in json) {
          const data = new Int8Array(Buffer.from(json.data, 'base64'));
          for (const frame of bstream.write(data)) {
            sendLastFrame(segmentId, false);
            lastFrame = frame;
          }
        } else if ('done' in json) {
          for (const frame of bstream.flush()) {
            sendLastFrame(segmentId, false);
            lastFrame = frame;
          }
          sendLastFrame(segmentId, true);
          this.queue.put(SynthesizeStream.END_OF_STREAM);

          if (segmentId === requestId) {
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

    const url = `wss://api.cartesia.ai/tts/websocket?api_key=${this.#opts.apiKey}&cartesia_version=${VERSION}`;
    const ws = new WebSocket(url);

    try {
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', (error) => reject(error));
        ws.on('close', (code) => reject(`WebSocket returned ${code}`));
      });

      await Promise.all([inputTask(), sentenceStreamTask(ws), recvTask(ws)]);
    } catch (e) {
      throw new Error(`failed to connect to Cartesia: ${e}`);
    }
  }
}

const toCartesiaOptions = (opts: TTSOptions): { [id: string]: unknown } => {
  const voice: { [id: string]: unknown } = {};
  if (typeof opts.voice === 'string') {
    voice.mode = 'id';
    voice.id = opts.voice;
  } else {
    voice.mode = 'embedding';
    voice.embedding = opts.voice;
  }

  const voiceControls: { [id: string]: unknown } = {};
  if (opts.speed) {
    voiceControls.speed = opts.speed;
  }
  if (opts.emotion) {
    voiceControls.emotion = opts.emotion;
  }

  if (Object.keys({}).length) {
    voice.__experimental_controls = voiceControls;
  }

  return {
    model_id: opts.model,
    voice,
    output_format: {
      container: 'raw',
      encoding: opts.encoding,
      sample_rate: opts.sampleRate,
    },
    language: opts.language,
  };
};
