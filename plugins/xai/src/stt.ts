// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LanguageCode } from '@livekit/agents';
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  Future,
  Task,
  createTimedString,
  log,
  mergeFrames,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PeriodicCollector } from './_utils.js';

const SAMPLE_RATE = 16000;
const XAI_WEBSOCKET_URL = 'wss://api.x.ai/v1/stt';
const XAI_REST_URL = 'https://api.x.ai/v1/stt';

export type STTLanguages =
  | 'ar'
  | 'cs'
  | 'da'
  | 'nl'
  | 'en'
  | 'fil'
  | 'fr'
  | 'de'
  | 'hi'
  | 'id'
  | 'it'
  | 'ja'
  | 'ko'
  | 'mk'
  | 'ms'
  | 'fa'
  | 'pl'
  | 'pt'
  | 'ro'
  | 'ru'
  | 'es'
  | 'sv'
  | 'th'
  | 'tr'
  | 'vi';

export interface STTOptions {
  apiKey?: string;
  interimResults: boolean;
  sampleRate: number;
  enableDiarization: boolean;
  language: STTLanguages | string;
}

const defaultSTTOptions: Omit<STTOptions, 'apiKey'> = {
  interimResults: true,
  sampleRate: SAMPLE_RATE,
  enableDiarization: false,
  language: 'en',
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #apiKey: string;
  #streams = new Set<WeakRef<SpeechStream>>();
  label = 'xai.STT';

  get provider(): string {
    return 'xai';
  }

  constructor(opts: Partial<STTOptions> = {}) {
    const merged = { ...defaultSTTOptions, ...opts };
    super({
      streaming: true,
      interimResults: merged.interimResults,
      alignedTranscript: 'word',
    });

    const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('xAI API key is required, whether as an argument or as $XAI_API_KEY');
    }
    this.#apiKey = apiKey;
    this.#opts = { ...merged, apiKey };
  }

  async _recognize(buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const wavBuffer = createWav(frame);
    const file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('language', this.#opts.language);
    formData.append('format', 'true');

    const resp = await fetch(XAI_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: 'application/json',
      },
      body: formData,
    });

    if (!resp.ok) {
      throw new Error(`xAI STT REST request failed with status ${resp.status}`);
    }

    const data = await resp.json();
    return prerecordedTranscriptionToSpeechEvent(data);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    const stream = new SpeechStream(this, this.#opts, this.#apiKey, options?.connOptions);
    this.#streams.add(new WeakRef(stream));
    return stream;
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };

    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (stream) {
        stream.updateOptions(opts);
      } else {
        this.#streams.delete(ref);
      }
    }
  }

  async close() {
    // no-op; streams clean up independently
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #apiKey: string;
  #logger = log();
  #speaking = false;
  #emittedChunkFinal = false;
  #resetWS = new Future();
  #requestId: string;
  #audioDurationCollector: PeriodicCollector<number>;
  #serverReady = new Future();
  label = 'xai.SpeechStream';

  constructor(stt: STT, opts: STTOptions, apiKey: string, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = { ...opts };
    this.#apiKey = apiKey;
    this.closed = false;
    this.#requestId = randomUUID();
    this.#audioDurationCollector = new PeriodicCollector(
      (duration) => this.#onAudioDurationReport(duration),
      { duration: 5.0 },
    );
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    this.#resetWS.resolve();
  }

  protected async run() {
    const maxRetry = 32;
    let retries = 0;
    let ws: WebSocket;

    while (!this.input.closed && !this.closed) {
      const streamURL = new URL(XAI_WEBSOCKET_URL);
      streamURL.searchParams.set('encoding', 'pcm');
      streamURL.searchParams.set('sample_rate', String(this.#opts.sampleRate));
      streamURL.searchParams.set(
        'interim_results',
        String(this.#opts.interimResults).toLowerCase(),
      );
      streamURL.searchParams.set('diarize', String(this.#opts.enableDiarization).toLowerCase());
      streamURL.searchParams.set('language', this.#opts.language);

      ws = new WebSocket(streamURL, {
        headers: { Authorization: `Bearer ${this.#apiKey}` },
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
            throw new Error(`failed to connect to xAI after ${retries} attempts: ${e}`);
          }

          const delay = Math.min(retries * 5, 10);
          retries++;

          this.#logger.warn(
            `failed to connect to xAI STT, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        } else {
          this.#logger.warn(
            `xAI STT disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
      }
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket) {
    this.#resetWS = new Future();
    this.#serverReady = new Future();
    let closing = false;

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
      await this.#serverReady.await;

      const samples50ms = Math.floor(this.#opts.sampleRate / 20);
      const stream = new AudioByteStream(this.#opts.sampleRate, 1, samples50ms);
      const abortPromise = waitForAbort(this.abortSignal);

      try {
        while (!this.closed) {
          const result = await Promise.race([this.input.next(), abortPromise]);

          if (result === undefined) return;
          if (result.done) break;

          const data = result.value;
          let frames: AudioFrame[];

          if (data === SpeechStream.FLUSH_SENTINEL) {
            frames = stream.flush();
            this.#audioDurationCollector.flush();
          } else {
            frames = stream.write(data.data.buffer as ArrayBuffer);
          }

          for (const frame of frames) {
            const frameDuration = frame.samplesPerChannel / frame.sampleRate;
            this.#audioDurationCollector.push(frameDuration);
            ws.send(frame.data.buffer);
          }
        }
      } finally {
        this.#audioDurationCollector.flush();
        closing = true;
        ws.send(JSON.stringify({ type: 'audio.done' }));
        wsMonitor.cancel();
      }
    };

    const listenTask = Task.from(async (controller) => {
      const listenMessage = new Promise<void>((resolve, reject) => {
        ws.on('message', (msg) => {
          try {
            const json = JSON.parse(msg.toString());
            this.#processStreamEvent(json);

            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`xAI STT: error processing message: ${msg}`);
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
  }

  #onAudioDurationReport(duration: number) {
    const usageEvent: stt.SpeechEvent = {
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: {
        audioDuration: duration,
      },
    };
    if (!this.queue.closed) {
      this.queue.put(usageEvent);
    }
  }

  #putMessage(message: stt.SpeechEvent) {
    if (!this.queue.closed) {
      try {
        this.queue.put(message);
      } catch {
        // ignore
      }
    }
  }

  #processStreamEvent(data: Record<string, unknown>) {
    const msgType = (data['type'] as string) ?? '';

    if (msgType === 'transcript.created') {
      this.#serverReady.resolve();
    } else if (msgType === 'transcript.partial') {
      const text = (data['text'] as string) ?? '';
      const isFinal = (data['is_final'] as boolean) ?? false;
      const speechFinal = (data['speech_final'] as boolean) ?? false;
      const words = (data['words'] as Record<string, unknown>[]) ?? [];
      const language = (data['language'] as string) ?? '';

      if (!text) return;

      if (!this.#speaking) {
        this.#speaking = true;
        this.#putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
      }

      if (isFinal) {
        if (!speechFinal) {
          this.#emittedChunkFinal = true;
          this.#putMessage({
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            requestId: this.#requestId,
            alternatives: [wordsToSpeechData(words, text, language)],
          });
        } else {
          if (!this.#emittedChunkFinal) {
            this.#putMessage({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              requestId: this.#requestId,
              alternatives: [wordsToSpeechData(words, text, language)],
            });
          }
          this.#emittedChunkFinal = false;
          this.#speaking = false;
          this.#putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
        }
      } else {
        if (this.#opts.interimResults) {
          this.#putMessage({
            type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
            requestId: this.#requestId,
            alternatives: [
              {
                language: language as LanguageCode,
                text,
                startTime: 0,
                endTime: 0,
                confidence: 0,
              },
            ],
          });
        }
      }
    } else if (msgType === 'transcript.done') {
      const text = (data['text'] as string) ?? '';
      const words = (data['words'] as Record<string, unknown>[]) ?? [];
      const language = (data['language'] as string) ?? '';

      if (text) {
        this.#putMessage({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          requestId: this.#requestId,
          alternatives: [wordsToSpeechData(words, text, language)],
        });
      }
      if (this.#speaking) {
        this.#speaking = false;
        this.#putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    } else if (msgType === 'error') {
      this.#logger.error(`xAI STT error: ${(data['message'] as string) ?? 'unknown error'}`);
    } else {
      this.#logger.warn(`received unexpected message from xAI: ${msgType}`);
    }
  }
}

function wordsToSpeechData(
  words: Record<string, unknown>[],
  text: string,
  language: string,
): stt.SpeechData {
  return {
    language: language as LanguageCode,
    text,
    startTime: words.length ? (words[0]!['start'] as number) ?? 0 : 0,
    endTime: words.length ? (words[words.length - 1]!['end'] as number) ?? 0 : 0,
    confidence: 0,
    words:
      words.length > 0
        ? words.map((w) =>
            createTimedString({
              text: (w['text'] as string) ?? '',
              startTime: (w['start'] as number) ?? 0,
              endTime: (w['end'] as number) ?? 0,
            }),
          )
        : undefined,
  };
}

function prerecordedTranscriptionToSpeechEvent(data: Record<string, unknown>): stt.SpeechEvent {
  const text = (data['text'] as string) ?? '';
  const words = (data['words'] as Record<string, unknown>[]) ?? [];
  const language = (data['language'] as string) ?? '';
  return {
    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [wordsToSpeechData(words, text, language)],
  };
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
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);
  return Buffer.concat([header, Buffer.from(frame.data.buffer)]);
}
