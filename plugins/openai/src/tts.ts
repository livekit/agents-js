// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, APIError, AudioByteStream, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import type { TTSModels, TTSVoices } from './models.js';

const OPENAI_TTS_SAMPLE_RATE = 24000;
const OPENAI_TTS_CHANNELS = 1;

/**
 * `response_format` sent to the provider. Only raw PCM can be played, since this plugin ships no
 * decoder. Any string is accepted for OpenAI-compatible servers that use a different name for
 * raw PCM; a response in a container or compressed format is still rejected when it arrives.
 */
export type TTSResponseFormat = 'pcm' | (string & Record<never, never>);

/**
 * Content types this plugin cannot play. The body is written straight into an `AudioByteStream`
 * as 16-bit samples, so a container or compressed body would come out as a click or as noise.
 */
const UNPLAYABLE_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/x-mpeg',
  'audio/aac',
  'audio/x-aac',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/opus',
  'audio/ogg',
  'application/ogg',
  'audio/webm',
  'audio/mp4',
]);

export interface TTSOptions {
  model: TTSModels | string;
  voice: TTSVoices;
  speed: number;
  instructions?: string;
  baseURL?: string;
  client?: OpenAI;
  apiKey?: string;
  /** Defaults to `pcm`, the only playable format. Set only if your server names raw PCM differently. */
  responseFormat?: TTSResponseFormat;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.OPENAI_API_KEY,
  model: 'tts-1',
  voice: 'alloy',
  speed: 1,
  responseFormat: 'pcm',
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #client: OpenAI;
  label = 'openai.TTS';
  private abortController = new AbortController();

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    try {
      const url = new URL(this.#client.baseURL);
      return url.host;
    } catch {
      return 'api.openai.com';
    }
  }

  /**
   * Create a new instance of OpenAI TTS.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environment variable.
   */
  constructor(opts: Partial<TTSOptions> = defaultTTSOptions) {
    super(OPENAI_TTS_SAMPLE_RATE, OPENAI_TTS_CHANNELS, { streaming: false });

    this.#opts = { ...defaultTTSOptions, ...opts };
    if (this.#opts.apiKey === undefined && !this.#opts.client) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: this.#opts.baseURL,
        maxRetries: 0,
        apiKey: this.#opts.apiKey,
      });
  }

  updateOptions(opts: {
    model?: TTSModels | string;
    voice?: TTSVoices;
    speed?: number;
    responseFormat?: TTSResponseFormat;
  }) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, this.abortController.signal])
      : this.abortController.signal;
    return new ChunkedStream(
      this,
      text,
      this.#client.audio.speech.create(
        {
          input: text,
          model: this.#opts.model,
          voice: this.#opts.voice,
          instructions: this.#opts.instructions,
          // pass a compatible server's own spelling through; the SDK only types OpenAI's
          response_format: (this.#opts.responseFormat ??
            'pcm') as OpenAI.Audio.SpeechCreateParams['response_format'],
          speed: this.#opts.speed,
        },
        { signal },
      ),
      connOptions,
      signal,
    );
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on OpenAI TTS');
  }

  async close(): Promise<void> {
    this.abortController.abort();
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'openai.ChunkedStream';
  private stream: Promise<any>;

  // set Promise<T> to any because OpenAI returns an annoying Response type
  constructor(
    tts: TTS,
    text: string,
    stream: Promise<any>,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.stream = stream;
  }

  protected async run() {
    try {
      const response = await this.stream;
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      if (UNPLAYABLE_CONTENT_TYPES.has(contentType)) {
        throw new APIError(
          `OpenAI TTS returned '${contentType}', which cannot be played as raw PCM: this plugin ` +
            `has no decoder. Request 'pcm' from the provider, or use a TTS plugin for that format.`,
          { retryable: false },
        );
      }

      const buffer = await response.arrayBuffer();
      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(OPENAI_TTS_SAMPLE_RATE, OPENAI_TTS_CHANNELS);
      const frames = audioByteStream.write(buffer);

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      for (const frame of frames) {
        sendLastFrame(requestId, false);
        lastFrame = frame;
      }
      sendLastFrame(requestId, true);

      this.queue.close();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw error;
    } finally {
      this.queue.close();
    }
  }
}
