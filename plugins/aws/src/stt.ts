// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  Result,
  StartStreamTranscriptionCommandInput,
  AudioStream as TranscribeAudioStream,
  TranscriptEvent,
  TranscriptResultStream,
} from '@aws-sdk/client-transcribe-streaming';
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from '@aws-sdk/client-transcribe-streaming';
import {
  type APIConnectOptions,
  APIStatusError,
  AsyncIterableQueue,
  type AudioBuffer,
  createTimedString,
  log,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import { type AwsCredentials, resolveRegion, stripUndefined, toAwsApiError } from './utils.js';

export interface STTOptions {
  sampleRate: number;
  language?: string;
  region?: string;
  credentials?: AwsCredentials;
  vocabularyName?: string;
  sessionId?: string;
  vocabFilterMethod?: string;
  vocabFilterName?: string;
  showSpeakerLabel?: boolean;
  enableChannelIdentification?: boolean;
  numberOfChannels?: number;
  enablePartialResultsStabilization?: boolean;
  partialResultsStability?: string;
  languageModelName?: string;
  identifyLanguage?: boolean;
  identifyMultipleLanguages?: boolean;
  /**
   * Comma-separated language codes Amazon Transcribe should consider when automatic
   * language identification is enabled. Required when {@link identifyLanguage} or
   * {@link identifyMultipleLanguages} is true (AWS rejects the request without it).
   */
  languageOptions?: string;
  preferredLanguage?: string;
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
 */
export class STT extends stt.STT {
  #opts: STTOptions;
  #client: TranscribeStreamingClient;
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
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
    });

    if (opts.identifyLanguage && opts.identifyMultipleLanguages) {
      throw new Error(
        'identifyLanguage and identifyMultipleLanguages are mutually exclusive; set only one to true',
      );
    }

    const identifyLanguage = opts.identifyLanguage ?? false;
    const identifyMultipleLanguages = opts.identifyMultipleLanguages ?? false;

    // StartStreamTranscription requires LanguageOptions whenever either identify flag is set;
    // without it AWS returns BadRequest, so fail fast at construction with a clear message.
    if ((identifyLanguage || identifyMultipleLanguages) && !opts.languageOptions) {
      throw new Error(
        'languageOptions is required when identifyLanguage or identifyMultipleLanguages is true ' +
          '(comma-separated language codes Amazon Transcribe should consider, e.g. "en-US,es-US")',
      );
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      identifyLanguage,
      identifyMultipleLanguages,
      // Auto language detection is mutually exclusive with a fixed language code.
      language:
        identifyLanguage || identifyMultipleLanguages
          ? undefined
          : opts.language ?? defaultSTTOptions.language,
    };

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

  async _recognize(_frame: AudioBuffer, _abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    throw new Error(
      'Amazon Transcribe does not support single-frame recognition, use stream() instead',
    );
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, this.#client, options?.connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #client: TranscribeStreamingClient;
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
  // than one place races for frames). Bedrock's Node HTTP/2 request pipeline can leave an
  // abandoned session's `AudioStream` generator alive as a hidden consumer after a session
  // fails (the SDK doesn't reliably tear down the request side when the response side
  // errors), so a single long-lived pump owns `this.input` and feeds a single persistent
  // `#channel` for the lifetime of this stream — the channel itself is never replaced, so
  // no already-buffered frame can ever be orphaned on a session transition. Each session
  // instead reads through a token-guarded wrapper generator: the token is invalidated the
  // moment its session ends, so a superseded generator drops (at most) the one frame it may
  // already be mid-await on instead of racing the new session for every subsequent frame.
  #channel = new AsyncIterableQueue<Uint8Array>();
  #pumpStarted = false;

  constructor(
    stt: STT,
    opts: STTOptions,
    client: TranscribeStreamingClient,
    connOptions?: APIConnectOptions,
  ) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#client = client;
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
      const token: SessionToken = { active: true };
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
        throw toAwsApiError(error, 'aws transcribe stt');
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

    const response = await this.#client.send(new StartStreamTranscriptionCommand(input), {
      abortSignal: this.abortSignal,
    });

    if (!response.TranscriptResultStream) {
      throw new Error('aws transcribe stt: no TranscriptResultStream in the response');
    }

    for await (const event of response.TranscriptResultStream) {
      if (event.TranscriptEvent) {
        this.#processTranscriptEvent(event.TranscriptEvent);
        continue;
      }

      // Amazon Transcribe can deliver service failures as TranscriptResultStream union
      // members rather than thrown errors. Ignoring them lets the stream end "successfully"
      // with no transcript and no retry — surface them as API errors instead.
      this.#throwIfStreamException(event);
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

  async *#audioStreamGenerator(token: SessionToken): AsyncGenerator<TranscribeAudioStream> {
    for (;;) {
      if (!token.active) return;
      const result = await this.#channel.next();
      // The token may have been invalidated while awaiting a frame that belonged to a
      // session that has since ended (e.g. an idle-timeout reconnect) — drop it rather
      // than yielding it into a request the SDK has already abandoned.
      if (!token.active) return;
      if (result.done) break;
      yield { AudioEvent: { AudioChunk: result.value } };
    }

    // AWS Transcribe requires an empty chunk to signal the end of the audio stream.
    if (token.active) {
      yield { AudioEvent: { AudioChunk: new Uint8Array(0) } };
    }
  }

  #processTranscriptEvent(transcriptEvent: TranscriptEvent): void {
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
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }

      if (result.EndTime !== undefined) {
        this.#lastKnownEndTime = Math.max(this.#lastKnownEndTime, result.EndTime);
        const alternative = this.#toSpeechData(result);
        this.queue.put({
          type: result.IsPartial
            ? stt.SpeechEventType.INTERIM_TRANSCRIPT
            : stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [alternative],
        });
      }

      if (!result.IsPartial) {
        this.#speakingChannels.delete(channelKey);
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
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

    const sourceLanguages =
      (this.#opts.identifyLanguage || this.#opts.identifyMultipleLanguages) && result.LanguageCode
        ? [normalizeLanguage(result.LanguageCode)]
        : undefined;

    const offset = this.startTimeOffset + this.#connectionTimeOffset;

    return {
      language: normalizeLanguage(detectedLanguage),
      startTime: (result.StartTime ?? 0) + offset,
      endTime: (result.EndTime ?? 0) + offset,
      text: alternative?.Transcript ?? '',
      confidence,
      sourceLanguages,
      words: items?.map((item) =>
        createTimedString({
          text: item.Content ?? '',
          startTime: (item.StartTime ?? 0) + offset,
          endTime: (item.EndTime ?? 0) + offset,
          confidence: item.Confidence ?? 0,
          startTimeOffset: offset,
        }),
      ),
    };
  }
}
