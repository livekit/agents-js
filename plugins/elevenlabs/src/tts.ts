// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, log, tokenize, tts } from '@livekit/agents';
import type { WordStream } from '@livekit/agents/dist/tokenize/tokenizer.js';
import { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { type RawData, WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

type Voice = {
  id: string;
  name: string;
  category: string;
  settings?: VoiceSettings;
};

type VoiceSettings = {
  stability: number; // 0..1
  similarity_boost: number; // 0..1
  style?: number; // 0..1
  use_speaker_boost: boolean;
};

const DEFAULT_VOICE: Voice = {
  id: 'EXAVITQu4vr4xnSDxMaL',
  name: 'Bella',
  category: 'premade',
  settings: {
    stability: 0.71,
    similarity_boost: 0.5,
    style: 0.0,
    use_speaker_boost: true,
  },
};

const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1/';
const AUTHORIZATION_HEADER = 'xi-api-key';

export interface TTSOptions {
  apiKey?: string;
  voice: Voice;
  modelID: TTSModels;
  baseURL: string;
  encoding: TTSEncoding;
  streamingLatency: number;
  wordTokenizer: tokenize.WordTokenizer;
  chunkLengthSchedule: number[];
  enableSsmlParsing: boolean;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.ELEVEN_API_KEY,
  voice: DEFAULT_VOICE,
  modelID: 'eleven_turbo_v2_5',
  baseURL: API_BASE_URL_V1,
  encoding: 'pcm_22050',
  streamingLatency: 3,
  wordTokenizer: new tokenize.basic.WordTokenizer(false),
  chunkLengthSchedule: [],
  enableSsmlParsing: false,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;

  constructor(opts: Partial<TTSOptions> = defaultTTSOptions) {
    super(sampleRateFromFormat(opts.encoding || defaultTTSOptions.encoding), 1, {
      streaming: true,
    });
    if (opts.apiKey === undefined) {
      throw new Error(
        'ElevenLabs API key is required, whether as an argument or as $ELEVEN_API_KEY',
      );
    }

    this.#opts = { ...defaultTTSOptions, ...opts };
  }

  async listVoices(): Promise<Voice[]> {
    return fetch(this.#opts.baseURL + '/voices', {
      headers: {
        [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
      },
    })
      .then((data) => data.json())
      .then((data) => {
        const voices: Voice[] = [];
        for (const voice of (
          data as { voices: { voice_id: string; name: string; category: string }[] }
        ).voices) {
          voices.push({
            id: voice.voice_id,
            name: voice.name,
            category: voice.category,
            settings: undefined,
          });
        }
        return voices;
      });
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this.#opts);
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  readonly streamURL: URL;

  constructor(opts: TTSOptions) {
    super();
    this.#opts = opts;
    this.closed = false;

    // add trailing slash to URL if needed
    const baseURL = opts.baseURL + (opts.baseURL.endsWith('/') ? '' : '/');

    this.streamURL = new URL(`text-to-speech/${opts.voice.id}/stream-input`, baseURL);
    const params = {
      model_id: opts.modelID,
      output_format: opts.encoding,
      optimize_streaming_latency: `${opts.streamingLatency}`,
      enable_ssml_parsing: `${opts.enableSsmlParsing}`,
    };
    Object.entries(params).forEach(([k, v]) => this.streamURL.searchParams.append(k, v));
    this.streamURL.protocol = this.streamURL.protocol.replace('http', 'ws');

    this.#run();
  }

  async #run() {
    const segments = new AsyncIterableQueue<WordStream>();

    const tokenizeInput = async () => {
      let stream: tokenize.WordStream | null = null;
      for await (const text of this.input) {
        if (text === SynthesizeStream.FLUSH_SENTINEL) {
          if (stream) {
            stream.close();
          }
          stream = null;
        } else {
          if (!stream) {
            stream = this.#opts.wordTokenizer.stream();
            segments.put(stream);
          }
          stream.pushText(text);
        }
      }
      segments.close();
    };

    const runStream = async () => {
      for await (const stream of segments) {
        await this.#runWS(stream);
      }
    };

    await Promise.all([tokenizeInput(), runStream()]);
    this.close();
  }

  async #runWS(stream: tokenize.WordStream, maxRetry = 3) {
    let retries = 0;
    let ws: WebSocket;
    while (true) {
      ws = new WebSocket(this.streamURL, {
        headers: { [AUTHORIZATION_HEADER]: this.#opts.apiKey },
      });

      try {
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', (error) => reject(error));
          ws.on('close', (code) => reject(`WebSocket returned ${code}`));
        });
        break;
      } catch (e) {
        if (retries >= maxRetry) {
          throw new Error(`failed to connect to ElevenLabs after ${retries} attempts: ${e}`);
        }

        const delay = Math.min(retries * 5, 5);
        retries++;

        this.#logger.warn(
          `failed to connect to ElevenLabs, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }

    const requestId = randomUUID();
    const segmentId = randomUUID();

    ws.send(
      JSON.stringify({
        text: ' ',
        voice_settings: this.#opts.voice.settings,
        try_trigger_generation: true,
        chunk_length_schedule: this.#opts.chunkLengthSchedule,
      }),
    );
    let eosSent = false;

    const sendTask = async () => {
      let xmlContent: string[] = [];
      for await (const data of stream) {
        let text = data.token;

        if ((this.#opts.enableSsmlParsing && text.startsWith('<phoneme')) || xmlContent.length) {
          xmlContent.push(text);
          if (text.indexOf('</phoneme>') !== -1) {
            text = xmlContent.join(' ');
            xmlContent = [];
          } else {
            continue;
          }
        }

        ws.send(JSON.stringify({ text: text + ' ', try_trigger_generation: false }));
      }

      if (xmlContent.length) {
        this.#logger.warn('ElevenLabs stream ended with incomplete XML content');
      }

      ws.send(JSON.stringify({ text: '' }));
      eosSent = true;
    };

    const listenTask = async () => {
      while (!this.closed) {
        try {
          await new Promise<RawData>((resolve, reject) => {
            ws.on('message', (data) => resolve(data));
            ws.on('close', (code, reason) => {
              if (!eosSent) {
                this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
              }
              this.closed = true;
              reject();
            });
          }).then((msg) => {
            const json = JSON.parse(msg.toString());
            if ('audio' in json) {
              const data = new Int16Array(Buffer.from(json.audio, 'base64').buffer);
              const frame = new AudioFrame(
                data,
                sampleRateFromFormat(this.#opts.encoding),
                1,
                data.length,
              );
              this.queue.put({ requestId, segmentId, frame });
            }
          });
        } catch {
          break;
        }
      }
    };

    await Promise.all([sendTask(), listenTask()]);
  }
}

const sampleRateFromFormat = (encoding: TTSEncoding): number => {
  return Number(encoding.split('_')[1]);
};
