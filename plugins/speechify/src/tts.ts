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
const OUTPUT_FORMAT: Speechify.AudioOutputFormat = 'pcm_24000';
const DEFAULT_VOICE_ID = 'dominic_32';
const DEFAULT_MODEL: TTSModels = 'simba-3.2';

// Attribution: the caller is the installable artifact's slug; the version is
// this plugin's release, so usage attributes to the integration per release.
// The SDK sets no caller of its own, and these client-level headers are merged
// into every request, so per-call request options never clobber them.
const CALLER_HEADER = 'Speechify-Caller';
const CALLER_VALUE = 'livekit-typescript';
const CALLER_VERSION_HEADER = 'Speechify-Caller-Version';

export interface TTSOptions {
  voiceId: string;
  model?: TTSModels;
  language?: string;
  loudnessNormalization?: boolean;
  textNormalization?: boolean;
  apiKey?: string;
  baseUrl?: string;
  tokenizer?: tokenize.SentenceTokenizer;
}

const defaultOptions = (): Omit<TTSOptions, 'tokenizer'> => ({
  voiceId: DEFAULT_VOICE_ID,
  model: DEFAULT_MODEL,
});

const buildSpeechRequest = (text: string, opts: TTSOptions): Speechify.GetSpeechRequest => {
  const request: Speechify.GetSpeechRequest = {
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

// Speechify speech marks carry millisecond times; TimedString wants seconds.
const timedStringsFromMarks = (
  marks: Speechify.SpeechMarks | undefined,
  offsetSeconds: number,
): TimedString[] => {
  if (!marks?.chunks) return [];
  const out: TimedString[] = [];
  for (const chunk of marks.chunks) {
    if (!chunk.value || chunk.start_time === undefined) continue;
    out.push(
      createTimedString({
        text: chunk.value,
        startTime: chunk.start_time / 1000 + offsetSeconds,
        endTime: chunk.end_time !== undefined ? chunk.end_time / 1000 + offsetSeconds : undefined,
      }),
    );
  }
  return out;
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
   * Synthesis uses the Speechify `/v1/audio/speech` endpoint, which returns raw
   * PCM (24 kHz mono) plus word-level speech marks. `stream()` chunks input into
   * sentences and issues one request per sentence, emitting audio and aligned
   * word timestamps as each sentence completes.
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

  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseUrl' | 'tokenizer'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  /** @internal */
  async _synthesize(
    text: string,
    opts: TTSOptions,
    offsetSeconds: number,
    params: { abortSignal: AbortSignal; timeoutInSeconds?: number },
  ): Promise<{ audio: Buffer; timed: TimedString[] }> {
    const response = await this.#client.audio.speech(buildSpeechRequest(text, opts), params);
    return {
      audio: Buffer.from(response.audio_data, 'base64'),
      timed: timedStringsFromMarks(response.speech_marks, offsetSeconds),
    };
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

    try {
      const { audio, timed } = await this.#tts._synthesize(this.inputText, this.#opts, 0, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.#timeoutInSeconds,
      });

      // Buffer-one deferral so the final frame is flagged `final: true`; the
      // word timestamps ride along with the first frame of the request.
      let lastFrame: AudioFrame | undefined;
      let attached = false;
      const sendLastFrame = (final: boolean) => {
        if (!lastFrame) return;
        const timedTranscripts = !attached && timed.length > 0 ? timed : undefined;
        if (timedTranscripts) attached = true;
        this.queue.put({
          requestId,
          segmentId: requestId,
          frame: lastFrame,
          final,
          timedTranscripts,
        });
        lastFrame = undefined;
      };

      for (const frame of [...bstream.write(audio), ...bstream.flush()]) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
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
    // sentence. Advances by each sentence's full frame duration right after
    // synthesis, staying accurate despite the buffer-one deferral below.
    let offsetSeconds = 0;
    let started = false;

    // Buffer-one deferral across the WHOLE run: `final: true` is emitted exactly
    // once, on the last frame of the entire stream. Each frame carries the word
    // timestamps assigned to it (the first frame of each sentence).
    let lastFrame: AudioFrame | undefined;
    let lastRequestId: string | undefined;
    let lastTimed: TimedString[] | undefined;
    const flush = (final: boolean) => {
      if (!lastFrame || !lastRequestId) return;
      this.queue.put({
        requestId: lastRequestId,
        segmentId: lastRequestId,
        frame: lastFrame,
        final,
        timedTranscripts: lastTimed,
      });
      lastFrame = undefined;
      lastTimed = undefined;
    };
    const push = (frame: AudioFrame, requestId: string, timed?: TimedString[]) => {
      flush(false);
      lastFrame = frame;
      lastRequestId = requestId;
      lastTimed = timed;
    };

    const synthesizeSentence = async (text: string) => {
      const requestId = shortuuid();
      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

      if (!started) {
        this.markStarted();
        started = true;
      }

      const { audio, timed } = await this.#tts._synthesize(text, this.#opts, offsetSeconds, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.connOptions.timeoutMs / 1000,
      });

      const frames = [...bstream.write(audio), ...bstream.flush()];
      offsetSeconds += frames.reduce((sum, f) => sum + f.samplesPerChannel / f.sampleRate, 0);

      frames.forEach((frame, i) => push(frame, requestId, i === 0 ? timed : undefined));
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
      flush(true);
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
