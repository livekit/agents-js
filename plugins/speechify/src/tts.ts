// SPDX-FileCopyrightText: 2025 Speechify, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  USERDATA_TIMED_TRANSCRIPT,
  createTimedString,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { Speechify } from '@speechify/api';
import { SpeechifyClient, SpeechifyError } from '@speechify/api';
import type { TTSModels } from './models.js';

const NUM_CHANNELS = 1;
const SAMPLE_RATE = 24000;
const AUDIO_FORMAT: Speechify.GetSpeechRequest.AudioFormat = 'pcm';
const DEFAULT_VOICE_ID = 'jack';

export interface TTSOptions {
  voiceId: string;
  model?: TTSModels;
  language?: string;
  loudnessNormalization?: boolean;
  textNormalization?: boolean;
  apiKey?: string;
  baseUrl?: string;
  client?: SpeechifyClient;
  tokenizer?: tokenize.SentenceTokenizer;
}

const defaultOptions = (): Omit<TTSOptions, 'client' | 'tokenizer'> => ({
  voiceId: DEFAULT_VOICE_ID,
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
   * environment variable. Pass a preconfigured `client` to reuse an existing
   * `SpeechifyClient` (in which case `apiKey`/`baseUrl` are ignored).
   *
   * Synthesis uses the Speechify `/audio/speech` endpoint, which returns raw PCM
   * (24 kHz mono) plus word-level speech marks. `stream()` chunks input into
   * sentences and issues one request per sentence, emitting audio and aligned
   * word timestamps as each sentence completes.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const merged = { ...defaultOptions(), ...opts };

    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true, alignedTranscript: true });

    this.#opts = merged;
    this.#tokenizer = merged.tokenizer ?? new tokenize.basic.SentenceTokenizer();

    if (merged.client) {
      this.#client = merged.client;
    } else {
      const apiKey = merged.apiKey ?? process.env.SPEECHIFY_API_KEY;
      if (!apiKey) {
        throw new Error(
          'Speechify API key is required, whether as an argument or as $SPEECHIFY_API_KEY',
        );
      }
      this.#client = new SpeechifyClient({ apiKey, baseUrl: merged.baseUrl });
    }
  }

  get model(): string {
    return this.#opts.model ?? 'unknown';
  }

  get provider(): string {
    return 'Speechify';
  }

  get client(): SpeechifyClient {
    return this.#client;
  }

  get options(): TTSOptions {
    return this.#opts;
  }

  get tokenizer(): tokenize.SentenceTokenizer {
    return this.#tokenizer;
  }

  updateOptions(opts: Partial<Omit<TTSOptions, 'client' | 'apiKey' | 'baseUrl' | 'tokenizer'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(text: string, connOptions?: APIConnectOptions): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions);
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

  constructor(ttsInstance: TTS, text: string, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(text, ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
    this.#timeoutInSeconds =
      connOptions?.timeoutMs !== undefined ? connOptions.timeoutMs / 1000 : undefined;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

    try {
      const response = await this.#tts.client.audio.speech(
        buildSpeechRequest(this.inputText, this.#opts),
        { abortSignal: this.abortSignal, timeoutInSeconds: this.#timeoutInSeconds },
      );

      const audio = Buffer.from(response.audio_data, 'base64');
      const timed = timedStringsFromMarks(response.speech_marks, 0);
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
      if (!this.queue.closed) this.queue.close();
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
    let cumulativeDuration = 0;

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
      sentenceStream.close();
    };

    const synthesizeSentence = async (text: string) => {
      const requestId = shortuuid();
      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

      const response = await this.#tts.client.audio.speech(buildSpeechRequest(text, this.#opts), {
        abortSignal: this.abortSignal,
        timeoutInSeconds: this.connOptions.timeoutMs / 1000,
      });

      const audio = Buffer.from(response.audio_data, 'base64');
      const timed = timedStringsFromMarks(response.speech_marks, cumulativeDuration);
      let attached = false;

      const putFrames = (frames: ReturnType<AudioByteStream['write']>) => {
        for (const frame of frames) {
          if (!attached && timed.length > 0) {
            frame.userdata[USERDATA_TIMED_TRANSCRIPT] = timed;
            attached = true;
          }
          cumulativeDuration += frame.samplesPerChannel / frame.sampleRate;
          this.queue.put({ requestId, frame, final: false, segmentId: requestId });
        }
      };

      putFrames(bstream.write(audio));
      putFrames(bstream.flush());
    };

    const consume = async () => {
      for await (const ev of sentenceStream) {
        if (this.abortController.signal.aborted) break;
        const text = ev.token.trim();
        if (!text) continue;
        await synthesizeSentence(text);
      }
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    };

    try {
      await Promise.all([forwardInput(), consume()]);
    } catch (e) {
      if (!this.queue.closed) this.queue.close();
      if (this.abortSignal.aborted) return;
      throw toError(e);
    }
  }
}
