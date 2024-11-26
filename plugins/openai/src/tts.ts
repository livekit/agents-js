// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, tts } from '@livekit/agents';
import { OpenAI } from 'openai';
import type { TTSModels, TTSVoices } from './models.js';

const OPENAI_TTS_SAMPLE_RATE = 24000;
const OPENAI_TTS_CHANNELS = 1;

export interface TTSOptions {
  model: TTSModels | string;
  voice: TTSVoices;
  speed: number;
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

  /**
   * Create a new instance of OpenAI TTS.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environmental variable.
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
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
      });
  }

  updateOptions(opts: { model?: TTSModels | string; voice?: TTSVoices; speed?: number }) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(text: string): ChunkedStream {
    return new ChunkedStream(
      this.#client.audio.speech.create({
        input: text,
        model: this.#opts.model,
        voice: this.#opts.voice,
        response_format: 'pcm',
        speed: this.#opts.speed,
      }),
    );
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on OpenAI TTS');
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  // set Promise<T> to any because OpenAI returns an annoying Response type
  constructor(stream: Promise<any>) {
    super();
    this.#run(stream);
  }

  async #run(stream: Promise<Response>) {
    const buffer = await stream.then((r) => r.arrayBuffer());
    const requestId = crypto.randomUUID();
    const audioByteStream = new AudioByteStream(OPENAI_TTS_SAMPLE_RATE, OPENAI_TTS_CHANNELS);
    const frames = audioByteStream.write(buffer);

    for (const frame of frames) {
      this.queue.put({
        frame,
        requestId,
        segmentId: requestId,
      });
    }
    this.queue.close();
  }
}
