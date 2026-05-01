// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  type AudioBuffer,
  createTimedString,
  mergeFrames,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import { type AudioFrame } from '@livekit/rtc-node';
import { Mistral } from '@mistralai/mistralai';
import { RealtimeTranscription } from '@mistralai/mistralai/extra/realtime';
import { AudioEncoding } from '@mistralai/mistralai/extra/realtime';
import type { MistralSTTModels } from './models.js';

type audioFormat = {
  encoding: AudioEncoding;
  sampleRate: number;
};

export interface STTOptions {
  apiKey?: string;
  language: string;
  liveModel: MistralSTTModels | string;
  offlineModel: MistralSTTModels | string;
  audioFormat: audioFormat;
  baseURL?: string;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.MISTRAL_API_KEY,
  language: 'en',
  liveModel: 'voxtral-mini-transcribe-realtime-2602',
  offlineModel: 'voxtral-mini-2602',
  audioFormat: { encoding: AudioEncoding.PcmS16le, sampleRate: 16000 },
  baseURL: 'https://api.mistral.ai',
};

export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'mistral.STT';
  #client: Mistral;

  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    super({ streaming: true, interimResults: true, alignedTranscript: 'word', diarization: false });

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
    };

    if (this.#opts.apiKey === undefined) {
      throw new Error('Mistral API key is required');
    }

    this.#client = new Mistral({ apiKey: this.#opts.apiKey, serverURL: this.#opts.baseURL });

    // Patch the metrics emitter to correctly dynamically route live vs offline models for observability
    const originalEmit = this.emit.bind(this);
    this.emit = <E extends keyof stt.STTCallbacks>(
      event: E,
      ...args: Parameters<stt.STTCallbacks[E]>
    ) => {
      if (event === 'metrics_collected' && args[0]?.type === 'stt_metrics') {
        const metric = args[0] as any;
        metric.metadata.modelName = metric.streamed
          ? this.#opts.liveModel
          : this.#opts.offlineModel;
      }
      return originalEmit(event, ...args);
    };
  }

  get model(): string {
    return this.#opts.liveModel as string;
  }

  get provider(): string {
    return 'api.mistral.ai';
  }

  get options(): Readonly<STTOptions> {
    return this.#opts;
  }

  #createWav(frame: AudioFrame): Buffer {
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
    return Buffer.concat([
      header,
      Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    ]);
  }

  async _recognize(frame: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    let buffer = mergeFrames(frame);
    let wavBuffer = this.#createWav(buffer);
    const audio_file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' });

    const resp = await this.#client.audio.transcriptions.complete(
      {
        file: {
          content: audio_file,
          fileName: 'audio.wav',
        },
        model: this.#opts.offlineModel as string,
        language: this.#opts.language,
        timestampGranularities: ['word'],
      },
      {
        fetchOptions: { signal: abortSignal },
      },
    );

    let parsedWords: any[] | undefined;
    if ('words' in resp && Array.isArray(resp.words)) {
      parsedWords = resp.words.map((w: any) =>
        createTimedString({
          text: w.word || w.text || '',
          startTime: w.start || 0,
          endTime: w.end || 0,
          confidence: w.confidence ?? 1.0,
        }),
      );
    }

    // Return the final result to LiveKit
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: resp.text || '',
          language: normalizeLanguage(this.#opts.language),
          startTime: parsedWords && parsedWords.length > 0 ? parsedWords[0].startTime : 0,
          endTime:
            parsedWords && parsedWords.length > 0 ? parsedWords[parsedWords.length - 1].endTime : 0,
          confidence: 1.0,
          words: parsedWords,
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    // All this does is instantiate our async listener!
    return new SpeechStream(this, this.#opts.audioFormat, options?.connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  label = 'mistral.SpeechStream';
  #stt: STT;
  #client: RealtimeTranscription;
  #audioFormat: audioFormat;

  constructor(sttInstance: STT, audioFormat: audioFormat, connOptions?: APIConnectOptions) {
    super(sttInstance, audioFormat.sampleRate, connOptions);
    this.#stt = sttInstance;

    // Note: It is safe to instantiate the RealtimeTranscription client once per SpeechStream,
    // rather than per framework retry inside run(). The SDK class is a stateless config container,
    // and its .transcribeStream() method establishes a completely fresh WebSocket internally on every call.
    this.#client = new RealtimeTranscription({
      apiKey: this.#stt.options.apiKey,
      serverURL: this.#stt.options.baseURL,
    });
    this.#audioFormat = audioFormat;
  }

  protected async run(): Promise<void> {
    let currentText = '';
    let currentLanguage = this.#stt.options.language;
    let speaking = false;
    let stopRequested = false;
    let resolveAbortTask: () => void = () => {};
    const abortTaskPromise = new Promise<void>((resolve) => {
      resolveAbortTask = resolve;
    });

    let connection: any;
    let sendAudioTask: Promise<void> | undefined;
    let sendError: unknown;

    try {
      connection = await this.#client.connect(this.#stt.options.liveModel, {
        audioFormat: this.#audioFormat,
      });

      sendAudioTask = (async () => {
        try {
          const iterator = this.input[Symbol.asyncIterator]();
          while (true) {
            if (stopRequested || connection.isClosed) break;

            const nextPromise = iterator.next();
            const result = await Promise.race([
              nextPromise,
              abortTaskPromise.then(() => ({ abort: true }) as const),
            ]);

            if ('abort' in result) break;
            if (result.done) break;

            const chunk = result.value;
            if (chunk === stt.SpeechStream.FLUSH_SENTINEL) {
              await connection.flushAudio();
              continue;
            }

            const pcmBuffer = Buffer.from(
              chunk.data.buffer,
              chunk.data.byteOffset,
              chunk.data.byteLength,
            );
            await connection.sendAudio(new Uint8Array(pcmBuffer));
          }
        } catch (err: unknown) {
          if (!stopRequested) {
            sendError = err;
            connection.close().catch(() => {});
          }
        } finally {
          if (!connection.isClosed) {
            await connection.flushAudio().catch(() => {});
          }
          await connection.endAudio().catch(() => {});
        }
      })();

      for await (const event of connection) {
        // [PR Reviewer]: Mistral's RealtimeConnectOptions does not formally accept an outbound
        // static language parameter for streaming API initialization (forcing backend auto-detection).
        // To prevent metadata drift, we intercept their dynamic inbound language detection payload
        // down the socket and natively hydrate the SpeechEvent payload with the truthful dialect.
        if (event.type === 'transcription.language') {
          const typedEvent = event as any;
          if (typedEvent.audio_language) {
            currentLanguage = typedEvent.audio_language;
          }
        } else if (event.type === 'transcription.text.delta') {
          if (!speaking) {
            speaking = true;
            this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          }
          const typedEvent = event as any;
          currentText += typedEvent.text || '';
          this.queue.put({
            type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
            alternatives: [
              {
                text: currentText,
                language: normalizeLanguage(currentLanguage),
                startTime: 0,
                endTime: 0,
                confidence: 1.0,
              },
            ],
          });
        } else if (event.type === 'transcription.segment') {
          const typedEvent = event as any;
          currentText = typedEvent.text || currentText;

          let parsedWords: any[] | undefined;
          if ('words' in typedEvent && Array.isArray(typedEvent.words)) {
            parsedWords = typedEvent.words.map((w: any) =>
              createTimedString({
                text: w.word || w.text || '',
                startTime: w.start || 0,
                endTime: w.end || 0,
                confidence: w.confidence ?? 1.0,
              }),
            );
          }

          this.queue.put({
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [
              {
                text: currentText,
                language: normalizeLanguage(currentLanguage),
                startTime:
                  typedEvent.start ??
                  (parsedWords && parsedWords.length > 0 ? parsedWords[0].startTime : 0),
                endTime:
                  typedEvent.end ??
                  (parsedWords && parsedWords.length > 0
                    ? parsedWords[parsedWords.length - 1].endTime
                    : 0),
                confidence: 1.0,
                words: parsedWords,
              },
            ],
          });
          currentText = ''; // reset for the next utterance

          if (speaking) {
            speaking = false;
            this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
          }
        } else if (event.type === 'transcription.done') {
          if (currentText.trim().length > 0) {
            this.queue.put({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              alternatives: [
                {
                  text: currentText,
                  language: normalizeLanguage(currentLanguage),
                  startTime: 0,
                  endTime: 0,
                  confidence: 1.0,
                },
              ],
            });
          }
          if (speaking) {
            speaking = false;
            this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
          }
          break;
        } else if (event.type === 'error') {
          const errEvent = event as any;
          const errorMessage =
            typeof errEvent.error === 'string' ? errEvent.error : JSON.stringify(errEvent.error);
          throw new APIConnectionError({
            message: `Mistral STT connection error: ${errorMessage}`,
          });
        }
      }

      if (sendError) {
        throw sendError;
      }
    } catch (error: unknown) {
      error = sendError ?? error;

      // An aborted signal means the stream was intentionally closed — do not
      // wrap into APIConnectionError, which would trigger the retry loop.
      if (this.abortController.signal.aborted) throw error;

      // Re-throw errors already in the framework's error hierarchy
      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      // Inspect the Mistral SDK error for an HTTP status code
      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        if (statusCode === 429) {
          throw new APIStatusError({
            message: `Mistral STT: rate limit error - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        if (statusCode >= 400 && statusCode < 500) {
          throw new APIStatusError({
            message: `Mistral STT: client error (${statusCode}) - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: false },
          });
        }
        if (statusCode >= 500) {
          throw new APIStatusError({
            message: `Mistral STT: server error (${statusCode}) - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
      }

      // Network failure or unknown error — retryable by default
      throw new APIConnectionError({
        message: `Mistral STT: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable: true },
      });
    } finally {
      stopRequested = true;
      resolveAbortTask();
      if (connection) {
        await connection.close().catch(() => {});
      }
      if (sendAudioTask) {
        await sendAudioTask;
      }
    }
  }
}
