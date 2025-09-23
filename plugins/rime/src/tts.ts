// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'crypto';
import type { DefaultLanguages, TTSModels } from './models.js';

const RIME_BASE_URL = 'https://users.rime.ai/v1/rime-tts';
const RIME_TTS_SAMPLE_RATE = 22050;
const RIME_TTS_CHANNELS = 1;

export interface TTSOptions {
  speaker: string;
  modelId: TTSModels | string;
  baseURL: string;
  apiKey?: string;
  lang?: DefaultLanguages | string;
  repetition_penalty?: number;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  samplingRate?: number;
  speedAlpha?: number;
  pauseBetweenBrackets?: boolean;
  phonemizeBetweenBrackets?: boolean;
  inlineSpeedAlpha?: string;
  noTextNormalization?: boolean;
  saveOovs?: boolean;
  [key: string]: any;
}

const defaultTTSOptions: TTSOptions = {
  modelId: 'arcana',
  speaker: 'luna',
  apiKey: process.env.RIME_API_KEY,
  baseURL: RIME_BASE_URL,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'rime.TTS';

  constructor(opts: Partial<TTSOptions> = defaultTTSOptions) {
    super(RIME_TTS_SAMPLE_RATE, RIME_TTS_CHANNELS, {
      streaming: false,
    });

    this.#opts = { ...defaultTTSOptions, ...opts };
    if (this.#opts.apiKey === undefined) {
      throw new Error('RIME API key is required, whether as an argument or as $RIME_API_KEY');
    }
  }

  synthesize(text: string): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on RimeTTS');
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'rime-tts.ChunkedStream';
  #opts: TTSOptions;

  constructor(tts: TTS, text: string, opts: TTSOptions) {
    super(text, tts);
    this.#opts = opts;
    this.#run(text);
  }

  async #run(text: string) {
    const requestId = randomUUID();

    const response = await fetch(`${this.#opts.baseURL}`, {
      method: 'POST',
      headers: {
        Accept: 'audio/pcm',
        Authorization: `Bearer ${this.#opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...Object.fromEntries(
          Object.entries(this.#opts).filter(([k]) => !['apiKey', 'baseURL'].includes(k)),
        ),
        text: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Rime AI TTS request failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const audioByteStream = new AudioByteStream(RIME_TTS_SAMPLE_RATE, RIME_TTS_CHANNELS);
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
  }
}
