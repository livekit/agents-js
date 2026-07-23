// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  AudioByteStream,
  USERDATA_TIMED_TRANSCRIPT,
  createTimedString,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Speechify } from '@speechify/api';
import { SpeechifyClient, SpeechifyError } from '@speechify/api';
import type { TTSModels } from './models.js';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;
const AUDIO_FORMAT: Speechify.GetSpeechRequest.AudioFormat = 'pcm';
const DEFAULT_VOICE_ID = 'dominic_32';
const DEFAULT_MODEL: TTSModels = 'simba-3.2';

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
    audio_format: AUDIO_FORMAT,
    input: text,
    voice_id: opts.voiceId,
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
    return new APIStatusError({ message: e.message, options: { statusCode: e.statusCode ?? -1 } });
  }
  return new APIConnectionError({ message: e instanceof Error ? e.message : String(e) });
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
   * Synthesis uses the Speechify `/audio/speech` endpoint, which returns raw PCM
   * (24 kHz mono) plus word-level speech marks. `stream()` chunks input into
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
    this.#client = new SpeechifyClient({ token, baseUrl: merged.baseUrl });
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

  /** @internal */
  async _synthesize(
    text: string,
    opts: TTSOptions,
    offsetSeconds: number,
    params: { abortSignal: AbortSignal; timeoutInSeconds?: number },
  ): Promise<{ audio: Buffer; timed: ReturnType<typeof createTimedString>[] }> {
    const response = await this.#client.audio.speech(buildSpeechRequest(text, opts), params);
    return {
      audio: Buffer.from(response.audio_data, 'base64'),
      timed: timedStringsFromMarks(response.speech_marks, offsetSeconds),
    };
  }

  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseUrl' | 'tokenizer'>>) {
    this.#opts = { ...this.#opts, ...opts };
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

const timedStringsFromMarks = (
  marks: Speechify.SpeechMarks | undefined,
  offsetSeconds: number,
): ReturnType<typeof createTimedString>[] => {
  if (!marks?.chunks) return [];
  const out: ReturnType<typeof createTimedString>[] = [];
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

export class ChunkedStream extends tts.ChunkedStream {
  label = 'speechify.ChunkedStream';
  #opts: TTSOptions;
  #tts: TTS;
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

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

    try {
      const { audio, timed } = await this.#tts._synthesize(this.inputText, this.#opts, 0, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.#timeoutInSeconds,
      });
      let attached = false;

      const putFrames = (frames: ReturnType<AudioByteStream['write']>) => {
        for (const frame of frames) {
          if (!attached && timed.length > 0) {
            frame.userdata[USERDATA_TIMED_TRANSCRIPT] = timed;
            attached = true;
          }
          this.queue.put({ requestId, frame, final: false, segmentId: requestId });
        }
      };

      putFrames(bstream.write(audio));
      putFrames(bstream.flush());
      this.queue.close();
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw toError(e);
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'speechify.SynthesizeStream';
  #opts: TTSOptions;
  #tts: TTS;

  constructor(ttsInstance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  protected async run() {
    const sentenceStream = this.#tts.tokenizer.stream();
    // Total audio duration produced so far, used as the timestamp offset for
    // the next sentence's word marks. Advances by each sentence's full frame
    // duration right after synthesis, so it stays accurate even though the
    // last frame of each sentence is deferred by the buffer-one loop below.
    let offsetSeconds = 0;

    // Buffer-one deferral across the WHOLE run: the base class only records
    // one pending text per reply, so `final: true` must be emitted exactly
    // once on the last frame of the entire stream (mirrors elevenlabs/cartesia).
    let lastFrame: AudioFrame | undefined;
    let lastRequestId: string | undefined;
    const sendFrame = (final: boolean) => {
      if (!lastFrame || !lastRequestId) return;
      this.queue.put({
        requestId: lastRequestId,
        frame: lastFrame,
        final,
        segmentId: lastRequestId,
      });
      lastFrame = undefined;
    };

    const forwardInput = async () => {
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;
        if (input === SynthesizeStream.FLUSH_SENTINEL) {
          sentenceStream.flush();
        } else {
          sentenceStream.pushText(input);
        }
      }
      sentenceStream.endInput();
    };

    const synthesizeSentence = async (text: string) => {
      const requestId = shortuuid();
      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

      this.markStarted();
      const { audio, timed } = await this.#tts._synthesize(text, this.#opts, offsetSeconds, {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.connOptions.timeoutMs / 1000,
      });

      const frames = [...bstream.write(audio), ...bstream.flush()];
      if (timed.length > 0 && frames.length > 0) {
        frames[0]!.userdata[USERDATA_TIMED_TRANSCRIPT] = timed;
      }
      offsetSeconds += frames.reduce((sum, f) => sum + f.samplesPerChannel / f.sampleRate, 0);

      for (const frame of frames) {
        sendFrame(false);
        lastFrame = frame;
        lastRequestId = requestId;
      }
    };

    const consume = async () => {
      for await (const ev of sentenceStream) {
        if (this.abortController.signal.aborted) break;
        const text = ev.token.trim();
        if (!text) continue;
        await synthesizeSentence(text);
      }
      sendFrame(true);
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    };

    try {
      await Promise.all([forwardInput(), consume()]);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw toError(e);
    }
  }
}
