// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioByteStream,
  shortuuid,
  tts,
} from '@livekit/agents';
import { URL } from 'node:url';
import type { ConfigOption } from './utils.js';

const API_URL = 'https://api.models.hathora.dev/inference/v1/tts';
const AUTHORIZATION_HEADER = 'Authorization';
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

export interface TTSOptions {
  model: string;
  voice?: string;
  speed?: number;
  modelConfig?: ConfigOption[];
  baseURL?: string;
  apiKey?: string;
}

const defaultTTSOptions: Partial<TTSOptions> = {
  baseURL: API_URL,
  apiKey: process.env.HATHORA_API_KEY,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'hathora.TTS';

  constructor(opts: TTSOptions) {
    super(SAMPLE_RATE, 1, {
      streaming: false,
    });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
    };

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Hathora API key is required, whether as an argument or as $HATHORA_API_KEY',
      );
    }
  }

  synthesize(text: string): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Hathora TTS');
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'hathora.ChunkedStream';
  #opts: TTSOptions;
  #text: string;
  #url: URL;

  // set Promise<T> to any because OpenAI returns an annoying Response type
  constructor(tts: TTS, text: string, opts: TTSOptions) {
    super(text, tts);
    this.#text = text;

    this.#opts = opts;

    if (opts.baseURL === undefined) {
      this.#opts.baseURL = API_URL;
    }

    // remove trailing slash from baseURL
    const baseURL = this.#opts.baseURL!.replace(/\/$/, '');

    this.#url = new URL(baseURL);
  }

  protected async run() {
    const requestId = shortuuid();

    const headers: HeadersInit = {
      [AUTHORIZATION_HEADER]: `Bearer ${this.#opts.apiKey!}`,
      'Content-Type': 'application/json',
    };

    const body: any = {
      model: this.#opts.model,
      text: this.#text,
    };

    if (this.#opts.voice) {
      body.voice = this.#opts.voice;
    }
    if (this.#opts.speed) {
      body.speed = this.#opts.speed;
    }
    if (this.#opts.modelConfig) {
      body.model_config = this.#opts.modelConfig;
    }

    const response = await fetch(
      this.#url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(`TTS request failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();

    // Convert the WAV/PCM payload into raw PCM samples to prevent clicking sounds
    const rawPCM = convertWavToRawPCM(arrayBuffer);

    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    for (const frame of bstream.write(rawPCM)) {
      this.queue.put({
        requestId,
        frame,
        final: false,
        segmentId: requestId,
      });
    }
  }
}

const convertWavToRawPCM = (wavBuffer: ArrayBuffer): ArrayBuffer => {
  const dataView = new DataView(wavBuffer);

  // Check the "RIFF" chunk descriptor
  if (dataView.getUint32(0, false) !== 0x52494646) { // "RIFF"
    throw new Error('Invalid WAV file: Missing "RIFF" descriptor');
  }

  // Check the "WAVE" format
  if (dataView.getUint32(8, false) !== 0x57415645) { // "WAVE"
    throw new Error('Invalid WAV file: Missing "WAVE" format');
  }

  // Find the "data" sub-chunk
  let offset = 12;
  while (offset < dataView.byteLength) {
    const subChunkID = dataView.getUint32(offset, false);
    const subChunkSize = dataView.getUint32(offset + 4, true);

    if (subChunkID === 0x64617461) { // "data"
      const dataStart = offset + 8;
      const dataEnd = dataStart + subChunkSize;
      return wavBuffer.slice(dataStart, dataEnd);
    }

    offset += (8 + subChunkSize);
  }

  throw new Error('Invalid WAV file: Missing "data" sub-chunk');
}
