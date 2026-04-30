// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  type AudioBuffer,
  AudioByteStream,
  type VAD,
  VADEventType,
  type VADStream,
  asLanguageCode,
  log,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { Mistral } from '@mistralai/mistralai';
import type {
  RealtimeConnection,
  RealtimeTranscriptionError,
  RealtimeTranscriptionSessionCreated,
  TranscriptionStreamDone,
  TranscriptionStreamLanguage,
  TranscriptionStreamTextDelta,
} from '@mistralai/mistralai/extra/realtime';
import { RealtimeTranscription } from '@mistralai/mistralai/extra/realtime';
import type { MistralSTTModels } from './models.js';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

function isRealtime(model: string): boolean {
  return model.includes('realtime');
}

export interface STTOptions {
  model: MistralSTTModels | string;
  language?: string;
  contextBias?: string[];
  targetStreamingDelayMs?: number;
  apiKey?: string;
  client?: Mistral;
  vad?: VAD;
}

const defaultSTTOptions: STTOptions = {
  model: 'voxtral-mini-latest',
  apiKey: process.env.MISTRAL_API_KEY,
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #client: Mistral;
  #vad: VAD | undefined;
  label = 'mistral.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    const merged = { ...defaultSTTOptions, ...opts };
    const realtime = isRealtime(merged.model);

    super({
      streaming: realtime,
      interimResults: realtime,
      alignedTranscript: false,
    });

    if (!merged.apiKey && !merged.client) {
      throw new Error(
        'Mistral API key is required, either as an argument or via MISTRAL_API_KEY env var',
      );
    }

    this.#opts = merged;
    this.#vad = merged.vad;
    this.#client =
      merged.client ??
      new Mistral({
        apiKey: merged.apiKey,
      });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'api.mistral.ai';
  }

  updateOptions(opts: {
    language?: string;
    contextBias?: string[];
    targetStreamingDelayMs?: number;
  }) {
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.contextBias !== undefined) this.#opts.contextBias = opts.contextBias;
    if (opts.targetStreamingDelayMs !== undefined)
      this.#opts.targetStreamingDelayMs = opts.targetStreamingDelayMs;
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    try {
      const frame = mergeFrames(buffer);
      const wavBytes = createWav(frame);

      const resp = await this.#client.audio.transcriptions.complete(
        {
          model: this.#opts.model,
          file: new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }),
          language: this.#opts.language ?? undefined,
          contextBias: this.#opts.contextBias ?? undefined,
          timestampGranularities: this.#opts.language ? undefined : ['segment'],
        },
        {
          fetchOptions: { signal: abortSignal },
        },
      );

      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text: resp.text ?? '',
            language: asLanguageCode(resp.language ?? this.#opts.language ?? ''),
            startTime: resp.segments?.[0]?.start ?? 0,
            endTime: resp.segments?.[resp.segments.length - 1]?.end ?? 0,
            confidence: 0,
          },
        ],
      };
    } catch (error: unknown) {
      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        if (statusCode === 429) {
          throw new APIStatusError({
            message: `Mistral STT: rate limit error - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        if (statusCode === 408 || statusCode === 504) {
          throw new APIStatusError({
            message: `Mistral STT: timeout error - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        throw new APIStatusError({
          message: `Mistral STT: error (${statusCode}) - ${err.message ?? 'unknown error'}`,
          options: { statusCode, retryable: statusCode >= 500 },
        });
      }

      throw new APIConnectionError({
        message: `Mistral STT: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable: true },
      });
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    if (!isRealtime(this.#opts.model)) {
      throw new Error(
        `Streaming is only supported for realtime models. Use a model with "realtime" in the name (e.g. voxtral-mini-transcribe-realtime-2602). Current model: ${this.#opts.model}`,
      );
    }

    return new SpeechStream(this, this.#client, this.#opts, this.#vad, options?.connOptions);
  }

  async close(): Promise<void> {
    return;
  }
}

export class SpeechStream extends stt.SpeechStream {
  #client: Mistral;
  #opts: STTOptions;
  #vad: VAD | undefined;
  #speaking = false;
  #requestId = '';
  #audioDuration = 0;
  #detectedLanguage = '';
  #logger = log();
  label = 'mistral.SpeechStream';

  constructor(
    sttInstance: STT,
    client: Mistral,
    opts: STTOptions,
    vad: VAD | undefined,
    connOptions?: APIConnectOptions,
  ) {
    super(sttInstance, SAMPLE_RATE, connOptions);
    this.#client = client;
    this.#opts = { ...opts };
    this.#vad = vad;
    this.#detectedLanguage = opts.language ?? '';
  }

  protected async run(): Promise<void> {
    try {
      let vad = this.#vad;
      if (!vad) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const silero = (await import('@livekit/agents-plugin-silero' as any)) as {
            VAD: { load: () => Promise<VAD> };
          };
          vad = await silero.VAD.load();
          this.#vad = vad;
        } catch {
          throw new Error(
            '@livekit/agents-plugin-silero is required for Voxtral realtime models ' +
              '(no server-side endpointing). Install it or pass a VAD via the `vad` option.',
          );
        }
      }

      const rt = new RealtimeTranscription(this.#client._options);

      const connection = await rt.connect(this.#opts.model, {
        timeoutMs: 10_000,
      });

      const vadStream = vad.stream();

      try {
        await Promise.all([
          this.#sendTask(connection, vadStream),
          this.#recvTask(connection),
          this.#vadTask(vadStream, connection),
        ]);
      } finally {
        vadStream.close();
        await connection.close();
      }
    } catch (error: unknown) {
      if (this.abortController.signal.aborted) return;

      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        if (statusCode === 429) {
          throw new APIStatusError({
            message: `Mistral STT: rate limit error - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        if (statusCode === 408 || statusCode === 504) {
          throw new APIStatusError({
            message: `Mistral STT: timeout error - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        throw new APIStatusError({
          message: `Mistral STT: error (${statusCode}) - ${err.message ?? 'unknown error'}`,
          options: { statusCode, retryable: statusCode >= 500 },
        });
      }

      throw new APIConnectionError({
        message: `Mistral STT: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable: true },
      });
    }
  }

  async #sendTask(connection: RealtimeConnection, vadStream: VADStream): Promise<void> {
    const samplesPerChunk = Math.floor(SAMPLE_RATE / 20); // 50ms chunks
    const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, samplesPerChunk);

    for await (const data of this.input) {
      if (this.abortController.signal.aborted) break;

      if (data === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of audioByteStream.flush()) {
          await connection.sendAudio(frame.data.buffer as ArrayBuffer);
        }
        await connection.flushAudio();
      } else {
        vadStream.pushFrame(data);

        const bytesPerSecond = SAMPLE_RATE * NUM_CHANNELS * 2;
        this.#audioDuration += data.data.byteLength / bytesPerSecond;

        for (const frame of audioByteStream.write(data.data.buffer as ArrayBuffer)) {
          await connection.sendAudio(frame.data.buffer as ArrayBuffer);
        }
      }
    }

    await connection.endAudio();
  }

  async #vadTask(vadStream: VADStream, connection: RealtimeConnection): Promise<void> {
    for await (const ev of vadStream) {
      if (this.abortController.signal.aborted) break;

      if (ev.type === VADEventType.START_OF_SPEECH) {
        if (!this.#speaking) {
          this.#speaking = true;
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
        }
      } else if (ev.type === VADEventType.END_OF_SPEECH) {
        // Force Mistral to finalize the current speech segment
        await connection.flushAudio();
        if (this.#speaking) {
          this.#speaking = false;
          this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
        }
      }
    }
  }

  async #recvTask(connection: RealtimeConnection): Promise<void> {
    let currentText = '';

    for await (const event of connection.events()) {
      if (this.abortController.signal.aborted) break;

      const eventType = (event as { type?: string }).type;

      if (eventType === 'session.created') {
        const sessionEvent = event as RealtimeTranscriptionSessionCreated;
        if (sessionEvent.session) {
          this.#requestId = sessionEvent.session.requestId;
        }
      } else if (eventType === 'transcription.language') {
        const langEvent = event as TranscriptionStreamLanguage;
        if (langEvent.audioLanguage) {
          this.#detectedLanguage = langEvent.audioLanguage;
        }
      } else if (eventType === 'transcription.text.delta') {
        const deltaEvent = event as TranscriptionStreamTextDelta;
        currentText += deltaEvent.text ?? '';
        this.queue.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          requestId: this.#requestId,
          alternatives: [
            {
              text: currentText,
              language: asLanguageCode(this.#detectedLanguage),
              startTime: 0,
              endTime: 0,
              confidence: 0,
            },
          ],
        });
      } else if (eventType === 'transcription.done') {
        const doneEvent = event as TranscriptionStreamDone;
        currentText = '';

        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          requestId: this.#requestId,
          alternatives: [
            {
              text: doneEvent.text ?? '',
              language: asLanguageCode(doneEvent.language ?? this.#detectedLanguage),
              startTime: 0,
              endTime: 0,
              confidence: 0,
            },
          ],
        });

        // Emit usage metrics
        if (doneEvent.usage) {
          this.queue.put({
            type: stt.SpeechEventType.RECOGNITION_USAGE,
            requestId: this.#requestId,
            recognitionUsage: {
              audioDuration: this.#audioDuration,
              inputTokens: doneEvent.usage.promptTokens ?? 0,
              outputTokens: doneEvent.usage.completionTokens ?? 0,
            },
          });
        }
      } else if (eventType === 'error') {
        const errorEvent = event as RealtimeTranscriptionError;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = (errorEvent as any).error as { status?: number; message?: string };
        throw new APIStatusError({
          message: `Mistral STT: realtime error - ${detail?.message ?? 'unknown error'}`,
          options: {
            statusCode: detail?.status ?? 500,
            retryable: true,
          },
        });
      }
    }
  }
}

function createWav(frame: AudioFrame): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;
  const dataSize = frame.data.byteLength;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const encoder = new TextEncoder();

  // RIFF header
  new Uint8Array(header, 0, 4).set(encoder.encode('RIFF'));
  view.setUint32(4, 36 + dataSize, true);
  new Uint8Array(header, 8, 4).set(encoder.encode('WAVE'));

  // fmt sub-chunk
  new Uint8Array(header, 12, 4).set(encoder.encode('fmt '));
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, frame.channels, true);
  view.setUint32(24, frame.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  new Uint8Array(header, 36, 4).set(encoder.encode('data'));
  view.setUint32(40, dataSize, true);

  const result = new Uint8Array(44 + dataSize);
  result.set(new Uint8Array(header));
  result.set(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), 44);
  return result;
}
