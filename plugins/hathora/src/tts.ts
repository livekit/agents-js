// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioByteStream,
  shortuuid,
  tts,
} from '@livekit/agents';
import { URL } from 'node:url';
import type { KokoroVoices, TTSModels } from './models.js';

const KOKORO_API_URL = 'https://app-01312daf-6e53-4b9d-a4ad-13039f35adc4.app.hathora.dev/synthesize';
const CHATTERBOX_API_URL = 'https://app-efbc8fe2-df55-4f96-bbe3-74f6ea9d986b.app.hathora.dev/v1/generate';
const AUTHORIZATION_HEADER = 'Authorization';
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

export type TTSOptions =
  | KokoroTTSOptions
  | ChatterboxTTSOptions;

export interface BaseTTSOptions {
  baseURL: string;
  apiKey?: string;
  model: TTSModels;
}

export interface KokoroTTSOptions extends BaseTTSOptions {
  model: 'hexgrad_kokoro';
  voice?: KokoroVoices | string;
  speed?: number;
}

export interface ChatterboxTTSOptions extends BaseTTSOptions {
  model: 'resembleai_chatterbox';
  audioPrompt?: Buffer;
  exaggeration?: number;
  cfgWeight?: number;
}

const defaultTTSOptionsBase: TTSOptions = {
  baseURL: KOKORO_API_URL,
  apiKey: process.env.HATHORA_API_KEY,
  model: 'hexgrad_kokoro',
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'hathora.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(SAMPLE_RATE, 1, {
      streaming: false,
    });

    this.#opts = {
      ...defaultTTSOptionsBase,
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

    opts.baseURL = opts.model === 'hexgrad_kokoro' ? KOKORO_API_URL : CHATTERBOX_API_URL;

    this.#opts = opts;

    // remove trailing slash from baseURL
    const baseURL = opts.baseURL.replace(/\/$/, '');

    this.#url = new URL(baseURL);
  }

  protected async run() {
    const requestId = shortuuid();

    const headers: HeadersInit = {
      [AUTHORIZATION_HEADER]: `Bearer ${this.#opts.apiKey!}`,
    };

    if (this.#opts.model === 'hexgrad_kokoro') {
      headers['Accept'] = 'application/json';
      headers['Content-Type'] = 'application/json';
    }

    let body: BodyInit = '';

    if (this.#opts.model === 'hexgrad_kokoro') {
      const kokoroOpts = toKokoroOptions(this.#text, this.#opts);
      body = JSON.stringify(kokoroOpts);
    } else if (this.#opts.model === 'resembleai_chatterbox') {
      const data = new FormData();

      data.append('text', this.#text);

      if (this.#opts.exaggeration !== undefined) {
        data.append('exaggeration', this.#opts.exaggeration.toString());
      }

      if (this.#opts.cfgWeight !== undefined) {
        data.append('cfg_weight', this.#opts.cfgWeight.toString());
      }

      if (this.#opts.audioPrompt) {
        const chunks: BlobPart[] = [];
        const source = new Uint8Array(this.#opts.audioPrompt);
        const copy = new ArrayBuffer(source.byteLength);
        new Uint8Array(copy).set(source);
        chunks.push(copy);

        // let done = false;
        // while (!done) {
        //   const { value, done: readDone } = await reader.read();
        //   if (value) {
        //     const source = new Uint8Array(value.data);
        //     const copy = new ArrayBuffer(source.byteLength);
        //     new Uint8Array(copy).set(source);
        //     chunks.push(copy);
        //   }
        //   done = readDone;
        // }
        const audioBlob = new Blob(chunks, { type: 'audio/wav' });
        data.append('audio_prompt', audioBlob, 'audio_prompt.raw');
      }

      body = data;
    }

    const response = await fetch(
      this.#url,
      {
        method: 'POST',
        headers,
        body,
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

const toKokoroOptions = (text: string, opts: TTSOptions) => {
  if (opts.model !== 'hexgrad_kokoro') {
    throw new Error('Invalid model for Kokoro options');
  }

  return {
    text,
    voice: opts.voice,
    speed: opts.speed,
  };
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
