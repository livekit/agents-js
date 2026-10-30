// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ServiceError, status } from '@grpc/grpc-js';
import {
  type APIConnectOptions,
  APIConnectionError,
  type AudioBuffer,
  AudioByteStream,
  normalizeLanguage,
  shortuuid,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { RivaConnection } from './connection.js';
import { log } from './log.js';
import {
  type ModelConfigResponse,
  RivaSpeechRecognition,
  type RivaSpeechRecognitionClient,
  type StreamingRecognizeResponse,
} from './proto.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081';
const DEFAULT_MODEL = 'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer';
const USAGE_REPORT_INTERVAL_IN_S = 5;

/** Options for NVIDIA Riva speech-to-text. */
export interface STTOptions {
  /** NVIDIA API key. Defaults to `NVIDIA_API_KEY`; required when `useSsl` is true. */
  apiKey?: string;
  /** Riva streaming ASR model name. */
  model: string;
  /** NVIDIA Cloud Functions ID sent as the `function-id` metadata. */
  functionId: string;
  /** Whether Riva adds punctuation to transcripts. */
  punctuate: boolean;
  /** BCP-47 language code, such as `en-US`. */
  languageCode: string;
  /** Sample rate of the audio sent to Riva, in Hz. */
  sampleRate: number;
  /** Riva gRPC server address as `host:port`. */
  server: string;
  /** Whether to connect with TLS. Disable for a locally hosted Riva NIM service. */
  useSsl: boolean;
}

const defaultSTTOptions: STTOptions = {
  model: DEFAULT_MODEL,
  functionId: DEFAULT_FUNCTION_ID,
  punctuate: true,
  languageCode: 'en-US',
  sampleRate: 16000,
  server: DEFAULT_SERVER,
  useSsl: true,
};

const connections = new WeakMap<STT, RivaConnection<RivaSpeechRecognitionClient>>();

/** Streaming speech-to-text backed by NVIDIA Riva. */
export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'nvidia.STT';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'NVIDIA';
  }

  /**
   * Create a Riva STT client.
   *
   * @throws Error when `useSsl` is true and no API key is available.
   */
  constructor(opts: Partial<STTOptions> = {}) {
    const resolvedOpts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey: opts.apiKey || process.env.NVIDIA_API_KEY,
    };
    super({ streaming: true, interimResults: true });
    connections.set(this, new RivaConnection(resolvedOpts, RivaSpeechRecognition));
    this.#opts = resolvedOpts;
    log().debug({ model: this.#opts.model, server: this.#opts.server }, 'Initializing NVIDIA STT');
  }

  async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('NVIDIA STT supports streaming recognition only');
  }

  /** Open a streaming recognition session, optionally overriding the language. */
  stream(options?: { language?: string; connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(
      this,
      { ...this.#opts, languageCode: options?.language ?? this.#opts.languageCode },
      options?.connOptions,
    );
  }

  /** List the server's online ASR models, grouped by language code. */
  async listModels(): Promise<Record<string, { model: string[] }[]>> {
    const session = connections.get(this)!;
    const client = await session.pool.get();
    try {
      const response = await new Promise<ModelConfigResponse>((resolve, reject) => {
        client.GetRivaSpeechRecognitionConfig({}, session.metadata, (error, value) =>
          error ? reject(error) : resolve(value),
        );
      });
      const result: Record<string, { model: string[] }[]> = {};
      for (const config of response.modelConfig) {
        if (config.parameters['type'] !== 'online') continue;
        const language = config.parameters['language_code'];
        if (!language || !config.modelName) continue;
        (result[language] ??= []).push({ model: [config.modelName] });
      }
      return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    } finally {
      session.pool.remove(client);
    }
  }

  /** Close all provider channels after its streams have finished. */
  override async close(): Promise<void> {
    await connections.get(this)!.pool.close();
    await super.close();
  }
}

/**
 * A streaming recognition session. Each connection attempt opens one Riva `StreamingRecognize`
 * call; audio sent to a failed call is not replayed.
 */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #speaking = false;
  #requestId = '';
  #unreportedSamples = 0;
  #connection: RivaConnection<RivaSpeechRecognitionClient>;
  label = 'nvidia.SpeechStream';

  constructor(instance: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(instance, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#connection = connections.get(instance)!;
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    const client = await this.#connection.pool.get();
    try {
      await this.#run(client);
    } finally {
      this.#connection.pool.remove(client);
    }
  }

  async #run(client: RivaSpeechRecognitionClient): Promise<void> {
    if (this.abortSignal.aborted) return;
    // A new call has no recognition context from a failed one: start the next utterance fresh.
    this.#speaking = false;
    this.#requestId = '';
    const call = client.StreamingRecognize(this.#connection.metadata);
    let inputEnded = false;
    const cancel = () => call.cancel();
    this.abortSignal.addEventListener('abort', cancel, { once: true });

    call.write({
      streamingConfig: {
        config: {
          encoding: 'LINEAR_PCM',
          sampleRateHertz: this.#opts.sampleRate,
          languageCode: this.#opts.languageCode,
          maxAlternatives: 1,
          enableAutomaticPunctuation: this.#opts.punctuate,
          audioChannelCount: 1,
          enableWordTimeOffsets: true,
          model: this.#opts.model,
        },
        interimResults: true,
      },
    });

    const receive = new Promise<void>((resolve, reject) => {
      call.on('data', (response: StreamingRecognizeResponse) => this.#handleResponse(response));
      call.on('end', () => {
        if (inputEnded || this.abortSignal.aborted) resolve();
        else
          reject(new APIConnectionError({ message: 'NVIDIA STT connection closed unexpectedly' }));
      });
      call.on('error', (error: ServiceError) => {
        if (this.abortSignal.aborted) resolve();
        else
          reject(
            new APIConnectionError({
              message: `NVIDIA STT stream failed: ${error.message}`,
              options: {
                retryable: ![
                  status.INVALID_ARGUMENT,
                  status.PERMISSION_DENIED,
                  status.UNAUTHENTICATED,
                ].includes(error.code),
              },
            }),
          );
      });
    });

    const attempt = new AbortController();
    const send = async () => {
      const stream = new AudioByteStream(this.#opts.sampleRate, 1, this.#opts.sampleRate / 10);
      while (true) {
        const item = await this.input.next({ signal: attempt.signal });
        if (item.done) break;
        const data = item.value;
        if (data === SpeechStream.FLUSH_SENTINEL) break;
        for (const frame of stream.write(data.data)) {
          this.#sendFrame(call, frame);
        }
      }
      for (const frame of stream.flush()) this.#sendFrame(call, frame);
      inputEnded = true;
      call.end();
    };
    const sendPromise = send();

    try {
      await Promise.all([sendPromise, receive]);
    } finally {
      attempt.abort();
      call.cancel();
      await sendPromise.catch(() => {});
      this.abortSignal.removeEventListener('abort', cancel);
      this.#reportUsage();
    }
  }

  #sendFrame(
    call: ReturnType<RivaSpeechRecognitionClient['StreamingRecognize']>,
    frame: AudioFrame,
  ): void {
    call.write({
      audioContent: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    });
    this.#unreportedSamples += frame.samplesPerChannel;
    if (this.#unreportedSamples >= this.#opts.sampleRate * USAGE_REPORT_INTERVAL_IN_S) {
      this.#reportUsage();
    }
  }

  /** Report the audio sent since the last report as billed recognition usage. */
  #reportUsage(): void {
    if (!this.#unreportedSamples || this.queue.closed) return;
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: { audioDuration: this.#unreportedSamples / this.#opts.sampleRate },
    });
    this.#unreportedSamples = 0;
  }

  #handleResponse(response: StreamingRecognizeResponse): void {
    for (const result of response.results) {
      const alternative = result.alternatives[0];
      const transcript = alternative?.transcript?.trim();
      if (!alternative || !transcript) continue;

      if (!this.#speaking) {
        this.#speaking = true;
        this.#requestId = shortuuid();
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      this.#requestId = response.id?.value || this.#requestId;

      const words = alternative.words;
      const speechData: stt.SpeechData = {
        language: normalizeLanguage(this.#opts.languageCode),
        startTime: (words[0]?.startTime ?? 0) / 1000 + this.startTimeOffset,
        endTime: (words.at(-1)?.endTime ?? 0) / 1000 + this.startTimeOffset,
        confidence: alternative.confidence,
        text: transcript,
      };

      this.queue.put({
        type: result.isFinal
          ? stt.SpeechEventType.FINAL_TRANSCRIPT
          : stt.SpeechEventType.INTERIM_TRANSCRIPT,
        requestId: this.#requestId,
        alternatives: [speechData],
      });

      if (result.isFinal) {
        this.#speaking = false;
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    }
  }
}
