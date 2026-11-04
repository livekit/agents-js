// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ServiceError } from '@grpc/grpc-js';
import {
  type APIConnectOptions,
  APIConnectionError,
  type AudioBuffer,
  AudioByteStream,
  createTimedString,
  normalizeLanguage,
  shortuuid,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { RivaConnection, toAPIConnectionError } from './connection.js';
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
  /** Label final transcripts with a speaker ID. Requires a Sortformer-based model. */
  enableDiarization: boolean;
  /** Upper bound on distinct speakers for diarization; 0 lets Riva decide. */
  maxSpeakerCount: number;
}

const defaultSTTOptions: STTOptions = {
  model: DEFAULT_MODEL,
  functionId: DEFAULT_FUNCTION_ID,
  punctuate: true,
  languageCode: 'en-US',
  sampleRate: 16000,
  server: DEFAULT_SERVER,
  useSsl: true,
  enableDiarization: false,
  maxSpeakerCount: 0,
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
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
      diarization: resolvedOpts.enableDiarization,
    });
    connections.set(this, new RivaConnection(resolvedOpts, RivaSpeechRecognition));
    this.#opts = resolvedOpts;
    if (resolvedOpts.enableDiarization && !resolvedOpts.model.includes('sortformer')) {
      log().warn(
        { model: resolvedOpts.model },
        'Speaker diarization is enabled but the model may not support it; diarization requires a Sortformer-based model',
      );
    }
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
    // Like the Python plugin, an utterance open when a call fails stays open: the next call's
    // final transcript ends it, so START_OF_SPEECH is never emitted twice in a row.
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
          ...(this.#opts.enableDiarization && {
            diarizationConfig: {
              enableSpeakerDiarization: true,
              maxSpeakerCount: this.#opts.maxSpeakerCount,
            },
          }),
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
        else reject(toAPIConnectionError(error, 'NVIDIA STT stream failed'));
      });
    });

    const attempt = new AbortController();
    const send = async () => {
      const stream = new AudioByteStream(
        this.#opts.sampleRate,
        1,
        Math.floor(this.#opts.sampleRate / 10),
      );
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
      if (!alternative) continue;
      this.markProviderProgress();
      const transcript = alternative.transcript?.trim();
      if (!transcript) continue;

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
        speakerId:
          this.#opts.enableDiarization && result.isFinal ? dominantSpeaker(words) : undefined,
        words: words.length
          ? words.map((word) =>
              createTimedString({
                text: word.word,
                // Riva word offsets are milliseconds; transcript times are seconds.
                startTime: word.startTime / 1000 + this.startTimeOffset,
                endTime: word.endTime / 1000 + this.startTimeOffset,
                confidence: word.confidence,
                startTimeOffset: this.startTimeOffset,
              }),
            )
          : undefined,
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

/** The speaker tagged on most words, as `S<tag>`, matching the Python plugin. */
function dominantSpeaker(words: { speakerTag: number }[]): string | undefined {
  const counts = new Map<number, number>();
  for (const { speakerTag } of words) counts.set(speakerTag, (counts.get(speakerTag) ?? 0) + 1);
  let best: number | undefined;
  for (const [tag, count] of counts) {
    if (best === undefined || count > counts.get(best)!) best = tag;
  }
  return best === undefined ? undefined : `S${best}`;
}
