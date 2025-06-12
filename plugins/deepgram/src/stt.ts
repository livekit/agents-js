// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioBuffer,
  AudioByteStream,
  AudioEnergyFilter,
  Future,
  log,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type { STTLanguages, STTModels } from './models.js';

const API_BASE_URL_V1 = 'wss://api.deepgram.com/v1/listen';

export interface STTOptions {
  apiKey?: string;
  language?: STTLanguages | string;
  detectLanguage: boolean;
  interimResults: boolean;
  punctuate: boolean;
  model: STTModels;
  smartFormat: boolean;
  noDelay: boolean;
  endpointing: number;
  fillerWords: boolean;
  sampleRate: number;
  numChannels: number;
  keywords: [string, number][];
  keyterm: string[];
  profanityFilter: boolean;
  dictation: boolean;
  diarize: boolean;
  numerals: boolean;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.DEEPGRAM_API_KEY,
  language: 'en-US',
  detectLanguage: false,
  interimResults: true,
  punctuate: true,
  model: 'nova-2-general',
  smartFormat: true,
  noDelay: true,
  endpointing: 25,
  fillerWords: false,
  sampleRate: 16000,
  numChannels: 1,
  keywords: [],
  keyterm: [],
  profanityFilter: false,
  dictation: false,
  diarize: false,
  numerals: false,
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #logger = log();
  label = 'deepgram.STT';

  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    super({
      streaming: true,
      interimResults: opts.interimResults ?? defaultSTTOptions.interimResults,
    });
    if (opts.apiKey === undefined && defaultSTTOptions.apiKey === undefined) {
      throw new Error(
        'Deepgram API key is required, whether as an argument or as $DEEPGRAM_API_KEY',
      );
    }

    this.#opts = { ...defaultSTTOptions, ...opts };

    if (this.#opts.detectLanguage) {
      this.#opts.language = undefined;
    } else if (
      this.#opts.language &&
      !['en-US', 'en'].includes(this.#opts.language) &&
      [
        'nova-2-meeting',
        'nova-2-phonecall',
        'nova-2-finance',
        'nova-2-conversationalai',
        'nova-2-voicemail',
        'nova-2-video',
        'nova-2-medical',
        'nova-2-drivethru',
        'nova-2-automotive',
        'nova-3-general',
      ].includes(this.#opts.model)
    ) {
      this.#logger.warn(
        `${this.#opts.model} does not support language ${this.#opts.language}, falling back to nova-2-general`,
      );
      this.#opts.model = 'nova-2-general';
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on Deepgram STT');
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(): SpeechStream {
    return new SpeechStream(this, this.#opts);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #audioEnergyFilter: AudioEnergyFilter;
  #logger = log();
  #speaking = false;
  #resetWS = new Future();
  label = 'deepgram.SpeechStream';

  constructor(stt: STT, opts: STTOptions) {
    super(stt);
    this.#opts = opts;
    this.closed = false;
    this.#audioEnergyFilter = new AudioEnergyFilter();

    this.#run();
  }

  async #run(maxRetry = 32) {
    let retries = 0;
    let ws: WebSocket;
    while (!this.input.closed) {
      const streamURL = new URL(API_BASE_URL_V1);
      const params = {
        model: this.#opts.model,
        punctuate: this.#opts.punctuate,
        smart_format: this.#opts.smartFormat,
        dictation: this.#opts.dictation,
        diarize: this.#opts.diarize,
        numerals: this.#opts.numerals,
        no_delay: this.#opts.noDelay,
        interim_results: this.#opts.interimResults,
        encoding: 'linear16',
        vad_events: true,
        sample_rate: this.#opts.sampleRate,
        channels: this.#opts.numChannels,
        endpointing: this.#opts.endpointing || false,
        filler_words: this.#opts.fillerWords,
        keywords: this.#opts.keywords.map((x) => x.join(':')),
        keyterm: this.#opts.keyterm,
        profanity_filter: this.#opts.profanityFilter,
        language: this.#opts.language,
      };
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            streamURL.searchParams.append(k, encodeURIComponent(v));
          } else {
            v.forEach((x) => streamURL.searchParams.append(k, encodeURIComponent(x)));
          }
        }
      });

      ws = new WebSocket(streamURL, {
        headers: { Authorization: `Token ${this.#opts.apiKey}` },
      });

      try {
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', (error) => reject(error));
          ws.on('close', (code) => reject(`WebSocket returned ${code}`));
        });

