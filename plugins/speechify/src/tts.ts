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

// A provider `speech.error` event, sanitized: a generic status error that never
// carries the provider's raw error text.
const speechStreamError = (): APIStatusError =>
  new APIStatusError({
    message: 'Speechify stream returned an error',
    options: { statusCode: -1 },
  });

// Speech marks carry absolute millisecond times from the start of synthesis;
// TimedString wants seconds, offset by the audio already emitted this run. A
// trailing space is appended to every word (matching Cartesia) so the
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

// Streams audio frames to the TTS output queue incrementally, with a buffer-one
// deferral so `final: true` lands on exactly the last frame. Frames are emitted
// as they arrive (not withheld) so a long response starts playing immediately —
// mirroring the incremental emission of the cartesia/elevenlabs plugins. Word
// timestamps ride the next frame flushed after they arrive; their absolute times
// mean the carrying frame does not matter semantically. `emitted` records whether
// any frame has reached the consumer, which the streams use to decide that a
// failure after playback has begun must end the turn rather than retry (a retried
// request re-generates the audio, which would double what was already spoken).
class FrameEmitter {
  #queue: tts.SynthesizeStream['queue'] | tts.ChunkedStream['queue'];
  #lastFrame?: AudioFrame;
  #requestId?: string;
  #segmentId?: string;
  #pending: TimedString[] = [];
  #emitted = false;

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
    this.#emitted = true;
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

  /** Flush the buffered frame as the run's final frame. */
  end() {
    this.#flush(true);
  }

  get emitted(): boolean {
    return this.#emitted;
  }
}

// Once audio has reached the consumer, a retry would re-generate and double the
// spoken audio, so a failure after playback has begun ends the turn instead of
// retrying. Errors before the first frame stay retryable (a retried request that
// never emitted is safe). The message is already sanitized by `toError`.
const finalizeError = (e: unknown, emitted: boolean): Error => {
  const err = toError(e);
  if (emitted && err instanceof APIError) {
    return new APIConnectionError({ message: err.message, options: { retryable: false } });
  }
  return err;
};

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
   * marks as the audio is generated. `stream()` chunks input into sentences and
   * streams one request per sentence, emitting audio and aligned word timestamps
   * incrementally as they arrive.
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
      emitter.end();
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw finalizeError(e, emitter.emitted);
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'speechify.SynthesizeStream';
  #tts: TTS;
  #opts: TTSOptions;

  constructor(ttsInstance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const emitter = new FrameEmitter(this.queue);
    const sentenceStream = this.#tts.tokenizer.stream();
    // Cumulative audio duration, used as the word-timestamp offset for the next
    // sentence (each request reports marks from 0). Advanced by each sentence's
    // reported audio duration.
    let offsetSeconds = 0;

    // Feed the sentence tokenizer from live input, flushing it on each caller
    // flush so buffered text is synthesized promptly. Mirrors cartesia: input is
    // pumped concurrently with synthesis so audio streams out as sentences land.
    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          sentenceStream.flush();
        } else {
          sentenceStream.pushText(data);
        }
      }
      sentenceStream.endInput();
    };

    // Synthesize each sentence as it emerges and stream its audio incrementally.
    const synthesizeTask = async () => {
      for await (const ev of sentenceStream) {
        if (this.abortSignal.aborted) return;
        const text = ev.token.trim();
        if (!text) continue;

        // Anchor TTFB per sentence send; the base resets the anchor after it
        // emits each sentence's metrics.
        this.markStarted();
        const stream = await this.#tts._openStream(text, this.#opts, {
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
              emitter.push(frame, requestId, requestId);
            }
          }
        }

        offsetSeconds += durationMs / 1000;
      }

      for (const frame of bstream.flush()) {
        emitter.push(frame, requestId, requestId);
      }
      emitter.end();
    };

    try {
      await Promise.all([inputTask(), synthesizeTask()]);
      if (!this.queue.closed) {
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw finalizeError(e, emitter.emitted);
    }
  }
}
