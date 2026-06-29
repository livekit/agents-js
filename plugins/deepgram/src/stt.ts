// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  AudioEnergyFilter,
  Future,
  Task,
  createTimedString,
  getBaseLanguage,
  log,
  mergeFrames,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { PeriodicCollector } from './_utils.js';
import type { STTLanguages, STTModels } from './models.js';

export interface STTOptions {
  apiKey?: string;
  language?: STTLanguages | string;
  detectLanguage: boolean;
  interimResults: boolean;
  punctuate: boolean;
  model: STTModels | string;
  smartFormat: boolean;
  noDelay: boolean;
  endpointing: number;
  fillerWords: boolean;
  sampleRate: number;
  numChannels: number;
  keywords: [string, number][];
  keyterm: string[];
  profanityFilter: boolean;
  /**
   * Redact sensitive information from the transcription. Accepts a single value or list of
   * values. Supported values: "pci", "numbers", "ssn", "true" (redact all).
   * See https://developers.deepgram.com/docs/redaction for details.
   */
  redact: string | string[];
  utteranceEndMs?: number | null;
  replace?: Record<string, string> | null;
  search?: string[] | null;
  dictation: boolean;
  diarize: boolean;
  numerals: boolean;
  mipOptOut: boolean;
  baseUrl: string;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.DEEPGRAM_API_KEY,
  language: 'en-US',
  detectLanguage: false,
  interimResults: true,
  punctuate: true,
  model: 'nova-3',
  smartFormat: true,
  noDelay: true,
  endpointing: 25,
  fillerWords: false,
  sampleRate: 16000,
  numChannels: 1,
  keywords: [],
  keyterm: [],
  profanityFilter: false,
  redact: [],
  utteranceEndMs: null,
  replace: null,
  search: null,
  dictation: false,
  diarize: false,
  numerals: false,
  mipOptOut: false,
  baseUrl: 'wss://api.deepgram.com',
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #logger = log();
  label = 'deepgram.STT';
  private abortController = new AbortController();

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Deepgram';
  }

  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    super({
      streaming: true,
      interimResults: opts.interimResults ?? defaultSTTOptions.interimResults,
      alignedTranscript: 'word',
    });
    if (opts.apiKey === undefined && defaultSTTOptions.apiKey === undefined) {
      throw new Error(
        'Deepgram API key is required, whether as an argument or as $DEEPGRAM_API_KEY',
      );
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      language: opts.language ? normalizeLanguage(opts.language) : defaultSTTOptions.language,
    };

    if (this.#opts.detectLanguage) {
      this.#opts.language = undefined;
    } else {
      this.#opts.model = this.#validateModel(this.#opts.model, this.#opts.language);
    }
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const listenURL = new URL(`${this.#opts.baseUrl.replace(/^ws/, 'http')}/v1/listen`);
    const params = {
      model: this.#opts.model,
      punctuate: this.#opts.punctuate,
      detect_language: this.#opts.detectLanguage,
      smart_format: this.#opts.smartFormat,
      keywords: this.#opts.keywords.map((x) => x.join(':')),
      profanity_filter: this.#opts.profanityFilter,
      numerals: this.#opts.numerals,
      mip_opt_out: this.#opts.mipOptOut,
      language: this.#opts.language,
      ...(this.#opts.keyterm.length > 0 ? { keyterm: this.#opts.keyterm } : {}),
      ...(this.#opts.redact.length > 0 ? { redact: this.#opts.redact } : {}),
    };

    appendSearchParams(listenURL, params);

    if (this.#opts.diarize) {
      this.#logger.warn('speaker diarization is not supported in non-streaming mode, ignoring');
    }

    const resp = await fetch(listenURL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.#opts.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'audio/wav',
      },
      body: new Blob([new Uint8Array(createWav(frame))], { type: 'audio/wav' }),
      signal: abortSignal ?? null,
    });

    if (!resp.ok) {
      throw new Error(
        `Deepgram STT REST request failed with status ${resp.status}: ${await resp.text()}`,
      );
    }

    return prerecordedTranscriptionToSpeechEvent(this.#opts.language, await resp.json());
  }

  updateOptions(opts: Partial<STTOptions>) {
    const language =
      opts.language !== undefined ? normalizeLanguage(opts.language) : this.#opts.language;
    const model =
      opts.model !== undefined || opts.language !== undefined
        ? this.#validateModel(opts.model ?? this.#opts.model, language)
        : this.#opts.model;

    this.#opts = {
      ...this.#opts,
      ...opts,
      language,
      model,
    };
  }

  #validateModel(model: STTModels | string, language?: string) {
    if (
      language &&
      getBaseLanguage(language) !== 'en' &&
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
      ].includes(model)
    ) {
      this.#logger.warn(
        `${model} does not support language ${language}, falling back to nova-2-general`,
      );
      return 'nova-2-general';
    }

    return model;
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    // Deepgram only supports language detection for prerecorded audio, not streaming.
    if (this.#opts.detectLanguage || this.#opts.language === undefined) {
      throw new Error(
        'language detection is not supported in streaming mode, please disable it and specify a language',
      );
    }
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }

  async close() {
    this.abortController.abort();
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #audioEnergyFilter: AudioEnergyFilter;
  #logger = log();
  #speaking = false;
  #resetWS = new Future();
  #requestId = '';
  #audioDurationCollector: PeriodicCollector<number>;
  label = 'deepgram.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.closed = false;
    this.#audioEnergyFilter = new AudioEnergyFilter();
    this.#audioDurationCollector = new PeriodicCollector(
      (duration) => this.onAudioDurationReport(duration),
      { duration: 5.0 },
    );
  }

  protected async run() {
    const maxRetry = 32;
    let retries = 0;
    let ws: WebSocket;

    while (!this.input.closed && !this.closed) {
      const streamURL = new URL(`${this.#opts.baseUrl}/v1/listen`);
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
        utterance_end_ms: this.#opts.utteranceEndMs,
        replace: this.#opts.replace,
        search: this.#opts.search,
        language: this.#opts.language,
        mip_opt_out: this.#opts.mipOptOut,
        ...(this.#opts.redact.length > 0 ? { redact: this.#opts.redact } : {}),
      };
      appendSearchParams(streamURL, params);

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
        if (!this.closed && !this.input.closed) {
          if (retries >= maxRetry) {
            throw new Error(`failed to connect to Deepgram after ${retries} attempts: ${e}`);
          }

          const delay = Math.min(retries * 5, 10);
          retries++;

          this.#logger.warn(
            `failed to connect to Deepgram, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        } else {
          this.#logger.warn(
            `Deepgram disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
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

    // gets cancelled also when sendTask is complete
    const wsMonitor = Task.from(async (controller) => {
      const closed = new Promise<void>(async (_, reject) => {
        ws.once('close', (code, reason) => {
          if (!closing) {
            this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
            reject(new Error('WebSocket closed'));
          }
        });
      });

      await Promise.race([closed, waitForAbort(controller.signal)]);
    });

    const sendTask = async () => {
      const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
      const stream = new AudioByteStream(
        this.#opts.sampleRate,
        this.#opts.numChannels,
        samples100Ms,
      );

      // waitForAbort internally sets up an abort listener on the abort signal
      // we need to put it outside loop to avoid constant re-registration of the listener
      const abortPromise = waitForAbort(this.abortSignal);

      try {
        while (!this.closed) {
          const result = await Promise.race([this.input.next(), abortPromise]);

          if (result === undefined) return; // aborted
          if (result.done) {
            break;
          }

          const data = result.value;

          let frames: AudioFrame[];
          if (data === SpeechStream.FLUSH_SENTINEL) {
            frames = stream.flush();
            this.#audioDurationCollector.flush();
          } else if (
            data.sampleRate === this.#opts.sampleRate &&
            data.channels === this.#opts.numChannels
          ) {
            frames = stream.write(data.data.buffer as ArrayBuffer);
          } else {
            throw new Error(`sample rate or channel count of frame does not match`);
          }

          for await (const frame of frames) {
            if (this.#audioEnergyFilter.pushFrame(frame)) {
              const frameDuration = frame.samplesPerChannel / frame.sampleRate;
              this.#audioDurationCollector.push(frameDuration);
              ws.send(frame.data.buffer);
            }
          }
        }
      } finally {
        closing = true;
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        wsMonitor.cancel();
      }
    };

    const listenTask = Task.from(async (controller) => {
      const putMessage = (message: stt.SpeechEvent) => {
        if (!this.queue.closed) {
          try {
            this.queue.put(message);
          } catch (e) {
            // ignore
          }
        }
      };

      const listenMessage = new Promise<void>((resolve, reject) => {
        ws.on('message', (msg) => {
          try {
            const json = JSON.parse(msg.toString());
            switch (json['type']) {
              case 'SpeechStarted': {
                // This is a normal case. Deepgram's SpeechStarted events
                // are not correlated with speech_final or utterance end.
                // It's possible that we receive two in a row without an endpoint
                // It's also possible we receive a transcript without a SpeechStarted event.
                if (this.#speaking) return;
                this.#speaking = true;
                putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                break;
              }
              // see this page:
              // https://developers.deepgram.com/docs/understand-endpointing-interim-results#using-endpointing-speech_final
              // for more information about the different types of events
              case 'Results': {
                const metadata = json['metadata'];
                const requestId = metadata['request_id'];
                const isFinal = json['is_final'];
                const isEndpoint = json['speech_final'];
                this.#requestId = requestId;

                const alternatives = liveTranscriptionToSpeechData(
                  this.#opts.language!,
                  json,
                  this.startTimeOffset,
                );

                // If, for some reason, we didn't get a SpeechStarted event but we got
                // a transcript with text, we should start speaking. It's rare but has
                // been observed.
                if (alternatives[0] && alternatives[0].text) {
                  if (!this.#speaking) {
                    this.#speaking = true;
                    putMessage({
                      type: stt.SpeechEventType.START_OF_SPEECH,
                    });
                  }

                  if (isFinal) {
                    putMessage({
                      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                      alternatives: [alternatives[0], ...alternatives.slice(1)],
                    });
                  } else {
                    putMessage({
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
                  putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
                }

                break;
              }
              case 'Metadata': {
                break;
              }
              case 'UtteranceEnd': {
                if (this.#speaking) {
                  this.#speaking = false;
                  putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
                }
                break;
              }
              default: {
                this.#logger.child({ msg: json }).warn('received unexpected message from Deepgram');
                break;
              }
            }

            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`STT: Error processing message: ${msg}`);
            reject(err);
          }
        });
      });

      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    }, this.abortController);

    await Promise.race([
      this.#resetWS.await,
      Promise.all([sendTask(), listenTask.result, wsMonitor]),
    ]);
    closing = true;
    ws.close();
    clearInterval(keepalive);
  }

  private onAudioDurationReport(duration: number) {
    const usageEvent: stt.SpeechEvent = {
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: {
        audioDuration: duration,
      },
    };
    this.queue.put(usageEvent);
  }
}

function appendSearchParams(url: URL, params: Record<string, unknown>) {
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;

    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
    } else if (typeof value === 'object') {
      Object.entries(value).forEach(([term, replacement]) => {
        url.searchParams.append(key, `${term}:${replacement}`);
      });
    } else {
      url.searchParams.append(key, String(value));
    }
  });
}

function createWav(frame: AudioFrame): Buffer {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frame.data.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(frame.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);

  const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  return Buffer.concat([header, pcm]);
}

const liveTranscriptionToSpeechData = (
  language: STTLanguages | string,
  data: { [id: string]: any },
  startTimeOffset: number = 0,
): stt.SpeechData[] => {
  const alts: any[] = data['channel']['alternatives'];

  return alts.map((alt) => {
    const wordsData: any[] = alt['words'] ?? [];
    const detectedLanguage =
      language === 'multi' ? alt['languages']?.[0] ?? language : alt['language'] ?? language;

    return {
      language: normalizeLanguage(detectedLanguage),
      startTime: wordsData.length ? wordsData[0]['start'] + startTimeOffset : startTimeOffset,
      endTime: wordsData.length
        ? wordsData[wordsData.length - 1]['end'] + startTimeOffset
        : startTimeOffset,
      confidence: alt['confidence'],
      text: alt['transcript'],
      words: wordsData.map((word) =>
        createTimedString({
          text: word['word'] ?? '',
          startTime: (word['start'] ?? 0) + startTimeOffset,
          endTime: (word['end'] ?? 0) + startTimeOffset,
          confidence: word['confidence'] ?? 0.0,
          startTimeOffset,
        }),
      ),
    };
  });
};

function prerecordedTranscriptionToSpeechEvent(
  language: STTLanguages | string | undefined,
  data: { [id: string]: any },
): stt.SpeechEvent {
  const channel = data['results']['channels'][0];
  const detectedLanguage = channel['detected_language'] ?? '';
  const alternatives = channel['alternatives'].map((alt: { [id: string]: any }) => {
    const wordsData: any[] = alt['words'] ?? [];

    return {
      language: normalizeLanguage(language ?? detectedLanguage),
      startTime: wordsData.length ? wordsData[0]['start'] : 0,
      endTime: wordsData.length ? wordsData[wordsData.length - 1]['end'] : 0,
      confidence: alt['confidence'],
      text: alt['transcript'],
      words: wordsData.map((word) =>
        createTimedString({
          text: word['word'] ?? '',
          startTime: word['start'] ?? 0,
          endTime: word['end'] ?? 0,
          confidence: word['confidence'] ?? 0.0,
        }),
      ),
    };
  }) as stt.SpeechData[];

  return {
    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
    requestId: data['metadata']['request_id'],
    ...(alternatives.length
      ? { alternatives: alternatives as [stt.SpeechData, ...stt.SpeechData[]] }
      : {}),
  };
}
