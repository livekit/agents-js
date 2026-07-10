// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  LanguageCode,
  PartialResultsStability,
  Result,
  StartStreamTranscriptionCommandInput,
  AudioStream as TranscribeAudioStream,
  TranscriptEvent,
  TranscriptResultStream,
  VocabularyFilterMethod,
} from '@aws-sdk/client-transcribe-streaming';
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from '@aws-sdk/client-transcribe-streaming';
import {
  type APIConnectOptions,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  createTimedString,
  log,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import {
  type AwsCredentials,
  createRequestSignal,
  resolveRegion,
  stripUndefined,
  toAwsApiError,
} from './utils.js';

/** @public */
export interface STTOptions {
  sampleRate: number;
  language?: LanguageCode;
  region?: string;
  credentials?: AwsCredentials;
  vocabularyName?: string;
  sessionId?: string;
  vocabFilterMethod?: VocabularyFilterMethod;
  vocabFilterName?: string;
  showSpeakerLabel?: boolean;
  enableChannelIdentification?: boolean;
  numberOfChannels?: number;
  enablePartialResultsStabilization?: boolean;
  partialResultsStability?: PartialResultsStability;
  languageModelName?: string;
  identifyLanguage?: boolean;
  identifyMultipleLanguages?: boolean;
  /**
   * Comma-separated language codes Amazon Transcribe should consider when automatic
   * language identification is enabled. Required when {@link STTOptions.identifyLanguage} or
   * {@link STTOptions.identifyMultipleLanguages} is true (AWS rejects the request without it).
   */
  languageOptions?: string;
  preferredLanguage?: LanguageCode;
  vocabularyNames?: string;
  vocabularyFilterNames?: string;
  client?: TranscribeStreamingClient;
}

/**
 * HTTP status codes for exception members of {@link TranscriptResultStream}. These arrive
 * as event-stream union members rather than thrown SDK errors, so they have no
 * `$metadata.httpStatusCode` to read.
 */
const STREAM_EXCEPTION_STATUS: Record<string, number> = {
  BadRequestException: 400,
  LimitExceededException: 429,
  InternalFailureException: 500,
  ConflictException: 409,
  ServiceUnavailableException: 503,
};

const defaultSTTOptions: Pick<STTOptions, 'sampleRate' | 'language'> = {
  sampleRate: 24000,
  language: 'en-US',
};

/** Invalidated the instant its session ends, so a superseded audio generator stops pulling. */
interface SessionToken {
  active: boolean;
  audioSent: boolean;
}

/** Amazon Transcribe reports this after ~15s of stream inactivity; it's not a hard failure. */
function isIdleTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'BadRequestException' &&
    (error.message ?? '').startsWith('Your request timed out')
  );
}

/**
 * Amazon Transcribe streaming STT.
 *
 * @remarks
 * Streaming only — {@link STT.stream} is the sole recognition entrypoint, matching Amazon
 * Transcribe's streaming-only API surface.
 * @public
 */
export class STT extends stt.STT {
  #opts: STTOptions;
  #client: TranscribeStreamingClient;
  #ownsClient: boolean;
  label = 'aws.STT';

  get model(): string {
    return this.#opts.languageModelName ?? 'unknown';
  }

  get provider(): string {
    return 'Amazon Transcribe';
  }

