// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, AudioByteStream, log, tokenize, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { URL } from 'node:url';
import { type RawData, WebSocket } from 'ws';
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

  // TODO(nbsp): updateOptions

  synthesize(text: string): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): tts.SynthesizeStream {
    throw new Error();
    // return new SynthesizeStream(this, this.#opts);
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
    const requestId = randomUUID();
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
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
        });
        res.on('close', () => {
          this.queue.close();
        });
      },
    );

    req.write(JSON.stringify(json));
    req.end();
  }
}

// export class SynthesizeStream extends tts.SynthesizeStream {
//   #opts: TTSOptions;
//   #logger = log();
//   label = 'cartesia.SynthesizeStream';
//   readonly streamURL: URL;

//   constructor(tts: TTS, opts: TTSOptions) {
//     super(tts);
//     this.#opts = opts;
//     this.closed = false;

//     // add trailing slash to URL if needed
//     const baseURL = opts.baseURL + (opts.baseURL.endsWith('/') ? '' : '/');

//     this.streamURL = new URL(`text-to-speech/${opts.voice.id}/stream-input`, baseURL);
//     const params = {
//       model_id: opts.modelID,
//       output_format: opts.encoding,
//       optimize_streaming_latency: `${opts.streamingLatency}`,
//       enable_ssml_parsing: `${opts.enableSsmlParsing}`,
//     };
//     Object.entries(params).forEach(([k, v]) => this.streamURL.searchParams.append(k, v));
//     this.streamURL.protocol = this.streamURL.protocol.replace('http', 'ws');

//     this.#run();
//   }

//   async #run() {
//     const segments = new AsyncIterableQueue<tokenize.WordStream>();

//     const tokenizeInput = async () => {
//       let stream: tokenize.WordStream | null = null;
//       for await (const text of this.input) {
//         if (text === SynthesizeStream.FLUSH_SENTINEL) {
//           stream?.endInput();
//           stream = null;
//         } else {
//           if (!stream) {
//             stream = this.#opts.wordTokenizer.stream();
//             segments.put(stream);
//           }
//           stream.pushText(text);
//         }
//       }
//       segments.close();
//     };

//     const runStream = async () => {
//       for await (const stream of segments) {
//         await this.#runWS(stream);
//         this.queue.put(SynthesizeStream.END_OF_STREAM);
//       }
//     };

//     await Promise.all([tokenizeInput(), runStream()]);
//     this.close();
//   }

//   async #runWS(stream: tokenize.WordStream, maxRetry = 3) {
//     let retries = 0;
//     let ws: WebSocket;
//     while (true) {
//       ws = new WebSocket(this.streamURL, {
//         headers: { [AUTHORIZATION_HEADER]: this.#opts.apiKey },
//       });

//       try {
//         await new Promise((resolve, reject) => {
//           ws.on('open', resolve);
//           ws.on('error', (error) => reject(error));
//           ws.on('close', (code) => reject(`WebSocket returned ${code}`));
//         });
//         break;
//       } catch (e) {
//         if (retries >= maxRetry) {
//           throw new Error(`failed to connect to ElevenLabs after ${retries} attempts: ${e}`);
//         }

//         const delay = Math.min(retries * 5, 5);
//         retries++;

//         this.#logger.warn(
//           `failed to connect to ElevenLabs, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
//         );
//         await new Promise((resolve) => setTimeout(resolve, delay * 1000));
//       }
//     }

//     const requestId = randomUUID();
//     const segmentId = randomUUID();

//     ws.send(
//       JSON.stringify({
//         text: ' ',
//         voice_settings: this.#opts.voice.settings,
//         try_trigger_generation: true,
//         chunk_length_schedule: this.#opts.chunkLengthSchedule,
//       }),
//     );
//     let eosSent = false;

//     const sendTask = async () => {
//       let xmlContent: string[] = [];
//       for await (const data of stream) {
//         let text = data.token;

//         if ((this.#opts.enableSsmlParsing && text.startsWith('<phoneme')) || xmlContent.length) {
//           xmlContent.push(text);
//           if (text.indexOf('</phoneme>') !== -1) {
//             text = xmlContent.join(' ');
//             xmlContent = [];
//           } else {
//             continue;
//           }
//         }

//         ws.send(JSON.stringify({ text: text + ' ', try_trigger_generation: false }));
//       }

//       if (xmlContent.length) {
//         this.#logger.warn('ElevenLabs stream ended with incomplete XML content');
//       }

//       ws.send(JSON.stringify({ text: '' }));
//       eosSent = true;
//     };

//     let lastFrame: AudioFrame | undefined;
//     const sendLastFrame = (segmentId: string, final: boolean) => {
//       if (lastFrame) {
//         this.queue.put({ requestId, segmentId, frame: lastFrame, final });
//         lastFrame = undefined;
//       }
//     };

//     const listenTask = async () => {
//       while (!this.closed) {
//         try {
//           await new Promise<RawData>((resolve, reject) => {
//             ws.removeAllListeners();
//             ws.on('message', (data) => resolve(data));
//             ws.on('close', (code, reason) => {
//               if (!eosSent) {
//                 this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
//               }
//               reject();
//             });
//           }).then((msg) => {
//             const json = JSON.parse(msg.toString());
//             if ('audio' in json) {
//               const data = new Int16Array(Buffer.from(json.audio, 'base64').buffer);
//               const frame = new AudioFrame(
//                 data,
//                 sampleRateFromFormat(this.#opts.encoding),
//                 1,
//                 data.length,
//               );
//               sendLastFrame(segmentId, false);
//               lastFrame = frame;
//             } else if ('isFinal' in json) {
//               sendLastFrame(segmentId, true);
//             }
//           });
//         } catch {
//           break;
//         }
//       }
//     };

//     await Promise.all([sendTask(), listenTask()]);
//   }
// }

const sampleRateFromFormat = (encoding: TTSEncoding): number => {
  return Number(encoding.split('_')[1]);
};

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
