// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  AudioByteStream,
  type TimedString,
  createTimedString,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type Speechify, SpeechifyClient, SpeechifyError } from '@speechify/api';
import type { TTSModels } from './models.js';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;
// Headerless raw 16-bit PCM at the plugin's sample rate; feeds straight into
// AudioByteStream.
const OUTPUT_FORMAT: Speechify.AudioStreamOutputFormat = 'pcm_24000';
const DEFAULT_VOICE_ID = 'dominic_32';
const DEFAULT_MODEL: TTSModels = 'simba-3.2';

// Attribution: the caller is the installable artifact's slug; the version is
// this plugin's release, so usage attributes to the integration per release.
// The SDK sets no caller of its own, and these client-level headers are merged
// into every request, so per-call request options never clobber them.
const CALLER_HEADER = 'Speechify-Caller';
const CALLER_VALUE = 'livekit-typescript';
const CALLER_VERSION_HEADER = 'Speechify-Caller-Version';

/** Configuration options for Speechify TTS. */
export interface TTSOptions {
  /** Voice to synthesize with. Must support the chosen {@link TTSOptions.model}. */
  voiceId: string;
  /** Speechify model. Defaults to `simba-3.2`. */
  model?: TTSModels;
  /** BCP-47 language hint, e.g. `en-US`. */
  language?: string;
  /** Enable Speechify loudness normalization. */
  loudnessNormalization?: boolean;
  /** Enable Speechify text normalization. */
  textNormalization?: boolean;
  /** Speechify API key. Falls back to `$SPEECHIFY_API_KEY`. */
  apiKey?: string;
  /** Override the Speechify API base URL. */
  baseUrl?: string;
  /** Sentence tokenizer used to chunk streamed input; defaults to the basic tokenizer. */
  tokenizer?: tokenize.SentenceTokenizer;
}

const defaultOptions = (): Omit<TTSOptions, 'tokenizer'> => ({
  voiceId: DEFAULT_VOICE_ID,
  model: DEFAULT_MODEL,
});

const buildStreamRequest = (text: string, opts: TTSOptions): Speechify.GetStreamRequest => {
  const request: Speechify.GetStreamRequest = {
    input: text,
    voice_id: opts.voiceId,
    output_format: OUTPUT_FORMAT,
  };
  if (opts.model) request.model = opts.model;
  if (opts.language) request.language = opts.language;
  if (opts.loudnessNormalization !== undefined || opts.textNormalization !== undefined) {
    request.options = {
      loudness_normalization: opts.loudnessNormalization,
      text_normalization: opts.textNormalization,
    };
  }
  return request;
};

// Map provider/SDK/transport failures to a generic message plus the status code,
// never echoing raw provider payloads (customer text, response bodies, headers,
// or URLs) into traces or retry logs. The status code is preserved so the base
// class can still classify retryability (`APIStatusError` derives `retryable`
// from it), but the message carries no provider-supplied content.
const toError = (e: unknown): Error => {
  if (e instanceof APIError) {
    // Already one of ours — every APIError we raise is sanitized at the throw
    // site (see the `speech.error` handling below), so it is safe to surface.
    return e;
  }
  if (e instanceof SpeechifyError) {
    const statusCode = e.statusCode ?? -1;
    return new APIStatusError({
      message:
        statusCode >= 0
          ? `Speechify API request failed with status ${statusCode}`
          : 'Speechify API request failed',
      options: { statusCode },
    });
  }
  return new APIConnectionError({ message: 'Speechify connection error' });
};

// A provider `speech.error` event, sanitized: a generic, retryable status error
// that never carries the provider's raw error text.
const speechStreamError = (): APIStatusError =>
  new APIStatusError({
    message: 'Speechify stream returned an error',
    options: { statusCode: -1 },
  });

// Speech marks carry absolute millisecond times from the start of synthesis;
// TimedString wants seconds, offset by the audio already emitted this segment.
// A trailing space is appended to every word (matching Cartesia) so the
// aligned-transcript synchronizer does not concatenate adjacent words into
// "helloworld".
const timedStringsFromMarks = (
  marks: Speechify.NestedChunk[] | undefined,
  offsetSeconds: number,
): TimedString[] => {
  if (!marks) return [];
  const out: TimedString[] = [];
  for (const mark of marks) {
    if (!mark.value || mark.start_time === undefined) continue;
    out.push(
      createTimedString({
        text: mark.value + ' ',
        startTime: mark.start_time / 1000 + offsetSeconds,
        endTime: mark.end_time !== undefined ? mark.end_time / 1000 + offsetSeconds : undefined,
      }),
    );
  }
  return out;
};