  /**
   * Create a new instance of Amazon Transcribe streaming STT.
   *
   * @remarks
   * Credentials are resolved via the AWS SDK v3 default credential chain (environment
   * variables, shared config/credentials files, IMDS, etc.) unless `credentials` is provided
   * explicitly. The region is resolved from `region`, then `AWS_REGION`, then
   * `AWS_DEFAULT_REGION`, falling back to `us-east-1`.
   */
  constructor(opts: Partial<STTOptions> = {}) {
    const enableChannelIdentification = opts.enableChannelIdentification ?? false;
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
      diarization: Boolean(opts.showSpeakerLabel || enableChannelIdentification),
    });

    if (opts.identifyLanguage && opts.identifyMultipleLanguages) {
      throw new Error(
        'identifyLanguage and identifyMultipleLanguages are mutually exclusive; set only one to true',
      );
    }

    const identifyLanguage = opts.identifyLanguage ?? false;
    const identifyMultipleLanguages = opts.identifyMultipleLanguages ?? false;

    if (opts.showSpeakerLabel && enableChannelIdentification) {
      throw new Error(
        'showSpeakerLabel and enableChannelIdentification are mutually exclusive; set only one to true',
      );
    }

    // StartStreamTranscription requires LanguageOptions whenever either identify flag is set;
    // without it AWS returns BadRequest, so fail fast at construction with a clear message.
    if ((identifyLanguage || identifyMultipleLanguages) && !opts.languageOptions) {
      throw new Error(
        'languageOptions is required when identifyLanguage or identifyMultipleLanguages is true ' +
          '(comma-separated language codes Amazon Transcribe should consider, e.g. "en-US,es-US")',
      );
    }

    if ((identifyLanguage || identifyMultipleLanguages) && opts.languageModelName) {
      throw new Error(
        'languageModelName cannot be used with identifyLanguage or identifyMultipleLanguages ' +
          '(Amazon Transcribe streaming language identification does not support custom language models)',
      );
    }

    // EnableChannelIdentification and NumberOfChannels must be supplied together; streaming
    // Transcribe supports two channels. Default numberOfChannels to 2 when identification is
    // enabled without an explicit value, and reject the inverse (channels without identification).
    let numberOfChannels = opts.numberOfChannels;
    if (enableChannelIdentification && numberOfChannels === undefined) {
      numberOfChannels = 2;
    } else if (!enableChannelIdentification && numberOfChannels !== undefined) {
      throw new Error(
        'numberOfChannels requires enableChannelIdentification to be true ' +
          '(Amazon Transcribe rejects NumberOfChannels without EnableChannelIdentification)',
      );
    } else if (enableChannelIdentification && numberOfChannels !== 2) {
      throw new Error(
        'numberOfChannels must be 2 when enableChannelIdentification is true ' +
          '(Amazon Transcribe streaming supports two channels)',
      );
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      identifyLanguage,
      identifyMultipleLanguages,
      enableChannelIdentification,
      numberOfChannels,
      // Auto language detection is mutually exclusive with a fixed language code.
      language:
        identifyLanguage || identifyMultipleLanguages
          ? undefined
          : opts.language ?? defaultSTTOptions.language,
    };

    this.#ownsClient = opts.client === undefined;
    this.#client =
      opts.client ??
      new TranscribeStreamingClient({
        region: resolveRegion(opts.region),
        credentials: opts.credentials,
        // The framework's own connOptions retry loop handles retries; disable the SDK's
        // internal retries so failures aren't retried twice (matches tts.ts's PollyClient).
        maxAttempts: 1,
      });
  }

  async close(): Promise<void> {
    if (this.#ownsClient) this.#client.destroy();
  }

  async _recognize(_frame: AudioBuffer, _abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    throw new Error(
      'Amazon Transcribe does not support single-frame recognition, use stream() instead',
    );
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, this.#client, options?.connOptions);
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #client: TranscribeStreamingClient;
  #timeoutMs: number;
  #logger = log();
  // Keyed by Transcribe's `ChannelId` (the empty string when channel identification is off,
  // i.e. single-channel audio) so a channel finishing its utterance can't spuriously flip
  // speaking state for another channel that's still mid-utterance in the same TranscriptEvent.
  #speakingChannels = new Set<string>();
  // Transcribe's StartTime/EndTime are cumulative from the start of the current streaming
  // *connection*, and reset to ~0 whenever a reconnect opens a new one. This offset
  // accumulates the last known end time of the previous connection so timestamps stay
  // monotonic across reconnects, on top of `this.startTimeOffset` (which compensates for the
  // framework creating a new SpeechStream instance, a separate concern).
  #connectionTimeOffset = 0;
  #lastKnownEndTime = 0;
  label = 'aws.SpeechStream';

  // `this.input` may only ever have a single active consumer (calling `.next()` from more
  // than one place races for frames). Transcribe's Node HTTP/2 request pipeline can leave an
  // abandoned session's `AudioStream` generator alive as a hidden consumer after a session
  // fails (the SDK doesn't reliably tear down the request side when the response side errors),
  // so a single long-lived pump owns `this.input` and feeds a single persistent
  // `#channel` for the lifetime of this stream — the channel itself is never replaced, so
  // no already-buffered frame can ever be orphaned on a session transition. Each session
  // instead reads through a token-guarded wrapper generator: the token is invalidated the
  // moment its session ends. Takes are serialised via `#frameTakeChain` so a superseded
  // generator that is mid-await requeues its frame for the active session rather than
  // dropping the start of the next utterance.
  #channel = new AsyncIterableQueue<Uint8Array>();
  #requeuedFrames: Uint8Array[] = [];
  #frameTakeChain: Promise<void> = Promise.resolve();
  #pumpStarted = false;

  constructor(
    stt: STT,
    opts: STTOptions,
    client: TranscribeStreamingClient,
    connOptions?: APIConnectOptions,
  ) {
    const resolvedConnOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    super(stt, opts.sampleRate, resolvedConnOptions);
    this.#opts = opts;
    this.#client = client;
    this.#timeoutMs = resolvedConnOptions.timeoutMs;
  }

  #startPump(): void {
    if (this.#pumpStarted) return;
    this.#pumpStarted = true;

    (async () => {
      for (;;) {
        const result = await this.input.next();
        if (result.done) {
          this.#channel.close();
          return;
        }
        const frame = result.value;
        if (frame === SpeechStream.FLUSH_SENTINEL) continue;
        this.#channel.put(
          new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
        );
      }
    })();
  }

  protected async run(): Promise<void> {
    this.#startPump();

    // Always attempt at least one session, even if the input already closed before run()
    // was scheduled (e.g. a very short utterance) — otherwise the final transcript would
    // never be requested.
    for (;;) {
      const token: SessionToken = { active: true, audioSent: false };
      try {
        await this.#runSession(this.#audioStreamGenerator(token));
      } catch (error) {
        token.active = false;

        if (this.closed) {
          return;
        }

        // Any session end (idle timeout, or a hard failure the base class will retry via a
        // fresh run() call) means the *next* session — whether started here or by a retried
        // run() — starts on a brand-new Transcribe connection with a reset clock and no
        // memory of in-flight utterances. Reset unconditionally so state from the failed
        // session can't leak into the next one: carry the previous connection's furthest
        // timestamp forward so reported times keep increasing, and clear speaking state so
        // the next session's first result re-emits START_OF_SPEECH.
        this.#connectionTimeOffset += this.#lastKnownEndTime;
        this.#lastKnownEndTime = 0;
        this.#speakingChannels.clear();

        if (isIdleTimeout(error)) {
          // AWS times out after 15s of inactivity, which tends to happen at the end of a
          // session once the input is gone. Reconnect unconditionally, matching the Python
          // plugin, rather than gating on input state.
          this.#logger.info('aws transcribe stt: idle timeout, restarting session');
          continue;
        }
        // Preserve APIStatusError (incl. non-retryable 4xx) so the base SpeechStream does not
        // treat client errors as retryable connection failures.
        // Once AWS has consumed audio, retrying run() cannot replay those frames from the
        // persistent channel. Treat the failure as terminal instead of letting a retry open a
        // new session that can complete successfully without ever transcribing the lost audio.
        throw toAwsApiError(error, 'aws transcribe stt', {
          retryable: !token.audioSent,
        });
      }

      // #runSession only returns without throwing once its audio generator drains
      // `#channel` to completion, which only happens after the pump closes it (input
      // exhausted) — so there's nothing left to reconnect for.
      token.active = false;
      return;
    }
  }

  async #runSession(audioStream: AsyncGenerator<TranscribeAudioStream>): Promise<void> {
    const input = stripUndefined({
      LanguageCode: this.#opts.language,
      MediaSampleRateHertz: this.#opts.sampleRate,
      MediaEncoding: 'pcm',
      AudioStream: audioStream,
      VocabularyName: this.#opts.vocabularyName,
      SessionId: this.#opts.sessionId,
      VocabularyFilterName: this.#opts.vocabFilterName,
      VocabularyFilterMethod: this.#opts.vocabFilterMethod,
      ShowSpeakerLabel: this.#opts.showSpeakerLabel,
      EnableChannelIdentification: this.#opts.enableChannelIdentification,
      NumberOfChannels: this.#opts.numberOfChannels,
      EnablePartialResultsStabilization: this.#opts.enablePartialResultsStabilization,
      PartialResultsStability: this.#opts.partialResultsStability,
      LanguageModelName: this.#opts.languageModelName,
      IdentifyLanguage: this.#opts.identifyLanguage,
      IdentifyMultipleLanguages: this.#opts.identifyMultipleLanguages,
      LanguageOptions: this.#opts.languageOptions,
      PreferredLanguage: this.#opts.preferredLanguage,
      VocabularyNames: this.#opts.vocabularyNames,
      VocabularyFilterNames: this.#opts.vocabularyFilterNames,
    }) as unknown as StartStreamTranscriptionCommandInput;

    const request = createRequestSignal(this.abortSignal, this.#timeoutMs);
    try {
      const response = await this.#client.send(new StartStreamTranscriptionCommand(input), {
        abortSignal: request.signal,
      });
      // `timeoutMs` bounds opening the long-lived stream, not the stream's total lifetime.
      request.clearTimeout();

      if (!response.TranscriptResultStream) {
        throw new Error('aws transcribe stt: no TranscriptResultStream in the response');
      }

      const requestId = response.$metadata?.requestId;
      for await (const event of response.TranscriptResultStream) {
        if (event.TranscriptEvent) {
          this.#processTranscriptEvent(event.TranscriptEvent, requestId);
          continue;
        }

        // Amazon Transcribe can deliver service failures as TranscriptResultStream union
        // members rather than thrown errors. Ignoring them lets the stream end "successfully"
        // with no transcript and no retry — surface them as API errors instead.
        this.#throwIfStreamException(event);
      }
    } catch (error) {
      if (request.didTimeout()) {
        throw new APITimeoutError({
          message: `aws transcribe stt: request timed out after ${this.#timeoutMs}ms`,
        });
      }
      throw error;
    } finally {
      request.dispose();
    }
  }

  /**
   * Maps a non-transcript event-stream member onto a thrown error so the session loop in
   * {@link run} can classify idle timeouts / retryable failures / hard client errors.
   */
  #throwIfStreamException(event: TranscriptResultStream): void {
    const entries: Array<
      [name: string, value: { Message?: string; message?: string } | undefined]
    > = [
      ['BadRequestException', event.BadRequestException],
      ['LimitExceededException', event.LimitExceededException],
      ['InternalFailureException', event.InternalFailureException],
      ['ConflictException', event.ConflictException],
      ['ServiceUnavailableException', event.ServiceUnavailableException],
    ];

    for (const [name, value] of entries) {
      if (!value) continue;

      const message = value.Message ?? value.message ?? name;

      // Preserve the idle-timeout shape so {@link isIdleTimeout} still recognises it and
      // the session reconnects rather than failing the stream.
      if (name === 'BadRequestException' && message.startsWith('Your request timed out')) {
        const err = new Error(message);
        err.name = 'BadRequestException';
        throw err;
      }

      throw new APIStatusError({
        message: `aws transcribe stt: ${message}`,
        options: {
          statusCode: STREAM_EXCEPTION_STATUS[name] ?? 500,
          body: value as object,
        },
      });
    }
  }

  /**
   * Exclusively take the next audio frame for `token`. Serialises readers so an abandoned
   * session generator cannot race the active one on `#channel`, and requeues a frame that
   * was dequeued after the token was invalidated so reconnects do not clip the next utterance.
   */
  async #takeFrame(token: SessionToken): Promise<IteratorResult<Uint8Array>> {
    const outcome: IteratorResult<Uint8Array> = { value: undefined, done: true };

    const previous = this.#frameTakeChain;
    let release!: () => void;
    this.#frameTakeChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      if (!token.active) {
        return outcome;
      }

      if (this.#requeuedFrames.length > 0) {
        return { value: this.#requeuedFrames.shift()!, done: false };
      }

      const result = await this.#channel.next();
      // Invalidated while awaiting — stash the frame for the active session instead of dropping it.
      if (!token.active) {
        if (!result.done) {
          this.#requeuedFrames.push(result.value);
        }
        return outcome;
      }

      return result;
    } finally {
      release();
    }
  }

  async *#audioStreamGenerator(token: SessionToken): AsyncGenerator<TranscribeAudioStream> {
    for (;;) {
      if (!token.active) return;
      const result = await this.#takeFrame(token);
      if (!token.active) return;
      if (result.done) break;
      if (result.value.byteLength > 0) {
        token.audioSent = true;
      }
      yield { AudioEvent: { AudioChunk: result.value } };
    }

    // AWS Transcribe requires an empty chunk to signal the end of the audio stream.
    if (token.active) {
      yield { AudioEvent: { AudioChunk: new Uint8Array(0) } };
    }
  }

  #processTranscriptEvent(transcriptEvent: TranscriptEvent, requestId?: string): void {
    const results = transcriptEvent.Transcript?.Results;
    if (!results) return;

    for (const result of results) {
      // Transcribe's StartTime/EndTime are cumulative offsets from the start of the whole
      // streaming connection, not per-utterance — so `StartTime === 0` is only ever true for
      // the very first result of a session. START_OF_SPEECH must instead be driven by our own
      // per-channel speaking state so it fires once per utterance, not once per connection,
      // and so one channel finishing doesn't affect another channel's speaking state.
      const channelKey = result.ChannelId ?? '';
      if (!this.#speakingChannels.has(channelKey)) {
        this.#speakingChannels.add(channelKey);
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH, requestId });
      }

      if (result.EndTime !== undefined) {
        this.#lastKnownEndTime = Math.max(this.#lastKnownEndTime, result.EndTime);
        const alternative = this.#toSpeechData(result);
        this.queue.put({
          type: result.IsPartial
            ? stt.SpeechEventType.INTERIM_TRANSCRIPT
            : stt.SpeechEventType.FINAL_TRANSCRIPT,
          requestId,
          alternatives: [alternative],
        });
      }

      if (!result.IsPartial) {
        this.#speakingChannels.delete(channelKey);
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH, requestId });
      }
    }
  }

  #toSpeechData(result: Result): stt.SpeechData {
    const alternative = result.Alternatives?.[0];
    // Transcribe tags punctuation items with no meaningful timestamp/confidence; excluding
    // them keeps word-level alignment and utterance confidence limited to spoken words.
    const items = alternative?.Items?.filter((item) => item.Type !== 'punctuation');
    const confidence = items?.length
      ? items.reduce((sum, item) => sum + (item.Confidence ?? 0), 0) / items.length
      : 0;
    const detectedLanguage = result.LanguageCode ?? this.#opts.language ?? 'en-US';

    const identifiedLanguages = result.LanguageIdentification?.flatMap(({ LanguageCode }) =>
      LanguageCode ? [normalizeLanguage(LanguageCode)] : [],
    );
    const sourceLanguages =
      this.#opts.identifyLanguage || this.#opts.identifyMultipleLanguages
        ? identifiedLanguages?.length
          ? [...new Set(identifiedLanguages)]
          : result.LanguageCode
            ? [normalizeLanguage(result.LanguageCode)]
            : undefined
        : undefined;

    const offset = this.startTimeOffset + this.#connectionTimeOffset;

    // When showSpeakerLabel is enabled, Transcribe attaches a Speaker label to each item.
    // Surface it on every word and derive a segment-level speakerId from the first labelled word.
    const words = items?.map((item) =>
      createTimedString({
        text: item.Content ?? '',
        startTime: (item.StartTime ?? 0) + offset,
        endTime: (item.EndTime ?? 0) + offset,
        confidence: item.Confidence ?? 0,
        startTimeOffset: offset,
        speakerId: item.Speaker ?? result.ChannelId ?? null,
      }),
    );
    const speakerId = words?.find((word) => word.speakerId)?.speakerId ?? result.ChannelId ?? null;

    return {
      language: normalizeLanguage(detectedLanguage),
      startTime: (result.StartTime ?? 0) + offset,
      endTime: (result.EndTime ?? 0) + offset,
      text: alternative?.Transcript ?? '',
      confidence,
      sourceLanguages,
      speakerId,
      words,
    };
  }
}
