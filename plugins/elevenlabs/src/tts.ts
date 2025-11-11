// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AsyncIterableQueue,
  AudioByteStream,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { URL } from 'node:url';
import { type RawData, WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

const DEFAULT_INACTIVITY_TIMEOUT = 300;

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
  id: 'bIHbv24MWmeRgasZH58o',
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
  modelID: TTSModels | string;
  languageCode?: string;
  baseURL: string;
  encoding: TTSEncoding;
  streamingLatency?: number;
  wordTokenizer: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  chunkLengthSchedule?: number[];
  enableSsmlParsing: boolean;
  inactivityTimeout: number;
  syncAlignment: boolean;
  autoMode?: boolean;
}

const defaultTTSOptionsBase = {
  apiKey: process.env.ELEVEN_API_KEY,
  voice: DEFAULT_VOICE,
  modelID: 'eleven_turbo_v2_5',
  baseURL: API_BASE_URL_V1,
  encoding: 'pcm_22050' as TTSEncoding,
  enableSsmlParsing: false,
  inactivityTimeout: DEFAULT_INACTIVITY_TIMEOUT,
  syncAlignment: true,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'elevenlabs.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(sampleRateFromFormat(opts.encoding || defaultTTSOptionsBase.encoding), 1, {
      streaming: true,
    });

    // Set autoMode to true by default if not provided is Python behavior,
    // but to make it non-breaking, we keep false as default in typescript
    const autoMode = opts.autoMode !== undefined ? opts.autoMode : false;

    // Set default tokenizer based on autoMode if not provided
    let wordTokenizer = opts.wordTokenizer;
    if (!wordTokenizer) {
      wordTokenizer = autoMode
        ? new tokenize.basic.SentenceTokenizer()
        : new tokenize.basic.WordTokenizer(false);
    } else if (autoMode && !(wordTokenizer instanceof tokenize.SentenceTokenizer)) {
      // Warn if autoMode is enabled but a WordTokenizer was provided
      log().warn(
        'autoMode is enabled, it expects full sentences or phrases. ' +
          'Please provide a SentenceTokenizer instead of a WordTokenizer.',
      );
    }

    this.#opts = {
      ...defaultTTSOptionsBase,
      ...opts,
      autoMode,
      wordTokenizer,
    };

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'ElevenLabs API key is required, whether as an argument or as $ELEVEN_API_KEY',
      );
    }
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

  synthesize(): tts.ChunkedStream {
    throw new Error('Chunked responses are not supported on ElevenLabs TTS');
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  label = 'elevenlabs.SynthesizeStream';
  readonly streamURL: URL;

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
    this.closed = false;

    // add trailing slash to URL if needed
    const baseURL = opts.baseURL + (opts.baseURL.endsWith('/') ? '' : '/');

    this.streamURL = new URL(`text-to-speech/${opts.voice.id}/stream-input`, baseURL);
    const params = {
      model_id: opts.modelID,
      output_format: opts.encoding,
      enable_ssml_parsing: `${opts.enableSsmlParsing}`,
      sync_alignment: `${opts.syncAlignment}`,
      ...(opts.autoMode !== undefined && { auto_mode: `${opts.autoMode}` }),
      ...(opts.languageCode && { language_code: opts.languageCode }),
      ...(opts.inactivityTimeout && { inactivity_timeout: `${opts.inactivityTimeout}` }),
      ...(opts.streamingLatency && { optimize_streaming_latency: `${opts.streamingLatency}` }),
    };
    Object.entries(params).forEach(([k, v]) => this.streamURL.searchParams.append(k, v));
    this.streamURL.protocol = this.streamURL.protocol.replace('http', 'ws');
  }

  protected async run() {
    const segments = new AsyncIterableQueue<tokenize.WordStream | tokenize.SentenceStream>();

    const tokenizeInput = async () => {
      let stream: tokenize.WordStream | tokenize.SentenceStream | null = null;
      for await (const text of this.input) {
        if (this.abortController.signal.aborted) {
          break;
        }
        if (text === SynthesizeStream.FLUSH_SENTINEL) {
          stream?.endInput();
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
        if (this.abortController.signal.aborted) {
          break;
        }
        await this.#runWS(stream);
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    };

    await Promise.all([tokenizeInput(), runStream()]);
  }

  async #runWS(stream: tokenize.WordStream | tokenize.SentenceStream, maxRetry = 3) {
    let retries = 0;
    let ws: WebSocket;
    while (true) {
      ws = new WebSocket(this.streamURL, {
        headers: { [AUTHORIZATION_HEADER]: this.#opts.apiKey },
      });

      ws.on('error', (error) => {
        this.abortController.abort();
        this.#logger.error({ error }, 'Error connecting to ElevenLabs');
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

    const requestId = shortuuid();
    const segmentId = shortuuid();

    // simple helper to make sure what we send to ws.send
    const wsSend = (data: {
      // (SynthesizeContent from python)
      text: string;
      // setting flush somehow never finishes the current speech generation
      // https://github.com/livekit/agents-js/pull/820#issuecomment-3517138706
      // flush?: boolean;
      // initialization
      voice_settings?: VoiceSettings;
      generation_config?: {
        chunk_length_schedule: number[];
      };
    }) => {
      ws.send(JSON.stringify(data));
    };

    wsSend({
      text: ' ',
      voice_settings: this.#opts.voice.settings,
      ...(this.#opts.chunkLengthSchedule && {
        generation_config: {
          chunk_length_schedule: this.#opts.chunkLengthSchedule,
        },
      }),
    });
    let eosSent = false;

    const sendTask = async () => {
      // Determine if we should flush on each chunk (sentence)
      /*const flushOnChunk =
        this.#opts.wordTokenizer instanceof tokenize.SentenceTokenizer &&
        this.#opts.autoMode !== undefined &&
        this.#opts.autoMode;*/

      let xmlContent: string[] = [];
      for await (const data of stream) {
        if (this.abortController.signal.aborted) {
          break;
        }
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

        wsSend({
          text: text + ' ', // must always end with a space
          // ...(flushOnChunk && { flush: true }),
        });
      }

      if (xmlContent.length) {
        this.#logger.warn('ElevenLabs stream ended with incomplete XML content');
      }

      // no more tokens, mark eos with flush
      // setting flush somehow never finishes the current speech generation
      // wsSend({ text: '', flush: true });
      wsSend({ text: '' });
      eosSent = true;
    };

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const listenTask = async () => {
      let finalReceived = false;
      const bstream = new AudioByteStream(sampleRateFromFormat(this.#opts.encoding), 1);
      while (!this.closed && !this.abortController.signal.aborted) {
        try {
          await new Promise<RawData>((resolve, reject) => {
            ws.removeAllListeners();
            ws.on('message', (data) => resolve(data));
            ws.on('close', (code, reason) => {
              if (!eosSent) {
                this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
              }
              if (!finalReceived) {
                reject(new Error('WebSocket closed'));
              }
            });
          }).then((msg) => {
            const json = JSON.parse(msg.toString());
            // remove the "audio" field from the json object when printing
            if ('audio' in json && json.audio !== null) {
              const data = new Int8Array(Buffer.from(json.audio, 'base64'));
              for (const frame of bstream.write(data)) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
            } else if (json.isFinal) {
              finalReceived = true;
              for (const frame of bstream.flush()) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
              sendLastFrame(segmentId, true);
              this.queue.put(SynthesizeStream.END_OF_STREAM);

              if (segmentId === requestId || this.abortController.signal.aborted) {
                ws.close();
                return;
              }
            }
          });
        } catch (err) {
          // skip log error for normal websocket close
          if (err instanceof Error && !err.message.includes('WebSocket closed')) {
            this.#logger.error({ err }, 'Error in listenTask from ElevenLabs WebSocket');
          }
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
