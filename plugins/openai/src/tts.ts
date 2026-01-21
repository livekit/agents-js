// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, AudioByteStream, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import type { TTSModels, TTSVoices } from './models.js';

const OPENAI_TTS_SAMPLE_RATE = 24000;
const OPENAI_TTS_CHANNELS = 1;

export interface TTSOptions {
  model: TTSModels | string;
  voice: TTSVoices;
  speed: number;
  instructions?: string;
  baseURL?: string;
  client?: OpenAI;
  apiKey?: string;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.OPENAI_API_KEY,
  model: 'tts-1',
  voice: 'alloy',
  speed: 1,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #client: OpenAI;
  label = 'openai.TTS';
  private abortController = new AbortController();

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
    if (this.#opts.apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: this.#opts.baseURL,
        apiKey: this.#opts.apiKey,
      });
  }

  updateOptions(opts: { model?: TTSModels | string; voice?: TTSVoices; speed?: number }) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(
      this,
      text,
      this.#client.audio.speech.create(
        {
          input: text,
          model: this.#opts.model,
          voice: this.#opts.voice,
          instructions: this.#opts.instructions,
          response_format: 'pcm',
          speed: this.#opts.speed,
        },
        { signal: abortSignal },
      ),
      connOptions,
      abortSignal,
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
      const buffer = await this.stream.then((r) => r.arrayBuffer());
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
