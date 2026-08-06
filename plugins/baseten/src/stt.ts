// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  Task,
  log,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { Qwen3Backend } from './qwen3_stt.js';
import type { BasetenSttOptions } from './types.js';

const defaultSTTOptions: Partial<BasetenSttOptions> = {
  environment: 'production',
  encoding: 'pcm_s16le',
  sampleRate: 16000,
  bufferSizeSeconds: 0.032,
  enablePartialTranscripts: true,
  partialTranscriptIntervalS: 1,
  finalTranscriptMaxDurationS: 30,
  audioLanguage: 'en',
  languageDetectionOnly: false,
  vadThreshold: 0.5,
  vadMinSilenceDurationMs: 300,
  vadSpeechPadMs: 30,
};

export class STT extends stt.STT {
  #opts: BasetenSttOptions;
  #qwen3?: Qwen3Backend;
  #streams = new Set<SpeechStream>();
  #logger = log();
  label = 'baseten.STT';

  constructor(opts: Partial<BasetenSttOptions> = {}) {
    const model = opts.model ?? 'whisper';
    const showWordTimestamps = opts.showWordTimestamps ?? model === 'whisper';
    super({
      streaming: true,
      interimResults: opts.enablePartialTranscripts ?? defaultSTTOptions.enablePartialTranscripts!,
      alignedTranscript: showWordTimestamps ? 'word' : false,
    });

    if (model === 'qwen3-asr') {
      this.#opts = { ...opts, model };
      this.#qwen3 = new Qwen3Backend({
        apiKey: opts.apiKey,
        modelEndpoint: opts.modelEndpoint,
        modelId: opts.modelId,
        chainId: opts.chainId,
        language: opts.audioLanguage ?? 'auto',
        interimResults: opts.enablePartialTranscripts ?? true,
        partialTranscriptIntervalS: opts.partialTranscriptIntervalS ?? 0.5,
        finalTranscriptMaxDurationS: opts.finalTranscriptMaxDurationS ?? 30,
        vadThreshold: opts.vadThreshold ?? 0.5,
        vadMinSilenceDurationMs: opts.vadMinSilenceDurationMs ?? 500,
        vadSpeechPadMs: opts.vadSpeechPadMs ?? 100,
        wordTimestamps: showWordTimestamps,
      });
      return;
    }

    const apiKey = opts.apiKey ?? process.env.BASETEN_API_KEY;
    const modelId = opts.modelId;
    const modelEndpoint =
      opts.modelEndpoint ??
      (modelId
        ? `wss://model-${modelId}.api.baseten.co/environments/production/websocket`
        : undefined) ??
      (opts.chainId
        ? `wss://chain-${opts.chainId}.api.baseten.co/environments/production/websocket`
        : undefined) ??
      (process.env.BASETEN_STT_MODEL_ID
        ? `wss://model-${process.env.BASETEN_STT_MODEL_ID}.api.baseten.co/environments/production/websocket`
        : undefined) ??
      process.env.BASETEN_MODEL_ENDPOINT;

    if (!apiKey) {
      throw new Error(
        'Baseten API key is required, either pass it as `apiKey` or set $BASETEN_API_KEY',
      );
    }
    if (!modelEndpoint) {
      throw new Error(
        'Baseten model endpoint is required, either pass it as `modelEndpoint` or set $BASETEN_MODEL_ENDPOINT',
      );
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey,
      modelEndpoint,
      modelId: undefined,
      model,
      audioLanguage: normalizeLanguage((opts.audioLanguage ?? defaultSTTOptions.audioLanguage)!),
      languageOptions: opts.languageOptions?.map((language) => normalizeLanguage(language)) ?? [],
      showWordTimestamps,
    } as BasetenSttOptions;
  }

  // eslint-disable-next-line
  async _recognize(
    frame: AudioBuffer,
    abortSignal?: AbortSignal,
    options?: { language?: string },
  ): Promise<stt.SpeechEvent> {
    if (this.#qwen3) {
      return this.#qwen3.recognizeViaStream(this, frame, {
        abortSignal,
        language: options?.language,
      });
    }
    throw new Error('Recognize is not supported on Baseten STT');
  }

  updateOptions(opts: Partial<BasetenSttOptions>) {
    if (this.#qwen3) {
      this.#qwen3.updateOptions({
        language: opts.audioLanguage,
        vadThreshold: opts.vadThreshold,
        vadMinSilenceDurationMs: opts.vadMinSilenceDurationMs,
        vadSpeechPadMs: opts.vadSpeechPadMs,
        partialTranscriptIntervalS: opts.partialTranscriptIntervalS,
      });
      for (const name of ['languageOptions', 'bufferSizeSeconds'] as const) {
        if (opts[name] !== undefined) {
          this.#logger.warn(
            { model: this.model, option: name },
            'option does not apply and was ignored',
          );
        }
      }
      return;
    }
    const next = {
      ...opts,
      audioLanguage:
        opts.audioLanguage !== undefined
          ? normalizeLanguage(opts.audioLanguage)
          : this.#opts.audioLanguage,
      languageOptions:
        opts.languageOptions !== undefined
          ? opts.languageOptions.map((language) => normalizeLanguage(language))
          : this.#opts.languageOptions,
    };
    Object.assign(this.#opts, next);
    for (const stream of this.#streams) stream.updateOptions(next);
  }

  get model(): string {
    return this.#opts.model ?? 'whisper';
  }

  get provider(): string {
    return 'Baseten';
  }

  stream(options?: { connOptions?: APIConnectOptions; language?: string }): stt.SpeechStream {
    if (this.#qwen3) {
      return this.#qwen3.makeStream(this, {
        connOptions: options?.connOptions,
        language: options?.language,
      });
    }
    const stream = new SpeechStream(this, this.#opts, options?.connOptions, () => {
      this.#streams.delete(stream);
    });
    this.#streams.add(stream);
    return stream;
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: BasetenSttOptions;
  #logger = log();
  #speaking = false;
  #requestId = '';
  #ws?: WebSocket;
  #reconnectRequested = false;
  #onClose: () => void;
  label = 'baseten.SpeechStream';

  constructor(
    stt: STT,
    opts: BasetenSttOptions,
    connOptions: APIConnectOptions | undefined,
    onClose: () => void,
  ) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#onClose = onClose;
    this.closed = false;
  }

  updateOptions(opts: Partial<BasetenSttOptions>): void {
    Object.assign(this.#opts, opts);
    this.#reconnectRequested = true;
    if (!this.input.closed) this.input.put(SpeechStream.FLUSH_SENTINEL);
    this.#ws?.close();
  }

  override close(): void {
    this.#onClose();
    super.close();
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

      const ws = new WebSocket(url, { headers });
      this.#ws = ws;

      try {
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', (error) => reject(error));
          ws.on('close', (code) => reject(`WebSocket returned ${code}`));
        });

        await this.#runWS(ws);
        this.#reconnectRequested = false;
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
      this.#ws = undefined;
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket) {
    let closing = false;
    let connectionEnded = false;

    const metadata = {
      whisper_params: {
        audio_language: this.#opts.audioLanguage ?? 'en',
        show_word_timestamps: this.#opts.showWordTimestamps ?? true,
        ...(this.#opts.languageOptions?.length
          ? { language_options: this.#opts.languageOptions }
          : {}),
      },
      streaming_params: {
        encoding: this.#opts.encoding ?? 'pcm_s16le',
        sample_rate: this.#opts.sampleRate ?? 16000,
        enable_partial_transcripts: this.#opts.enablePartialTranscripts ?? true,
        partial_transcript_interval_s: this.#opts.partialTranscriptIntervalS ?? 1,
        final_transcript_max_duration_s: this.#opts.finalTranscriptMaxDurationS ?? 30,
      },
      streaming_vad_config: {
        threshold: this.#opts.vadThreshold,
        min_silence_duration_ms: this.#opts.vadMinSilenceDurationMs,
        speech_pad_ms: this.#opts.vadSpeechPadMs,
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

          if (connectionEnded) return;
          if (this.#reconnectRequested && data === SpeechStream.FLUSH_SENTINEL) return;

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
        const wakeSender = () => {
          connectionEnded = true;
          if (!this.input.closed) this.input.put(SpeechStream.FLUSH_SENTINEL);
        };
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
            const transcript =
              msg.transcript ??
              segments
                .map((segment: { text?: string }) => segment.text ?? '')
                .join(' ')
                .trim();
            const confidence = msg.confidence ?? 0.0;
            const languageCode = normalizeLanguage(msg.language_code ?? this.#opts.audioLanguage);

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
              language: languageCode,
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
            wakeSender();
            reject(err);
          }
        });

        ws.on('close', () => {
          wakeSender();
          resolve();
        });
      });

      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    }, this.abortController);

    await Promise.all([sendTask(), listenTask.result]);
    closing = true;
    ws.close();
  }
}