// Emits audio frames to the TTS output queue with a buffer-one deferral, so
// `final: true` lands on exactly the last frame of a segment. Word timestamps
// are attached to the next frame flushed after they arrive; their absolute times
// mean the carrying frame does not matter semantically. One emitter is reused
// across segments — `endSegment()` flushes the buffered last frame as the
// segment's final frame and clears state, so the next segment starts clean.
class FrameEmitter {
  #queue: tts.SynthesizeStream['queue'] | tts.ChunkedStream['queue'];
  #lastFrame?: AudioFrame;
  #requestId?: string;
  #segmentId?: string;
  #pending: TimedString[] = [];

  constructor(queue: tts.SynthesizeStream['queue'] | tts.ChunkedStream['queue']) {
    this.#queue = queue;
  }

  #flush(final: boolean) {
    if (!this.#lastFrame || !this.#requestId || !this.#segmentId) return;
    this.#queue.put({
      requestId: this.#requestId,
      segmentId: this.#segmentId,
      frame: this.#lastFrame,
      final,
      timedTranscripts: this.#pending.length > 0 ? this.#pending : undefined,
    });
    this.#lastFrame = undefined;
    this.#pending = [];
  }

  push(frame: AudioFrame, requestId: string, segmentId: string) {
    this.#flush(false);
    this.#lastFrame = frame;
    this.#requestId = requestId;
    this.#segmentId = segmentId;
  }

  addTimed(timed: TimedString[]) {
    if (timed.length > 0) this.#pending.push(...timed);
  }

  /** Flush the buffered frame as this segment's final frame. */
  endSegment() {
    this.#flush(true);
  }
}

export class TTS extends tts.TTS {
  label = 'speechify.TTS';
  #opts: TTSOptions;
  #client: SpeechifyClient;
  #tokenizer: tokenize.SentenceTokenizer;

  /**
   * Create a new instance of Speechify TTS.
   *
   * @remarks
   * `apiKey` must be set, either via the constructor or the `SPEECHIFY_API_KEY`
   * environment variable.
   *
   * Synthesis uses the Speechify `/v1/audio/stream/with-timestamps` endpoint
   * (SSE), which streams raw PCM (24 kHz mono) together with word-level speech
   * marks as the audio is generated. `stream()` groups input into flush-delimited
   * segments, chunks each segment into sentences, and streams one request per
   * sentence; every segment ends with its own final audio frame carrying a
   * distinct segment id, and aligned word timestamps are emitted as they arrive.
   *
   * Defaults to the `dominic_32` voice and the `simba-3.2` model. The voice must
   * support the chosen model; see the `/v1/voices` endpoint.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const merged = { ...defaultOptions(), ...opts };

    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true, alignedTranscript: true });

    this.#opts = merged;
    this.#tokenizer = merged.tokenizer ?? new tokenize.basic.SentenceTokenizer();

    const token = merged.apiKey ?? process.env.SPEECHIFY_API_KEY;
    if (!token) {
      throw new Error(
        'Speechify API key is required, whether as an argument or as $SPEECHIFY_API_KEY',
      );
    }

    this.#client = new SpeechifyClient({
      token,
      baseUrl: merged.baseUrl,
      headers: {
        [CALLER_HEADER]: CALLER_VALUE,
        [CALLER_VERSION_HEADER]: __PACKAGE_VERSION__,
      },
    });
  }

  get model(): string {
    return this.#opts.model ?? 'unknown';
  }

  get provider(): string {
    return 'Speechify';
  }

  get options(): TTSOptions {
    return this.#opts;
  }

  get tokenizer(): tokenize.SentenceTokenizer {
    return this.#tokenizer;
  }

  /** Update the synthesis options (voice, model, language, normalization) for subsequent requests. */
  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseUrl' | 'tokenizer'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  /** @internal Open a Speechify streaming-with-timestamps SSE stream for `text`. */
  async _openStream(
    text: string,
    opts: TTSOptions,
    params: { abortSignal: AbortSignal; timeoutInSeconds?: number },
  ): Promise<AsyncIterable<Speechify.SpeechStreamEvent>> {
    return this.#client.audio.streamWithTimestamps(
      { body: buildStreamRequest(text, opts) },
      params,
    );
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'speechify.ChunkedStream';
  #tts: TTS;
  #opts: TTSOptions;
  #timeoutInSeconds?: number;

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#tts = ttsInstance;
    this.#opts = opts;
    this.#timeoutInSeconds =
      connOptions?.timeoutMs !== undefined ? connOptions.timeoutMs / 1000 : undefined;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const emitter = new FrameEmitter(this.queue);

