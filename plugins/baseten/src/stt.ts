// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioBuffer, AudioByteStream, Task, log, stt, waitForAbort } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import type { BasetenSttOptions } from './types.js';

const defaultSTTOptions: Partial<BasetenSttOptions> = {
  environment: 'production',
  encoding: 'pcm_s16le',
  sampleRate: 16000,
  bufferSizeSeconds: 0.032,
  enablePartialTranscripts: true,
  partialTranscriptIntervalS: 0.5,
  finalTranscriptMaxDurationS: 5,
  audioLanguage: 'en',
  languageDetectionOnly: false,
  vadThreshold: 0.5,
  vadMinSilenceDurationMs: 300,
  vadSpeechPadMs: 30,
};

export class STT extends stt.STT {
  #opts: BasetenSttOptions;
  #logger = log();
  label = 'baseten.STT';

  constructor(opts: Partial<BasetenSttOptions> = {}) {
    super({
      streaming: true,
      interimResults: opts.enablePartialTranscripts ?? defaultSTTOptions.enablePartialTranscripts!,
      alignedTranscript: 'word',
    });

    const apiKey = opts.apiKey ?? process.env.BASETEN_API_KEY;
    const modelEndpoint = opts.modelEndpoint ?? process.env.BASETEN_MODEL_ENDPOINT;
    const modelId = opts.modelId ?? process.env.BASETEN_STT_MODEL_ID;

    if (!apiKey) {
      throw new Error(
        'Baseten API key is required, either pass it as `apiKey` or set $BASETEN_API_KEY',
      );
    }
    if (!modelEndpoint && !modelId) {
      throw new Error(
        'Baseten model endpoint is required, either pass it as `modelEndpoint` or set $BASETEN_MODEL_ENDPOINT',
      );
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey,
      modelEndpoint,
      modelId,
    } as BasetenSttOptions;
  }

