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

const toError = (e: unknown): Error => {
  if (e instanceof APIError) {
    return e;
  }
  if (e instanceof SpeechifyError) {
    return new APIStatusError({
      message: e.message,
      options: { statusCode: e.statusCode ?? -1 },
    });
  }
  return new APIConnectionError({ message: e instanceof Error ? e.message : String(e) });
};

// Speech marks carry absolute millisecond times from the start of synthesis;
// TimedString wants seconds, offset by the audio already emitted this stream.
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
        text: mark.value,
        startTime: mark.start_time / 1000 + offsetSeconds,
        endTime: mark.end_time !== undefined ? mark.end_time / 1000 + offsetSeconds : undefined,
      }),
    );
  }
  return out;
};

// Emits audio frames to the TTS output queue with a buffer-one deferral, so
// `final: true` lands on exactly the last frame of the whole stream. Word
// timestamps are attached to the next frame flushed after they arrive; their
// absolute times mean the carrying frame does not matter semantically.
class FrameEmitter {
  #queue: tts.SynthesizeStream['queue'] | tts.ChunkedStream['queue'];
  #lastFrame?: AudioFrame;
  #lastRequestId?: string;
  #pending: TimedString[] = [];

  constructor(queue: tts.SynthesizeStream['queue'] | tts.ChunkedStream['queue']) {
    this.#queue = queue;
  }

  #flush(final: boolean) {
    if (!this.#lastFrame || !this.#lastRequestId) return;
    this.#queue.put({
      requestId: this.#lastRequestId,
      segmentId: this.#lastRequestId,
      frame: this.#lastFrame,
      final,
      timedTranscripts: this.#pending.length > 0 ? this.#pending : undefined,
    });
    this.#lastFrame = undefined;
    this.#pending = [];
  }

  push(frame: AudioFrame, requestId: string) {
    this.#flush(false);
    this.#lastFrame = frame;
    this.#lastRequestId = requestId;
  }

  addTimed(timed: TimedString[]) {
    if (timed.length > 0) this.#pending.push(...timed);
  }

  end() {
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
   * marks as the audio is generated. `stream()` chunks input into sentences and
   * streams one request per sentence, emitting audio and aligned word
   * timestamps as they arrive.
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
          throw new APIStatusError({
            message: event.error?.message ?? 'Speechify stream error',
            options: { statusCode: -1 },
          });
        }
        if (event.type === 'speech.done') continue;
        emitter.addTimed(timedStringsFromMarks(event.speech_marks, 0));
        if (event.audio) {
          for (const frame of bstream.write(Buffer.from(event.audio, 'base64'))) {
            emitter.push(frame, requestId);
          }
        }
      }

      for (const frame of bstream.flush()) {
        emitter.push(frame, requestId);
      }
      emitter.end();
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

  constructor(ttsInstance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const sentenceStream = this.#tts.tokenizer.stream();
    // Cumulative audio duration, used as the word-timestamp offset for the next
    // sentence (each request reports marks from 0). Advanced by the reported
    // audio duration once a sentence's stream completes.
    let offsetSeconds = 0;
    let started = false;
    const emitter = new FrameEmitter(this.queue);

    const synthesizeSentence = async (text: string) => {
      const requestId = shortuuid();
      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

      if (!started) {
        this.markStarted();
        started = true;
      }

      const stream = await this.#tts._openStream(text, this.#opts, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.connOptions.timeoutMs / 1000,
      });

      let durationMs = 0;
      for await (const event of stream) {
        if (this.abortSignal.aborted) return;
        if (event.type === 'speech.error') {
          throw new APIStatusError({
            message: event.error?.message ?? 'Speechify stream error',
            options: { statusCode: -1 },
          });
        }
        if (event.type === 'speech.done') {
          durationMs = event.audio_duration_ms ?? 0;
          continue;
        }
        emitter.addTimed(timedStringsFromMarks(event.speech_marks, offsetSeconds));
        if (event.audio) {
          for (const frame of bstream.write(Buffer.from(event.audio, 'base64'))) {
            emitter.push(frame, requestId);
          }
        }
      }

      for (const frame of bstream.flush()) {
        emitter.push(frame, requestId);
      }
      offsetSeconds += durationMs / 1000;
    };

    const forwardInput = async () => {
      for await (const input of this.input) {
        if (input === SynthesizeStream.FLUSH_SENTINEL) {
          sentenceStream.flush();
        } else {
          sentenceStream.pushText(input);
        }
      }
      sentenceStream.endInput();
    };

    const consume = async () => {
      for await (const ev of sentenceStream) {
        const text = ev.token.trim();
        if (!text) continue;
        await synthesizeSentence(text);
      }
      emitter.end();
      if (!this.queue.closed) {
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    };

    try {
      await Promise.all([forwardInput(), consume()]);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw toError(e);
    }
  }
}