    try {
      const stream = await this.#tts._openStream(this.inputText, this.#opts, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.#timeoutInSeconds,
      });

      for await (const event of stream) {
        if (this.abortSignal.aborted) return;
        if (event.type === 'speech.error') {
          throw speechStreamError();
        }
        if (event.type === 'speech.done') continue;
        emitter.addTimed(timedStringsFromMarks(event.speech_marks, 0));
        if (event.audio) {
          for (const frame of bstream.write(Buffer.from(event.audio, 'base64'))) {
            emitter.push(frame, requestId, requestId);
          }
        }
      }

      for (const frame of bstream.flush()) {
        emitter.push(frame, requestId, requestId);
      }
      emitter.endSegment();
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw toError(e);
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'speechify.SynthesizeStream';
  #tts: TTS;
  #opts: TTSOptions;
  // Retry safety: completed flush-delimited segments, buffered on the instance
  // so they survive a re-invocation of `run()`. The base retry loop re-calls
  // `run()` after a retryable APIError but does not re-provide input, and
  // `this.input` has already been drained on the first attempt; without this
  // buffer the retry would synthesize nothing and report success with silence.
  #segments: string[] = [];
  // Number of segments already fully emitted (their audio and final frame reached
  // the consumer). A retry resumes at this index so already-spoken segments are
  // not re-synthesized, and the run picks up at the segment that actually failed.
  #finalized = 0;

  constructor(ttsInstance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  // Synthesize one flush-delimited segment: one request per sentence, a distinct
  // segment id, and a single final frame at the segment boundary. The
  // word-timestamp offset resets to 0 at the segment start and advances by each
  // sentence's reported audio duration, so timestamps stay correct across
  // sentences within the segment while every segment is anchored to its own audio.
  async #synthesizeSegment(text: string, emitter: FrameEmitter): Promise<void> {
    const sentences = this.#tts.tokenizer
      .tokenize(text)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Fall back to the whole segment when the tokenizer yields nothing (e.g. text
    // with no sentence-final punctuation) so short input still synthesizes.
    const chunks = sentences.length > 0 ? sentences : [text.trim()].filter((s) => s.length > 0);
    if (chunks.length === 0) return;

    const requestId = shortuuid();
    const segmentId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    let offsetSeconds = 0;

    this.markStarted();

    for (const chunk of chunks) {
      const stream = await this.#tts._openStream(chunk, this.#opts, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.connOptions.timeoutMs / 1000,
      });

      let durationMs = 0;
      for await (const event of stream) {
        if (this.abortSignal.aborted) return;
        if (event.type === 'speech.error') {
          throw speechStreamError();
        }
        if (event.type === 'speech.done') {
          durationMs = event.audio_duration_ms ?? 0;
          continue;
        }
        emitter.addTimed(timedStringsFromMarks(event.speech_marks, offsetSeconds));
        if (event.audio) {
          for (const frame of bstream.write(Buffer.from(event.audio, 'base64'))) {
            emitter.push(frame, requestId, segmentId);
          }
        }
      }

      offsetSeconds += durationMs / 1000;
    }

    for (const frame of bstream.flush()) {
      emitter.push(frame, requestId, segmentId);
    }
    // One final frame per segment: the base queues one metrics text per flush and
    // expects exactly one final audio frame per segment.
    emitter.endSegment();
  }

  protected async run(): Promise<void> {
    const emitter = new FrameEmitter(this.queue);

    try {
      // 1) Retry replay. On the first attempt #finalized and #segments are empty,
      //    so this is a no-op. On a retry, already-finalized segments are skipped
      //    and we re-synthesize buffered-but-unfinalized segments (the one that
      //    failed), rather than emitting silence.
      let index = this.#finalized;
      while (index < this.#segments.length) {
        await this.#synthesizeSegment(this.#segments[index]!, emitter);
        this.#finalized = ++index;
      }

      // 2) Drain the remaining live input. Each segment is buffered before it is
      //    synthesized (so a retryable failure can replay it), and synthesis is
      //    awaited inside the loop so the loop never reads ahead — any unread
      //    input therefore stays queued on `this.input` and resumes on a retry.
      let current = '';
      let hasText = false;
      for await (const input of this.input) {
        if (input === SynthesizeStream.FLUSH_SENTINEL) {
          if (hasText) {
            this.#segments.push(current);
            await this.#synthesizeSegment(current, emitter);
            this.#finalized = this.#segments.length;
          }
          current = '';
          hasText = false;
        } else {
          current += input;
          hasText = true;
        }
      }
      if (hasText) {
        this.#segments.push(current);
        await this.#synthesizeSegment(current, emitter);
        this.#finalized = this.#segments.length;
      }

      if (!this.queue.closed) {
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw toError(e);
    }
  }
}
