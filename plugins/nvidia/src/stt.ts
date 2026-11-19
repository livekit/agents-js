// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as grpc from '@grpc/grpc-js';
import {
  type APIConnectOptions,
  APIConnectionError,
  type APIError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  createTimedString,
  delay,
  intervalForRetry,
  mergeFrames,
  normalizeLanguage,
  shortuuid,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { RivaConnection, toAPIError } from './connection.js';
import { log } from './log.js';
import {
  type ModelConfigResponse,
  type EndpointingConfig as ProtoEndpointingConfig,
  type RecognitionConfig,
  type RecognizeResponse,
  RivaSpeechRecognition,
  type RivaSpeechRecognitionClient,
  type StreamingRecognizeRequest,
  type StreamingRecognizeResponse,
} from './proto.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081';
const DEFAULT_MODEL = 'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer';
const MAX_REPLAY_AUDIO_SECONDS = 30;
const PCM_BYTES_PER_SAMPLE = 2;
const USAGE_REPORT_INTERVAL_IN_S = 5;

export type STTInferenceMode = 'auto' | 'streaming' | 'offline';

/** NVIDIA Speech endpoint detection settings for streaming recognition. */
export interface EndpointingConfig {
  /** Endpointing preset. `lowLatency` applies NVIDIA's low-latency defaults. */
  mode?: 'lowLatency';
  startHistory?: number;
  startThreshold?: number;
  stopHistory?: number;
  stopThreshold?: number;
  stopHistoryEou?: number;
  stopThresholdEou?: number;
}

/** Provider-specific recognition configuration passed directly on the Riva wire protocol. */
export interface STTProviderOptions {
  recognitionConfig?: Record<string, unknown>;
  customConfiguration?: Record<string, string>;
}

/** Options for NVIDIA Speech speech-to-text. */
export interface STTOptions {
  apiKey?: string;
  model: string;
  functionId: string;
  punctuate: boolean;
  languageCode: string;
  sampleRate: number;
  server: string;
  useSsl: boolean;
  enableDiarization: boolean;
  maxSpeakerCount: number;
  interimResults: boolean;
  profanityFilter: boolean;
  verbatimTranscripts: boolean;
  boostedLmWords?: string[];
  boostedLmScore: number;
  endpointing?: EndpointingConfig;
  options: STTProviderOptions;
  enableWordTimeOffsets: boolean;
  inferenceMode: STTInferenceMode;
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
  interimResults: true,
  profanityFilter: false,
  verbatimTranscripts: false,
  boostedLmScore: 4,
  options: {},
  enableWordTimeOffsets: true,
  inferenceMode: 'auto',
};

const connections = new WeakMap<STT, RivaConnection<RivaSpeechRecognitionClient>>();

/** Streaming and offline speech-to-text backed by NVIDIA Speech. */
export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'nvidia.STT';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'NVIDIA Speech';
  }

  constructor(opts: Partial<STTOptions> = {}) {
    const resolvedOpts: STTOptions = {
      ...defaultSTTOptions,
      ...opts,
      options: { ...defaultSTTOptions.options, ...opts.options },
      apiKey: opts.apiKey || process.env.NVIDIA_API_KEY,
    };
    if (!['auto', 'streaming', 'offline'].includes(resolvedOpts.inferenceMode)) {
      throw new Error("inferenceMode must be 'auto', 'streaming', or 'offline'");
    }
    const supportsStreaming = resolvedOpts.inferenceMode !== 'offline';
    super({
      streaming: supportsStreaming,
      interimResults: supportsStreaming && resolvedOpts.interimResults,
      offlineRecognize: resolvedOpts.inferenceMode !== 'streaming',
      alignedTranscript: resolvedOpts.enableWordTimeOffsets ? 'word' : false,
      diarization: resolvedOpts.enableDiarization,
    });
    connections.set(this, new RivaConnection(resolvedOpts, RivaSpeechRecognition));
    this.#opts = resolvedOpts;
    if (
      resolvedOpts.enableDiarization &&
      !resolvedOpts.model.toLowerCase().includes('sortformer')
    ) {
      log().warn(
        { model: resolvedOpts.model },
        'Speaker diarization is enabled but the model may not support it; diarization requires a Sortformer-based model',
      );
    }
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    if (this.#opts.inferenceMode === 'streaming') {
      throw new Error(
        "recognize() requires inferenceMode: 'offline'; use stream() for streaming models",
      );
    }
    if (abortSignal?.aborted) {
      throw new APIConnectionError({
        message: 'NVIDIA Speech offline STT was cancelled',
        options: { retryable: false },
      });
    }
    const frame = mergeFrames(buffer);
    const session = connections.get(this)!;
    const client = await session.pool.get();
    try {
      const response = await new Promise<RecognizeResponse>((resolve, reject) => {
        let cancel = () => {};
        const call = client.Recognize(
          {
            config: this.#recognitionConfig(
              this.#opts.languageCode,
              frame.sampleRate,
              frame.channels,
            ),
            audio: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
          },
          session.metadata,
          {},
          (error, value) => {
            abortSignal?.removeEventListener('abort', cancel);
            error ? reject(toAPIError(error, 'NVIDIA Speech offline STT')) : resolve(value);
          },
        );
        cancel = () => call.cancel();
        abortSignal?.addEventListener('abort', cancel, { once: true });
      });
      return responseToSpeechEvent(response, this.#opts.languageCode, this.#opts.enableDiarization);
    } finally {
      session.pool.put(client);
    }
  }

  /** Open a streaming recognition session, optionally overriding the language. */
  stream(options?: { language?: string; connOptions?: APIConnectOptions }): SpeechStream {
    if (this.#opts.inferenceMode === 'offline') {
      throw new Error(
        "stream() requires inferenceMode: 'streaming'; use recognize() for offline models",
      );
    }
    return new SpeechStream(
      this,
      { ...this.#opts, languageCode: options?.language ?? this.#opts.languageCode },
      this.#streamingConfig(options?.language ?? this.#opts.languageCode),
      options?.connOptions,
    );
  }

  /** List ASR models compatible with the selected inference mode, grouped by locale. */
  async listModels(): Promise<Record<string, { model: string[] }[]>> {
    const session = connections.get(this)!;
    const client = await session.pool.get();
    try {
      const response = await new Promise<ModelConfigResponse>((resolve, reject) => {
        client.GetRivaSpeechRecognitionConfig({}, session.metadata, (error, value) =>
          error ? reject(toAPIError(error, 'NVIDIA Speech model listing')) : resolve(value),
        );
      });
      const result: Record<string, { model: string[] }[]> = {};
      const expectedType = this.#opts.inferenceMode === 'streaming' ? 'online' : 'offline';
      for (const config of response.modelConfig) {
        if (this.#opts.inferenceMode !== 'auto' && config.parameters['type'] !== expectedType) {
          continue;
        }
        const language = config.parameters['language_code'];
        if (!language || !config.modelName) continue;
        (result[language] ??= []).push({ model: [config.modelName] });
      }
      return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    } finally {
      session.pool.put(client);
    }
  }

  #streamingConfig(languageCode: string): StreamingRecognizeRequest {
    return {
      streamingConfig: {
        config: this.#recognitionConfig(languageCode, this.#opts.sampleRate, 1),
        interimResults: this.#opts.interimResults,
      },
    };
  }

  #recognitionConfig(
    languageCode: string,
    sampleRateHertz: number,
    audioChannelCount: number,
  ): RecognitionConfig {
    const config: RecognitionConfig = {
      encoding: 'LINEAR_PCM',
      sampleRateHertz,
      languageCode,
      maxAlternatives: 1,
      profanityFilter: this.#opts.profanityFilter,
      speechContexts: this.#opts.boostedLmWords?.length
        ? [{ phrases: this.#opts.boostedLmWords, boost: this.#opts.boostedLmScore }]
        : [],
      audioChannelCount,
      enableWordTimeOffsets: this.#opts.enableWordTimeOffsets,
      enableAutomaticPunctuation: this.#opts.punctuate,
      model: this.#opts.model,
      verbatimTranscripts: this.#opts.verbatimTranscripts,
      customConfiguration: this.#opts.options.customConfiguration ?? {},
      ...(this.#opts.enableDiarization && {
        diarizationConfig: {
          enableSpeakerDiarization: true,
          maxSpeakerCount: this.#opts.maxSpeakerCount,
        },
      }),
      ...(this.#opts.endpointing && {
        endpointingConfig: endpointingValues(this.#opts.endpointing),
      }),
      ...(this.#opts.options.recognitionConfig as Partial<RecognitionConfig>),
    };
    return config;
  }

  override async close(): Promise<void> {
    await connections.get(this)!.pool.close();
    await super.close();
  }
}

interface RecognitionAttempt {
  call: grpc.ClientDuplexStream<StreamingRecognizeRequest, StreamingRecognizeResponse>;
  done: Promise<void>;
  chunks: Buffer[];
  replayBytes: number;
  audioBytes: number;
  startTimeOffset: number;
  finalReceived: boolean;
  finalEmitted: boolean;
  inputEnded: boolean;
  settled: boolean;
  error?: APIError;
}

/** A reusable streaming recognition session. Flush ends one Riva RPC and starts another. */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #speaking = false;
  #requestId = '';
  #unreportedSamples = 0;
  #connection: RivaConnection<RivaSpeechRecognitionClient>;
  #streamingConfig: StreamingRecognizeRequest;
  #connOptions: APIConnectOptions;
  #maxReplayBytes: number;
  #inputSamples = 0;
  label = 'nvidia.SpeechStream';

  constructor(
    instance: STT,
    opts: STTOptions,
    streamingConfig: object,
    connOptions?: APIConnectOptions,
  ) {
    super(instance, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#connection = connections.get(instance)!;
    this.#streamingConfig = streamingConfig as StreamingRecognizeRequest;
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    this.#maxReplayBytes = opts.sampleRate * PCM_BYTES_PER_SAMPLE * MAX_REPLAY_AUDIO_SECONDS;
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    const client = await this.#connection.pool.get();
    let active: RecognitionAttempt | undefined;
    let retries = 0;
    let input = this.input.next({ signal: this.abortSignal });
    try {
      while (!this.abortSignal.aborted) {
        let winner = await Promise.race([
          input.then((value) => ({ kind: 'input' as const, value })),
          ...(active
            ? [
                active.done.then(
                  () => ({ kind: 'done' as const }),
                  (error: APIError) => ({ kind: 'error' as const, error }),
                ),
              ]
            : []),
        ]);

        if (winner.kind === 'input') {
          if (winner.value.done) {
            if (active) await this.#finishSegment(client, active);
            break;
          }
          const data = winner.value.value;
          if (data === SpeechStream.FLUSH_SENTINEL) {
            if (active) await this.#finishSegment(client, active);
            active = undefined;
            retries = 0;
            this.#finishSpeechSegment();
          } else {
            active ??= this.#startAttempt(
              client,
              this.startTimeOffset + this.#inputSamples / this.#opts.sampleRate,
            );
            this.#sendFrame(active, data);
            this.#inputSamples += data.samplesPerChannel;
          }
          input = this.input.next({ signal: this.abortSignal });
          if (!active?.settled) continue;
          winner = active.error
            ? { kind: 'error' as const, error: active.error }
            : { kind: 'done' as const };
        }

        if (!active) continue;
        const failed = active;
        const error = winner.kind === 'error' ? winner.error : undefined;
        if (error && !error.retryable) throw error;
        if (failed.finalReceived) retries = 0;
        const cleanAfterProgress = !error && failed.finalReceived;
        if (!cleanAfterProgress && retries >= this.#connOptions.maxRetry) {
          throw new APIConnectionError({
            message: `NVIDIA Speech streaming STT ${error ? 'failed' : 'ended unexpectedly'} after ${retries + 1} attempts`,
            options: { retryable: false },
          });
        }
        if (!cleanAfterProgress) {
          await delay(intervalForRetry(this.#connOptions, retries), { signal: this.abortSignal });
          retries++;
        }
        active = this.#restartAttempt(client, failed);
      }
    } finally {
      active?.call.cancel();
      this.#reportUsage();
      this.#connection.pool.put(client);
    }
  }

  #startAttempt(client: RivaSpeechRecognitionClient, startTimeOffset: number): RecognitionAttempt {
    const call = client.StreamingRecognize(this.#connection.metadata);
    let resolveDone!: () => void;
    let rejectDone!: (error: APIError) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const attempt: RecognitionAttempt = {
      call,
      done,
      chunks: [],
      replayBytes: 0,
      audioBytes: 0,
      startTimeOffset,
      finalReceived: false,
      finalEmitted: false,
      inputEnded: false,
      settled: false,
    };
    let settled = false;
    const settle = (error?: APIError) => {
      if (settled) return;
      settled = true;
      attempt.settled = true;
      attempt.error = error;
      error ? rejectDone(error) : resolveDone();
    };
    call.on('data', (response: StreamingRecognizeResponse) => {
      if (this.#handleResponse(response, attempt.startTimeOffset)) {
        attempt.finalReceived = true;
        attempt.finalEmitted = true;
        attempt.chunks = [];
        attempt.replayBytes = 0;
      }
    });
    call.on('end', () => settle());
    call.on('error', (error: grpc.ServiceError) => {
      if (this.abortSignal.aborted) settle();
      else settle(toAPIError(error, 'NVIDIA Speech streaming STT'));
    });
    const cancel = () => call.cancel();
    this.abortSignal.addEventListener('abort', cancel, { once: true });
    void done.finally(() => this.abortSignal.removeEventListener('abort', cancel)).catch(() => {});
    call.write(this.#streamingConfig);
    return attempt;
  }

  #sendFrame(attempt: RecognitionAttempt, frame: AudioFrame): void {
    const chunk = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    attempt.call.write({ audioContent: chunk });
    attempt.chunks.push(chunk);
    attempt.replayBytes += chunk.length;
    attempt.audioBytes += chunk.length;
    attempt.finalEmitted = false;
    while (attempt.replayBytes > this.#maxReplayBytes) {
      const oldest = attempt.chunks.shift()!;
      const excess = attempt.replayBytes - this.#maxReplayBytes;
      if (oldest.length > excess) attempt.chunks.unshift(oldest.subarray(excess));
      attempt.replayBytes -= Math.min(oldest.length, excess);
    }
    this.#unreportedSamples += frame.samplesPerChannel;
    if (this.#unreportedSamples >= this.#opts.sampleRate * USAGE_REPORT_INTERVAL_IN_S) {
      this.#reportUsage();
    }
  }

  #restartAttempt(
    client: RivaSpeechRecognitionClient,
    failed: RecognitionAttempt,
  ): RecognitionAttempt {
    failed.call.cancel();
    const replayOffset =
      failed.startTimeOffset +
      (failed.audioBytes - failed.replayBytes) / (this.#opts.sampleRate * PCM_BYTES_PER_SAMPLE);
    const next = this.#startAttempt(client, replayOffset);
    for (const chunk of failed.chunks) {
      next.call.write({ audioContent: chunk });
      next.chunks.push(chunk);
      next.replayBytes += chunk.length;
      next.audioBytes += chunk.length;
    }
    return next;
  }

  async #finishSegment(
    client: RivaSpeechRecognitionClient,
    initial: RecognitionAttempt,
  ): Promise<void> {
    let attempt = initial;
    let retries = 0;
    while (true) {
      if (!attempt.inputEnded) {
        attempt.inputEnded = true;
        attempt.call.end();
      }
      try {
        await attempt.done;
        return;
      } catch (error) {
        const apiError = error as APIError;
        if (attempt.finalEmitted && attempt.replayBytes === 0) return;
        if (!apiError.retryable) throw apiError;
        if (retries >= this.#connOptions.maxRetry) {
          throw new APIConnectionError({
            message: `NVIDIA Speech streaming STT failed after ${retries + 1} attempts`,
            options: { retryable: false },
          });
        }
        await delay(intervalForRetry(this.#connOptions, retries), { signal: this.abortSignal });
        retries++;
        attempt = this.#restartAttempt(client, attempt);
      }
    }
  }

  #finishSpeechSegment(): void {
    if (this.#speaking) {
      this.#speaking = false;
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    }
    this.#requestId = '';
  }

  #reportUsage(): void {
    if (!this.#unreportedSamples || this.queue.closed) return;
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: { audioDuration: this.#unreportedSamples / this.#opts.sampleRate },
    });
    this.#unreportedSamples = 0;
  }

  #handleResponse(response: StreamingRecognizeResponse, startTimeOffset: number): boolean {
    let finalEmitted = false;
    this.#requestId = response.id?.value || shortuuid();
    for (const result of response.results) {
      const alternative = result.alternatives[0];
      if (!alternative) continue;
      this.markProviderProgress();
      const transcript = alternative.transcript?.trim();
      if (!transcript) continue;
      if (!this.#speaking) {
        this.#speaking = true;
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      this.queue.put({
        type: result.isFinal
          ? stt.SpeechEventType.FINAL_TRANSCRIPT
          : stt.SpeechEventType.INTERIM_TRANSCRIPT,
        requestId: this.#requestId,
        alternatives: [
          alternativeToSpeechData(
            alternative,
            this.#opts.languageCode,
            startTimeOffset,
            this.#opts.enableDiarization && result.isFinal,
          ),
        ],
      });
      if (result.isFinal) {
        finalEmitted = true;
        this.#speaking = false;
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    }
    return finalEmitted;
  }
}

function endpointingValues(endpointing: EndpointingConfig): ProtoEndpointingConfig {
  if (endpointing.mode !== undefined && endpointing.mode !== 'lowLatency') {
    throw new Error(`Unsupported NVIDIA endpointing mode: ${String(endpointing.mode)}`);
  }
  return {
    startHistory: endpointing.startHistory ?? -1,
    startThreshold: endpointing.startThreshold ?? -1,
    stopHistory: endpointing.stopHistory ?? 500,
    stopThreshold: endpointing.stopThreshold ?? -1,
    stopHistoryEou: endpointing.stopHistoryEou ?? 240,
    stopThresholdEou: endpointing.stopThresholdEou ?? -1,
  };
}

function responseToSpeechEvent(
  response: RecognizeResponse,
  languageCode: string,
  enableDiarization: boolean,
): stt.SpeechEvent {
  const results = response.results.filter((result) => result.alternatives.length > 0);
  const count = Math.max(0, ...results.map((result) => result.alternatives.length));
  const alternatives = Array.from({ length: count }, (_, index) =>
    combineAlternatives(
      results.flatMap((result) => result.alternatives[index] ?? []),
      languageCode,
      0,
      enableDiarization,
    ),
  );
  const eventAlternatives: [stt.SpeechData, ...stt.SpeechData[]] = alternatives.length
    ? (alternatives as [stt.SpeechData, ...stt.SpeechData[]])
    : [
        {
          language: normalizeLanguage(languageCode),
          text: '',
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ];
  return {
    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
    requestId: response.id?.value || shortuuid(),
    alternatives: eventAlternatives,
  };
}

function combineAlternatives(
  alternatives: StreamingRecognizeResponse['results'][number]['alternatives'],
  languageCode: string,
  startTimeOffset: number,
  diarize: boolean,
): stt.SpeechData {
  const words = alternatives.flatMap((alternative) => alternative.words);
  const confidences = alternatives.map((alternative) => alternative.confidence);
  return {
    language: normalizeLanguage(languageCode),
    text: alternatives
      .map((alternative) => alternative.transcript.trim())
      .filter(Boolean)
      .join(' '),
    startTime: (words[0]?.startTime ?? 0) / 1000 + startTimeOffset,
    endTime: (words.at(-1)?.endTime ?? 0) / 1000 + startTimeOffset,
    confidence: confidences.length
      ? confidences.reduce((total, value) => total + value, 0) / confidences.length
      : 0,
    speakerId: diarize ? dominantSpeaker(words) : undefined,
    words: words.length
      ? words.map((word) =>
          createTimedString({
            text: word.word,
            startTime: word.startTime / 1000 + startTimeOffset,
            endTime: word.endTime / 1000 + startTimeOffset,
            confidence: word.confidence,
            startTimeOffset,
            speakerId: diarize && word.speakerTag > 0 ? `S${word.speakerTag}` : undefined,
          }),
        )
      : undefined,
  };
}

function alternativeToSpeechData(
  alternative: StreamingRecognizeResponse['results'][number]['alternatives'][number],
  languageCode: string,
  startTimeOffset: number,
  diarize: boolean,
): stt.SpeechData {
  return combineAlternatives([alternative], languageCode, startTimeOffset, diarize);
}

function dominantSpeaker(words: { speakerTag: number }[]): string | undefined {
  const counts = new Map<number, number>();
  for (const { speakerTag } of words) {
    if (speakerTag > 0) counts.set(speakerTag, (counts.get(speakerTag) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [tag, count] of counts) {
    if (best === undefined || count > counts.get(best)!) best = tag;
  }
  return best === undefined ? undefined : `S${best}`;
}