  // eslint-disable-next-line
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on Baseten STT');
  }

  updateOptions(opts: Partial<BasetenSttOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(): SpeechStream {
    return new SpeechStream(this, this.#opts);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: BasetenSttOptions;
  #logger = log();
  #speaking = false;
  #requestId = '';
  label = 'baseten.SpeechStream';

  constructor(stt: STT, opts: BasetenSttOptions) {
    super(stt, opts.sampleRate);
    this.#opts = opts;
    this.closed = false;
  }

  private getWsUrl(): string {
    if (this.#opts.modelEndpoint) {
      return this.#opts.modelEndpoint;
    }
    // Fallback to constructing URL from modelId (deprecated)
    return `wss://model-${this.#opts.modelId}.api.baseten.co/environments/${this.#opts.environment}/websocket`;
  }

  protected async run() {
    const maxRetry = 32;
    let retries = 0;

    while (!this.input.closed && !this.closed) {
      const url = this.getWsUrl();
      const headers = {
        Authorization: `Api-Key ${this.#opts.apiKey}`,
      };

      const ws = new WebSocket(url, { headers, rejectUnauthorized: false });

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
            throw new Error(`failed to connect to Baseten after ${retries} attempts: ${e}`);
          }

          const delay = Math.min(retries * 5, 10);
          retries++;

          this.#logger.warn(
            `failed to connect to Baseten, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        } else {
          this.#logger.warn(
            `Baseten disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
      }
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket) {
    let closing = false;

    // Send initial metadata
    // Note: Baseten server expects 'vad_params' and 'streaming_whisper_params' field names
    // (not 'streaming_vad_config', 'streaming_params', 'whisper_params' as in older versions)
    const metadata = {
      vad_params: {
        threshold: this.#opts.vadThreshold,
        min_silence_duration_ms: this.#opts.vadMinSilenceDurationMs,
        speech_pad_ms: this.#opts.vadSpeechPadMs,
      },
      streaming_whisper_params: {
        encoding: this.#opts.encoding ?? 'pcm_s16le',
        sample_rate: this.#opts.sampleRate ?? 16000,
        enable_partial_transcripts: false,
        audio_language: this.#opts.audioLanguage ?? 'en',
        show_word_timestamps: true,
      },
    };

    ws.send(JSON.stringify(metadata));

    const sendTask = async () => {
      const sampleRate = this.#opts.sampleRate ?? 16000;
      const samplesPerChunk = sampleRate === 16000 ? 512 : 256;
      const audioByteStream = new AudioByteStream(sampleRate, 1, samplesPerChunk);

      try {
        while (!this.closed) {
          const result = await this.input.next();
          if (result.done) {
            break;
          }

          const data = result.value;

          let frames: AudioFrame[];
          if (data === SpeechStream.FLUSH_SENTINEL) {
            // Flush any remaining buffered audio
            frames = audioByteStream.flush();
          } else {
            if (data.sampleRate !== sampleRate || data.channels !== 1) {
              throw new Error(
                `sample rate or channel count mismatch: expected ${sampleRate}Hz/1ch, got ${data.sampleRate}Hz/${data.channels}ch`,
              );
            }
            frames = audioByteStream.write(data.data.buffer as ArrayBuffer);
          }

          for (const frame of frames) {
            const buffer = Buffer.from(
              frame.data.buffer,
              frame.data.byteOffset,
              frame.data.byteLength,
            );
            ws.send(buffer);
          }
        }
      } finally {
        closing = true;
        ws.close();
      }
    };

    const listenTask = Task.from(async (controller) => {
      const listenMessage = new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          try {
            let jsonString: string;

            if (typeof data === 'string') {
              jsonString = data;
            } else if (data instanceof Buffer) {
              jsonString = data.toString('utf-8');
            } else if (Array.isArray(data)) {
              jsonString = Buffer.concat(data).toString('utf-8');
            } else {
              return;
            }

            const msg = JSON.parse(jsonString);
            const isFinal = msg.is_final ?? true;
            const segments = msg.segments ?? [];
            const transcript = msg.transcript ?? '';
            const confidence = msg.confidence ?? 0.0;
            const languageCode = msg.language_code ?? this.#opts.audioLanguage;

            // Skip if no transcript text
            if (!transcript) {
              this.#logger.debug('Received non-transcript message:', msg);
              return;
            }

            // Emit START_OF_SPEECH if not already speaking (only for interim or first final)
            if (!this.#speaking && !isFinal) {
              this.#speaking = true;
              this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
            }

            // Note: Baseten uses 'start_time' and 'end_time' field names (with underscores)
            const startTime =
              segments.length > 0
                ? (segments[0].start_time ?? 0.0) + this.startTimeOffset
                : this.startTimeOffset;
            const endTime =
              segments.length > 0
                ? (segments[segments.length - 1].end_time ?? 0.0) + this.startTimeOffset
                : this.startTimeOffset;

            // Note: Baseten returns segments (chunks) which we treat as words for aligned transcripts
            const words = segments.map(
              (segment: { text?: string; start_time?: number; end_time?: number }) => ({
                text: segment.text ?? '',
                startTime: (segment.start_time ?? 0.0) + this.startTimeOffset,
                endTime: (segment.end_time ?? 0.0) + this.startTimeOffset,
                startTimeOffset: this.startTimeOffset,
                confidence: confidence,
              }),
            );

            const speechData: stt.SpeechData = {
              language: languageCode!,
              text: transcript,
              startTime,
              endTime,
              confidence,
              words: words.length > 0 ? words : undefined,
            };

            // Handle interim vs final transcripts (matching Python implementation)
            if (!isFinal) {
              // Interim transcript
              this.queue.put({
                type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
                alternatives: [speechData],
              });
            } else {
              // Final transcript
              this.queue.put({
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives: [speechData],
              });

              // Emit END_OF_SPEECH after final transcript
              if (this.#speaking) {
                this.#speaking = false;
                this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
              }
            }

            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`STT: Error processing message: ${data}`);
            reject(err);
          }
        });

        ws.on('error', (err) => {
          if (!closing) {
            reject(err);
          }
        });

        ws.on('close', () => {
          if (!closing) {
            resolve();
          }
        });
      });

      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    }, this.abortController);

    await Promise.all([sendTask(), listenTask.result]);
    closing = true;
    ws.close();
  }
}