        await this.#runWS(ws);
      } catch (e) {
        if (retries >= maxRetry) {
          throw new Error(`failed to connect to Deepgram after ${retries} attempts: ${e}`);
        }

        const delay = Math.min(retries * 5, 10);
        retries++;

        this.#logger.warn(
          `failed to connect to Deepgram, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }

    this.closed = true;
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    this.#resetWS.resolve();
  }

  async #runWS(ws: WebSocket) {
    this.#resetWS = new Future();
    let closing = false;

    const keepalive = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch {
        clearInterval(keepalive);
        return;
      }
    }, 5000);

    const sendTask = async () => {
      const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
      const stream = new AudioByteStream(
        this.#opts.sampleRate,
        this.#opts.numChannels,
        samples100Ms,
      );

      for await (const data of this.input) {
        let frames: AudioFrame[];
        if (data === SpeechStream.FLUSH_SENTINEL) {
          frames = stream.flush();
        } else if (
          data.sampleRate === this.#opts.sampleRate ||
          data.channels === this.#opts.numChannels
        ) {
          frames = stream.write(data.data.buffer);
        } else {
          throw new Error(`sample rate or channel count of frame does not match`);
        }

        for await (const frame of frames) {
          if (this.#audioEnergyFilter.pushFrame(frame)) {
            ws.send(frame.data.buffer);
          }
        }
      }

      closing = true;
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    };

    const wsMonitor = new Promise<void>((_, reject) =>
      ws.once('close', (code, reason) => {
        if (!closing) {
          this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
          reject();
        }
      }),
    );

    const listenTask = async () => {
      while (!this.closed && !closing) {
        try {
          await new Promise<RawData>((resolve) => {
            ws.once('message', (data) => resolve(data));
          }).then((msg) => {
            const json = JSON.parse(msg.toString());
            switch (json['type']) {
              case 'SpeechStarted': {
                // This is a normal case. Deepgram's SpeechStarted events
                // are not correlated with speech_final or utterance end.
                // It's possible that we receive two in a row without an endpoint
                // It's also possible we receive a transcript without a SpeechStarted event.
                if (this.#speaking) return;
                this.#speaking = true;
                this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
                break;
              }
              // see this page:
              // https://developers.deepgram.com/docs/understand-endpointing-interim-results#using-endpointing-speech_final
              // for more information about the different types of events
              case 'Results': {
                const isFinal = json['is_final'];
                const isEndpoint = json['speech_final'];

                const alternatives = liveTranscriptionToSpeechData(this.#opts.language!, json);

                // If, for some reason, we didn't get a SpeechStarted event but we got
                // a transcript with text, we should start speaking. It's rare but has
                // been observed.
                if (alternatives[0] && alternatives[0].text) {
                  if (!this.#speaking) {
                    this.#speaking = true;
                    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
                  }

                  if (isFinal) {
                    this.queue.put({
                      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                      alternatives: [alternatives[0], ...alternatives.slice(1)],
                    });
                  } else {
                    this.queue.put({
                      type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
                      alternatives: [alternatives[0], ...alternatives.slice(1)],
                    });
                  }
                }

                // if we receive an endpoint, only end the speech if
                // we either had a SpeechStarted event or we have a seen
                // a non-empty transcript (deepgram doesn't have a SpeechEnded event)
                if (isEndpoint && this.#speaking) {
                  this.#speaking = false;
                  this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
                }

                break;
              }
              case 'Metadata': {
                break;
              }
              default: {
                this.#logger.child({ msg: json }).warn('received unexpected message from Deepgram');
                break;
              }
            }
          });
        } catch (error) {
          this.#logger.child({ error }).warn('unrecoverable error, exiting');
          break;
        }
      }
    };

    await Promise.race([this.#resetWS.await, Promise.all([sendTask(), listenTask(), wsMonitor])]);
    closing = true;
    ws.close();
    clearInterval(keepalive);
  }
}

const liveTranscriptionToSpeechData = (
  language: STTLanguages | string,
  data: { [id: string]: any },
): stt.SpeechData[] => {
  const alts: any[] = data['channel']['alternatives'];

  return alts.map((alt) => ({
    language,
    startTime: alt['words'].length ? alt['words'][0]['start'] : 0,
    endTime: alt['words'].length ? alt['words'][alt['words'].length - 1]['end'] : 0,
    confidence: alt['confidence'],
    text: alt['transcript'],
  }));
};
